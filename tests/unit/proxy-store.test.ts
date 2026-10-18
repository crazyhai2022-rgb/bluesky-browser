import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContainerStore } from '../../src/main/containers';
import { buildElectronProxy, validateProxy, ProxyConfig } from '../../src/main/network';

const base: ProxyConfig = { enabled: true, scheme: 'socks5', host: 'proxy.example.net', port: 1080, strict: true };

test('proxy host cannot smuggle extra rules such as a direct fallback', () => {
  for (const host of [
    '1.2.3.4:80,direct://',
    'proxy.example.net;direct://',
    'a.com/path',
    'a.com b.com',
    'a.com,socks5://other',
    '',
    '-bad.com',
  ]) {
    assert.ok(validateProxy({ ...base, host }), `should reject: ${host}`);
    assert.throws(() => buildElectronProxy({ ...base, host }));
  }
});

test('valid hosts are accepted (hostname, IPv4, bracketed IPv6)', () => {
  for (const host of ['proxy.example.net', '10.0.0.5', 'localhost', '[2001:db8::1]']) {
    assert.equal(validateProxy({ ...base, host }), null, host);
  }
  assert.equal(buildElectronProxy({ ...base, host: ' 10.0.0.5 ' }).proxyRules, 'socks5://10.0.0.5:1080');
});

test('proxy config persists per container and is copied by duplicate (config only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsb-px-'));
  const file = path.join(dir, 'c.json');
  const s = new ContainerStore(file);
  const a = s.create({ name: 'Client A' });
  const b = s.create({ name: 'Client B' });
  s.setProxy(a.id, base);

  const reopened = new ContainerStore(file);
  assert.deepEqual(reopened.get(a.id)!.proxy, base);
  assert.equal(reopened.get(b.id)!.proxy, null); // other containers are unaffected

  const copy = reopened.duplicate(a.id);
  assert.deepEqual(copy.proxy, base);
  assert.notEqual(copy.partition, a.partition);

  reopened.setProxy(a.id, { ...base, enabled: false });
  assert.equal(reopened.get(a.id)!.proxy, null);
});

test('containers saved before proxy support load with proxy = null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsb-px-'));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(
    file,
    JSON.stringify([{ id: 'x', name: 'Old', color: '#fff', emoji: '🔵', description: '', pinned: false, createdAt: 1, lastUsedAt: null, partition: 'persist:container-x' }]),
  );
  assert.equal(new ContainerStore(file).get('x')!.proxy, null);
});
