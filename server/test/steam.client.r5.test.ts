import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RETRY_AFTER_MS,
  SteamClient,
  parseRetryAfterMs,
} from '../src/steam/client';
import { SteamCache } from '../src/cache/file';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import { computeTrend } from '../src/steam/trend';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function rawReview(id: string, text: string): Record<string, unknown> {
  return {
    recommendationid: id,
    author: { playtime_at_review: 60 },
    language: 'english',
    review: text,
    timestamp_created: 1700000000,
    voted_up: true,
    votes_up: 1,
    weighted_vote_score: '0.5',
    received_for_free: false,
    written_during_early_access: false,
  };
}

function officialPage(reviews: unknown[], cursor: string | null, total = 100): Record<string, unknown> {
  return {
    response: {
      reviews,
      cursor: cursor ?? undefined,
      query_summary: {
        review_score_desc: '特别好评',
        total_positive: Math.floor(total * 0.9),
        total_negative: total - Math.floor(total * 0.9),
        total_reviews: total,
      },
      total_matching: total,
    },
  };
}

function storefrontPage(reviews: unknown[], cursor: string | null, total = 100): Record<string, unknown> {
  return {
    success: 1,
    reviews,
    cursor,
    query_summary: {
      total_positive: Math.floor(total * 0.9),
      total_negative: total - Math.floor(total * 0.9),
      total_reviews: total,
    },
    total_matching: total,
  };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-r5-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fastSleep = async (): Promise<void> => undefined;

describe('explicit refresh penetrates the short-term Steam cache', () => {
  it('bypasses the cached aggregate and overwrites it with fresh data', async () => {
    const cache = new SteamCache(tmpDir());
    let calls = 0;
    let total = 100;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(officialPage([rawReview('r1', 'cached review')], null, total));
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
      cache,
    });
    const filters = withFilterDefaults();

    const first = await client.fetchAggregate(570, filters, { dayRangeOverride: 30 });
    expect(first.summary?.total).toBe(100);
    const cachedAgain = await client.fetchAggregate(570, filters, { dayRangeOverride: 30 });
    expect(cachedAgain.summary?.total).toBe(100);
    expect(calls).toBe(1);
    expect(client.cacheHits).toBe(1);

    total = 200;
    const refreshed = await client.fetchAggregate(570, filters, { dayRangeOverride: 30, refresh: true });
    expect(refreshed.summary?.total).toBe(200);
    expect(calls).toBe(2);

    // The explicit refresh wrote the new body back to the cache, so ordinary
    // reuse now sees the refreshed value without another network request.
    const afterRefresh = await client.fetchAggregate(570, filters, { dayRangeOverride: 30 });
    expect(afterRefresh.summary?.total).toBe(200);
    expect(calls).toBe(2);
  });

  it('bypasses the cached review page when refresh flows through pagination', async () => {
    const cache = new SteamCache(tmpDir());
    let calls = 0;
    let text = 'old review text';
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(officialPage([rawReview('r1', text)], null));
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
      cache,
    });
    const opts = {
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 10,
      maxPages: 1,
    };
    const first = await client.fetchReviews(570, opts);
    expect(first.reviews[0].text).toBe('old review text');
    await client.fetchReviews(570, opts);
    expect(calls).toBe(1);

    text = 'new review text';
    const refreshed = await client.fetchReviews(570, { ...opts, refresh: true });
    expect(refreshed.reviews[0].text).toBe('new review text');
    expect(calls).toBe(2);
    const afterRefresh = await client.fetchReviews(570, opts);
    expect(afterRefresh.reviews[0].text).toBe('new review text');
    expect(calls).toBe(2);
  });
});

