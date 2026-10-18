// Encrypted local password vault. No Electron imports: OS key protection is injected, so this is unit-testable.
//
// Key management (documented in docs/ARCHITECTURE.md, Phase 4):
//   - A random 256-bit vault key encrypts all entries with AES-256-GCM (one encrypted blob; origins,
//     usernames and passwords are all inside it, so nothing readable sits on disk).
//   - The vault key itself is wrapped in one of two ways:
//       mode "os":       wrapped by the OS (Electron safeStorage: DPAPI on Windows, Keychain on macOS)
//       mode "password": wrapped by a key derived from the user's master password with scrypt (AES-256-GCM)
//   - Auto-lock wipes the in-memory key and entries after inactivity.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface KeyProtector {
  protect(plain: Buffer): Buffer;
  unprotect(wrapped: Buffer): Buffer;
}

export interface VaultEntry {
  id: string;
  containerId: string;
  origin: string; // exact origin: scheme + host + port
  username: string;
  password: string;
  /** Explicit opt-in. Default false: the entry is only offered inside its own container. */
  allowAcrossContainers: boolean;
  createdAt: number;
  updatedAt: number;
}

export type EntryInput = Pick<VaultEntry, 'containerId' | 'origin' | 'username' | 'password'> &
  Partial<Pick<VaultEntry, 'allowAcrossContainers'>>;

/** What the UI may see in lists. Never includes the password. */
export type EntrySummary = Omit<VaultEntry, 'password'>;

interface VaultFile {
  v: 1;
  mode: 'os' | 'password';
  salt?: string; // base64, password mode only
  wrapped: string; // base64 wrapped vault key
  data: string; // base64 nonce|tag|ciphertext of JSON entries
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function seal(key: Buffer, plain: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer): Buffer {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function kdf(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT);
}

export class Vault {
  private key: Buffer | null = null;
  private entries: VaultEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly protector: KeyProtector,
    private autoLockMs: number = 5 * 60 * 1000,
    private readonly onLock: () => void = () => undefined,
  ) {}

  // ---- state -------------------------------------------------------------

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  mode(): 'os' | 'password' | null {
    return this.exists() ? this.read().mode : null;
  }

  setAutoLockMs(ms: number): void {
    this.autoLockMs = ms;
    this.touch();
  }

