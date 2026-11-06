import { AppError, isAppError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { silentLogger } from '../lib/logger';
import { type SleepFn, realSleep } from '../lib/rate-limit';
import type { ClientFilters, Review, ScrapeFilters, SteamPage, SteamSummary } from '../types';
import { SteamCache } from '../cache/file';
import { RequestBudget } from './budget';
import {
  DEFAULT_CLIENT_FILTERS,
  applyClientFilters,
  officialUrl,
  storefrontUrl,
  toOfficialInput,
  toStorefrontQuery,
} from './filters';
import { normalizeSteamPage } from './normalize';

export const USER_AGENT = 'GReview/0.1 (local open-source tool; +https://github.com/greview/greview)';
export const REVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const APPDETAILS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_STEAM_TIMEOUT_MS = 30000;
/** Longest server-requested Retry-After we are willing to wait out. */
export const MAX_RETRY_AFTER_MS = 60_000;

const BACKOFF_MS = [1000, 2000, 4000];

/**
 * Parse a `Retry-After` header (delay seconds or an HTTP date) into a wait in
 * milliseconds. Returns null when the header is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

function isAbortError(err: unknown): boolean {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

export interface SteamClientOptions {
  fetchImpl?: typeof fetch;
  cache?: SteamCache | null;
  sleep?: SleepFn;
  delayMs?: number;
  now?: () => number;
  maxRetries?: number;
  /** Per-attempt timeout for a single Steam HTTP request (review Major 8). */
  timeoutMs?: number;
  logger?: Logger;
  userAgent?: string;
}

export interface PageRequestOptions {
  cursor?: string;
  numPerPage?: number;
  reviewTypeOverride?: ScrapeFilters['reviewType'];
  dateRangeOverride?: { start?: number; end?: number } | null;
  dayRangeOverride?: number | null;
  /** Shared per-job request budget; every network attempt consumes one slot. */
  budget?: RequestBudget;
  /**
   * Explicit refresh: bypass the short-term HTTP cache for this request and
   * overwrite the cached entry with the freshly fetched body. Ordinary reuse
   * keeps the cache behaviour untouched.
   */
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface FetchReviewsOptions {
  maxPages: number;
  signal?: AbortSignal;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  maxReviews: number;
  budget?: RequestBudget;
  /** Bypass the short-term review cache (explicit "重新抓取"). */
  refresh?: boolean;
  onProgress?: (info: { fetched: number; target: number; pages: number; total?: number }) => void;
}

export interface TrendSampleOptions {
  maxPages: number;
  signal?: AbortSignal;
  budget?: RequestBudget;
  /** Bypass the short-term review cache (explicit "刷新趋势" fallback). */
  refresh?: boolean;
}

export interface FetchReviewsResult {
  reviews: Review[];
  pages: number;
  sourceEndpoint: 'official' | 'storefront';
  summary: SteamSummary | null;
  matchedTotal: number;
}

/**
 * Decide the final error after both endpoints failed (design §7.2): the app is
 * only "not found" when both official and storefront confirm it; endpoint
 * shape changes win over generic unavailability; aborts/rate limits propagate.
 */
function combineEndpointErrors(officialError: unknown, storefrontError: unknown): unknown {
  for (const candidate of [storefrontError, officialError]) {
    if (isAppError(candidate) && (candidate.code === 'CANCELLED' || candidate.code === 'STEAM_RATE_LIMITED')) {
      return candidate;
    }
  }
  const officialCode = isAppError(officialError) ? officialError.code : 'STEAM_UNAVAILABLE';
  const storefrontCode = isAppError(storefrontError) ? storefrontError.code : 'STEAM_UNAVAILABLE';
  const officialMsg = officialError instanceof Error ? officialError.message : String(officialError);
  const storefrontMsg = storefrontError instanceof Error ? storefrontError.message : String(storefrontError);
  const message = `官方端点失败: ${officialMsg}; 回退端点失败: ${storefrontMsg}`;
  if (officialCode === 'APP_NOT_FOUND' && storefrontCode === 'APP_NOT_FOUND') {
    return new AppError('APP_NOT_FOUND', message);
  }
  if (officialCode === 'STEAM_ENDPOINT_CHANGED' || storefrontCode === 'STEAM_ENDPOINT_CHANGED') {
    return new AppError('STEAM_ENDPOINT_CHANGED', message);
  }
  return new AppError('STEAM_UNAVAILABLE', message);
}

export class SteamClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cache: SteamCache | null;
  private readonly sleep: SleepFn;
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly now: () => number;

