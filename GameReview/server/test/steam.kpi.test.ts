import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { withFilterDefaults } from '../src/steam/filters';
import { computeRollingKpis, sampleWindows, type KpiClient } from '../src/steam/kpi';
import { RequestBudget } from '../src/steam/budget';
import type { PageRequestOptions } from '../src/steam/client';
import type { Review, ScrapeFilters, SteamPage, SteamSummary } from '../src/types';

function summary(total: number, positive: number): SteamSummary {
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

function page(total: number, positive: number): SteamPage {
  return { reviews: [], cursor: null, summary: summary(total, positive), matchingTotal: total, source: 'official' };
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

describe('rolling KPI windows', () => {
  const now = new Date('2026-01-15T00:00:00.000Z');

  it('uses official aggregate day_range windows with review_type=all', async () => {
    const calls: PageRequestOptions[] = [];
    const client: KpiClient = {
      fetchAggregate: async (_appid, _filters, opts) => {
        calls.push(opts);
        return opts.dayRangeOverride === 30 ? page(50, 40) : page(250, 200);
      },
      pace: async () => undefined,
    };
    const kpis = await computeRollingKpis({ appid: 570, client, filters: withFilterDefaults(), now });
    expect(calls.map((c) => c.dayRangeOverride)).toEqual([30, 90]);
    expect(calls.every((c) => c.reviewTypeOverride === 'all' && c.numPerPage === 1)).toBe(true);
    // A custom AI-sample date range must never truncate the rolling windows.
    expect(calls.every((c) => c.dateRangeOverride === null)).toBe(true);
    expect(kpis.source).toBe('official_aggregate');
    expect(kpis.sources).toEqual({ last30d: 'official_aggregate', last90d: 'official_aggregate' });
    expect(kpis.last30d).toMatchObject({ total: 50, positive: 40, negative: 10, positiveRate: 0.8 });
    expect(kpis.last90d).toMatchObject({ total: 250, positive: 200, negative: 50, positiveRate: 0.8 });
  });

  it('forces helpful ordering for rolling windows regardless of the sample sort', async () => {
    const captured: ScrapeFilters[] = [];
    const client: KpiClient = {
      fetchAggregate: async (_appid, filters) => {
        captured.push(filters);
        return page(10, 8);
      },
    };
    for (const sort of ['helpful', 'recent', 'updated'] as const) {
      captured.length = 0;
      const kpis = await computeRollingKpis({
        appid: 570,
        client,
        filters: withFilterDefaults({ sort }),
        now,
      });
      expect(captured).toHaveLength(2);
      // Steam only applies day_range to helpful ordering; using the user's
      // recent/updated sort would return an unbounded aggregate mislabelled as
      // a 30/90-day window (review R3 Major 4).
      expect(captured.every((f) => f.sort === 'helpful')).toBe(true);
      expect(kpis.sources).toEqual({ last30d: 'official_aggregate', last90d: 'official_aggregate' });
      expect(kpis.source).toBe('official_aggregate');
    }
  });

  it('keeps a successful official window when the other window fails', async () => {
    const calls: PageRequestOptions[] = [];
    const client: KpiClient = {
      fetchAggregate: async (_appid, _filters, opts) => {
        calls.push(opts);
        expect(opts.dateRangeOverride).toBeNull();
        if (opts.dayRangeOverride === 90) throw new AppError('STEAM_UNAVAILABLE', '90d down');
        return page(50, 40);
      },
    };
    const nowSec = Math.floor(now.getTime() / 1000);
    const kpis = await computeRollingKpis({
      appid: 570,
      client,
      filters: withFilterDefaults(),
      sampleReviews: [reviewAt('a', nowSec - 31 * 86400, true), reviewAt('b', nowSec - 31 * 86400, false)],
      now,
    });
    expect(calls.map((c) => c.dayRangeOverride)).toEqual([30, 90]);
    // The 30-day official aggregate survives; the 90-day window is a labelled
    // sample estimate (review Major 9).
    expect(kpis.last30d).toMatchObject({ total: 50, positive: 40, positiveRate: 0.8 });
    expect(kpis.last90d).toMatchObject({ total: 2, positive: 1, positiveRate: 0.5 });
    expect(kpis.sources).toEqual({ last30d: 'official_aggregate', last90d: 'sample_estimate' });
    expect(kpis.source).toBe('sample_estimate');
  });

  it('falls back to sample timestamps via sampleReviews and labels the source', async () => {
    const client: KpiClient = {
      fetchAggregate: async () => {
        throw new AppError('STEAM_UNAVAILABLE', 'down');
      },
    };
    const nowSec = Math.floor(now.getTime() / 1000);
    const kpis = await computeRollingKpis({
      appid: 570,
      client,
      filters: withFilterDefaults(),
      sampleReviews: [
        reviewAt('in30', nowSec - 30 * 86400, true),
        reviewAt('in30-neg', nowSec - 10 * 86400, false),
        reviewAt('only90', nowSec - 31 * 86400, true),
        reviewAt('outside', nowSec - 91 * 86400, true),
        reviewAt('unknown-time', 0, true),
      ],
      now,
    });
    expect(kpis.source).toBe('sample_estimate');
    expect(kpis.sources).toEqual({ last30d: 'sample_estimate', last90d: 'sample_estimate' });
    expect(kpis.last30d).toMatchObject({ total: 2, positive: 1, negative: 1, positiveRate: 0.5 });
    expect(kpis.last90d).toMatchObject({ total: 3, positive: 2, negative: 1 });
  });

  it('does not exceed the shared request budget and labels the skipped window', async () => {
    let calls = 0;
    const budget = new RequestBudget(1);
    const client: KpiClient = {
      fetchAggregate: async (_appid, _filters, opts) => {
        opts.budget?.consume();
        calls += 1;
        return page(10, 8);
      },
    };
    const nowSec = Math.floor(now.getTime() / 1000);
    const kpis = await computeRollingKpis({
      appid: 570,
      client,
      filters: withFilterDefaults(),
      sampleReviews: [reviewAt('only', nowSec - 5 * 86400, true)],
      budget,
      now,
    });
    expect(calls).toBe(1);
    expect(budget.remaining).toBe(0);
    expect(kpis.last30d).toMatchObject({ total: 10, positive: 8 });
    expect(kpis.last90d).toMatchObject({ total: 1, positive: 1 });
    expect(kpis.sources).toEqual({ last30d: 'official_aggregate', last90d: 'sample_estimate' });
  });

  it('returns empty windows when neither aggregates nor samples exist', async () => {
    const client: KpiClient = {
      fetchAggregate: async () => {
        throw new AppError('STEAM_ENDPOINT_CHANGED', 'shape');
      },
    };
    const kpis = await computeRollingKpis({ appid: 570, client, filters: withFilterDefaults(), now });
    expect(kpis.source).toBe('sample_estimate');
    expect(kpis.last30d.total).toBe(0);
    expect(kpis.last90d.total).toBe(0);
  });

  it('propagates cancellation and rate limits instead of falling back', async () => {
    for (const code of ['CANCELLED', 'STEAM_RATE_LIMITED'] as const) {
      const client: KpiClient = {
        fetchAggregate: async () => {
          throw new AppError(code);
        },
      };
      await expect(
        computeRollingKpis({ appid: 570, client, filters: withFilterDefaults(), now }),
      ).rejects.toThrow(code);
    }
  });

  it('sampleWindows uses strict rolling day boundaries', () => {
    const nowSec = Math.floor(now.getTime() / 1000);
    const windows = sampleWindows(
      [
        reviewAt('edge30', nowSec - 30 * 86400, true),
        reviewAt('older30', nowSec - 30 * 86400 - 1, true),
        reviewAt('edge90', nowSec - 90 * 86400, false),
        reviewAt('outside90', nowSec - 90 * 86400 - 1, true),
      ],
      now,
    );
    expect(windows.last30d.total).toBe(1);
    expect(windows.last90d.total).toBe(3);
    expect(windows.source).toBe('sample_estimate');
  });
});
