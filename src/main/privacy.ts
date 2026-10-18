// Electron side of the privacy features: applies the settings to every container session and tab.
// Decision logic lives in blocklist.ts / permissions.ts / settings.ts (unit tested); this file only wires it up.
import type { Session, WebContents } from 'electron';
import { classify, isThirdParty, shouldUpgradeToHttps } from './blocklist';
import { PermissionStore, PermKind, combine, kindsOf } from './permissions';
import type { Settings } from './settings';
import { originOf } from './url';

export interface PrivacyStats {
  ads: number;
  trackers: number;
  youtubeAds: number;
  httpsUpgrades: number;
  popups: number;
  cookiesStripped: number;
  since: number;
}

export const stats: PrivacyStats = { ads: 0, trackers: 0, youtubeAds: 0, httpsUpgrades: 0, popups: 0, cookiesStripped: 0, since: Date.now() };

export interface PrivacyDeps {
  settings: () => Settings;
  perms: PermissionStore;
  strictProxy: (containerId: string) => boolean;
  ask: (containerId: string, origin: string, kinds: PermKind[]) => Promise<{ allow: boolean; remember: boolean }>;
}

const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const configured = new WeakSet<Session>();

function pageUrlOf(wc: WebContents | null | undefined): string {
  try {
    return wc && !wc.isDestroyed() ? wc.getURL() : '';
  } catch {
    return '';
  }
}

/** Sets up request blocking, headers, cookies and permission handling once per container session. */
export function applyPrivacy(ses: Session, containerId: string, deps: PrivacyDeps): void {
  if (configured.has(ses)) return;
  configured.add(ses);
  refreshSession(ses, deps);

  ses.webRequest.onBeforeRequest((details, cb) => {
    const s = deps.settings();
    if (s.httpsFirst && details.resourceType === 'mainFrame' && shouldUpgradeToHttps(details.url)) {
      stats.httpsUpgrades++;
      cb({ redirectURL: details.url.replace(/^http:/, 'https:') });
      return;
    }
    const why = classify(details.url, { ads: s.blockAds, trackers: s.blockTrackers, youtubeAds: s.blockYouTubeAds });
    if (why) {
      if (why === 'ad') stats.ads++;
      else if (why === 'tracker') stats.trackers++;
      else stats.youtubeAds++;
      cb({ cancel: true });
      return;
    }
    cb({});
  });

  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const s = deps.settings();
    const headers = { ...details.requestHeaders };
    if (s.sendDoNotTrack) {
      headers['DNT'] = '1';
      headers['Sec-GPC'] = '1';
    }
    if (s.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdParty(details.url, pageUrlOf(details.webContents))) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'cookie') delete headers[k];
    }
    cb({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived((details, cb) => {
    const s = deps.settings();
    if (s.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && details.responseHeaders && isThirdParty(details.url, pageUrlOf(details.webContents))) {
      const headers = { ...details.responseHeaders };
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'set-cookie') {
          delete headers[k];
          stats.cookiesStripped++;
        }
      }
      cb({ responseHeaders: headers });
      return;
    }
    cb({});
  });

  // Site permissions: remembered answer for this container + site, otherwise the default (ask / allow / block).
  const decide = (kinds: PermKind[], origin: string) =>
    combine(kinds.map((k) => deps.perms.decide(deps.settings().permissions, containerId, origin, k)));

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const kinds = kindsOf(permission, details as { mediaTypes?: string[] });
    if (!kinds) return callback(ALWAYS_ALLOW.has(permission));
    const origin = originOf(details.requestingUrl || pageUrlOf(wc));
    if (!origin) return callback(false);
    const d = decide(kinds, origin);
    if (d !== 'ask') return callback(d === 'allow');
    void deps.ask(containerId, origin, kinds).then(
      (res) => {
        if (res.remember) for (const k of kinds) deps.perms.remember(containerId, origin, k, res.allow ? 'allow' : 'block');
        callback(res.allow);
      },
      () => callback(false),
    );
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const kinds = kindsOf(permission, details as { mediaType?: string });
    if (!kinds) return ALWAYS_ALLOW.has(permission);
    const origin = originOf(requestingOrigin) ?? originOf(pageUrlOf(wc));
    return origin ? decide(kinds, origin) === 'allow' : false;
  });
}

export function refreshSession(ses: Session, deps: PrivacyDeps): void {
  ses.setSpellCheckerEnabled(deps.settings().spellcheck);
}

// ---------------------------------------------------------------- per tab

const YT_CSS = `
.video-ads, .ytp-ad-module, .ytp-ad-overlay-container, .ytp-ad-overlay-slot, ytd-ad-slot-renderer,
ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer,
ytd-promoted-video-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer,
ytd-player-legacy-desktop-watch-ads-renderer, #masthead-ad, #player-ads,
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"] { display: none !important; }
`;

// Runs inside the YouTube page (no Node, no bridge): clicks "Skip", and mutes + fast-forwards an ad that is playing.
const YT_JS = `(() => {
  if (window.__bsbYt) return; window.__bsbYt = true;
  let saved = null;
  setInterval(() => {
    const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
    if (skip) skip.click();
    const close = document.querySelector('.ytp-ad-overlay-close-button');
    if (close) close.click();
    const player = document.querySelector('.html5-video-player');
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!video) return;
    if (player && player.classList.contains('ad-showing')) {
      if (!saved) saved = { muted: video.muted, rate: video.playbackRate };
      video.muted = true;
      if (isFinite(video.duration) && video.duration > 0) { video.playbackRate = 16; try { video.currentTime = video.duration; } catch (e) {} }
    } else if (saved) {
      video.muted = saved.muted; video.playbackRate = saved.rate; saved = null;
    }
  }, 400);
})();`;

function injectYouTube(wc: WebContents, s: Settings): void {
  if (!s.blockYouTubeAds || wc.isDestroyed()) return;
  let host = '';
  try {
    host = new URL(wc.getURL()).hostname;
  } catch {
    return;
  }
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return;
  void wc.insertCSS(YT_CSS).catch(() => undefined);
  void wc.executeJavaScript(YT_JS).catch(() => undefined);
}

export function refreshTab(wc: WebContents, containerId: string, deps: PrivacyDeps): void {
  if (wc.isDestroyed()) return;
  const s = deps.settings();
  wc.setZoomFactor(s.zoomPercent / 100);
  // A container with a proxy never exposes addresses outside it; otherwise only hide local network addresses.
  wc.setWebRTCIPHandlingPolicy(
    deps.strictProxy(containerId) ? 'disable_non_proxied_udp' : s.limitWebRtc ? 'default_public_interface_only' : 'default',
  );
}

/**
 * Per-tab hooks. Pop-up blocking: a page may only open a new window within 3 seconds of a real click or key
 * press in that tab (the common browser rule). Returns a function the window-open handler calls.
 */
export function attachTab(wc: WebContents, containerId: string, deps: PrivacyDeps): { popupAllowed: () => boolean } {
  let lastInput = 0;
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown') lastInput = Date.now();
  });
  wc.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown' || input.type === 'touchStart') lastInput = Date.now();
  });
  wc.on('dom-ready', () => {
    refreshTab(wc, containerId, deps);
    injectYouTube(wc, deps.settings());
  });
  return {
    popupAllowed: () => {
      if (!deps.settings().blockPopups) return true;
      if (Date.now() - lastInput < 3000) return true;
      stats.popups++;
      return false;
    },
  };
}
