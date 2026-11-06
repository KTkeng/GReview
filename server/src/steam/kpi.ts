import { AppError } from '../lib/errors';
import type { KpiSource, KpiWindow, KpiWindows, Review, ScrapeFilters, SteamPage } from '../types';
import type { PageRequestOptions } from './client';
import type { RequestBudget } from './budget';

/** Minimal Steam surface needed to compute rolling KPI windows (mockable in tests). */
export interface KpiClient {
  fetchAggregate(appid: number, filters: ScrapeFilters, opts: PageRequestOptions): Promise<SteamPage>;
  pace?(signal?: AbortSignal): Promise<void>;
}

export interface RollingKpiOptions {
  appid: number;
  client: KpiClient;
  filters: ScrapeFilters;
  /** Used only when an individual official rolling aggregate is unavailable. */
  sampleReviews?: Review[];
  /** Shared per-job request budget (design §6.4). */
  budget?: RequestBudget;
  /** Explicit "重新抓取": bypass the short-term Steam HTTP cache. */
  refresh?: boolean;
  now?: Date;
  signal?: AbortSignal;
}

export const ROLLING_KPI_DAYS = [30, 90] as const;

const KEYS = ['last30d', 'last90d'] as const;
type WindowKey = (typeof KEYS)[number];

function emptyWindow(): KpiWindow {
  return { total: 0, positive: 0, negative: 0, positiveRate: 0 };
}

function windowFromPage(page: SteamPage, days: number): KpiWindow {
  const summary = page.summary;
  if (!summary) {
    throw new AppError('STEAM_ENDPOINT_CHANGED', `最近 ${days} 天聚合缺少 query_summary`);
  }
  return {
    total: summary.total,
    positive: summary.positive,
    negative: summary.negative,
    positiveRate: summary.positiveRate,
  };
}

/**
 * Rolling window from sample timestamps. Used only when the official aggregate
 * for that individual window is unavailable; the caller labels it
 * `sample_estimate`.
 */
export function sampleWindow(reviews: Review[], days: number, now: Date = new Date()): KpiWindow {
  const nowSec = Math.floor(now.getTime() / 1000);
  const start = nowSec - days * 86400;
  const slice = reviews.filter((r) => r.createdAt > 0 && r.createdAt >= start);
  const positive = slice.filter((r) => r.votedUp).length;
  const total = slice.length;
  return {
    total,
    positive,
    negative: total - positive,
    positiveRate: total > 0 ? positive / total : 0,
  };
}

export function sampleWindows(reviews: Review[], now: Date = new Date()): KpiWindows {
  return {
    last30d: sampleWindow(reviews, 30, now),
    last90d: sampleWindow(reviews, 90, now),
    source: 'sample_estimate',
    sources: { last30d: 'sample_estimate', last90d: 'sample_estimate' },
  };
}

/**
 * True rolling 30/90-day windows from Steam's official aggregate (design §6.7,
 * §9.4). The official query uses review_type=all, an explicit `day_range` and
 * `dateRangeOverride: null` so the user's AI-sample date range cannot truncate
 * the KPI windows (review Major 2).
 *
 * Each window is handled independently: a failure of the 30-day query must not
 * discard an already successful 90-day official aggregate (review Major 9).
 * Per-window sources are reported so sample estimates are visible in the final
 * report.
 */
export async function computeRollingKpis(opts: RollingKpiOptions): Promise<KpiWindows> {
  const now = opts.now ?? new Date();
  const windows: Record<WindowKey, KpiWindow> = { last30d: emptyWindow(), last90d: emptyWindow() };
  const sources: Record<WindowKey, KpiSource> = {
    last30d: 'sample_estimate',
    last90d: 'sample_estimate',
  };
  // `day_range` only applies to Steam's helpful ordering (design §7.1). Keeping
  // the user's `recent`/`updated` sort here would label an unbounded aggregate
  // as a 30/90-day window (review R3 Major). Rolling windows are always queried
  // with helpful ordering; the sample's sort is unaffected.
  const windowFilters: ScrapeFilters = { ...opts.filters, sort: 'helpful' };

  for (let i = 0; i < ROLLING_KPI_DAYS.length; i += 1) {
    const days = ROLLING_KPI_DAYS[i];
    const key = KEYS[i];
    if (opts.signal?.aborted) throw new AppError('CANCELLED');

    if (opts.budget && !opts.budget.canConsume(1)) {
      // No budget left for this window: label it as an estimate below.
      sources[key] = 'sample_estimate';
      continue;
    }
    try {
      const page = await opts.client.fetchAggregate(opts.appid, windowFilters, {
        dayRangeOverride: days,
        // The user's custom date range only applies to the AI sample; without
        // this the nominally rolling window gets truncated twice (review Major 2).
        dateRangeOverride: null,
        reviewTypeOverride: 'all',
        numPerPage: 1,
        budget: opts.budget,
        signal: opts.signal,
        refresh: opts.refresh,
      });
      windows[key] = windowFromPage(page, days);
      sources[key] = 'official_aggregate';
    } catch (err) {
      if (err instanceof AppError && (err.code === 'CANCELLED' || err.code === 'STEAM_RATE_LIMITED')) {
        throw err;
      }
      sources[key] = 'sample_estimate';
    }
    if (i < ROLLING_KPI_DAYS.length - 1 && opts.client.pace) await opts.client.pace(opts.signal);
  }

  for (let i = 0; i < ROLLING_KPI_DAYS.length; i += 1) {
    const key = KEYS[i];
    if (sources[key] !== 'sample_estimate') continue;
    windows[key] =
      opts.sampleReviews && opts.sampleReviews.length > 0
        ? sampleWindow(opts.sampleReviews, ROLLING_KPI_DAYS[i], now)
        : emptyWindow();
  }

  const allOfficial = sources.last30d === 'official_aggregate' && sources.last90d === 'official_aggregate';
  return {
    last30d: windows.last30d,
    last90d: windows.last90d,
    source: allOfficial ? 'official_aggregate' : 'sample_estimate',
    sources: { ...sources },
  };
}
