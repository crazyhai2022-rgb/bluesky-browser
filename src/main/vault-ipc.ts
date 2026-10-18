import { app, dialog, ipcMain, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EntryInput, KeyProtector, Vault } from './vault';

/** OS-protected key wrapping: DPAPI on Windows, Keychain on macOS. Refuses to run without OS encryption. */
const osProtector: KeyProtector = {
  protect(plain) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is not available on this system');
    return safeStorage.encryptString(plain.toString('base64'));
  },
  unprotect(wrapped) {
    return Buffer.from(safeStorage.decryptString(wrapped), 'base64');
  },
};

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
};

export function createVault(onLock: () => void): Vault {
  return new Vault(path.join(app.getPath('userData'), 'vault.json'), osProtector, 5 * 60 * 1000, onLock);
}

/**
 * IPC for the browser shell only. Lists never contain passwords; a password leaves the main process only
 * through the explicit `vault:reveal` call (the "show password" button). Web pages have no access to any
 * of these channels: tab views have no preload.
 */
export function registerVaultIpc(vault: Vault): void {
  ipcMain.handle('vault:status', () => ({
    exists: vault.exists(),
    unlocked: vault.isUnlocked(),
    mode: vault.mode(),
  }));
  ipcMain.handle('vault:create', (_e, masterPassword?: unknown) => {
    vault.create(masterPassword === undefined || masterPassword === '' ? undefined : str(masterPassword, 'password'));
  });
  ipcMain.handle('vault:unlock', (_e, masterPassword?: unknown) => {
    vault.unlock(masterPassword === undefined ? undefined : str(masterPassword, 'password'));
  });
  ipcMain.handle('vault:lock', () => vault.lock());
  ipcMain.handle('vault:list', (_e, opts?: { containerId?: string; search?: string }) =>
    vault.list({ containerId: opts?.containerId, search: opts?.search }),
  );
  ipcMain.handle('vault:add', (_e, input: EntryInput) =>
    vault.add({
      containerId: str(input?.containerId, 'containerId'),
      origin: str(input?.origin, 'origin'),
      username: str(input?.username, 'username'),
      password: str(input?.password, 'password'),
      allowAcrossContainers: input?.allowAcrossContainers === true,
    }),
  );
  ipcMain.handle('vault:update', (_e, id: unknown, patch: { username?: string; password?: string; allowAcrossContainers?: boolean }) =>
    vault.update(str(id, 'id'), patch ?? {}),
  );
  ipcMain.handle('vault:remove', (_e, id: unknown) => vault.remove(str(id, 'id')));
  ipcMain.handle('vault:reveal', (_e, id: unknown) => vault.reveal(str(id, 'id')));
  // Backups go straight between the vault and a file the user picks; the backup text never reaches the UI.
  ipcMain.handle('vault:exportBackupFile', async (_e, pw: unknown) => {
    const data = vault.exportBackup(str(pw, 'password'));
    const r = await dialog.showSaveDialog({
      title: 'Save encrypted vault backup',
      defaultPath: 'bluesky-vault-backup.bsbbackup',
      filters: [{ name: 'BlueSky vault backup', extensions: ['bsbbackup'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, data, { mode: 0o600 });
    return r.filePath;
  });
  ipcMain.handle('vault:importBackupFile', async (_e, pw: unknown) => {
    const password = str(pw, 'password');
    const r = await dialog.showOpenDialog({
      title: 'Choose a vault backup',
      properties: ['openFile'],
      filters: [{ name: 'BlueSky vault backup', extensions: ['bsbbackup'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return vault.importBackup(fs.readFileSync(r.filePaths[0], 'utf8'), password);
  });
}
