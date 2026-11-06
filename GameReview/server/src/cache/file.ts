import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, shortHash } from '../lib/hash';
import { atomicWriteJson, readJsonFile } from '../lib/fs';
import { silentLogger, type Logger } from '../lib/logger';

export interface CacheEntry<T = unknown> {
  endpoint: string;
  appid: number;
  key: string;
  fetchedAt: number;
  body: T;
}

/**
 * Keys that identify a Steam user or point at their profile. Raw Steam review
 * responses include these; they must never reach disk (design §6.4/§6.6).
 */
const PERSONAL_KEY = /(steamid|steam_id|account_id|personaname|persona_name|real_name|avatar|profile_url|clanid|nickname)/i;
/** Inside `author` only the playtime fields are needed by normalization. */
const AUTHOR_ALLOWED_KEYS = new Set(['playtime_at_review', 'playtime_forever']);

/** Recursively strip personal author fields while keeping public review data. */
export function sanitizeForCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeForCache(item));
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (PERSONAL_KEY.test(key)) continue;
    if (key === 'author') {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const author: Record<string, unknown> = {};
        for (const [authorKey, authorValue] of Object.entries(child as Record<string, unknown>)) {
          if (AUTHOR_ALLOWED_KEYS.has(authorKey)) author[authorKey] = authorValue;
        }
        output[key] = author;
      }
      continue;
    }
    output[key] = sanitizeForCache(child);
  }
  return output;
}

/**
 * Short-term Steam request cache (design §6.4). Only public Steam responses are
 * stored; no headers, keys or personal data. TTL: reviews 24h, appdetails 7d.
 */
export class SteamCache {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(dir: string, opts: { now?: () => number; logger?: Logger } = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? silentLogger;
  }

  private fileFor(endpoint: string, appid: number, params: unknown): string {
    const key = shortHash(canonicalJson(params));
    return path.join(this.dir, `${endpoint}.${appid}.${key}.json`);
  }

  async get<T>(endpoint: string, appid: number, params: unknown, ttlMs: number): Promise<T | null> {
    const file = this.fileFor(endpoint, appid, params);
    try {
      const entry = await readJsonFile<CacheEntry<T>>(file);
      if (!entry || typeof entry.fetchedAt !== 'number' || entry.endpoint !== endpoint) return null;
      if (this.now() - entry.fetchedAt > ttlMs) {
        await fsp.rm(file, { force: true }).catch(() => undefined);
        return null;
      }
      return entry.body;
    } catch {
      return null;
    }
  }

  async set<T>(endpoint: string, appid: number, params: unknown, body: T): Promise<void> {
    const file = this.fileFor(endpoint, appid, params);
    const entry: CacheEntry<T> = {
      endpoint,
      appid,
      key: path.basename(file),
      fetchedAt: this.now(),
      body: sanitizeForCache(body) as T,
    };
    try {
      await atomicWriteJson(file, entry);
    } catch (err) {
      this.logger.warn('steam cache write failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Clear the whole cache or only one app's entries. */
  async clear(appid?: number): Promise<number> {
    let removed = 0;
    let files: string[];
    try {
      files = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      if (appid === undefined) {
        await fsp.rm(file, { force: true }).catch(() => undefined);
        removed += 1;
        continue;
      }
      try {
        const entry = await readJsonFile<CacheEntry>(file);
        if (entry.appid === appid) {
          await fsp.rm(file, { force: true }).catch(() => undefined);
          removed += 1;
        }
      } catch {
        // Corrupted cache entry: remove it as well.
        await fsp.rm(file, { force: true }).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }
}
