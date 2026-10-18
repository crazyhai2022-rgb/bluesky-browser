'use strict';
/* Containers manager, Password vault panel, and in-app dialogs (window.prompt does not exist in Electron).
   All DOM is built with textContent / createElement, never innerHTML, so saved data cannot inject markup. */

const panelEl = $('panel');
const modalEl = $('modal');
let currentPanel = null; // { name, refresh }

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const errMsg = (e) =>
  String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function ago(ts) {
  if (!ts) return 'Never used';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'Used just now';
  if (m < 60) return `Used ${m} min ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `Used ${hr} h ago`;
  return `Used ${Math.floor(hr / 24)} d ago`;
}

// ---------------------------------------------------------------- modal

function closeModal() {
  modalEl.classList.remove('open');
  modalEl.replaceChildren();
}
function openModal(content) {
  modalEl.replaceChildren(content);
  modalEl.classList.add('open');
  const first = content.querySelector('input, textarea, select');
  if (first) first.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalEl.classList.contains('open')) closeModal();
});

function notice(title, message) {
  return new Promise((resolve) => {
    const done = () => { closeModal(); resolve(); };
    openModal(h('div', { class: 'dlg' }, h('h3', {}, title), h('p', { class: 'note' }, message),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: done }, 'OK'))));
  });
}

function confirmBox({ title, message, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const finish = (v) => { closeModal(); resolve(v); };
    openModal(h('div', { class: 'dlg' }, h('h3', {}, title), h('p', { class: 'note' }, message),
      h('div', { class: 'row' },
        h('button', { onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: danger ? 'danger' : 'primary', onclick: () => finish(true) }, ok))));
  });
}

function askText({ title, label, type = 'text', ok = 'OK', note = '', minLength = 0 }) {
  return new Promise((resolve) => {
    const err = h('p', { class: 'error' });
    const input = h('input', { class: 'input', type, autocomplete: 'off' });
    const finish = (v) => { closeModal(); resolve(v); };
    const submit = () => {
      if (input.value.length < minLength) { err.textContent = `At least ${minLength} characters.`; return; }
      finish(input.value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    openModal(h('div', { class: 'dlg' }, h('h3', {}, title),
      h('label', { class: 'field' }, h('span', {}, label), input),
      note && h('p', { class: 'note' }, note), err,
      h('div', { class: 'row' }, h('button', { onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'primary', onclick: submit }, ok))));
  });
}

// ---------------------------------------------------------------- panels

function closePanel() {
  currentPanel = null;
  panelEl.classList.remove('open');
  panelEl.replaceChildren();
  closeModal();
  window.bsb.ui.panel(false);
}
window.closePanel = closePanel;

function openPanel(name, build) {
  closeModal();
  currentPanel = { name, refresh: null };
  panelEl.classList.add('open');
  window.bsb.ui.panel(true);
  currentPanel.refresh = build();
}

window.onStateChange = () => {
  if (currentPanel && currentPanel.name === 'containers' && currentPanel.refresh && !modalEl.classList.contains('open')) {
    currentPanel.refresh();
  }
};

function panelHead(title, ...controls) {
  return h('div', { class: 'phead' }, h('h2', {}, title), h('div', { class: 'spacer' }), ...controls,
    h('button', { class: 'ghost', 'aria-label': 'Close panel', onclick: closePanel }, '✕ Close'));
}

// ---------------------------------------------------------------- containers

const EMOJIS = ['🔵', '🟢', '🟣', '🟠', '🔴', '🟡', '⚫', '🩵', '🏢', '🛒', '📣', '💼', '🎯', '⭐'];
const COLORS = ['#2563ff', '#16a34a', '#9333ea', '#f97316', '#e11d48', '#0891b2', '#eab308'];

function containerForm(existing) {
  const sample = existing || { name: '', description: '', color: COLORS[state.containers.length % COLORS.length], emoji: EMOJIS[state.containers.length % 6], pinned: false };
  let emoji = sample.emoji;
  const name = h('input', { class: 'input', value: sample.name, placeholder: 'e.g. Client A', maxlength: 60 });
  const desc = h('input', { class: 'input', value: sample.description, placeholder: 'Optional', maxlength: 200 });
  const color = h('input', { type: 'color', value: sample.color, 'aria-label': 'Container color', style: 'width:60px;height:34px;padding:2px;' });
  const pinned = h('input', { type: 'checkbox', checked: sample.pinned });
  const err = h('p', { class: 'error' });
  const swatches = h('div', { class: 'swatches' });
  const paint = () => {
    swatches.replaceChildren(...EMOJIS.map((e) =>
      h('button', { class: e === emoji ? 'sel' : '', type: 'button', onclick: () => { emoji = e; paint(); } }, e)));
  };
  paint();
  const save = async () => {
    try {
      const data = { name: name.value, description: desc.value, color: color.value, emoji, pinned: pinned.checked };
      if (existing) await window.bsb.containers.update(existing.id, data);
      else await window.bsb.containers.create(data);
      closeModal();
    } catch (e) { err.textContent = errMsg(e); }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  openModal(h('div', { class: 'dlg' }, h('h3', {}, existing ? 'Edit container' : 'New container'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), name),
    h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
    h('div', { class: 'field' }, h('span', { class: 'note' }, 'Icon'), swatches),
    h('label', { class: 'field' }, h('span', {}, 'Color'), color),
    h('label', { class: 'check' }, pinned, 'Pin to top'),
    h('p', { class: 'note' }, 'Each container has its own cookies, logins, local storage and cache, separate from every other container.'),
    err,
    h('div', { class: 'row' }, h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', onclick: save }, existing ? 'Save' : 'Create'))));
}

function proxyForm(c) {
  const p = c.proxy || { enabled: false, scheme: 'socks5', host: '', port: 1080, strict: true };
  const enabled = h('input', { type: 'checkbox', checked: p.enabled });
  const scheme = h('select', { class: 'input' },
    ['socks5', 'http', 'https'].map((s) => h('option', { value: s }, s === 'socks5' ? 'SOCKS5' : s.toUpperCase())));
  scheme.value = p.scheme;
  const host = h('input', { class: 'input', value: p.host, placeholder: 'proxy.example.com' });
  const port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: p.port });
  const strict = h('input', { type: 'checkbox', checked: p.strict });
  const err = h('p', { class: 'error' });
  const save = async () => {
    try {
      await window.bsb.containers.setProxy(c.id, {
        enabled: enabled.checked, scheme: scheme.value, host: host.value, port: Number(port.value), strict: strict.checked,
      });
      closeModal();
    } catch (e) { err.textContent = errMsg(e); }
  };
  openModal(h('div', { class: 'dlg' }, h('h3', {}, `Network route: ${c.emoji} ${c.name}`),
    h('label', { class: 'check' }, enabled, 'Use a proxy for this container'),
    h('div', { class: 'twocol' },
      h('label', { class: 'field' }, h('span', {}, 'Type'), scheme),
      h('label', { class: 'field' }, h('span', {}, 'Port'), port)),
    h('label', { class: 'field' }, h('span', {}, 'Host'), host),
    h('label', { class: 'check' }, strict, 'Strict: never fall back to a direct connection'),
    h('p', { class: 'note' },
      'If the proxy is unreachable, pages in this container fail to load instead of connecting directly. ' +
      'Proxy username/password login is not supported yet. Containers do not get a different IP address by themselves; ' +
      'that needs a separate proxy for each container. A proxy does not make you anonymous and does not stop websites from ' +
      'linking your sessions. Connection status is shown as "configured": live connectivity checks are not built yet.'),
    err,
    h('div', { class: 'row' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, 'Save'))));
}

function containerCard(c) {
  const tabCount = state.tabs.filter((t) => t.containerId === c.id).length;
  const route = c.proxy
    ? h('span', { class: 'badge ok' }, `${c.proxy.scheme.toUpperCase()} proxy ${c.proxy.host}:${c.proxy.port}${c.proxy.strict ? ' · strict' : ''} · configured`)
    : h('span', { class: 'badge' }, 'Direct connection (your own IP)');
  const act = (label, fn, cls = '') => h('button', { class: cls, onclick: fn }, label);
  return h('div', { class: 'card', style: `--c:${c.color}` },
    h('h3', {}, h('span', { class: 'emoji' }, c.emoji), c.name, c.pinned ? h('span', { title: 'Pinned' }, '📌') : null),
    h('div', { class: 'desc' }, c.description),
    h('div', {}, route),
    h('div', { class: 'meta' }, `${ago(c.lastUsedAt)}${tabCount ? ` · ${tabCount} open tab${tabCount > 1 ? 's' : ''}` : ''}`),
    h('div', { class: 'actions' },
      act('Open', async () => { await window.bsb.tabs.open(c.id); closePanel(); $('url').focus(); }, 'primary'),
      tabCount ? act('Close tabs', () => state.tabs.filter((t) => t.containerId === c.id).forEach((t) => window.bsb.tabs.close(t.id))) : null,
      act('Edit', () => containerForm(c)),
      act('Network', () => proxyForm(c)),
      act(c.pinned ? 'Unpin' : 'Pin', () => window.bsb.containers.update(c.id, { pinned: !c.pinned })),
      act('Duplicate', () => window.bsb.containers.duplicate(c.id)),
      act('Clear data', async () => {
        const ok = await confirmBox({ title: `Clear data for “${c.name}”?`, ok: 'Clear data', danger: true,
          message: 'Cookies, logins, site storage and cache for this container are deleted. You will be signed out of every site in it. Other containers are not affected.' });
        if (ok) { await window.bsb.containers.clearData(c.id); await notice('Done', 'Browsing data for this container was cleared.'); }
      }),
      act('Delete', async () => {
        const ok = await confirmBox({ title: `Delete “${c.name}”?`, ok: 'Delete container', danger: true,
          message: 'Its tabs are closed and all its browsing data is erased. Saved passwords for this container are removed too if the password vault is unlocked. This cannot be undone.' });
        if (ok) await window.bsb.containers.remove(c.id);
      }, 'danger')));
}

function showContainers() {
  openPanel('containers', () => {
    let search = '';
    let sort = 'lastUsed';
    const list = h('div', { class: 'pbody' });
    const refresh = async () => {
      const items = await window.bsb.containers.list({ search, sort });
      list.replaceChildren(items.length
        ? h('div', { class: 'grid' }, items.map(containerCard))
        : h('div', { class: 'empty' }, search ? 'No containers match your search.' : 'No containers yet. Create one to get started.'));
    };
    const s = h('input', { class: 'input sm', placeholder: 'Search containers', 'aria-label': 'Search containers' });
    s.addEventListener('input', () => { search = s.value; refresh(); });
    const o = h('select', { 'aria-label': 'Sort containers' },
      h('option', { value: 'lastUsed' }, 'Last used'), h('option', { value: 'name' }, 'Name'), h('option', { value: 'created' }, 'Newest'));
    o.addEventListener('change', () => { sort = o.value; refresh(); });
    panelEl.replaceChildren(
      panelHead('🧩 Containers', s, o, h('button', { class: 'primary', onclick: () => containerForm(null) }, '+ New container')),
      list);
    refresh();
    return refresh;
  });
}

// ---------------------------------------------------------------- vault

const originOfInput = (raw) => {
  const t = raw.trim();
  if (!t) throw new Error('Website is required');
  const u = new URL(t.includes('://') ? t : `https://${t}`);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https websites are supported');
  return u.origin;
};

