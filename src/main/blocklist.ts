// Request classification for ad / tracker / YouTube-ad blocking. Pure and unit tested.
//
// This is a small built-in domain list, not a full filter-list engine like uBlock Origin. It blocks the
// biggest ad and tracking networks; it will not catch everything, and YouTube changes its ads often.
// Domains used for managing ads (ads.google.com, analytics.google.com, business.facebook.com, ...) are
// deliberately NOT listed, so ad-management consoles keep working.

export type BlockReason = 'ad' | 'tracker' | 'youtube-ad';

const AD_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'adnxs.com', 'adsrvr.org', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com', 'amazon-adsystem.com',
  'moatads.com', 'advertising.com', 'adform.net', 'smartadserver.com', 'media.net', 'revcontent.com',
  'mgid.com', 'popads.net', 'popcash.net', 'propellerads.com', 'exoclick.com', 'juicyads.com',
];

const TRACKER_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'hotjar.com', 'hotjar.io', 'mixpanel.com',
  'api.segment.io', 'cdn.segment.com', 'api.amplitude.com', 'fullstory.com', 'mouseflow.com',
  'crazyegg.com', 'scorecardresearch.com', 'quantserve.com', 'chartbeat.com', 'nr-data.net',
  'clarity.ms', 'bat.bing.com', 'px.ads.linkedin.com', 'analytics.tiktok.com', 'ads-twitter.com',
  'static.ads-twitter.com', 'analytics.twitter.com',
];

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const inList = (host: string, list: string[]): boolean => list.some((d) => hostMatches(host, d));

export interface BlockOptions {
  ads: boolean;
  trackers: boolean;
  youtubeAds: boolean;
}

export function classify(url: string, opts: BlockOptions): BlockReason | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
  const host = u.hostname.toLowerCase();
  const p = u.pathname;

  if (opts.youtubeAds && (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtube-nocookie.com'))) {
    if (
      p.startsWith('/pagead/') || p.startsWith('/api/stats/ads') || p.startsWith('/ptracking') ||
      p.startsWith('/youtubei/v1/player/ad_break') || p.includes('/get_midroll_')
    ) return 'youtube-ad';
  }
  if (opts.youtubeAds && (host === 'googleads.g.doubleclick.net' || host === 'static.doubleclick.net')) return 'youtube-ad';

  if (opts.ads && inList(host, AD_DOMAINS)) return 'ad';

  if (opts.trackers) {
    if (inList(host, TRACKER_DOMAINS)) return 'tracker';
    // Meta Pixel: only the pixel hit and script, never the rest of facebook.com.
    if ((host === 'www.facebook.com' || host === 'facebook.com') && (p === '/tr' || p.startsWith('/tr/'))) return 'tracker';
    if (host === 'connect.facebook.net' && p.endsWith('/fbevents.js')) return 'tracker';
  }
  return null;
}

// ---- third-party detection (for the third-party cookie option) ----

const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in',
  'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'com.cn', 'com.tr', 'co.za', 'co.nz', 'com.sg', 'com.hk',
]);

/** Approximate registrable domain (eTLD+1). Good enough for first/third-party checks, not a full public suffix list. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function isThirdParty(requestUrl: string, pageUrl: string): boolean {
  try {
    const a = new URL(requestUrl);
    const b = new URL(pageUrl);
    if (!/^https?:$/.test(b.protocol)) return false;
    return registrableDomain(a.hostname) !== registrableDomain(b.hostname);
  } catch {
    return false;
  }
}

/** HTTPS-first: upgrade plain http page loads, except local/private addresses and single-label hosts. */
export function shouldUpgradeToHttps(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    if (!h.includes('.')) return false; // localhost, intranet names
    if (h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.test') || h.endsWith('.internal')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return false; // IP literals
    return true;
  } catch {
    return false;
  }
}