  private touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.key && this.autoLockMs > 0) {
      this.timer = setTimeout(() => this.lock(), this.autoLockMs);
      this.timer.unref?.();
    }
  }

  private read(): VaultFile {
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as VaultFile;
  }

  private persist(mode: 'os' | 'password', salt: Buffer | null, wrapped: Buffer): void {
    if (!this.key) throw new Error('Vault is locked');
    const data = seal(this.key, Buffer.from(JSON.stringify(this.entries), 'utf8'));
    const f: VaultFile = {
      v: 1,
      mode,
      salt: salt?.toString('base64'),
      wrapped: wrapped.toString('base64'),
      data: data.toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private save(): void {
    const f = this.read();
    this.persist(f.mode, f.salt ? Buffer.from(f.salt, 'base64') : null, Buffer.from(f.wrapped, 'base64'));
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Create a new vault. With a master password the vault key is wrapped by scrypt; otherwise by the OS. */
  create(masterPassword?: string): void {
    if (this.exists()) throw new Error('Vault already exists');
    this.key = crypto.randomBytes(32);
    this.entries = [];
    if (masterPassword) {
      if (masterPassword.length < 8) {
        this.key = null;
        throw new Error('Master password must be at least 8 characters');
      }
      const salt = crypto.randomBytes(16);
      this.persist('password', salt, seal(kdf(masterPassword, salt), this.key));
    } else {
      this.persist('os', null, this.protector.protect(this.key));
    }
    this.touch();
  }

  unlock(masterPassword?: string): void {
    const f = this.read();
    let key: Buffer;
    try {
      if (f.mode === 'password') {
        if (!masterPassword) throw new Error('Master password required');
        key = open(kdf(masterPassword, Buffer.from(f.salt!, 'base64')), Buffer.from(f.wrapped, 'base64'));
      } else {
        key = this.protector.unprotect(Buffer.from(f.wrapped, 'base64'));
      }
      this.entries = JSON.parse(open(key, Buffer.from(f.data, 'base64')).toString('utf8')) as VaultEntry[];
    } catch {
      // Deliberately vague: wrong password and corrupted/tampered file look the same.
      throw new Error('Unable to unlock vault (wrong password or damaged vault)');
    }
    this.key = key;
    this.touch();
  }

  lock(): void {
    const was = this.key !== null;
    if (this.key) this.key.fill(0);
    this.key = null;
    this.entries = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (was) this.onLock();
  }

  // ---- entries -----------------------------------------------------------

  private requireUnlocked(): void {
    if (!this.key) throw new Error('Vault is locked');
    this.touch();
  }

  private summary(e: VaultEntry): EntrySummary {
    const { password: _pw, ...rest } = e;
    void _pw;
    return rest;
  }

  add(input: EntryInput): EntrySummary {
    this.requireUnlocked();
    if (!input.origin || !input.username) throw new Error('Origin and username are required');
    const now = Date.now();
    const e: VaultEntry = {
      id: crypto.randomUUID(),
      containerId: input.containerId,
      origin: input.origin,
      username: input.username,
      password: input.password,
      allowAcrossContainers: input.allowAcrossContainers ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(e);
    this.save();
    return this.summary(e);
  }

  update(id: string, patch: Partial<Pick<VaultEntry, 'username' | 'password' | 'allowAcrossContainers'>>): EntrySummary {
    this.requireUnlocked();
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error('Entry not found');
    if (patch.username !== undefined) e.username = patch.username;
    if (patch.password !== undefined) e.password = patch.password;
    if (patch.allowAcrossContainers !== undefined) e.allowAcrossContainers = patch.allowAcrossContainers;
    e.updatedAt = Date.now();
    this.save();
    return this.summary(e);
  }

  remove(id: string): void {
    this.requireUnlocked();
    this.entries = this.entries.filter((x) => x.id !== id);
    this.save();
  }

  /** Removes all entries belonging to a container (used when the container is deleted). */
  removeForContainer(containerId: string): number {
    this.requireUnlocked();
    const before = this.entries.length;
    this.entries = this.entries.filter((x) => x.containerId !== containerId || x.allowAcrossContainers);
    this.save();
    return before - this.entries.length;
  }

  list(opts: { containerId?: string; search?: string } = {}): EntrySummary[] {
    this.requireUnlocked();
    const q = opts.search?.toLowerCase();
    return this.entries
      .filter((e) => (opts.containerId ? e.containerId === opts.containerId : true))
      .filter((e) => (q ? e.origin.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) : true))
      .map((e) => this.summary(e));
  }

  /** Explicit, user-initiated password reveal (View button). */
  reveal(id: string): string {
    this.requireUnlocked();
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error('Entry not found');
    return e.password;
  }

  /**
   * Credentials offered for autofill. Exact-origin match only (scheme + host + port; no subdomain or
   * parent-domain matching). Entries from other containers are returned only if the user opted in.
   */
  findForOrigin(containerId: string, origin: string): EntrySummary[] {
    this.requireUnlocked();
    return this.entries
      .filter((e) => e.origin === origin && (e.containerId === containerId || e.allowAcrossContainers))
      .map((e) => this.summary(e));
  }

  /** Used by the autofill path only, after findForOrigin has approved the entry for this tab. */
  secretFor(containerId: string, origin: string, id: string): { username: string; password: string } | null {
    this.requireUnlocked();
    const e = this.entries.find((x) => x.id === id);
    if (!e || e.origin !== origin) return null;
    if (e.containerId !== containerId && !e.allowAcrossContainers) return null;
    return { username: e.username, password: e.password };
  }

  // ---- backup / restore --------------------------------------------------

  /** Encrypted backup, always protected by a user-chosen backup password (independent of the OS key). */
  exportBackup(backupPassword: string): string {
    this.requireUnlocked();
    if (backupPassword.length < 8) throw new Error('Backup password must be at least 8 characters');
    const salt = crypto.randomBytes(16);
    const blob = seal(kdf(backupPassword, salt), Buffer.from(JSON.stringify(this.entries), 'utf8'));
    return JSON.stringify({ bsbBackup: 1, salt: salt.toString('base64'), data: blob.toString('base64') });
  }

  /** Merges a backup into the unlocked vault. Existing entries with the same id are kept as is. */
  importBackup(backup: string, backupPassword: string): number {
    this.requireUnlocked();
    let incoming: VaultEntry[];
    try {
      const b = JSON.parse(backup) as { bsbBackup: number; salt: string; data: string };
      if (b.bsbBackup !== 1) throw new Error('bad version');
      incoming = JSON.parse(
        open(kdf(backupPassword, Buffer.from(b.salt, 'base64')), Buffer.from(b.data, 'base64')).toString('utf8'),
      ) as VaultEntry[];
    } catch {
      throw new Error('Unable to read backup (wrong password or damaged file)');
    }
    const have = new Set(this.entries.map((e) => e.id));
    let added = 0;
    for (const e of incoming) {
      if (!have.has(e.id)) {
        this.entries.push(e);
        added++;
      }
    }
    this.save();
    return added;
  }
}
