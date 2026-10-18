// Runtime smoke test of the shell UI in jsdom with a stubbed window.bsb (no Electron available here).
const { JSDOM, VirtualConsole } = require('jsdom');
const assert = require('node:assert/strict');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(String(e.stack || e)));
vc.on('error', (e) => errors.push(String(e)));

const calls = [];
const containers = [
  { id: 'a', name: 'Client A', color: '#2563ff', emoji: '🔵', description: 'Main client', pinned: true, createdAt: 1, lastUsedAt: Date.now() - 3600e3 * 5, partition: 'persist:container-a',
    proxy: { enabled: true, scheme: 'socks5', host: 'px.example.net', port: 1080, strict: true } },
  { id: 'b', name: 'Client B', color: '#16a34a', emoji: '🟢', description: '', pinned: false, createdAt: 2, lastUsedAt: null, partition: 'persist:container-b', proxy: null },
];
let stateCb = null;
let vaultExists = false, vaultUnlocked = false;
const entries = [];
const bsb = {
  onState: (cb) => { stateCb = cb; },
  ui: { panel: async (o) => calls.push(['ui.panel', o]) },
  containers: {
    list: async () => containers,
    create: async (d) => calls.push(['create', d]),
    update: async (id, d) => calls.push(['update', id, d]),
    duplicate: async (id) => calls.push(['duplicate', id]),
    remove: async (id) => calls.push(['remove', id]),
    clearData: async (id) => calls.push(['clearData', id]),
    setProxy: async (id, cfg) => { calls.push(['setProxy', id, cfg]); if (/[,;]/.test(cfg.host)) throw new Error("Error invoking remote method 'containers:setProxy': Error: Proxy host contains invalid characters"); },
  },
  tabs: { open: async (...a) => calls.push(['tabs.open', ...a]), activate: async () => {}, close: async (id) => calls.push(['tabs.close', id]) },
  nav: { go: async () => {}, back: async () => {}, forward: async () => {}, reload: async () => {} },
  vault: {
    status: async () => ({ exists: vaultExists, unlocked: vaultUnlocked, mode: 'os' }),
    create: async () => { vaultExists = true; vaultUnlocked = true; },
    unlock: async () => { vaultUnlocked = true; },
    lock: async () => { vaultUnlocked = false; },
    list: async () => entries.map(({ password, ...r }) => r),
    add: async (i) => { entries.push({ id: 'e' + entries.length, ...i }); },
    update: async () => {}, remove: async (id) => { const i = entries.findIndex((e) => e.id === id); entries.splice(i, 1); },
    reveal: async (id) => entries.find((e) => e.id === id).password,
    exportBackupFile: async () => '/tmp/x.bsbbackup', importBackupFile: async () => 2,
    onLocked: (cb) => { bsb._locked = cb; },
  },
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromFile(require('node:path').join(__dirname, '../../src/renderer/index.html'), {
    runScripts: 'dangerously', resources: 'usable', virtualConsole: vc,
    beforeParse(w) { w.bsb = bsb; },
  });
  const w = dom.window, d = w.document;
  await tick(200); // scripts load
  assert.ok(stateCb, 'shell.js registered onState');
  stateCb({ containers, tabs: [{ id: 1, containerId: 'a', title: 'Example', url: 'https://example.com' }], activeTabId: 1 });
  assert.equal(d.querySelectorAll('#tabs .tab').length, 1);
  assert.equal(d.querySelectorAll('#cont option').length, 2);

  // Containers panel
  d.getElementById('btn-containers').click();
  await tick();
  assert.ok(d.getElementById('panel').classList.contains('open'));
  assert.deepEqual(calls.find((c) => c[0] === 'ui.panel'), ['ui.panel', true]);
  assert.equal(d.querySelectorAll('.card').length, 2);
  assert.ok(d.querySelector('.card').textContent.includes('SOCKS5 proxy px.example.net:1080'));
  assert.ok(d.querySelectorAll('.card')[1].textContent.includes('Direct connection'));
  const btn = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label);

  // Edit dialog
  btn(d.querySelector('.card'), 'Edit').click();
  assert.ok(d.getElementById('modal').classList.contains('open'));
  assert.equal(d.querySelector('#modal input').value, 'Client A');
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Save').click();
  await tick();
  assert.equal(calls.find((c) => c[0] === 'update')[1], 'a');
  assert.ok(!d.getElementById('modal').classList.contains('open'));

  // Proxy dialog shows an error for a bad host and stays open
  btn(d.querySelector('.card'), 'Network').click();
  const inputs = d.querySelectorAll('#modal input');
  const hostInput = [...inputs].find((i) => i.placeholder === 'proxy.example.com');
  hostInput.value = '1.2.3.4,direct://';
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Save').click();
  await tick();
  assert.ok(d.querySelector('#modal .error').textContent.includes('invalid characters'));
  assert.ok(d.getElementById('modal').classList.contains('open'));
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Cancel').click();

  // Delete asks for confirmation first
  btn(d.querySelector('.card'), 'Delete').click();
  assert.ok(d.querySelector('#modal h3').textContent.includes('Delete'));
  assert.ok(!calls.some((c) => c[0] === 'remove'), 'not deleted before confirm');
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Delete container').click();
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'remove'), ['remove', 'a']);

  // New container dialog, create
  [...d.querySelectorAll('.phead button')].find((b) => b.textContent === '+ New container').click();
  d.querySelector('#modal input').value = 'Client C';
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Create').click();
  await tick();
  assert.equal(calls.find((c) => c[0] === 'create')[1].name, 'Client C');

  // Vault: setup -> add -> reveal -> delete confirm
  d.getElementById('btn-vault').click();
  await tick();
  assert.ok(d.querySelector('.vcard h3').textContent.includes('Set up'));
  [...d.querySelectorAll('button')].find((b) => b.textContent === 'Create vault').click();
  await tick();
  assert.ok(d.querySelector('.empty').textContent.includes('No saved passwords'));
  [...d.querySelectorAll('.phead button')].find((b) => b.textContent === '+ Add').click();
  const fields = d.querySelectorAll('#modal input');
  const [site, user, pw, share] = [fields[0], fields[1], fields[2], fields[3]];
  assert.equal(share.checked, false, 'cross-container sharing defaults to off');
  site.value = 'example.com'; user.value = 'alice'; pw.value = 'Sup3rSecret!';
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Save').click();
  await tick();
  const added = entries[0];
  assert.equal(added.origin, 'https://example.com');
  assert.equal(added.allowAcrossContainers, false);
  const row = d.querySelector('tbody tr');
  assert.ok(!row.textContent.includes('Sup3rSecret!'), 'password hidden in list');
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Show').click();
  await tick();
  assert.ok(row.textContent.includes('Sup3rSecret!'), 'password shown after Show');
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
  assert.ok(d.querySelector('#modal').textContent.includes('permanently deleted'));
  [...d.querySelectorAll('#modal button')].find((b) => b.textContent === 'Delete').click();
  await tick();
  assert.equal(entries.length, 0);

  // Auto-lock event switches the open vault panel to the lock screen
  vaultUnlocked = false;
  bsb._locked();
  await tick();
  assert.ok(d.querySelector('.vcard h3').textContent.includes('locked'));

  // Closing the panel re-attaches the web view
  [...d.querySelectorAll('.phead button')].find((b) => b.textContent.includes('Close')).click();
  assert.deepEqual(calls.filter((c) => c[0] === 'ui.panel').pop(), ['ui.panel', false]);

  // XSS: hostile container name is rendered as text
  containers[1].name = '<img src=x onerror=alert(1)>';
  stateCb({ containers, tabs: [], activeTabId: null });
  d.getElementById('btn-containers').click();
  await tick();
  assert.equal(d.querySelectorAll('.card img').length, 0);

  assert.deepEqual(errors, [], 'no script errors: ' + errors.join('\n'));
  console.log('UI smoke test passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); if (errors.length) console.error(errors.join('\n')); process.exit(1); });
