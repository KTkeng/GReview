import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { withFilterDefaults } from '../src/steam/filters';
import type { PageRequestOptions } from '../src/steam/client';
import { RequestBudget } from '../src/steam/budget';
import {
  anchorMonthOf,
  buildMonths,
  buildTrendHash,
  computeTrend,
  daysInMonth,
  parseReleaseMonth,
  type TrendClient,
} from '../src/steam/trend';
import type { Review, SourceEndpoint, SteamPage, SteamSummary } from '../src/types';

function summary(total: number, positive = total): SteamSummary {
  return {
    total,
    positive,
    negative: total - positive,
    positiveRate: total > 0 ? positive / total : 0,
    reviewScoreDesc: '好评',
    matchingTotal: total,
    sourceEndpoint: 'official',
  };
}

function page(total: number, source: SourceEndpoint = 'official'): SteamPage {
  return { reviews: [], cursor: null, summary: summary(total), matchingTotal: total, source };
}

function reviewAt(id: string, createdAt: number, votedUp = true): Review {
  return {
    id,
    language: 'en',
    votedUp,
    votesUp: 1,
    weightedVoteScore: 0,
    playtimeAtReviewMinutes: 0,
    createdAt,
    text: 'review',
    writtenDuringEarlyAccess: false,
    receivedForFree: false,
  };
}

describe('trend month boundaries', () => {
  it('crosses a year boundary using natural months in the configured timezone', () => {
    const now = new Date('2026-01-15T04:00:00.000Z');
    expect(anchorMonthOf(now, 'Asia/Shanghai')).toBe('2026-01');
    const slots = buildMonths(3, 'Asia/Shanghai', now);
    expect(slots.map((s) => s.period)).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(slots[0].start).toBe(Math.floor(Date.parse('2025-10-31T16:00:00.000Z') / 1000));
    expect(slots[1].start).toBe(Math.floor(Date.parse('2025-11-30T16:00:00.000Z') / 1000));
    expect(slots[2].start).toBe(Math.floor(Date.parse('2025-12-31T16:00:00.000Z') / 1000));
  });

  it('handles a leap February and a common February', () => {
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2023, 1)).toBe(28);
    const leap = buildMonths(2, 'Asia/Shanghai', new Date('2024-03-10T00:00:00.000Z'));
    expect(leap.map((s) => s.period)).toEqual(['2024-02', '2024-03']);
    // The February slot ends at 29 Feb 23:59:59 Shanghai time.
    expect(leap[0].end - leap[0].start).toBe(29 * 86400 - 1);
    const common = buildMonths(1, 'Asia/Shanghai', new Date('2023-02-10T00:00:00.000Z'));
    expect(common[0].period).toBe('2023-02');
    expect(common[0].end - common[0].start).toBe(28 * 86400 - 1);
  });

  it('parses release dates used to trim early months', () => {
    expect(parseReleaseMonth('9 Jul, 2013')).toEqual({ year: 2013, monthIndex: 6 });
    expect(parseReleaseMonth('2020年5月')).toEqual({ year: 2020, monthIndex: 4 });
    expect(parseReleaseMonth('2020-02-29')).toEqual({ year: 2020, monthIndex: 1 });
    expect(parseReleaseMonth('not a date')).toBeNull();
  });
});

describe('trend hash and timezone', () => {
  it('includes the timezone so caches cannot be reused across zones', () => {
    const filters = withFilterDefaults();
    const shanghai = buildTrendHash(570, 12, '2026-03', 'Asia/Shanghai', filters);
    const utc = buildTrendHash(570, 12, '2026-03', 'UTC', filters);
    expect(shanghai).not.toBe(utc);
    expect(buildTrendHash(570, 12, '2026-03', 'Asia/Shanghai', filters)).toBe(shanghai);
  });

  it('stamps the timezone and matching hash on every trend result', async () => {
    const now = new Date('2026-03-15T00:00:00.000Z');
    const client: TrendClient = {
      fetchAggregate: async (_appid, _filters, opts: PageRequestOptions) =>
        page(Math.max(1, 30 - (opts.dateRangeOverride?.start ?? 0) % 10)),
      fetchTrendSample: async () => [],
      pace: async () => undefined,
    };
    const trend = await computeTrend(570, {
      months: 2,
      timezone: 'America/New_York',
      client,
      filters: withFilterDefaults(),
      now,
    });
    expect(trend.timezone).toBe('America/New_York');
    expect(trend.trendHash).toBe(
      buildTrendHash(570, 2, anchorMonthOf(now, 'America/New_York'), 'America/New_York', withFilterDefaults()),
    );
    expect(trend.trendContentHash).toBeTruthy();
  });
});

