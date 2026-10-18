import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings, normalizeHomepage, SEARCH_ENGINES } from '../../src/main/settings';
import { classify, isThirdParty, registrableDomain, shouldUpgradeToHttps } from '../../src/main/blocklist';
import { PermissionStore, combine, kindsOf } from '../../src/main/permissions';

const tmp = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bsb-set-')), name);
const ALL = { ads: true, trackers: true, youtubeAds: true };
const NONE = { ads: false, trackers: false, youtubeAds: false };

// ---------------------------------------------------------------- settings

test('defaults: ad/tracker/YouTube blocking on, third-party cookie blocking off, notifications blocked', () => {
  assert.equal(DEFAULT_SETTINGS.blockAds, true);
  assert.equal(DEFAULT_SETTINGS.blockYouTubeAds, true);
  assert.equal(DEFAULT_SETTINGS.blockThirdPartyCookies, false);
  assert.equal(DEFAULT_SETTINGS.permissions.notifications, 'block');
});

test('sanitize drops unknown keys and falls back on invalid values', () => {
  const s = sanitizeSettings({ blockAds: 'yes', searchEngine: 'evil', zoomPercent: 'big', hack: 1, permissions: { camera: 'maybe', microphone: 'allow' } });
  assert.equal(s.blockAds, DEFAULT_SETTINGS.blockAds);
  assert.equal(s.searchEngine, 'duckduckgo');
  assert.equal(s.zoomPercent, 100);
  assert.equal(s.permissions.camera, 'ask');
  assert.equal(s.permissions.microphone, 'allow');
  assert.ok(!('hack' in s));
});

test('zoom and auto-lock snap to the nearest allowed choice', () => {
  assert.equal(sanitizeSettings({ zoomPercent: 500 }).zoomPercent, 200);
  assert.equal(sanitizeSettings({ zoomPercent: 1 }).zoomPercent, 50);
  assert.equal(sanitizeSettings({ vaultAutoLockMinutes: 7 }).vaultAutoLockMinutes, 5);
});

test('homepage accepts only http(s) and normalizes bare domains', () => {
  assert.equal(normalizeHomepage('example.com'), 'https://example.com/');
  assert.equal(normalizeHomepage('javascript:alert(1)'), '');
  assert.equal(normalizeHomepage('file:///etc/passwd'), '');
  assert.equal(normalizeHomepage(''), '');
});

test('every search engine has a %s placeholder', () => {
  for (const e of Object.values(SEARCH_ENGINES)) assert.ok(e.url.includes('%s') && e.url.startsWith('https://'));
});

test('settings store saves partial changes and reloads them', () => {
  const f = tmp('settings.json');
  const s = new SettingsStore(f);
  s.set({ blockYouTubeAds: false, permissions: { camera: 'block' }, zoomPercent: 125 });
  const again = new SettingsStore(f).get();
  assert.equal(again.blockYouTubeAds, false);
  assert.equal(again.permissions.camera, 'block');
  assert.equal(again.permissions.microphone, 'ask'); // untouched
  assert.equal(again.zoomPercent, 125);
  assert.equal(again.blockAds, true); // untouched
  s.set({ blockAds: 'garbage' }); // ignored
  assert.equal(s.get().blockAds, true);
});

test('corrupt settings file falls back to defaults', () => {
  const f = tmp('settings.json');
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(new SettingsStore(f).get(), DEFAULT_SETTINGS);
});

// ---------------------------------------------------------------- blocklist

test('ad networks and trackers are blocked, lookalike hosts are not', () => {
  assert.equal(classify('https://securepubads.g.doubleclick.net/gampad/ads', ALL), 'ad');
  assert.equal(classify('https://www.google-analytics.com/collect', ALL), 'tracker');
  assert.equal(classify('https://notdoubleclick.net/x', ALL), null);
  assert.equal(classify('https://doubleclick.net.evil.io/x', ALL), null);
});

test('options switch each category off independently', () => {
  assert.equal(classify('https://ad.doubleclick.net/x', NONE), null);
  assert.equal(classify('https://www.google-analytics.com/collect', { ...ALL, trackers: false }), null);
  assert.equal(classify('https://ad.doubleclick.net/x', { ...ALL, ads: false, youtubeAds: false }), null);
});

