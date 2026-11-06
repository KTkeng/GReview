import path from 'node:path';
import type { ServerConfig } from '../lib/config';
import { SteamCache } from '../cache/file';
import type { GameMeta, Review, ScrapeFilters, SteamPage } from '../types';
import type { TrendClient } from './trend';
import type { RequestBudget } from './budget';
import { resolveGame } from './appdetails';
import {
  SteamClient,
  type FetchReviewsOptions,
  type FetchReviewsResult,
  type PageRequestOptions,
  type TrendSampleOptions,
} from './client';
import type { SleepFn } from '../lib/rate-limit';

/** High-level Steam interface used by routes and the job manager (mockable in tests). */
export interface SteamService extends TrendClient {
  resolveGame(
    appid: number,
    signal?: AbortSignal,
    budget?: RequestBudget,
    refresh?: boolean,
  ): Promise<GameMeta>;
  fetchAggregate(appid: number, filters: ScrapeFilters, opts?: PageRequestOptions): Promise<SteamPage>;
  fetchReviews(appid: number, opts: FetchReviewsOptions): Promise<FetchReviewsResult>;
  fetchTrendSample(appid: number, filters: ScrapeFilters, opts: TrendSampleOptions): Promise<Review[]>;
  pace(signal?: AbortSignal): Promise<void>;
  resetCounters(): void;
  counters(): { steamRequests: number; cacheHits: number };
  clearCache(appid?: number): Promise<number>;
}

export class DefaultSteamService implements SteamService {
  constructor(
    private readonly client: SteamClient,
    private readonly cache: SteamCache | null,
  ) {}

  resolveGame(appid: number, signal?: AbortSignal, budget?: RequestBudget, refresh = false): Promise<GameMeta> {
    return resolveGame(appid, {
      fetchAppDetails: (id) => this.client.fetchAppDetailsRaw(id, signal, budget, refresh),
    });
  }

  fetchAggregate(appid: number, filters: ScrapeFilters, opts: PageRequestOptions = {}): Promise<SteamPage> {
    return this.client.fetchAggregate(appid, filters, opts);
  }

  fetchReviews(appid: number, opts: FetchReviewsOptions): Promise<FetchReviewsResult> {
    return this.client.fetchReviews(appid, opts);
  }

  fetchTrendSample(appid: number, filters: ScrapeFilters, opts: TrendSampleOptions): Promise<Review[]> {
    return this.client.fetchTrendSample(appid, filters, opts);
  }

  pace(signal?: AbortSignal): Promise<void> {
    return this.client.pace(signal);
  }

  resetCounters(): void {
    this.client.resetCounters();
  }

  counters(): { steamRequests: number; cacheHits: number } {
    return { steamRequests: this.client.steamRequests, cacheHits: this.client.cacheHits };
  }

  async clearCache(appid?: number): Promise<number> {
    if (!this.cache) return 0;
    return this.cache.clear(appid);
  }
}

export interface CreateSteamServiceOptions {
  fetchImpl?: typeof fetch;
  sleep?: SleepFn;
  delayMs?: number;
  cache?: SteamCache | null;
}

export function createSteamService(config: ServerConfig, opts: CreateSteamServiceOptions = {}): SteamService {
  const cache =
    opts.cache === undefined
      ? new SteamCache(path.join(config.cacheDir, 'steam'))
      : opts.cache;
  const client = new SteamClient({
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    delayMs: opts.delayMs ?? config.steamRequestDelayMs,
    timeoutMs: config.steamTimeoutMs,
    cache,
  });
  return new DefaultSteamService(client, cache);
}
