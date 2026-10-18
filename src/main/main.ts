import { app, BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron';
import * as path from 'node:path';
import { ContainerStore } from './containers';
import { buildElectronProxy, ProxyConfig } from './network';
import { isAllowedNavigation, normalizeInput } from './url';
import { createVault, registerVaultIpc } from './vault-ipc';
import type { Vault } from './vault';

const CHROME_HEIGHT = 96; // tab strip + toolbar height in px

interface Tab {
  id: number;
  containerId: string;
  view: WebContentsView;
  /** Resolves once this container's network route is applied. Pages are never loaded before it resolves. */
  ready: Promise<void>;
}

let win: BrowserWindow;
let store: ContainerStore;
let vault: Vault;
const tabs = new Map<number, Tab>();
let activeTabId: number | null = null;
let nextTabId = 1;
let panelOpen = false; // while a shell panel is open, the active web view is detached so the panel is visible

function hardenSession(ses: Electron.Session): void {
  // Deny every permission by default. A per-container permission UI replaces this in Phase 5.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

async function applyProxy(containerId: string, cfg: ProxyConfig): Promise<void> {
  const c = store.get(containerId);
  if (!c) throw new Error('Container not found');
  const electronCfg = buildElectronProxy(cfg); // throws on invalid input, nothing is applied or saved
  await session.fromPartition(c.partition).setProxy(electronCfg);
  store.setProxy(containerId, cfg);
  pushState();
}

function layoutActive(): void {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (!t) return;
  const [w, h] = win.getContentSize();
  t.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: w, height: h - CHROME_HEIGHT });
}

function pushState(): void {
  win.webContents.send('state', {
    containers: store.list({ sort: 'lastUsed' }),
    tabs: [...tabs.values()].map((t) => ({
      id: t.id,
      containerId: t.containerId,
      title: t.view.webContents.getTitle() || 'New Tab',
      url: t.view.webContents.getURL(),
    })),
    activeTabId,
  });
}

function openTab(containerId: string, url = 'about:blank'): number {
  const c = store.get(containerId);
  if (!c) throw new Error('Container not found');
  const ses = session.fromPartition(c.partition);
  hardenSession(ses);
  // Apply this container's saved network route (or direct) before anything loads in it.
  const ready: Promise<void> = ses.setProxy(c.proxy ? buildElectronProxy(c.proxy) : { mode: 'direct' });
  ready.catch(() => undefined);

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const id = nextTabId++;
  tabs.set(id, { id, containerId, view, ready });
  store.touch(containerId);

  const wc = view.webContents;
  // Block unsafe navigation (file:, javascript:, custom schemes)
  wc.on('will-navigate', (e, target) => {
    if (!isAllowedNavigation(target) && target !== 'about:blank') e.preventDefault();
  });
  // New windows: only http(s), opened as a new tab in the SAME container. Never a native popup.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isAllowedNavigation(target)) openTab(containerId, target);
    return { action: 'deny' };
  });
  for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) {
    wc.on(ev as 'did-navigate', pushState);
  }

  activate(id);
  // Fail closed: if the route could not be applied, the page is not loaded at all.
  if (url !== 'about:blank') void ready.then(() => wc.loadURL(url)).catch(() => undefined);
  return id;
}

function activate(id: number): void {
  const t = tabs.get(id);
  if (!t) return;
  if (activeTabId !== null) {
    const prev = tabs.get(activeTabId);
    if (prev) win.contentView.removeChildView(prev.view);
  }
  activeTabId = id;
  if (!panelOpen) win.contentView.addChildView(t.view);
  layoutActive();
  pushState();
}

function closeTab(id: number): void {
  const t = tabs.get(id);
  if (!t) return;
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  if (activeTabId === id) {
    activeTabId = null;
    const rest = [...tabs.keys()];
    if (rest.length) activate(rest[rest.length - 1]);
  }
  pushState();
}

