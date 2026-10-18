import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContainerStore } from '../../src/main/containers';
import { buildElectronProxy, validateProxy } from '../../src/main/network';
import { isAllowedNavigation, normalizeInput, originOf } from '../../src/main/url';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsb-'));
  return new ContainerStore(path.join(dir, 'containers.json'));
}

test('each container gets a unique persistent partition', () => {
  const s = tmpStore();
  const a = s.create({ name: 'Client A' });
  const b = s.create({ name: 'Client B' });
  assert.notEqual(a.partition, b.partition);
  assert.ok(a.partition.startsWith('persist:container-'));
});

test('duplicate copies config but gets a new partition', () => {
  const s = tmpStore();
  const a = s.create({ name: 'Client A', color: '#00aa55', emoji: '🟢' });
  const d = s.duplicate(a.id);
  assert.equal(d.color, a.color);
  assert.notEqual(d.partition, a.partition);
});

test('create, rename, pin, search, delete', () => {
  const s = tmpStore();
  const a = s.create({ name: 'Alpha' });
  s.create({ name: 'Beta' });
  s.update(a.id, { name: 'Alpha Renamed', pinned: true });
  assert.equal(s.list()[0].name, 'Alpha Renamed');
  assert.equal(s.list({ search: 'beta' }).length, 1);
  s.remove(a.id);
  assert.equal(s.get(a.id), undefined);
  assert.throws(() => s.create({ name: '  ' }));
});

test('store persists to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsb-'));
  const file = path.join(dir, 'c.json');
  new ContainerStore(file).create({ name: 'Persisted' });
  assert.equal(new ContainerStore(file).list()[0].name, 'Persisted');
});

test('proxy rules never include a direct fallback', () => {
  const cfg = buildElectronProxy({ enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, strict: true });
  assert.equal(cfg.mode, 'fixed_servers');
  assert.equal(cfg.proxyRules, 'socks5://1.2.3.4:1080');
  assert.ok(!cfg.proxyRules!.includes('direct'));
});

test('disabled proxy is direct, invalid proxy rejected', () => {
  assert.equal(buildElectronProxy({ enabled: false, scheme: 'http', host: '', port: 0, strict: false }).mode, 'direct');
  assert.ok(validateProxy({ enabled: true, scheme: 'http', host: '', port: 80, strict: false }));
  assert.ok(validateProxy({ enabled: true, scheme: 'http', host: 'x', port: 70000, strict: false }));
});

test('address bar input', () => {
  assert.equal(normalizeInput('example.com'), 'https://example.com');
  assert.equal(normalizeInput('localhost:3000'), 'http://localhost:3000');
  assert.ok(normalizeInput('best crm tools').startsWith('https://duckduckgo.com/?q='));
});

test('navigation allows only http(s)', () => {
  assert.ok(isAllowedNavigation('https://example.com'));
  assert.ok(!isAllowedNavigation('file:///etc/passwd'));
  assert.ok(!isAllowedNavigation('javascript:alert(1)'));
  assert.equal(originOf('https://a.com:8443/x'), 'https://a.com:8443');
});
