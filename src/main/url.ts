// Address bar input handling and navigation safety. Pure functions, unit tested.

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=%s';

export function normalizeInput(raw: string, searchTemplate: string = DEFAULT_SEARCH): string {
  const input = raw.trim();
  if (!input) return 'about:blank';

  // Explicit scheme
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) return input;

  // localhost or host:port
  if (/^localhost(:\d+)?(\/.*)?$/i.test(input)) return `http://${input}`;

  // Looks like a domain (has a dot, no spaces)
  if (!/\s/.test(input) && /^[^\s.]+(\.[^\s.]+)+(:\d+)?(\/.*)?$/.test(input)) {
    return `https://${input}`;
  }

  return searchTemplate.replace('%s', encodeURIComponent(input));
}

/** Only http(s) may load inside a tab. Everything else is blocked or handed to the user for confirmation. */
export function isAllowedNavigation(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Exact origin (scheme + host + port). Used later to bind password autofill. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return ALLOWED_SCHEMES.has(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}
