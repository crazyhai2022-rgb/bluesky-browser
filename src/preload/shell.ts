import { contextBridge, ipcRenderer } from 'electron';

// Minimal, explicit API. No generic ipcRenderer is ever exposed to the page.
contextBridge.exposeInMainWorld('bsb', {
  onState: (cb: (s: unknown) => void) => {
    ipcRenderer.on('state', (_e, s) => cb(s));
    void ipcRenderer.invoke('state:get');
  },
  ui: {
    panel: (open: boolean) => ipcRenderer.invoke('ui:panel', open),
  },
  containers: {
    list: (opts?: unknown) => ipcRenderer.invoke('containers:list', opts),
    create: (input: unknown) => ipcRenderer.invoke('containers:create', input),
    update: (id: string, input: unknown) => ipcRenderer.invoke('containers:update', id, input),
    duplicate: (id: string) => ipcRenderer.invoke('containers:duplicate', id),
    remove: (id: string) => ipcRenderer.invoke('containers:delete', id),
    clearData: (id: string) => ipcRenderer.invoke('containers:clearData', id),
    setProxy: (id: string, cfg: unknown) => ipcRenderer.invoke('containers:setProxy', id, cfg),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  },
  privacy: {
    stats: () => ipcRenderer.invoke('privacy:stats'),
    resetSitePermissions: () => ipcRenderer.invoke('permissions:resetAll'),
    clearAllData: () => ipcRenderer.invoke('data:clearAll'),
  },
  tabs: {
    open: (containerId: string, input?: string) => ipcRenderer.invoke('tabs:open', containerId, input),
    activate: (id: number) => ipcRenderer.invoke('tabs:activate', id),
    close: (id: number) => ipcRenderer.invoke('tabs:close', id),
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    create: (masterPassword?: string) => ipcRenderer.invoke('vault:create', masterPassword),
    unlock: (masterPassword?: string) => ipcRenderer.invoke('vault:unlock', masterPassword),
    lock: () => ipcRenderer.invoke('vault:lock'),
    list: (opts?: unknown) => ipcRenderer.invoke('vault:list', opts),
    add: (input: unknown) => ipcRenderer.invoke('vault:add', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('vault:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('vault:remove', id),
    reveal: (id: string) => ipcRenderer.invoke('vault:reveal', id),
    exportBackupFile: (pw: string) => ipcRenderer.invoke('vault:exportBackupFile', pw),
    importBackupFile: (pw: string) => ipcRenderer.invoke('vault:importBackupFile', pw),
    onLocked: (cb: () => void) => ipcRenderer.on('vault:locked', () => cb()),
  },
  nav: {
    go: (input: string) => ipcRenderer.invoke('nav:go', input),
    back: () => ipcRenderer.invoke('nav:back'),
    forward: () => ipcRenderer.invoke('nav:forward'),
    reload: () => ipcRenderer.invoke('nav:reload'),
  },
});
