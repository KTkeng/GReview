import { AppError } from '../lib/errors';
import { canonicalJson, contentHash, shortHash } from '../lib/hash';
import type { Review, ScrapeFilters, SourceEndpoint, SteamPage, TrendDataset, TrendPoint } from '../types';
import type { PageRequestOptions, TrendSampleOptions } from './client';
import type { RequestBudget } from './budget';

const MIN_MONTHS = 1;
const MAX_MONTHS = 36;
/** Steam's `day_range` maximum; above it the cumulative fallback is impossible. */
const MAX_DAY_RANGE = 365;
/** Upper bound for the lazy recent-order fallback sample (100 reviews/page). */
export const TREND_SAMPLE_MAX_PAGES = 5;

export interface TrendClient {
  fetchAggregate(appid: number, filters: ScrapeFilters, opts: PageRequestOptions): Promise<SteamPage>;
  /**
   * Lazily fetch an independent recent-order sample used only when every
   * official aggregate path failed (design §6.5). Implementations must ignore
   * the AI sample's sorting/review-type/date-range filters.
   */
  fetchTrendSample(appid: number, filters: ScrapeFilters, opts: TrendSampleOptions): Promise<Review[]>;
  pace(signal?: AbortSignal): Promise<void>;
}

export interface ComputeTrendOptions {
  months: number;
  timezone: string;
  client: TrendClient;
  filters: ScrapeFilters;
  releaseDate?: string;
  /** Shared per-job request budget; the lazy sample never exceeds it. */
  budget?: RequestBudget;
  /** Optional cap on fallback sample pages (default TREND_SAMPLE_MAX_PAGES). */
  maxSamplePages?: number;
  /** Explicit "refresh trend": bypass the short-term Steam HTTP cache. */
  refresh?: boolean;
  signal?: AbortSignal;
  now?: Date;
}

export interface MonthSlot {
  year: number;
  monthIndex: number; // 0-based
  period: string;
  start: number;
  end: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Offset of a timezone (ms) at the given UTC instant. */
export function timezoneOffsetMs(timestamp: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(timestamp));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - (timestamp - (timestamp % 1000));
}

