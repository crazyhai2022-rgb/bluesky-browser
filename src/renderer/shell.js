/* Browser chrome: tabs, address bar, container picker. Panels live in panels.js. No Node access here. */
const $ = (id) => document.getElementById(id);
let state = { containers: [], tabs: [], activeTabId: null };

window.bsb.onState((s) => {
  state = s;
  render();
  if (typeof window.onStateChange === 'function') window.onStateChange();
});

function render() {
  const cont = $('cont');
  const selected = cont.value;
  cont.replaceChildren();
  for (const c of state.containers) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.emoji} ${c.name}`;
    cont.appendChild(o);
  }
  if (selected && state.containers.some((c) => c.id === selected)) cont.value = selected;

  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const t of state.tabs) {
    const c = state.containers.find((x) => x.id === t.containerId);
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeTabId ? ' active' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.id === state.activeTabId));
    el.style.setProperty('--c', c ? c.color : '#2563ff');
    el.title = c ? `${c.name}: ${t.title}` : t.title;
    el.textContent = `${c ? c.emoji : ''} ${t.title}`;
    el.onclick = () => { if (window.closePanel) window.closePanel(); window.bsb.tabs.activate(t.id); };
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = ' ✕';
    x.setAttribute('aria-label', 'Close tab');
    x.onclick = (e) => { e.stopPropagation(); window.bsb.tabs.close(t.id); };
    el.appendChild(x);
    tabs.appendChild(el);
  }
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active && document.activeElement !== $('url')) $('url').value = active.url;
}

function go(input) {
  if (window.closePanel) window.closePanel();
  if (state.activeTabId === null) window.bsb.tabs.open($('cont').value, input);
  else window.bsb.nav.go(input);
}

$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') go($('url').value); });
$('back').onclick = () => window.bsb.nav.back();
$('fwd').onclick = () => window.bsb.nav.forward();
$('reload').onclick = () => window.bsb.nav.reload();
$('newtab').onclick = async () => {
  await window.bsb.tabs.open($('cont').value);
  if (window.closePanel) window.closePanel();
  $('url').focus();
};