  /** Serial request queue: one Steam network attempt at a time, across jobs. */
  private queueTail: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  steamRequests = 0;
  cacheHits = 0;

  constructor(opts: SteamClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.cache = opts.cache ?? null;
    this.sleep = opts.sleep ?? realSleep;
    this.delayMs = opts.delayMs ?? 400;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_STEAM_TIMEOUT_MS;
    this.logger = opts.logger ?? silentLogger;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.now = opts.now ?? Date.now;
  }

  resetCounters(): void {
    this.steamRequests = 0;
    this.cacheHits = 0;
  }

  /**
   * Compatibility no-op. All network traffic is paced by the shared serial
   * scheduler in `httpGet`, so callers that still invoke `pace()` between
   * logical requests must not add a second delay.
   */
  async pace(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AppError('CANCELLED');
  }

  /** Jittered interval between consecutive Steam network attempts. */
  private requestInterval(): number {
    if (this.delayMs <= 0) return 0;
    const jitter = Math.floor(Math.random() * 101) - 50;
    return Math.max(350, this.delayMs + jitter);
  }

  private waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return previous;
    if (signal.aborted) return Promise.reject(new AppError('CANCELLED'));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new AppError('CANCELLED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      previous.then(
        () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.sleep(ms, signal);
    } catch (err) {
      if (signal?.aborted) throw new AppError('CANCELLED');
      throw err;
    }
  }

  /**
   * Run one network attempt behind the shared serial queue. Requests are never
   * concurrent (even across jobs sharing this client) and consecutive attempts
   * start at least `requestInterval()` apart. Waiting for a turn, the interval
   * and the attempt itself are all cancellable through `signal`.
   */
  private async runSerial<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await this.waitForTurn(previous, signal);
      const wait = this.nextAllowedAt - this.now();
      if (wait > 0) await this.sleepAbortable(wait, signal);
      if (signal?.aborted) throw new AppError('CANCELLED');
      this.nextAllowedAt = this.now() + this.requestInterval();
      return await work();
    } finally {
      release();
    }
  }

  private async getJson(
    url: string,
    endpoint: string,
    appid: number,
    cacheParams: unknown,
    ttlMs: number,
    signal?: AbortSignal,
    budget?: RequestBudget,
    refresh = false,
  ): Promise<{ body: unknown; cached: boolean }> {
    if (this.cache && !refresh) {
      const hit = await this.cache.get(endpoint, appid, cacheParams, ttlMs);
      if (hit !== null) {
        this.cacheHits += 1;
        return { body: hit, cached: true };
      }
    }
    const body = await this.httpGet(url, signal, budget);
    // An explicit refresh skips the read above but always overwrites the cached
    // entry, so later ordinary requests see the refreshed content.
    if (this.cache) await this.cache.set(endpoint, appid, cacheParams, body);
    return { body, cached: false };
  }

  /**
   * Perform one HTTP attempt. Timeout and caller cancellation cover the whole
   * exchange, including reading the response body: a server that sends headers
   * and then stalls the body can never hang a job. Cancellation, timeout and
   * invalid JSON are reported as distinct errors.
   */
  private async performGet(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; retryAfter: string | null; body?: unknown }> {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    let rejectAborted!: (err: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    // The race may reject `aborted` after the body promise has already settled;
    // keep the losing branch from becoming an unhandled rejection.
    aborted.catch(() => undefined);
    const onAbort = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectAborted(err);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();

    const timeoutError = () => new AppError('STEAM_UNAVAILABLE', `Steam 请求超时（${this.timeoutMs}ms）`);

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(url, {
            method: 'GET',
            headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
            signal: controller.signal,
          }),
          aborted,
        ]);
      } catch (err) {
        if (signal?.aborted) throw new AppError('CANCELLED');
        if (timedOut || isAbortError(err)) throw timeoutError();
        this.logger.warn('steam request failed', { error: err instanceof Error ? err.message : String(err) });
        throw new AppError('STEAM_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      }

      if (response.status === 429) {
        return { status: 429, retryAfter: response.headers.get('retry-after') };
      }
      if (response.status === 400 || response.status === 404 || response.status === 410) {
        throw new AppError('APP_NOT_FOUND', `Steam HTTP ${response.status}`);
      }
      if (response.status >= 500) {
        throw new AppError('STEAM_UNAVAILABLE', `Steam HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new AppError('STEAM_UNAVAILABLE', `Steam HTTP ${response.status}`);
      }

      let body: unknown;
      try {
        const jsonPromise = response.json();
        jsonPromise.catch(() => undefined);
        body = await Promise.race([jsonPromise, aborted]);
      } catch (err) {
        if (signal?.aborted) throw new AppError('CANCELLED');
        if (timedOut || isAbortError(err)) throw timeoutError();
        throw new AppError('STEAM_ENDPOINT_CHANGED', 'Steam 响应不是合法 JSON');
      }
      return { status: response.status, retryAfter: null, body };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async httpGet(url: string, signal?: AbortSignal, budget?: RequestBudget): Promise<unknown> {
    let retries = 0;
    for (;;) {
      if (signal?.aborted) throw new AppError('CANCELLED');
      // Throw before touching the network when the shared per-job budget is
      // exhausted (design §6.4: hard cap of 60 requests per analysis).
      budget?.consume();
      this.steamRequests += 1;

      const attempt = await this.runSerial(() => this.performGet(url, signal), signal);

      if (attempt.status === 429) {
        if (retries >= this.maxRetries) throw new AppError('STEAM_RATE_LIMITED');
        const specified = parseRetryAfterMs(attempt.retryAfter, this.now());
        let wait: number;
        if (specified !== null) {
          // Never retry earlier than the server asked. If the requested delay is
          // impractically long, surface a rate-limit error instead of waiting.
          if (specified > MAX_RETRY_AFTER_MS) {
            throw new AppError(
              'STEAM_RATE_LIMITED',
              `Steam Retry-After 要求等待 ${specified}ms，超过可等待上限 ${MAX_RETRY_AFTER_MS}ms`,
            );
          }
          wait = specified;
        } else {
          wait = BACKOFF_MS[Math.min(retries, BACKOFF_MS.length - 1)];
        }
        this.logger.warn('steam 429, backing off', { retries, wait });
        await this.sleepAbortable(wait, signal);
        retries += 1;
        continue;
      }

      return attempt.body;
    }
  }

  /** Fetch one page, trying the official endpoint first and storefront second. */
  async fetchReviewsPage(appid: number, filters: ScrapeFilters, opts: PageRequestOptions = {}): Promise<SteamPage> {
    const officialInput = toOfficialInput(appid, filters, {
      cursor: opts.cursor,
      numPerPage: opts.numPerPage,
      reviewTypeOverride: opts.reviewTypeOverride,
      dateRangeOverride: opts.dateRangeOverride,
      dayRangeOverride: opts.dayRangeOverride,
    });
    let officialError: unknown = null;
    try {
      const { body } = await this.getJson(
        officialUrl(officialInput),
        'reviews-official',
        appid,
        officialInput,
        REVIEW_CACHE_TTL_MS,
        opts.signal,
        opts.budget,
        opts.refresh,
      );
      const page = normalizeSteamPage(body, 'official');
      if (page.reviews.length === 0 && page.summary === null) {
        throw new AppError('STEAM_ENDPOINT_CHANGED', '官方响应没有评论也没有汇总');
      }
      return page;
    } catch (err) {
      if (
        !(
          isAppError(err) &&
          (err.code === 'STEAM_UNAVAILABLE' ||
            err.code === 'STEAM_ENDPOINT_CHANGED' ||
            err.code === 'APP_NOT_FOUND')
        )
      ) {
        throw err;
      }
      officialError = err;
      this.logger.info('official endpoint failed, falling back to storefront', { code: err.code });
    }

    const query = toStorefrontQuery(filters, {
      cursor: opts.cursor,
      numPerPage: opts.numPerPage,
      reviewTypeOverride: opts.reviewTypeOverride,
      dateRangeOverride: opts.dateRangeOverride,
      dayRangeOverride: opts.dayRangeOverride,
    });
    let storefrontError: unknown;
    try {
      const { body } = await this.getJson(
        storefrontUrl(appid, query),
        'reviews-storefront',
        appid,
        query,
        REVIEW_CACHE_TTL_MS,
        opts.signal,
        opts.budget,
        opts.refresh,
      );
      const page = normalizeSteamPage(body, 'storefront');
      if (page.reviews.length === 0 && page.summary === null) {
        throw new AppError('STEAM_ENDPOINT_CHANGED', '回退响应没有评论也没有汇总');
      }
      return page;
    } catch (err) {
      storefrontError = err;
    }
    throw combineEndpointErrors(officialError, storefrontError);
  }

  /**
   * Fetch an aggregate with num_per_page=1. The caller decides the review type:
   * preview matching must preserve the user's `reviewType`, while KPI/trend
   * aggregations pass an explicit `all` filter so their totals are unbiased.
   */
  async fetchAggregate(
    appid: number,
    filters: ScrapeFilters,
    opts: PageRequestOptions = {},
  ): Promise<SteamPage> {
    const page = await this.fetchReviewsPage(appid, filters, {
      ...opts,
      numPerPage: 1,
    });
    if (!page.summary) throw new AppError('STEAM_ENDPOINT_CHANGED', '聚合查询缺少 query_summary');
    return page;
  }

  /** Paginate sequentially, deduplicate by recommendationid and apply client filters. */
  async fetchReviews(appid: number, opts: FetchReviewsOptions): Promise<FetchReviewsResult> {
    const { filters, clientFilters, maxReviews, maxPages, signal, budget } = opts;
    const matched = new Map<string, Review>();
    let cursor = '*';
    let pages = 0;
    let source: 'official' | 'storefront' = 'official';
    let summary: SteamSummary | null = null;
    let matchedTotal = 0;

    while (pages < maxPages && matched.size < maxReviews) {
      if (signal?.aborted) throw new AppError('CANCELLED');
      const page = await this.fetchReviewsPage(appid, filters, {
        cursor,
        numPerPage: 100,
        signal,
        budget,
        refresh: opts.refresh,
      });
      pages += 1;
      source = page.source;
      if (page.summary) {
        // The official endpoint only returns the complete query_summary on the
        // first page; later pages may omit it or return a partial/zero summary.
        // Keep the first page summary as the dataset's source of truth so a
        // multi-page fetch cannot persist `total: 100, positive: 0` and be
        // rejected by the dataset runtime validator.
        if (summary === null) summary = page.summary;
        // `matchingTotal` is an explicit count; only fall back to `total` when
        // the summary truly has no matching info (never when it is zero).
        matchedTotal = Math.max(
          matchedTotal,
          page.summary.matchingTotal !== undefined ? page.summary.matchingTotal : page.summary.total,
        );
      } else {
        matchedTotal = Math.max(matchedTotal, page.matchingTotal);
      }

      const passed = applyClientFilters(page.reviews, clientFilters);
      for (const review of passed) {
        const existing = matched.get(review.id);
        // Prefer the fuller text when the same recommendation appears twice.
        if (!existing || review.text.length > existing.text.length) matched.set(review.id, review);
        if (matched.size >= maxReviews) break;
      }
      opts.onProgress?.({ fetched: matched.size, target: maxReviews, pages, total: matchedTotal });

      if (page.reviews.length === 0) break;
      const nextCursor = page.cursor;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
      if (matched.size < maxReviews && pages < maxPages) await this.pace(signal);
    }

    if (matched.size === 0) {
      throw new AppError('NO_REVIEWS', '筛选后没有匹配的评论');
    }

    return {
      reviews: [...matched.values()],
      pages,
      sourceEndpoint: source,
      summary,
      matchedTotal,
    };
  }

  /**
   * Lazily load an independent trend-estimate sample (design §6.5): sorted by
   * Steam's `recent` order, review_type=all, no user date range, and bounded by
   * the remaining per-task request budget. Never reuses the high-voted AI
   * sample, which is biased toward older reviews.
   */
  async fetchTrendSample(
    appid: number,
    filters: ScrapeFilters,
    opts: TrendSampleOptions = { maxPages: 3 },
  ): Promise<Review[]> {
    const maxPages = Math.max(1, Math.floor(opts.maxPages) || 1);
    try {
      const result = await this.fetchReviews(appid, {
        filters: { ...filters, sort: 'recent', reviewType: 'all', dateRange: null },
        clientFilters: DEFAULT_CLIENT_FILTERS,
        maxReviews: maxPages * 100,
        maxPages,
        budget: opts.budget,
        signal: opts.signal,
        refresh: opts.refresh,
      });
      return result.reviews;
    } catch (err) {
      if (isAppError(err) && err.code === 'NO_REVIEWS') return [];
      throw err;
    }
  }

  /** appdetails metadata request with a 7-day cache. Returns raw JSON. */
  async fetchAppDetailsRaw(
    appid: number,
    signal?: AbortSignal,
    budget?: RequestBudget,
    refresh = false,
  ): Promise<unknown> {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=cn`;
    const { body } = await this.getJson(
      url,
      'appdetails',
      appid,
      { appid },
      APPDETAILS_CACHE_TTL_MS,
      signal,
      budget,
      refresh,
    );
    return body;
  }
}