describe('trend fallback chain', () => {
  const filters = withFilterDefaults();
  const now = new Date('2026-03-15T00:00:00.000Z');

  it('falls back to day_range cumulative differentials when monthly aggregates fail', async () => {
    const calls: PageRequestOptions[] = [];
    const days: number[] = [];
    const client: TrendClient = {
      fetchAggregate: async (appid, _filters, opts) => {
        calls.push(opts);
        if (opts.dateRangeOverride) throw new AppError('STEAM_UNAVAILABLE', 'monthly down');
        expect(appid).toBe(570);
        expect(opts.reviewTypeOverride).toBe('all');
        expect(opts.numPerPage).toBe(1);
        days.push(opts.dayRangeOverride as number);
        // Cumulative identities make the differential easy to verify.
        return page(opts.dayRangeOverride as number);
      },
      fetchTrendSample: async () => [],
      pace: async () => undefined,
    };
    const trend = await computeTrend(570, { months: 3, timezone: 'Asia/Shanghai', client, filters, now });
    expect(calls.filter((c) => c.dateRangeOverride)).toHaveLength(1);
    expect(days).toHaveLength(3);
    expect(days.every((d) => d > 0 && d <= 365)).toBe(true);
    expect(trend.source).toBe('official_aggregate');
    expect(trend.points.map((p) => p.total)).toEqual([
      days[0] - days[1],
      days[1] - days[2],
      days[2],
    ]);
    expect(trend.coverage.note).toContain('day_range');
    expect(trend.coverage.note).toContain('Asia/Shanghai');
  });

  it('does not attempt a day_range differential beyond the 365-day limit and lazily fetches an independent recent sample', async () => {
    const calls: PageRequestOptions[] = [];
    const sampleCalls: Array<{ filters: unknown; maxPages: number }> = [];
    const client: TrendClient = {
      fetchAggregate: async (_appid, _filters, opts) => {
        calls.push(opts);
        throw new AppError('STEAM_UNAVAILABLE', 'all aggregates down');
      },
      fetchTrendSample: async (_appid, filters, opts) => {
        sampleCalls.push({ filters, maxPages: opts.maxPages });
        return [reviewAt('r1', Math.floor(now.getTime() / 1000) - 86400)];
      },
      pace: async () => undefined,
    };
    const trend = await computeTrend(570, {
      months: 24,
      timezone: 'Asia/Shanghai',
      client,
      filters,
      now,
    });
    expect(calls.every((c) => c.dateRangeOverride)).toBe(true);
    expect(trend.source).toBe('sample_estimate');
    expect(trend.points.reduce((n, p) => n + p.total, 0)).toBe(1);
    // The fallback sample is independent of the AI sample: recent sort, all
    // review types, no date range (review Major 1).
    expect(sampleCalls).toHaveLength(1);
    expect(sampleCalls[0].filters).toMatchObject({ sort: 'recent', reviewType: 'all', dateRange: null });
    expect(trend.coverage.note).toContain('样本');
    expect(trend.coverage.note).toContain('未使用 AI 高赞样本');
  });

  it('uses a labelled sample estimate when both official paths fail', async () => {
    const feb = Math.floor(Date.parse('2026-02-15T00:00:00.000Z') / 1000);
    const mar = Math.floor(Date.parse('2026-03-05T00:00:00.000Z') / 1000);
    const client: TrendClient = {
      fetchAggregate: async (_appid, _filters, opts) => {
        if (opts.dateRangeOverride) throw new AppError('STEAM_ENDPOINT_CHANGED', 'monthly shape');
        throw new AppError('STEAM_UNAVAILABLE', 'day range down');
      },
      fetchTrendSample: async () => [reviewAt('a', feb, true), reviewAt('b', feb, false), reviewAt('c', mar, true)],
      pace: async () => undefined,
    };
    const trend = await computeTrend(570, {
      months: 3,
      timezone: 'Asia/Shanghai',
      client,
      filters,
      now,
    });
    expect(trend.source).toBe('sample_estimate');
    expect(trend.points.find((p) => p.period === '2026-02')).toMatchObject({ total: 2, positive: 1, negative: 1 });
    expect(trend.points.find((p) => p.period === '2026-03')).toMatchObject({ total: 1, positive: 1 });
    expect(trend.coverage.note).toContain('样本');
    expect(trend.trendHash).toBeTruthy();
    expect(trend.trendContentHash).toBeTruthy();
  });

  it('rethrows cancellation instead of falling back', async () => {
    const client: TrendClient = {
      fetchAggregate: async () => {
        throw new AppError('CANCELLED');
      },
      fetchTrendSample: async () => {
        throw new AppError('CANCELLED');
      },
      pace: async () => undefined,
    };
    await expect(
      computeTrend(570, { months: 2, timezone: 'UTC', client, filters, now }),
    ).rejects.toThrow('CANCELLED');
  });

  it('bounds every branch with the shared task request budget', async () => {
    const calls: PageRequestOptions[] = [];
    const sampleCalls: number[] = [];
    const client: TrendClient = {
      fetchAggregate: async (_appid, _filters, opts) => {
        opts.budget?.consume();
        calls.push(opts);
        return page(10);
      },
      fetchTrendSample: async (_appid, _filters, opts) => {
        sampleCalls.push(opts.maxPages);
        return [];
      },
      pace: async () => undefined,
    };
    const budget = new RequestBudget(2);
    await expect(
      computeTrend(570, { months: 12, timezone: 'Asia/Shanghai', client, filters, budget, now }),
    ).rejects.toMatchObject({ code: 'STEAM_UNAVAILABLE' });
    // Monthly loop stops when the budget is exhausted; the day_range fallback
    // pre-check and the lazy sample then correctly decline to issue requests.
    expect(calls).toHaveLength(2);
    expect(sampleCalls).toHaveLength(0);
    expect(budget.remaining).toBe(0);
  });
});