async function wipeContainerData(partition: string): Promise<void> {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
}

function registerIpc(): void {
  ipcMain.handle('containers:list', (_e, opts) => store.list(opts));
  ipcMain.handle('containers:create', (_e, input) => {
    const c = store.create(input);
    pushState();
    return c;
  });
  ipcMain.handle('containers:update', (_e, id: string, input) => {
    const c = store.update(id, input);
    pushState();
    return c;
  });
  ipcMain.handle('containers:duplicate', (_e, id: string) => {
    const c = store.duplicate(id);
    pushState();
    return c;
  });
  ipcMain.handle('containers:delete', async (_e, id: string) => {
    for (const t of [...tabs.values()]) if (t.containerId === id) closeTab(t.id);
    const c = store.remove(id);
    await wipeContainerData(c.partition);
    // Remove this container's saved credentials (entries explicitly shared across containers are kept).
    if (vault.isUnlocked()) vault.removeForContainer(id);
    pushState();
  });
  ipcMain.handle('containers:clearData', async (_e, id: string) => {
    const c = store.get(id);
    if (c) await wipeContainerData(c.partition);
  });
  ipcMain.handle('containers:setProxy', async (_e, id: string, cfg: Partial<ProxyConfig>) => {
    // Rebuild the config from known fields only; nothing else from the renderer is trusted.
    const clean: ProxyConfig = {
      enabled: cfg?.enabled === true,
      scheme: cfg?.scheme as ProxyConfig['scheme'],
      host: String(cfg?.host ?? '').trim(),
      port: Number(cfg?.port),
      strict: cfg?.strict === true,
    };
    await applyProxy(String(id), clean);
  });
  ipcMain.handle('ui:panel', (_e, open: unknown) => {
    panelOpen = open === true;
    const t = activeTabId !== null ? tabs.get(activeTabId) : undefined;
    if (!t) return;
    if (panelOpen) win.contentView.removeChildView(t.view);
    else {
      win.contentView.addChildView(t.view);
      layoutActive();
    }
  });

  ipcMain.handle('tabs:open', (_e, containerId: string, input?: string) =>
    openTab(containerId, input ? normalizeInput(input) : 'about:blank'),
  );
  ipcMain.handle('tabs:activate', (_e, id: number) => activate(id));
  ipcMain.handle('tabs:close', (_e, id: number) => closeTab(id));
  ipcMain.handle('nav:go', (_e, input: string) => {
    const t = activeTabId !== null ? tabs.get(activeTabId) : undefined;
    if (t) void t.ready.then(() => t.view.webContents.loadURL(normalizeInput(input))).catch(() => undefined);
  });
  ipcMain.handle('nav:back', () => activeTabId !== null && tabs.get(activeTabId)?.view.webContents.navigationHistory.goBack());
  ipcMain.handle('nav:forward', () => activeTabId !== null && tabs.get(activeTabId)?.view.webContents.navigationHistory.goForward());
  ipcMain.handle('nav:reload', () => activeTabId !== null && tabs.get(activeTabId)?.view.webContents.reload());
  ipcMain.handle('state:get', () => pushState());
}

app.whenReady().then(() => {
  store = new ContainerStore(path.join(app.getPath('userData'), 'containers.json'));

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'BlueSky Browser',
    backgroundColor: '#05070d',
    webPreferences: {
      preload: path.join(__dirname, '../preload/shell.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
  win.on('resize', layoutActive);

  vault = createVault(() => win.webContents.send('vault:locked'));
  registerVaultIpc(vault);
  registerIpc();
  // Create a first container so the browser is usable immediately (no account/setup required).
  if (store.list().length === 0) store.create({ name: 'Default', emoji: '🔵' });
  win.webContents.once('did-finish-load', pushState);
});

app.on('window-all-closed', () => app.quit());

// Never let the app open arbitrary external protocols by itself.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
void shell; // external-link confirmation dialog is added in Phase 5