function entryForm(existing, containers, done) {
  const cont = h('select', { class: 'input' }, containers.map((c) => h('option', { value: c.id }, `${c.emoji} ${c.name}`)));
  if (existing) cont.value = existing.containerId;
  const site = h('input', { class: 'input', value: existing ? existing.origin : '', placeholder: 'https://example.com', disabled: !!existing });
  const user = h('input', { class: 'input', value: existing ? existing.username : '', autocomplete: 'off' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: existing ? 'Leave empty to keep the current password' : '' });
  const share = h('input', { type: 'checkbox', checked: existing ? existing.allowAcrossContainers : false });
  const err = h('p', { class: 'error' });
  const save = async () => {
    try {
      if (existing) {
        const patch = { username: user.value, allowAcrossContainers: share.checked };
        if (pw.value) patch.password = pw.value;
        await window.bsb.vault.update(existing.id, patch);
      } else {
        if (!user.value || !pw.value) throw new Error('Username and password are required');
        await window.bsb.vault.add({ containerId: cont.value, origin: originOfInput(site.value), username: user.value, password: pw.value, allowAcrossContainers: share.checked });
      }
      closeModal();
      done();
    } catch (e) { err.textContent = errMsg(e); }
  };
  openModal(h('div', { class: 'dlg' }, h('h3', {}, existing ? 'Edit saved password' : 'Add saved password'),
    h('label', { class: 'field' }, h('span', {}, 'Container'), cont),
    h('label', { class: 'field' }, h('span', {}, 'Website (exact address)'), site),
    h('label', { class: 'field' }, h('span', {}, 'Username'), user),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
    h('label', { class: 'check' }, share, 'Allow use in other containers'),
    h('p', { class: 'note' }, 'Off by default. A password is only offered on the exact website address above (same protocol, host and port). Turn this on only if you really want other containers to use it.'),
    err,
    h('div', { class: 'row' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, 'Save'))));
}