describe('timeout and cancellation cover response body reading', () => {
  function stalledBody(): Response {
    return new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('times out after headers arrive when the body never completes', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return stalledBody();
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
      timeoutMs: 25,
    });
    const started = Date.now();
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toMatchObject({
      code: 'STEAM_UNAVAILABLE',
    });
    // Official and storefront each time out; neither can hang the job.
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maps caller cancellation during body reading to CANCELLED', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return stalledBody();
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
      timeoutMs: 5000,
    });
    const controller = new AbortController();
    const pending = client.fetchReviewsPage(570, withFilterDefaults(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    // A cancelled request must not fall through to the storefront endpoint.
    expect(calls).toBe(1);
  });

  it('distinguishes invalid JSON from timeout and cancellation', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return new Response('this is not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
      timeoutMs: 5000,
    });
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toMatchObject({
      code: 'STEAM_ENDPOINT_CHANGED',
    });
    expect(calls).toBe(2);
  });
});

describe('preview aggregates preserve the user review type', () => {
  it('maps positive, negative and all review types to both endpoints', async () => {
    for (const reviewType of ['all', 'positive', 'negative'] as const) {
      const official: Array<Record<string, unknown>> = [];
      const storefront: Array<Record<string, string>> = [];
      const client = new SteamClient({
        fetchImpl: (async (url: string) => {
          const parsed = new URL(String(url));
          if (parsed.pathname.includes('/IUserReviewsService/')) {
            official.push(JSON.parse(parsed.searchParams.get('input_json') ?? '{}') as Record<string, unknown>);
            // Force the storefront fallback as well so its mapping is checked.
            return jsonResponse({}, 503);
          }
          storefront.push(Object.fromEntries(parsed.searchParams.entries()));
          return jsonResponse(storefrontPage([], null, 0));
        }) as unknown as typeof fetch,
        sleep: fastSleep,
        delayMs: 0,
      });

      const page = await client.fetchAggregate(570, withFilterDefaults({ reviewType }), { dayRangeOverride: 30 });
      const expected = { all: 0, positive: 1, negative: 2 }[reviewType];
      expect(official[0]).toMatchObject({ review_type: expected, num_per_page: 1, day_range: 30 });
      expect(storefront[0]).toMatchObject({
        review_type: reviewType,
        num_per_page: '1',
        day_range: '30',
      });
      // A genuine zero-match response must stay zero (preview disables analysis).
      expect(page.summary?.matchingTotal).toBe(0);
    }
  });
});

describe('serial scheduling, interval and Retry-After', () => {
  it('never runs concurrent Steam network attempts across tasks or endpoints', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return jsonResponse(officialPage([], null, 100));
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
    });
    await Promise.all([
      client.fetchAggregate(570, withFilterDefaults({ reviewType: 'all' })),
      client.fetchAggregate(570, withFilterDefaults({ reviewType: 'positive' })),
      client.fetchAggregate(570, withFilterDefaults({ reviewType: 'negative' })),
      client.fetchAppDetailsRaw(570),
    ]);
    expect(calls).toBe(4);
    expect(maxInFlight).toBe(1);
  });

  it('applies the request interval across endpoints for consecutive tasks', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const client = new SteamClient({
      fetchImpl: (async () => jsonResponse(officialPage([], null, 1))) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      delayMs: 400,
      now: () => clock,
    });
    await Promise.all([
      client.fetchAggregate(570, withFilterDefaults({ reviewType: 'all' })),
      client.fetchAppDetailsRaw(570),
      client.fetchAggregate(570, withFilterDefaults({ reviewType: 'positive' })),
      client.fetchAggregate(570, withFilterDefaults({ reviewType: 'negative' })),
    ]);
    expect(sleeps).toHaveLength(3);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(350);
      expect(ms).toBeLessThanOrEqual(450);
    }
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfterMs('2', now)).toBe(2000);
    expect(parseRetryAfterMs('2.5', now)).toBe(2500);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('not a date', now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });

  it('waits for the server-specified HTTP date before retrying', async () => {
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    let calls = 0;
    const sleeps: number[] = [];
    const client = new SteamClient({
      now: () => nowMs,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({}, 429, { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' });
        }
        return jsonResponse(officialPage([], null, 1));
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      delayMs: 0,
    });
    await client.fetchAggregate(570, withFilterDefaults());
    expect(calls).toBe(2);
    expect(sleeps[0]).toBe(5000);
  });

  it('fails with STEAM_RATE_LIMITED instead of ignoring an impractically long Retry-After', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({}, 429, { 'retry-after': String(MAX_RETRY_AFTER_MS / 1000 + 60) });
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      delayMs: 0,
    });
    await expect(client.fetchAggregate(570, withFilterDefaults())).rejects.toMatchObject({
      code: 'STEAM_RATE_LIMITED',
    });
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });
});