/** Convert a wall-clock date in a timezone to Unix seconds. */
export function zonedTimeToUnix(year: number, monthIndex: number, day: number, hour: number, timeZone: string): number {
  const utcGuess = Date.UTC(year, monthIndex, day, hour, 0, 0);
  const offset1 = timezoneOffsetMs(utcGuess, timeZone);
  let epoch = utcGuess - offset1;
  const offset2 = timezoneOffsetMs(epoch, timeZone);
  if (offset2 !== offset1) epoch = utcGuess - offset2;
  return Math.floor(epoch / 1000);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function anchorMonthOf(now: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });
  const parts = dtf.formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${y}-${m}`;
}

export function buildMonths(months: number, timezone: string, now: Date = new Date()): MonthSlot[] {
  const count = Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, Math.floor(months) || 12));
  const anchor = anchorMonthOf(now, timezone);
  const [anchorYear, anchorMonth] = anchor.split('-').map(Number);
  const slots: MonthSlot[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const absolute = anchorYear * 12 + (anchorMonth - 1) - i;
    const year = Math.floor(absolute / 12);
    const monthIndex = absolute % 12;
    const start = zonedTimeToUnix(year, monthIndex, 1, 0, timezone);
    const end = zonedTimeToUnix(year, monthIndex + 1, 1, 0, timezone) - 1;
    slots.push({ year, monthIndex, period: `${year}-${String(monthIndex + 1).padStart(2, '0')}`, start, end });
  }
  return slots;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseReleaseMonth(releaseDate?: string): { year: number; monthIndex: number } | null {
  if (!releaseDate) return null;
  const iso = releaseDate.match(/(\d{4})[-/.](\d{1,2})/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    if (month >= 1 && month <= 12) return { year, monthIndex: month - 1 };
  }
  const chinese = releaseDate.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (chinese) {
    const year = Number(chinese[1]);
    const month = Number(chinese[2]);
    if (month >= 1 && month <= 12) return { year, monthIndex: month - 1 };
  }
  const english = releaseDate.match(/(\d{1,2})\s+([A-Za-z]{3,9})[,.]?\s+(\d{4})/);
  if (english) {
    const monthIndex = MONTH_NAMES[english[2].slice(0, 3).toLowerCase()];
    if (monthIndex !== undefined) return { year: Number(english[3]), monthIndex };
  }
  const englishMonthFirst = releaseDate.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (englishMonthFirst) {
    const monthIndex = MONTH_NAMES[englishMonthFirst[1].slice(0, 3).toLowerCase()];
    if (monthIndex !== undefined) return { year: Number(englishMonthFirst[3]), monthIndex };
  }
  return null;
}

/**
 * Trend cache key. The timezone participates because natural-month boundaries
 * (and therefore every aggregate) depend on it (design §6.5, review Major 16).
 */
export function buildTrendHash(
  appid: number,
  months: number,
  anchorMonth: string,
  timezone: string,
  filters: Pick<ScrapeFilters, 'languages' | 'purchaseType' | 'excludeOffTopic'>,
): string {
  return shortHash(
    canonicalJson({
      appid,
      months,
      anchorMonth,
      timezone,
      languages: [...filters.languages].sort(),
      purchaseType: filters.purchaseType,
      excludeOffTopic: filters.excludeOffTopic,
    }),
  );
}

function samplePoints(slots: MonthSlot[], reviews: Review[], timezone: string): TrendPoint[] {
  const buckets = new Map<string, { total: number; positive: number; negative: number }>();
  for (const slot of slots) buckets.set(slot.period, { total: 0, positive: 0, negative: 0 });
  for (const review of reviews) {
    if (!review.createdAt) continue;
    const period = anchorMonthOf(new Date(review.createdAt * 1000), timezone);
    const bucket = buckets.get(period);
    if (!bucket) continue;
    bucket.total += 1;
    if (review.votedUp) bucket.positive += 1;
    else bucket.negative += 1;
  }
  return slots.map((slot) => {
    const b = buckets.get(slot.period)!;
    return {
      period: slot.period,
      total: b.total,
      positive: b.positive,
      negative: b.negative,
      positiveRate: b.total > 0 ? b.positive / b.total : 0,
    };
  });
}

function pointFromCounts(
  period: string,
  counts: { total: number; positive: number; negative: number },
): TrendPoint {
  return {
    period,
    total: counts.total,
    positive: counts.positive,
    negative: counts.negative,
    positiveRate: counts.total > 0 ? counts.positive / counts.total : 0,
  };
}

interface CumulativeCounts {
  total: number;
  positive: number;
  negative: number;
}

const ZERO_COUNTS: CumulativeCounts = { total: 0, positive: 0, negative: 0 };

function summaryCounts(page: SteamPage, label: string): CumulativeCounts {
  const summary = page.summary;
  if (!summary) throw new AppError('STEAM_ENDPOINT_CHANGED', `${label}缺少汇总`);
  return { total: summary.total, positive: summary.positive, negative: summary.negative };
}

function subCounts(a: CumulativeCounts, b: CumulativeCounts): CumulativeCounts {
  return {
    total: Math.max(0, a.total - b.total),
    positive: Math.max(0, a.positive - b.positive),
    negative: Math.max(0, a.negative - b.negative),
  };
}

/**
 * Steam `day_range` cumulative differential fallback (design §6.5). For every
 * month boundary we ask for the trailing-N-day aggregate; adjacent cumulative
 * totals differ into one natural month. Only possible when the oldest boundary
 * lies inside Steam's 365-day `day_range` limit. Returns null otherwise.
 *
 * Day granularity means boundaries are accurate to within ±1 day; this is
 * called out in the dataset coverage note.
 */
async function computeDayRangePoints(
  appid: number,
  slots: MonthSlot[],
  nowSec: number,
  opts: ComputeTrendOptions,
): Promise<{ points: TrendPoint[]; sourceEndpoint: SourceEndpoint } | null> {
  const daysForBoundary = slots.map((slot) => Math.ceil((nowSec - slot.start) / 86400));
  if (daysForBoundary.some((days) => days > MAX_DAY_RANGE)) return null;

  // A cumulative differential needs one request per non-zero boundary. Without
  // enough shared budget the fallback must not start (it could never finish).
  const neededRequests = daysForBoundary.filter((days) => days > 0).length;
  if (opts.budget && !opts.budget.canConsume(neededRequests)) return null;

  const cumulative: CumulativeCounts[] = [];
  let sourceEndpoint: SourceEndpoint = 'official';
  for (let i = 0; i < slots.length; i += 1) {
    if (opts.signal?.aborted) throw new AppError('CANCELLED');
    const days = daysForBoundary[i];
    if (days <= 0) {
      // Boundary at or after "now": the trailing window is empty, no request.
      cumulative.push(ZERO_COUNTS);
      continue;
    }
    // A cumulative differential must be measured on the same, unbiased basis:
    // helpful sort (the aggregation window is supplied explicitly through
    // `day_range`), all review types and no user date range.
    const aggregateFilters: ScrapeFilters = {
      ...opts.filters,
      sort: 'helpful',
      reviewType: 'all',
      dateRange: null,
    };
    const page = await opts.client.fetchAggregate(appid, aggregateFilters, {
      dayRangeOverride: days,
      dateRangeOverride: null,
      // Keep the explicit override as well: aggregation callers must never
      // inherit the user sample's review type even through a wrapper.
      reviewTypeOverride: 'all',
      numPerPage: 1,
      budget: opts.budget,
      signal: opts.signal,
      refresh: opts.refresh,
    });
    sourceEndpoint = page.source;
    cumulative.push(summaryCounts(page, `day_range=${days} 累计聚合`));
    if (i < slots.length - 1) await opts.client.pace(opts.signal);
  }

  const points: TrendPoint[] = slots.map((slot, i) => {
    // Slot i = [start_i, start_{i+1}); the last slot runs to "now".
    const next = i + 1 < cumulative.length ? cumulative[i + 1] : ZERO_COUNTS;
    return pointFromCounts(slot.period, subCounts(cumulative[i], next));
  });
  return { points, sourceEndpoint };
}

/**
 * Lazy fallback sample for the last resort (design §6.5): the AI sample is
 * deliberately *not* used. A separate `recent`-ordered fetch is made here, and
 * the number of pages is capped by the remaining per-task request budget.
 */
async function loadTrendSample(appid: number, opts: ComputeTrendOptions): Promise<Review[]> {
  const budgetRemaining = opts.budget ? opts.budget.remaining : Number.POSITIVE_INFINITY;
  const cap = opts.maxSamplePages ?? TREND_SAMPLE_MAX_PAGES;
  const maxPages = Math.max(0, Math.min(cap, budgetRemaining));
  if (maxPages < 1) return [];
  const sampleFilters: ScrapeFilters = {
    ...opts.filters,
    sort: 'recent',
    reviewType: 'all',
    dateRange: null,
  };
  try {
    return await opts.client.fetchTrendSample(appid, sampleFilters, {
      maxPages,
      budget: opts.budget,
      signal: opts.signal,
      refresh: opts.refresh,
    });
  } catch (err) {
    if (err instanceof AppError && (err.code === 'CANCELLED' || err.code === 'STEAM_RATE_LIMITED')) throw err;
    return [];
  }
}

/**
 * Compute the monthly reputation trend from official aggregates (design §6.5).
 * Order: official monthly `date_range` aggregates → `day_range` cumulative
 * differentials → an independent recent-order sample estimate (clearly
 * labelled). The high-voted AI sample is never used for the trend.
 */
export async function computeTrend(appid: number, opts: ComputeTrendOptions): Promise<TrendDataset> {
  const { client, filters, timezone } = opts;
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  let slots = buildMonths(opts.months, timezone, now);
  const release = parseReleaseMonth(opts.releaseDate);
  if (release) {
    const releaseAbs = release.year * 12 + release.monthIndex;
    slots = slots.filter((s) => s.year * 12 + s.monthIndex >= releaseAbs);
    if (slots.length === 0) slots = buildMonths(1, timezone, now);
  }

  const points: TrendPoint[] = [];
  let sourceEndpoint: SourceEndpoint = 'official';
  let officialFailed = false;
  let firstError: unknown = null;

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    if (opts.budget && !opts.budget.canConsume(1)) {
      // The shared budget cannot cover the whole month set; stop before the
      // limit and try the (also budget-bounded) fallbacks.
      officialFailed = true;
      firstError = new AppError('STEAM_UNAVAILABLE', '趋势月度聚合请求预算不足');
      break;
    }
    try {
      const page = await client.fetchAggregate(appid, filters, {
        dateRangeOverride: { start: slot.start, end: slot.end },
        reviewTypeOverride: 'all',
        numPerPage: 1,
        budget: opts.budget,
        signal: opts.signal,
        refresh: opts.refresh,
      });
      sourceEndpoint = page.source;
      const summary = page.summary;
      if (!summary) throw new AppError('STEAM_ENDPOINT_CHANGED', '月度聚合缺少汇总');
      points.push({
        period: slot.period,
        total: summary.total,
        positive: summary.positive,
        negative: summary.negative,
        positiveRate: summary.positiveRate,
      });
    } catch (err) {
      if (err instanceof AppError && (err.code === 'CANCELLED' || err.code === 'STEAM_RATE_LIMITED')) throw err;
      officialFailed = true;
      firstError = err;
      break;
    }
    if (i < slots.length - 1) await client.pace(opts.signal);
  }

  const fetchedAt = now.toISOString();
  const trendHashInput = buildTrendHash(appid, opts.months, anchorMonthOf(now, timezone), timezone, filters);

  if (officialFailed) {
    // Second chance: cumulative `day_range` differentials, still official data.
    try {
      const differential = await computeDayRangePoints(appid, slots, nowSec, { ...opts, now });
      if (differential && differential.points.length > 0) {
        return {
          granularity: 'month',
          source: 'official_aggregate',
          points: differential.points,
          coverage: {
            start: `${slots[0].period}-01`,
            end: `${slots[slots.length - 1].period}-${String(daysInMonth(slots[slots.length - 1].year, slots[slots.length - 1].monthIndex)).padStart(2, '0')}`,
            note: `官方 date_range 月度聚合不可用，改用 day_range 累计差分；月份边界按天数近似（±1 天）；时区 ${timezone}；趋势独立于 AI 样本筛选`,
          },
          timezone,
          sourceEndpoint: differential.sourceEndpoint,
          fetchedAt,
          trendHash: trendHashInput,
          trendContentHash: contentHash(differential.points),
        };
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'CANCELLED' || err.code === 'STEAM_RATE_LIMITED')) throw err;
      firstError = firstError ?? err;
    }

    const trendSample = await loadTrendSample(appid, opts);
    if (trendSample.length === 0) {
      if (firstError instanceof AppError) throw firstError;
      throw new AppError('STEAM_UNAVAILABLE', firstError instanceof Error ? firstError.message : '趋势聚合失败');
    }
    const estimatePoints = samplePoints(slots, trendSample, timezone);
    const totalSample = estimatePoints.reduce((n, p) => n + p.total, 0);
    return {
      granularity: 'month',
      source: 'sample_estimate',
      points: estimatePoints,
      coverage: {
        start: `${slots[0].period}-01`,
        end: `${slots[slots.length - 1].period}-${String(daysInMonth(slots[slots.length - 1].year, slots[slots.length - 1].monthIndex)).padStart(2, '0')}`,
        note: `官方月度聚合与 day_range 累计差分均不可用，改用按 recent 排序懒加载的独立趋势样本（${trendSample.length} 条，落入区间 ${totalSample} 条）按评论时间估算；未使用 AI 高赞样本；受剩余请求预算约束；时区 ${timezone}`,
      },
      timezone,
      sourceEndpoint,
      fetchedAt,
      trendHash: trendHashInput,
      trendContentHash: contentHash(estimatePoints),
    };
  }

  const first = points[0];
  const last = points[points.length - 1];
  return {
    granularity: 'month',
    source: 'official_aggregate',
    points,
    coverage: {
      start: `${first.period}-01`,
      end: `${last.period}-${String(daysInMonth(parseInt(last.period.slice(0, 4), 10), parseInt(last.period.slice(5, 7), 10) - 1)).padStart(2, '0')}`,
      note: `官方月度聚合，共 ${points.length} 个月；时区 ${timezone}；趋势独立于 AI 样本筛选`,
    },
    timezone,
    sourceEndpoint,
    fetchedAt,
    trendHash: trendHashInput,
    trendContentHash: contentHash(points),
  };
}

export function isValidTrendMonths(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_MONTHS && value <= MAX_MONTHS;
}

/** Used by the report for the "trend source" label; never mutates the dataset. */
export function trendSourceLabel(source: TrendDataset['source'], endpoint: SourceEndpoint): string {
  return `${source}${source === 'official_aggregate' ? ` (${endpoint})` : ''}`;
}

export function safeReleaseDate(value: unknown): string | undefined {
  const v = asString(value);
  return v || undefined;
}
