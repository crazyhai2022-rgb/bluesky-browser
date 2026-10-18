import { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContainerStore } from './containers';
import { buildElectronProxy, ProxyConfig } from './network';
import { PermissionStore, PermKind } from './permissions';
import { applyPrivacy, attachTab, PrivacyDeps, refreshSession, refreshTab, stats } from './privacy';
import { AUTOLOCK_CHOICES, SEARCH_ENGINES, SettingsStore, ZOOM_CHOICES } from './settings';
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
let settings: SettingsStore;
let perms: PermissionStore;
let privacyDeps: PrivacyDeps;
let sessionFile = '';
const tabs = new Map<number, Tab>();
let activeTabId: number | null = null;
let nextTabId = 1;
let panelOpen = false; // while a shell panel is open, the active web view is detached so the panel is visible
let saveTimer: NodeJS.Timeout | null = null;

const searchUrl = (): string => SEARCH_ENGINES[settings.get().searchEngine].url;

async function applyProxy(containerId: string, cfg: ProxyConfig): Promise<void> {
  const c = store.get(containerId);
  if (!c) throw new Error('Container not found');
  const electronCfg = buildElectronProxy(cfg); // throws on invalid input, nothing is applied or saved
  await session.fromPartition(c.partition).setProxy(electronCfg);
  store.setProxy(containerId, cfg);
  for (const t of tabs.values()) if (t.containerId === containerId) refreshTab(t.view.webContents, containerId, privacyDeps);
  pushState();
}

function layoutActive(): void {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (!t) return;
  const [w, h] = win.getContentSize();
  t.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: w, height: h - CHROME_HEIGHT });
}

/** Remembers open tabs (only when "restore tabs" is on) so they can be reopened next time. */
function saveSessionSoon(): void {
  if (!settings.get().restoreTabs) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...tabs.values()]
      .map((t) => ({ containerId: t.containerId, url: t.view.webContents.getURL() }))
      .filter((t) => /^https?:\/\//.test(t.url));
    try {
      fs.writeFileSync(sessionFile, JSON.stringify(list));
    } catch {
      /* best effort */
    }
  }, 800);
}

function pushState(): void {
  if (!win || win.isDestroyed()) return;
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
  saveSessionSoon();
}

function openTab(containerId: string, url = 'about:blank'): number {
  const c = store.get(containerId);
  if (!c) throw new Error('Container not found');
  const ses = session.fromPartition(c.partition);
  applyPrivacy(ses, containerId, privacyDeps); // blocking, headers, permissions: once per container session
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
  const hooks = attachTab(wc, containerId, privacyDeps);
  // Block unsafe navigation (file:, javascript:, custom schemes)
  wc.on('will-navigate', (e, target) => {
    if (!isAllowedNavigation(target) && target !== 'about:blank') e.preventDefault();
  });
  // New windows: only http(s), opened as a new tab in the SAME container, and only after a real user action
  // when pop-up blocking is on. Never a native popup window.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isAllowedNavigation(target) && hooks.popupAllowed()) openTab(containerId, target);
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

/** Native question when a site asks for camera, microphone, location or notifications. Default button is Block. */
async function askPermission(containerId: string, origin: string, kinds: PermKind[]): Promise<{ allow: boolean; remember: boolean }> {
  const c = store.get(containerId);
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Permission request',
    message: `${origin} wants to use your ${kinds.join(' and ')}`,
    detail: `Container: ${c ? `${c.emoji} ${c.name}` : 'unknown'}. Remembered answers apply to this site in this container only.`,
    buttons: ['Block', 'Allow', 'Block and remember', 'Allow and remember'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return { allow: r.response === 1 || r.response === 3, remember: r.response >= 2 };
}

function applySettingsEverywhere(): void {
  vault.setAutoLockMs(settings.get().vaultAutoLockMinutes * 60 * 1000);
  for (const t of tabs.values()) {
    refreshSession(t.view.webContents.session, privacyDeps);
    refreshTab(t.view.webContents, t.containerId, privacyDeps);
  }
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
    perms.reset(id);
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

  // ---- settings and privacy dashboard
  ipcMain.handle('settings:get', () => ({
    settings: settings.get(),
    engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label })),
    zoomChoices: ZOOM_CHOICES,
    autoLockChoices: AUTOLOCK_CHOICES,
  }));
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const next = settings.set(patch);
    applySettingsEverywhere();
    return next;
  });
  ipcMain.handle('privacy:stats', () => ({ ...stats, savedSiteDecisions: perms.count() }));
  ipcMain.handle('permissions:resetAll', () => perms.reset());
  ipcMain.handle('data:clearAll', async () => {
    const all = store.list();
    for (const c of all) await wipeContainerData(c.partition);
    return all.length;
  });

  ipcMain.handle('tabs:open', (_e, containerId: string, input?: string) =>
    openTab(containerId, input ? normalizeInput(input, searchUrl()) : settings.get().homepage || 'about:blank'),
  );
  ipcMain.handle('tabs:activate', (_e, id: number) => activate(id));
  ipcMain.handle('tabs:close', (_e, id: number) => closeTab(id));
  ipcMain.handle('nav:go', (_e, input: string) => {
    const t = activeTabId !== null ? tabs.get(activeTabId) : undefined;
    if (t) void t.ready.then(() => t.view.webContents.loadURL(normalizeInput(input, searchUrl()))).catch(() => undefined);
  });
  ipcMain.handle('nav:back', () => activeTabId !== null && tabs.get(activeTabId)?.view.webContents.navigationHistory.goBack());
  ipcMain.handle('nav:forward', () => activeTabId !== null && tabs.get(activeTabId)?.view.webContents.navigationHistory.goForward());
  ipcMain.handle('nav:reload', () => activeTabId !== null && tabs.get(activeTabId)?.view.webContents.reload());
  ipcMain.handle('state:get', () => pushState());
}

app.whenReady().then(() => {
  const data = app.getPath('userData');
  store = new ContainerStore(path.join(data, 'containers.json'));
  settings = new SettingsStore(path.join(data, 'settings.json'));
  perms = new PermissionStore(path.join(data, 'site-permissions.json'));
  sessionFile = path.join(data, 'session.json');
  privacyDeps = {
    settings: () => settings.get(),
    perms,
    strictProxy: (containerId) => store.get(containerId)?.proxy?.enabled === true,
    ask: askPermission,
  };

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

  vault = createVault(() => {
    if (!win.isDestroyed()) win.webContents.send('vault:locked');
  });
  vault.setAutoLockMs(settings.get().vaultAutoLockMinutes * 60 * 1000);
  registerVaultIpc(vault);
  registerIpc();
  // Create a first container so the browser is usable immediately (no account/setup required).
  if (store.list().length === 0) store.create({ name: 'Default', emoji: '🔵' });
  win.webContents.once('did-finish-load', () => {
    pushState();
    if (!settings.get().restoreTabs) return;
    try {
      const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { containerId: string; url: string }[];
      for (const t of saved.slice(0, 30)) {
        if (store.get(t.containerId) && isAllowedNavigation(t.url)) openTab(t.containerId, t.url);
      }
    } catch {
      /* nothing to restore */
    }
  });
});

app.on('window-all-closed', () => app.quit());

// Never let the app open arbitrary external protocols by itself.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
void shell; // external-link confirmation dialog is added in a later phase