describe('day_range trend fallback forces aggregation parameters through the real client', () => {
  it('sets helpful sort, all review types and no date range for recent/updated samples', async () => {
    for (const sort of ['recent', 'updated'] as const) {
      const official: Array<Record<string, unknown>> = [];
      const storefront: Array<Record<string, string>> = [];
      const client = new SteamClient({
        fetchImpl: (async (url: string) => {
          const parsed = new URL(String(url));
          if (parsed.pathname.includes('/IUserReviewsService/')) {
            const input = JSON.parse(parsed.searchParams.get('input_json') ?? '{}') as Record<string, unknown>;
            official.push(input);
            if (input.date_range_start !== undefined) return jsonResponse({}, 503);
            return jsonResponse(officialPage([], null, Number(input.day_range ?? 1)));
          }
          const query = Object.fromEntries(parsed.searchParams.entries());
          storefront.push(query);
          return jsonResponse({}, 503);
        }) as unknown as typeof fetch,
        sleep: fastSleep,
        delayMs: 0,
      });

      const now = new Date('2026-03-15T00:00:00.000Z');
      const trend = await computeTrend(570, {
        months: 2,
        timezone: 'Asia/Shanghai',
        client,
        filters: withFilterDefaults({ sort }),
        now,
      });
      expect(trend.source).toBe('official_aggregate');

      const dayRangeCalls = official.filter((input) => input.date_range_start === undefined);
      expect(dayRangeCalls.length).toBeGreaterThanOrEqual(2);
      for (const input of dayRangeCalls) {
        expect(input).toMatchObject({ filter: 0, review_type: 0, num_per_page: 1 });
        expect(input.date_range_start).toBeUndefined();
        expect(input.date_range_end).toBeUndefined();
      }
      // The failed monthly attempt still used the user's sort and review type;
      // only the fallback must be normalized.
      expect(official.some((input) => input.date_range_start !== undefined)).toBe(true);
      expect(storefront.length).toBeGreaterThanOrEqual(1);
      for (const query of storefront) expect(query.review_type).toBe('all');
    }
  });

  it('maps the lazy trend sample to recent + all review types through the real client', async () => {
    const official: Array<Record<string, unknown>> = [];
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        const parsed = new URL(String(url));
        if (!parsed.pathname.includes('/IUserReviewsService/')) return jsonResponse({}, 503);
        const input = JSON.parse(parsed.searchParams.get('input_json') ?? '{}') as Record<string, unknown>;
        official.push(input);
        // All aggregates fail; the lazy sample pagination succeeds.
        if (Number(input.num_per_page) === 1) return jsonResponse({}, 503);
        return jsonResponse(officialPage([rawReview('sample-1', 'recent sample')], null, 1));
      }) as unknown as typeof fetch,
      sleep: fastSleep,
      delayMs: 0,
    });
    const now = new Date('2026-03-15T00:00:00.000Z');
    const trend = await computeTrend(570, {
      months: 24,
      timezone: 'Asia/Shanghai',
      client,
      filters: withFilterDefaults({ sort: 'updated', reviewType: 'negative', dateRange: { start: 1, end: 2 } }),
      now,
      maxSamplePages: 1,
    });
    expect(trend.source).toBe('sample_estimate');
    const sampleCall = official.find((input) => Number(input.num_per_page) > 1);
    expect(sampleCall).toBeTruthy();
    expect(sampleCall).toMatchObject({ filter: 1, review_type: 0 });
    expect(sampleCall?.date_range_start).toBeUndefined();
    expect(sampleCall?.day_range).toBeUndefined();
  });
});