function showVault() {
  openPanel('vault', () => {
    const render = async () => {
      let st;
      try { st = await window.bsb.vault.status(); } catch (e) { panelEl.replaceChildren(panelHead('🔑 Passwords'), h('div', { class: 'pbody' }, errMsg(e))); return; }
      if (!st.exists) return renderSetup();
      if (!st.unlocked) return renderUnlock(st.mode);
      return renderList();
    };

    function renderSetup() {
      let mode = 'os';
      const pw1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Master password (8+ characters)' });
      const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repeat master password' });
      const pwBox = h('div', { style: 'display:none' }, pw1, h('div', { style: 'height:8px' }), pw2);
      const err = h('p', { class: 'error' });
      const radio = (value, title, sub, checked) => h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'vmode', value, checked, onchange: () => { mode = value; pwBox.style.display = value === 'password' ? 'block' : 'none'; } }),
        ' ', h('b', {}, title), h('small', {}, sub));
      const create = async () => {
        try {
          if (mode === 'password' && pw1.value !== pw2.value) throw new Error('Passwords do not match');
          await window.bsb.vault.create(mode === 'password' ? pw1.value : undefined);
          render();
        } catch (e) { err.textContent = errMsg(e); }
      };
      panelEl.replaceChildren(panelHead('🔑 Passwords'), h('div', { class: 'pbody' }, h('div', { class: 'vcard' },
        h('h3', {}, 'Set up your password vault'),
        h('p', { class: 'note' }, 'Passwords are encrypted on this computer only. Nothing is uploaded and no account is needed.'),
        radio('os', 'Protect with my computer account (recommended)', 'Uses Windows or macOS secure storage. Unlocks automatically for you.', true),
        radio('password', 'Protect with a master password', 'You type it to unlock. If you forget it, the vault cannot be recovered; keep a backup.', false),
        pwBox, err,
        h('div', { class: 'row', style: 'margin-top:14px;display:flex;justify-content:flex-end' }, h('button', { class: 'primary', onclick: create }, 'Create vault')))));
    }

    function renderUnlock(mode) {
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Master password' });
      const err = h('p', { class: 'error' });
      const unlock = async () => {
        try { await window.bsb.vault.unlock(mode === 'password' ? pw.value : undefined); render(); }
        catch (e) { err.textContent = errMsg(e); }
      };
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
      panelEl.replaceChildren(panelHead('🔑 Passwords'), h('div', { class: 'pbody' }, h('div', { class: 'vcard' },
        h('h3', {}, '🔒 Vault is locked'),
        mode === 'password' ? h('label', { class: 'field' }, h('span', {}, 'Master password'), pw) : h('p', { class: 'note' }, 'Unlock with your computer account.'),
        err,
        h('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, h('button', { class: 'primary', onclick: unlock }, 'Unlock')))));
      if (mode === 'password') pw.focus();
    }

    async function renderList() {
      let search = '';
      let containerId = '';
      const body = h('div', { class: 'pbody' });
      const fill = async () => {
        let items;
        try { items = await window.bsb.vault.list({ search, containerId: containerId || undefined }); }
        catch { return render(); } // locked meanwhile (auto-lock)
        const nameOf = (id) => { const c = state.containers.find((x) => x.id === id); return c ? `${c.emoji} ${c.name}` : 'Deleted container'; };
        if (!items.length) { body.replaceChildren(h('div', { class: 'empty' }, search || containerId ? 'Nothing matches.' : 'No saved passwords yet. Use “+ Add” to save one.')); return; }
        body.replaceChildren(h('table', {},
          h('thead', {}, h('tr', {}, ['Website', 'Username', 'Container', 'Password', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, items.map((e) => {
            const pwCell = h('td', { class: 'pw' }, '••••••••');
            let timer = null;
            const showBtn = h('button', { onclick: async () => {
              if (timer) { clearTimeout(timer); timer = null; pwCell.textContent = '••••••••'; showBtn.textContent = 'Show'; return; }
              try {
                pwCell.textContent = await window.bsb.vault.reveal(e.id);
                showBtn.textContent = 'Hide';
                timer = setTimeout(() => { timer = null; pwCell.textContent = '••••••••'; showBtn.textContent = 'Show'; }, 10000);
              } catch (er) { pwCell.textContent = errMsg(er); }
            } }, 'Show');
            return h('tr', {},
              h('td', {}, e.origin, e.allowAcrossContainers ? h('div', {}, h('span', { class: 'badge warn' }, 'shared across containers')) : null),
              h('td', {}, e.username), h('td', {}, nameOf(e.containerId)), pwCell,
              h('td', { style: 'white-space:nowrap' }, showBtn, ' ',
                h('button', { onclick: () => entryForm(e, state.containers, fill) }, 'Edit'), ' ',
                h('button', { class: 'danger', onclick: async () => {
                  const ok = await confirmBox({ title: 'Delete saved password?', ok: 'Delete', danger: true,
                    message: `The saved login “${e.username}” for ${e.origin} will be permanently deleted from this vault. This cannot be undone (unless you have a backup).` });
                  if (ok) { await window.bsb.vault.remove(e.id); fill(); }
                } }, 'Delete')));
          }))));
      };
      const s = h('input', { class: 'input sm', placeholder: 'Search website or username', 'aria-label': 'Search saved passwords' });
      s.addEventListener('input', () => { search = s.value; fill(); });
      const f = h('select', { 'aria-label': 'Filter by container' }, h('option', { value: '' }, 'All containers'),
        state.containers.map((c) => h('option', { value: c.id }, `${c.emoji} ${c.name}`)));
      f.addEventListener('change', () => { containerId = f.value; fill(); });
      const backup = async () => {
        const pw = await askText({ title: 'Export encrypted backup', label: 'Backup password', type: 'password', ok: 'Choose file…', minLength: 8,
          note: 'The backup is encrypted with this password, separate from your vault protection. You need it to restore.' });
        if (!pw) return;
        try { const p = await window.bsb.vault.exportBackupFile(pw); if (p) await notice('Backup saved', p); }
        catch (e) { await notice('Backup failed', errMsg(e)); }
      };
      const restore = async () => {
        const pw = await askText({ title: 'Restore from backup', label: 'Backup password', type: 'password', ok: 'Choose file…',
          note: 'Entries from the backup are added. Existing entries are kept as they are.' });
        if (!pw) return;
        try { const n = await window.bsb.vault.importBackupFile(pw); if (n !== null) { await notice('Restore complete', `${n} password${n === 1 ? '' : 's'} added.`); fill(); } }
        catch (e) { await notice('Restore failed', errMsg(e)); }
      };
      panelEl.replaceChildren(
        panelHead('🔑 Passwords', s, f,
          h('button', { class: 'primary', onclick: () => entryForm(null, state.containers, fill) }, '+ Add'),
          h('button', { onclick: backup }, 'Backup'), h('button', { onclick: restore }, 'Restore'),
          h('button', { onclick: async () => { await window.bsb.vault.lock(); render(); } }, '🔒 Lock')),
        body);
      fill();
    }

    vaultRender = render;
    render();
    return null;
  });
}

// Registered once. Fires when the vault auto-locks; the open vault panel switches to the unlock screen.
let vaultRender = null;
window.bsb.vault.onLocked(() => {
  if (currentPanel && currentPanel.name === 'vault' && vaultRender) { closeModal(); vaultRender(); }
});

$('btn-containers').onclick = () => (currentPanel && currentPanel.name === 'containers' ? closePanel() : showContainers());
$('btn-vault').onclick = () => (currentPanel && currentPanel.name === 'vault' ? closePanel() : showVault());
