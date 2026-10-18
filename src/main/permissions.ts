// Site permission decisions (camera, microphone, location, notifications). Pure and unit tested.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermDefault } from './settings';

export type PermKind = 'camera' | 'microphone' | 'location' | 'notifications';
export type Decision = 'allow' | 'block' | 'ask';

/** Maps an Electron permission name to the permission kinds we control. null = not one of ours. */
export function kindsOf(permission: string, details?: { mediaTypes?: string[]; mediaType?: string }): PermKind[] | null {
  switch (permission) {
    case 'media': {
      const t = details?.mediaTypes ?? (details?.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : ['video', 'audio']);
      const out: PermKind[] = [];
      if (t.includes('video')) out.push('camera');
      if (t.includes('audio')) out.push('microphone');
      return out.length ? out : ['camera', 'microphone'];
    }
    case 'geolocation':
      return ['location'];
    case 'notifications':
      return ['notifications'];
    default:
      return null;
  }
}

/** One blocked kind blocks everything; otherwise one unanswered kind means ask. */
export function combine(decisions: Decision[]): Decision {
  if (decisions.includes('block')) return 'block';
  if (decisions.includes('ask')) return 'ask';
  return 'allow';
}

export class PermissionStore {
  private map: Record<string, 'allow' | 'block'> = {};

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) if (v === 'allow' || v === 'block') this.map[k] = v;
    } catch {
      this.map = {};
    }
  }

  private key(containerId: string, origin: string, kind: PermKind): string {
    return `${containerId}|${origin}|${kind}`;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }

  /** A remembered answer for this container + site wins; otherwise the global default applies. */
  decide(defaults: Record<PermKind, PermDefault>, containerId: string, origin: string, kind: PermKind): Decision {
    return this.map[this.key(containerId, origin, kind)] ?? defaults[kind];
  }

  remember(containerId: string, origin: string, kind: PermKind, value: 'allow' | 'block'): void {
    this.map[this.key(containerId, origin, kind)] = value;
    this.save();
  }

  /** Forgets remembered answers, for one container or for all. Returns how many were removed. */
  reset(containerId?: string): number {
    const keys = Object.keys(this.map).filter((k) => (containerId ? k.startsWith(`${containerId}|`) : true));
    for (const k of keys) delete this.map[k];
    if (keys.length) this.save();
    return keys.length;
  }

  count(): number {
    return Object.keys(this.map).length;
  }
}
