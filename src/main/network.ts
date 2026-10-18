// Per-container network route. Pure logic, unit tested; applied via session.setProxy in main.ts.

export type ProxyScheme = 'http' | 'https' | 'socks5';

export interface ProxyConfig {
  enabled: boolean;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  /** Password lives in the vault, never in this config. */
  /** Strict mode: if the proxy is unreachable, traffic must fail instead of going direct. */
  strict: boolean;
}

export interface ElectronProxyConfig {
  mode: 'direct' | 'fixed_servers';
  proxyRules?: string;
  proxyBypassRules?: string;
}

export function validateProxy(p: ProxyConfig): string | null {
  if (!p.enabled) return null;
  const host = p.host.trim();
  if (!host) return 'Proxy host is required';
  // Strict allow-list. Characters like ",", ";", "/" or spaces could smuggle extra rules (e.g. a
  // "direct://" fallback) into the proxy rule string and silently defeat fail-closed behavior.
  const okHost = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || /^\[[0-9A-Fa-f:.]+\]$/.test(host);
  if (!okHost) return 'Proxy host contains invalid characters';
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return 'Proxy port must be 1-65535';
  if (!['http', 'https', 'socks5'].includes(p.scheme)) return 'Unsupported proxy type';
  return null;
}

/**
 * Builds the Electron proxy config.
 * Rules deliberately contain NO "direct://" fallback, so when the proxy is down Chromium returns
 * ERR_PROXY_CONNECTION_FAILED instead of silently connecting directly. This holds for strict and
 * non-strict mode alike; "non-strict" only changes what the UI offers the user (e.g. a retry-direct button).
 */
export function buildElectronProxy(p: ProxyConfig): ElectronProxyConfig {
  const err = validateProxy(p);
  if (err) throw new Error(err);
  if (!p.enabled) return { mode: 'direct' };
  const scheme = p.scheme === 'socks5' ? 'socks5' : p.scheme;
  return {
    mode: 'fixed_servers',
    proxyRules: `${scheme}://${p.host.trim()}:${p.port}`,
    // Local addresses are never sent through the proxy.
    proxyBypassRules: '<local>',
  };
}

export type ConnectionState = 'direct' | 'proxy-connected' | 'proxy-disconnected' | 'proxy-unavailable';

export function describeMode(p: ProxyConfig, state: ConnectionState): string {
  if (!p.enabled) return 'Direct connection (your own IP address)';
  const route = `${p.scheme.toUpperCase()} proxy ${p.host}:${p.port}`;
  switch (state) {
    case 'proxy-connected':
      return `Via ${route}${p.strict ? ' (strict: blocks traffic if proxy fails)' : ''}`;
    case 'proxy-unavailable':
      return p.strict ? `${route} unreachable. Traffic is blocked (strict mode).` : `${route} unreachable.`;
    case 'proxy-disconnected':
      return `${route} not connected yet`;
    default:
      return 'Direct connection (your own IP address)';
  }
}