test('ad-management and normal sites are never blocked', () => {
  for (const u of [
    'https://ads.google.com/aw/campaigns', 'https://analytics.google.com/analytics/web/', 'https://business.facebook.com/adsmanager',
    'https://www.facebook.com/ads/manager', 'https://www.youtube.com/watch?v=abc', 'https://example.com/', 'https://tagmanager.google.com/',
  ]) assert.equal(classify(u, ALL), null, u);
});

test('Meta Pixel hit and script are trackers, rest of facebook.com is untouched', () => {
  assert.equal(classify('https://www.facebook.com/tr?id=123&ev=PageView', ALL), 'tracker');
  assert.equal(classify('https://connect.facebook.net/en_US/fbevents.js', ALL), 'tracker');
  assert.equal(classify('https://connect.facebook.net/en_US/sdk.js', ALL), null);
  assert.equal(classify('https://www.facebook.com/trending', ALL), null);
});

test('YouTube ad requests are blocked only when that option is on', () => {
  assert.equal(classify('https://www.youtube.com/pagead/adview?x=1', ALL), 'youtube-ad');
  assert.equal(classify('https://www.youtube.com/api/stats/ads?x=1', ALL), 'youtube-ad');
  assert.equal(classify('https://www.youtube.com/pagead/adview?x=1', { ...ALL, youtubeAds: false }), null);
  assert.equal(classify('https://www.youtube.com/youtubei/v1/player', ALL), null);
  assert.equal(classify('https://rr1---sn-x.googlevideo.com/videoplayback', ALL), null);
});

test('registrable domain and third-party checks', () => {
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(isThirdParty('https://cdn.example.com/a.js', 'https://www.example.com/'), false);
  assert.equal(isThirdParty('https://tracker.net/p', 'https://www.example.com/'), true);
  assert.equal(isThirdParty('https://other.co.uk/p', 'https://example.co.uk/'), true);
  assert.equal(isThirdParty('https://x.com/p', 'about:blank'), false);
});

test('HTTPS-first upgrades public http sites but not local or IP addresses', () => {
  assert.equal(shouldUpgradeToHttps('http://example.com/a'), true);
  assert.equal(shouldUpgradeToHttps('https://example.com/a'), false);
  for (const u of ['http://localhost:3000/', 'http://127.0.0.1:8080/', 'http://192.168.1.5/', 'http://intranet/', 'http://printer.local/', 'http://[::1]:3000/'])
    assert.equal(shouldUpgradeToHttps(u), false, u);
});

// ---------------------------------------------------------------- permissions

const defs = { camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'block' } as const;

test('permission names map to kinds, unknown permissions are not ours', () => {
  assert.deepEqual(kindsOf('media', { mediaTypes: ['video'] }), ['camera']);
  assert.deepEqual(kindsOf('media', { mediaTypes: ['video', 'audio'] }), ['camera', 'microphone']);
  assert.deepEqual(kindsOf('media', { mediaType: 'audio' }), ['microphone']);
  assert.deepEqual(kindsOf('geolocation'), ['location']);
  assert.equal(kindsOf('clipboard-read'), null);
});

test('combine: block beats ask beats allow', () => {
  assert.equal(combine(['allow', 'allow']), 'allow');
  assert.equal(combine(['allow', 'ask']), 'ask');
  assert.equal(combine(['ask', 'block']), 'block');
});

test('remembered decisions are per container and per site', () => {
  const s = new PermissionStore(tmp('perm.json'));
  assert.equal(s.decide(defs, 'A', 'https://meet.example.com', 'camera'), 'ask');
  s.remember('A', 'https://meet.example.com', 'camera', 'allow');
  assert.equal(s.decide(defs, 'A', 'https://meet.example.com', 'camera'), 'allow');
  assert.equal(s.decide(defs, 'B', 'https://meet.example.com', 'camera'), 'ask'); // other container
  assert.equal(s.decide(defs, 'A', 'https://other.example.com', 'camera'), 'ask'); // other site
  assert.equal(s.decide(defs, 'A', 'https://meet.example.com', 'notifications'), 'block'); // default
});

test('remembered decisions persist and can be reset per container or all', () => {
  const f = tmp('perm.json');
  const s = new PermissionStore(f);
  s.remember('A', 'https://a.com', 'location', 'block');
  s.remember('B', 'https://b.com', 'location', 'allow');
  assert.equal(new PermissionStore(f).decide(defs, 'A', 'https://a.com', 'location'), 'block');
  assert.equal(s.reset('A'), 1);
  assert.equal(s.count(), 1);
  assert.equal(s.reset(), 1);
  assert.equal(new PermissionStore(f).count(), 0);
});
