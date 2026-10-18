import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KeyProtector, Vault } from '../../src/main/vault';

// Stand-in for Electron safeStorage: real encryption with a per-test key, so wrapped data is not the plain key.
function fakeProtector(): KeyProtector {
  const k = crypto.randomBytes(32);
  return {
    protect(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', k, iv);
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    unprotect(w) {
      const d = crypto.createDecipheriv('aes-256-gcm', k, w.subarray(0, 12));
      d.setAuthTag(w.subarray(12, 28));
      return Buffer.concat([d.update(w.subarray(28)), d.final()]);
    },
  };
}

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bsb-vault-')), 'vault.json');
}

const SECRET = 'S3cret-Pa$$w0rd-UNIQUE-4471';

test('vault file never contains plaintext origin, username or password (os mode)', () => {
  const f = tmpFile();
  const v = new Vault(f, fakeProtector());
  v.create();
  v.add({ containerId: 'A', origin: 'https://example.com', username: 'alice@client.com', password: SECRET });
  const raw = fs.readFileSync(f, 'utf8');
  for (const needle of [SECRET, 'alice@client.com', 'example.com']) assert.ok(!raw.includes(needle), needle);
});

test('vault file never contains plaintext (master password mode)', () => {
  const f = tmpFile();
  const v = new Vault(f, fakeProtector());
  v.create('correct horse battery');
  v.add({ containerId: 'A', origin: 'https://example.com', username: 'bob', password: SECRET });
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes(SECRET));
  assert.ok(!raw.includes('correct horse battery'));
});

test('os mode: lock then unlock restores entries', () => {
  const f = tmpFile();
  const p = fakeProtector();
  const v = new Vault(f, p);
  v.create();
  const e = v.add({ containerId: 'A', origin: 'https://a.com', username: 'u', password: SECRET });
  v.lock();
  assert.throws(() => v.list());
  v.unlock();
  assert.equal(v.reveal(e.id), SECRET);
});

test('master password: wrong password and missing password are rejected, right one works', () => {
  const f = tmpFile();
  const v = new Vault(f, fakeProtector());
  v.create('correct horse battery');
  v.lock();
  assert.throws(() => v.unlock('wrong password!!'));
  assert.throws(() => v.unlock());
  assert.equal(v.isUnlocked(), false);
  v.unlock('correct horse battery');
  assert.equal(v.isUnlocked(), true);
});

test('weak master password rejected and no vault left behind', () => {
  const f = tmpFile();
  const v = new Vault(f, fakeProtector());
  assert.throws(() => v.create('short'));
  assert.equal(v.exists(), false);
});

test('tampered vault file fails to unlock', () => {
  const f = tmpFile();
  const v = new Vault(f, fakeProtector());
  v.create('correct horse battery');
  v.add({ containerId: 'A', origin: 'https://a.com', username: 'u', password: 'p' });
  v.lock();
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const buf = Buffer.from(j.data, 'base64');
  buf[buf.length - 1] ^= 0xff;
  j.data = buf.toString('base64');
  fs.writeFileSync(f, JSON.stringify(j));
  assert.throws(() => v.unlock('correct horse battery'));
});

test('lists never include passwords', () => {
  const v = new Vault(tmpFile(), fakeProtector());
  v.create();
  v.add({ containerId: 'A', origin: 'https://a.com', username: 'u', password: SECRET });
  assert.ok(!JSON.stringify(v.list()).includes(SECRET));
  assert.ok(!JSON.stringify(v.findForOrigin('A', 'https://a.com')).includes(SECRET));
});

test('autofill is exact-origin only', () => {
  const v = new Vault(tmpFile(), fakeProtector());
  v.create();
  v.add({ containerId: 'A', origin: 'https://example.com', username: 'u', password: 'p' });
  assert.equal(v.findForOrigin('A', 'https://example.com').length, 1);
  assert.equal(v.findForOrigin('A', 'http://example.com').length, 0); // scheme
  assert.equal(v.findForOrigin('A', 'https://example.com:8443').length, 0); // port
  assert.equal(v.findForOrigin('A', 'https://sub.example.com').length, 0); // subdomain
  assert.equal(v.findForOrigin('A', 'https://example.com.evil.io').length, 0); // lookalike
});

test('cross-container sharing is off by default and opt-in works', () => {
  const v = new Vault(tmpFile(), fakeProtector());
  v.create();
  const a = v.add({ containerId: 'A', origin: 'https://x.com', username: 'u', password: 'p' });
  assert.equal(a.allowAcrossContainers, false);
  assert.equal(v.findForOrigin('B', 'https://x.com').length, 0);
  assert.equal(v.secretFor('B', 'https://x.com', a.id), null);
  v.update(a.id, { allowAcrossContainers: true });
  assert.equal(v.findForOrigin('B', 'https://x.com').length, 1);
  assert.deepEqual(v.secretFor('B', 'https://x.com', a.id), { username: 'u', password: 'p' });
});

test('secretFor refuses an entry for a different origin', () => {
  const v = new Vault(tmpFile(), fakeProtector());
  v.create();
  const a = v.add({ containerId: 'A', origin: 'https://x.com', username: 'u', password: 'p' });
  assert.equal(v.secretFor('A', 'https://evil.com', a.id), null);
});

test('edit, search, delete, delete-container cleanup', () => {
  const v = new Vault(tmpFile(), fakeProtector());
  v.create();
  const a = v.add({ containerId: 'A', origin: 'https://one.com', username: 'alpha', password: 'p1' });
  v.add({ containerId: 'B', origin: 'https://two.com', username: 'beta', password: 'p2' });
  v.update(a.id, { password: 'new' });
  assert.equal(v.reveal(a.id), 'new');
  assert.equal(v.list({ search: 'two' }).length, 1);
  assert.equal(v.list({ containerId: 'A' }).length, 1);
  assert.equal(v.removeForContainer('A'), 1);
  assert.equal(v.list().length, 1);
  const b = v.list()[0];
  v.remove(b.id);
  assert.equal(v.list().length, 0);
});

test('auto-lock wipes the unlocked state after inactivity', async () => {
  let locked = 0;
  const v = new Vault(tmpFile(), fakeProtector(), 40, () => locked++);
  v.create();
  assert.equal(v.isUnlocked(), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(v.isUnlocked(), false);
  assert.equal(locked, 1);
  assert.throws(() => v.list());
});

test('encrypted backup round-trips into a fresh vault and needs the right password', () => {
  const v1 = new Vault(tmpFile(), fakeProtector());
  v1.create();
  v1.add({ containerId: 'A', origin: 'https://a.com', username: 'u', password: SECRET });
  const backup = v1.exportBackup('backup-pass-123');
  assert.ok(!backup.includes(SECRET));
  assert.ok(!backup.includes('a.com'));

  const v2 = new Vault(tmpFile(), fakeProtector());
  v2.create();
  assert.throws(() => v2.importBackup(backup, 'wrong-pass-123'));
  assert.equal(v2.importBackup(backup, 'backup-pass-123'), 1);
  assert.equal(v2.reveal(v2.list()[0].id), SECRET);
  assert.equal(v2.importBackup(backup, 'backup-pass-123'), 0); // idempotent
});
