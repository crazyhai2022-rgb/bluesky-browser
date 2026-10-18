import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyConfig } from './network';

export interface Container {
  id: string;
  name: string;
  color: string;
  emoji: string;
  description: string;
  pinned: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  /** Electron session partition. Persistent and unique per container. */
  partition: string;
  /** Per-container network route. null = direct connection. Holds no secrets. */
  proxy: ProxyConfig | null;
}

export type ContainerInput = Partial<Pick<Container, 'name' | 'color' | 'emoji' | 'description' | 'pinned'>>;

export function partitionFor(id: string): string {
  return `persist:container-${id}`;
}

export class ContainerStore {
  private items: Container[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      this.items = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as Container[]).map((c) => ({
        ...c,
        proxy: c.proxy ?? null, // containers saved before proxy support
      }));
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }

  list(opts: { search?: string; sort?: 'name' | 'lastUsed' | 'created' } = {}): Container[] {
    let out = [...this.items];
    if (opts.search) {
      const q = opts.search.toLowerCase();
      out = out.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
    }
    const sort = opts.sort ?? 'name';
    out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === 'lastUsed') return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      if (sort === 'created') return b.createdAt - a.createdAt;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  get(id: string): Container | undefined {
    return this.items.find((c) => c.id === id);
  }

  create(input: ContainerInput): Container {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('Container name is required');
    const id = randomUUID();
    const c: Container = {
      id,
      name,
      color: input.color ?? '#2563ff',
      emoji: input.emoji ?? '🔵',
      description: input.description ?? '',
      pinned: input.pinned ?? false,
      createdAt: Date.now(),
      lastUsedAt: null,
      partition: partitionFor(id),
      proxy: null,
    };
    this.items.push(c);
    this.save();
    return c;
  }

  update(id: string, input: ContainerInput): Container {
    const c = this.get(id);
    if (!c) throw new Error('Container not found');
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n) throw new Error('Container name is required');
      c.name = n;
    }
    if (input.color !== undefined) c.color = input.color;
    if (input.emoji !== undefined) c.emoji = input.emoji;
    if (input.description !== undefined) c.description = input.description;
    if (input.pinned !== undefined) c.pinned = input.pinned;
    this.save();
    return c;
  }

  /** Copies configuration only. The duplicate gets a NEW partition: no cookies or logins are copied. */
  duplicate(id: string): Container {
    const src = this.get(id);
    if (!src) throw new Error('Container not found');
    const copy = this.create({
      name: `${src.name} (copy)`,
      color: src.color,
      emoji: src.emoji,
      description: src.description,
    });
    if (src.proxy) this.setProxy(copy.id, { ...src.proxy });
    return copy;
  }

  /** Stores the container's network route. Validation happens in network.ts before this is called. */
  setProxy(id: string, proxy: ProxyConfig | null): Container {
    const c = this.get(id);
    if (!c) throw new Error('Container not found');
    c.proxy = proxy && proxy.enabled ? proxy : null;
    this.save();
    return c;
  }

  touch(id: string): void {
    const c = this.get(id);
    if (c) {
      c.lastUsedAt = Date.now();
      this.save();
    }
  }

  remove(id: string): Container {
    const c = this.get(id);
    if (!c) throw new Error('Container not found');
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    return c; // caller is responsible for clearing the session storage for c.partition
  }
}
