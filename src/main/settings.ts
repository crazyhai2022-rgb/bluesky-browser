// App settings: schema, validation and a small JSON store. Pure (no Electron), unit tested.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PermDefault = 'ask' | 'allow' | 'block';
const PERM_VALUES = ['ask', 'allow', 'block'] as const;

/** %s is replaced by the encoded search text. */
export const SEARCH_ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { label: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
} as const;
export type SearchEngineId = keyof typeof SEARCH_ENGINES;
const ENGINE_IDS = Object.keys(SEARCH_ENGINES) as SearchEngineId[];

export const ZOOM_CHOICES = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;
export const AUTOLOCK_CHOICES = [1, 2, 5, 10, 15, 30, 60] as const;

export interface Settings {
  // General
  searchEngine: SearchEngineId;
  homepage: string; // '' = blank new tab
  restoreTabs: boolean;
  zoomPercent: number;
  spellcheck: boolean;
  // Blocking and privacy
  blockAds: boolean;
  blockTrackers: boolean;
  blockYouTubeAds: boolean;
  blockThirdPartyCookies: boolean;
  httpsFirst: boolean;
  blockPopups: boolean;
  sendDoNotTrack: boolean; // sends DNT and Sec-GPC headers
  limitWebRtc: boolean; // do not expose local network addresses through WebRTC
  // Site permission defaults
  permissions: { camera: PermDefault; microphone: PermDefault; location: PermDefault; notifications: PermDefault };
  // Password vault
  vaultAutoLockMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'duckduckgo',
  homepage: '',
  restoreTabs: false,
  zoomPercent: 100,
  spellcheck: true,
  blockAds: true,
  blockTrackers: true,
  blockYouTubeAds: true,
  blockThirdPartyCookies: false, // can break logins that use another domain, so it is opt-in
  httpsFirst: true,
  blockPopups: true,
  sendDoNotTrack: true,
  limitWebRtc: true,
  permissions: { camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'block' },
  vaultAutoLockMinutes: 5,
};

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const nearest = (v: unknown, choices: readonly number[], d: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  return choices.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), choices[0]);
};

export function normalizeHomepage(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/** Builds a complete, safe Settings object. Unknown keys are dropped, bad values fall back to `base`. */
export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const p = (i.permissions && typeof i.permissions === 'object' ? i.permissions : {}) as Record<string, unknown>;
  return {
    searchEngine: oneOf(i.searchEngine, ENGINE_IDS, base.searchEngine),
    homepage: 'homepage' in i ? normalizeHomepage(i.homepage) : base.homepage,
    restoreTabs: bool(i.restoreTabs, base.restoreTabs),
    zoomPercent: nearest(i.zoomPercent, ZOOM_CHOICES, base.zoomPercent),
    spellcheck: bool(i.spellcheck, base.spellcheck),
    blockAds: bool(i.blockAds, base.blockAds),
    blockTrackers: bool(i.blockTrackers, base.blockTrackers),
    blockYouTubeAds: bool(i.blockYouTubeAds, base.blockYouTubeAds),
    blockThirdPartyCookies: bool(i.blockThirdPartyCookies, base.blockThirdPartyCookies),
    httpsFirst: bool(i.httpsFirst, base.httpsFirst),
    blockPopups: bool(i.blockPopups, base.blockPopups),
    sendDoNotTrack: bool(i.sendDoNotTrack, base.sendDoNotTrack),
    limitWebRtc: bool(i.limitWebRtc, base.limitWebRtc),
    permissions: {
      camera: oneOf(p.camera, PERM_VALUES, base.permissions.camera),
      microphone: oneOf(p.microphone, PERM_VALUES, base.permissions.microphone),
      location: oneOf(p.location, PERM_VALUES, base.permissions.location),
      notifications: oneOf(p.notifications, PERM_VALUES, base.permissions.notifications),
    },
    vaultAutoLockMinutes: nearest(i.vaultAutoLockMinutes, AUTOLOCK_CHOICES, base.vaultAutoLockMinutes),
  };
}

export class SettingsStore {
  private cur: Settings = DEFAULT_SETTINGS;

  constructor(private readonly file: string) {
    try {
      this.cur = sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      this.cur = DEFAULT_SETTINGS;
    }
  }

  get(): Settings {
    return this.cur;
  }

  /** Applies a partial change. Anything invalid is ignored, so a bad value can never corrupt the settings. */
  set(patch: unknown): Settings {
    const pr = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const permPatch = pr.permissions && typeof pr.permissions === 'object' ? (pr.permissions as object) : {};
    this.cur = sanitizeSettings({ ...this.cur, ...pr, permissions: { ...this.cur.permissions, ...permPatch } }, this.cur);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cur, null, 2));
    return this.cur;
  }
}
