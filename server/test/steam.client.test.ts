import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SteamClient } from '../src/steam/client';
import { RequestBudget } from '../src/steam/budget';
import { SteamCache } from '../src/cache/file';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function rawReview(id: string, text: string, votesUp = 1, cursorReview = false): Record<string, unknown> {
  return {
    recommendationid: id,
    author: { playtime_at_review: 60 },
    language: 'english',
    review: text,
    timestamp_created: 1700000000,
    voted_up: true,
    votes_up: votesUp,
    weighted_vote_score: '0.5',
    received_for_free: false,
    written_during_early_access: false,
    ...(cursorReview ? { marker: true } : {}),
  };
}

function officialPage(reviews: unknown[], cursor: string | null, total = 500): Record<string, unknown> {
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

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-steam-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SteamClient rate limiting and fallback', () => {
  it('retries 429 with backoff and succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, 429, { 'retry-after': '1' });
        return jsonResponse(officialPage([rawReview('r1', 'great')], null));
      }) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      delayMs: 0,
    });
    const page = await client.fetchReviewsPage(570, withFilterDefaults());
    expect(page.reviews).toHaveLength(1);
    expect(calls).toBe(2);
    expect(sleeps[0]).toBe(1000);
    expect(client.steamRequests).toBe(2);
  });

  it('throws STEAM_RATE_LIMITED after three retries', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({}, 429);
      }) as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toThrow('STEAM_RATE_LIMITED');
    expect(calls).toBe(4);
  });

  it('falls back to the storefront endpoint after an official 5xx', async () => {
    const urls: string[] = [];
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        if (String(url).includes('api.steampowered.com')) return jsonResponse({}, 503);
        return jsonResponse({
          success: 1,
          reviews: [rawReview('s1', 'fallback review')],
          cursor: 's-cursor',
          query_summary: { total_positive: 8, total_negative: 2, total_reviews: 10 },
          total_matching: 10,
        });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const page = await client.fetchReviewsPage(570, withFilterDefaults());
    expect(page.source).toBe('storefront');
    expect(page.reviews[0].text).toBe('fallback review');
    expect(urls.some((u) => u.includes('ajaxappreviews/570'))).toBe(true);
    expect(urls.some((u) => u.includes('api.steampowered.com'))).toBe(true);
  });

  it('falls back to the storefront endpoint after an official 404', async () => {
    const urls: string[] = [];
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        if (String(url).includes('api.steampowered.com')) return jsonResponse({}, 404);
        return jsonResponse({
          success: 1,
          reviews: [rawReview('s1', 'storefront found it')],
          cursor: null,
          query_summary: { total_positive: 8, total_negative: 2, total_reviews: 10 },
          total_matching: 10,
        });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const page = await client.fetchReviewsPage(570, withFilterDefaults());
    expect(page.source).toBe('storefront');
    expect(page.reviews[0].text).toBe('storefront found it');
    expect(urls.filter((u) => u.includes('ajaxappreviews/570'))).toHaveLength(1);
  });

  it('reports APP_NOT_FOUND only when both endpoints return 404/410', async () => {
    const client = new SteamClient({
      fetchImpl: (async (url: string) => jsonResponse({}, String(url).includes('api.steampowered.com') ? 410 : 404)) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toThrow('APP_NOT_FOUND');
  });

  it('does not report APP_NOT_FOUND when the storefront fallback fails differently', async () => {
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        if (String(url).includes('api.steampowered.com')) return jsonResponse({}, 404);
        return jsonResponse({}, 503);
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toThrow('STEAM_UNAVAILABLE');
  });

  it('propagates STEAM_ENDPOINT_CHANGED when the storefront fallback is malformed', async () => {
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        if (String(url).includes('api.steampowered.com')) return jsonResponse({}, 404);
        return jsonResponse({ unexpected: true });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toThrow('STEAM_ENDPOINT_CHANGED');
  });

  it('passes day_range overrides to both endpoints', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        const parsed = new URL(String(url));
        seen.push(
          parsed.searchParams.get('input_json')
            ? (JSON.parse(parsed.searchParams.get('input_json') as string) as Record<string, unknown>)
            : Object.fromEntries(parsed.searchParams.entries()),
        );
        return jsonResponse(officialPage([rawReview('d1', 'day range')], null, 1));
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    await client.fetchAggregate(570, withFilterDefaults(), { dayRangeOverride: 30 });
    expect(seen[0]).toMatchObject({ day_range: 30, num_per_page: 1 });
    expect(seen[0].review_type).toBe(0); // review_type=all for aggregates
  });

  it('keeps an explicit matchingTotal of zero instead of falling back to total', async () => {
    const client = new SteamClient({
      fetchImpl: (async () => {
        const page = officialPage([], null, 0);
        (page.response as { total_matching?: number }).total_matching = 0;
        ((page.response as { query_summary: Record<string, unknown> }).query_summary).total_reviews = 123;
        return jsonResponse(page);
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const aggregate = await client.fetchAggregate(570, withFilterDefaults());
    expect(aggregate.summary?.matchingTotal).toBe(0);
    await expect(
      client.fetchReviews(570, {
        filters: withFilterDefaults(),
        clientFilters: withClientFilterDefaults(),
        maxReviews: 10,
        maxPages: 1,
      }),
    ).rejects.toThrow('NO_REVIEWS');
  });

  it('throws STEAM_ENDPOINT_CHANGED when both endpoints are unrecognisable', async () => {
    const client = new SteamClient({
      fetchImpl: (async () => jsonResponse({ nope: true })) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toThrow('STEAM_ENDPOINT_CHANGED');
  });

  it('times out a hanging request instead of holding the concurrency slot', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: ((_url: string, init: RequestInit) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
      timeoutMs: 20,
    });
    const started = Date.now();
    await expect(client.fetchReviewsPage(570, withFilterDefaults())).rejects.toThrow('STEAM_UNAVAILABLE');
    // Official and storefront attempts both terminate at the per-request
    // timeout; neither can hang the job (review Major 7).
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maps caller cancellation of a hanging request to CANCELLED', async () => {
    const controller = new AbortController();
    const client = new SteamClient({
      fetchImpl: ((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
      timeoutMs: 5000,
    });
    const promise = client.fetchReviewsPage(570, withFilterDefaults(), { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow('CANCELLED');
  });

  it('never exceeds the shared request budget across pages and endpoints', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(officialPage([rawReview(`r${calls}`, 'review')], `cursor-${calls}`));
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const budget = new RequestBudget(2);
    const result = await client.fetchReviews(570, {
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 100,
      maxPages: 2,
      budget,
    });
    expect(result.pages).toBe(2);
    expect(calls).toBe(2);
    expect(budget.used).toBe(2);
    await expect(
      client.fetchAggregate(570, withFilterDefaults(), { budget }),
    ).rejects.toThrow('STEAM_UNAVAILABLE');
    expect(calls).toBe(2);
  });
});

describe('SteamClient pagination', () => {
  it('paginates sequentially, deduplicates and stops at the target', async () => {
    const cursors: string[] = [];
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        const input = JSON.parse(new URL(String(url)).searchParams.get('input_json') ?? '{}') as { cursor: string };
        cursors.push(input.cursor);
        if (input.cursor === '*') {
          return jsonResponse(
            officialPage([rawReview('r1', 'first review'), rawReview('r2', 'second review')], 'c1'),
          );
        }
        return jsonResponse(
          officialPage([rawReview('r2', 'second review, now with more detail'), rawReview('r3', 'third review')], null),
        );
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const result = await client.fetchReviews(570, {
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 10,
      maxPages: 5,
    });
    expect(cursors).toEqual(['*', 'c1']);
    expect(result.reviews.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
    // Duplicate r2 keeps the fuller text.
    expect(result.reviews.find((r) => r.id === 'r2')?.text).toContain('more detail');
    expect(result.pages).toBe(2);
    expect(result.sourceEndpoint).toBe('official');
  });

  it('stops on an empty page and honours maxPages', async () => {
    let calls = 0;
    let mode: 'empty' | 'paginate' = 'empty';
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        calls += 1;
        if (mode === 'empty') return jsonResponse(officialPage([], null, 0));
        const input = JSON.parse(new URL(String(url)).searchParams.get('input_json') ?? '{}') as { cursor: string };
        return jsonResponse(officialPage([rawReview(`r-${input.cursor}-${calls}`, 'x')], `cursor-${calls}`));
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const empty = await client.fetchReviews(570, {
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 10,
      maxPages: 5,
    }).catch((err: unknown) => err);
    expect(empty).toBeInstanceOf(Error);
    expect((empty as Error).message).toBe('NO_REVIEWS');
    expect(calls).toBe(1);

    // A single page may legitimately be empty; only the pagination flow raises
    // NO_REVIEWS when nothing matches after an exhausted cursor.
    const page = await client.fetchReviewsPage(570, withFilterDefaults());
    expect(page.reviews).toEqual([]);

    mode = 'paginate';
    calls = 0;
    const paginated = await client.fetchReviews(570, {
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 100,
      maxPages: 2,
    });
    expect(paginated.pages).toBe(2);
    expect(calls).toBe(2);
  });

  it('keeps paginating while client-side filters reject early pages', async () => {
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async (url: string) => {
        calls += 1;
        const input = JSON.parse(new URL(String(url)).searchParams.get('input_json') ?? '{}') as { cursor: string };
        if (input.cursor === '*') return jsonResponse(officialPage([rawReview('low-1', 'low votes', 1)], 'c1'));
        if (input.cursor === 'c1') return jsonResponse(officialPage([rawReview('low-2', 'low votes', 2)], 'c2'));
        return jsonResponse(officialPage([rawReview('high-1', 'high votes', 100)], null));
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
    });
    const result = await client.fetchReviews(570, {
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults({ minVotes: 10 }),
      maxReviews: 10,
      maxPages: 5,
    });
    expect(calls).toBe(3);
    expect(result.pages).toBe(3);
    expect(result.reviews.map((r) => r.id)).toEqual(['high-1']);
  });

  it('uses the short-term cache for identical requests', async () => {
    const dir = tmpDir();
    const cache = new SteamCache(dir);
    let calls = 0;
    const client = new SteamClient({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(officialPage([rawReview('c1', 'cached')], null));
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      delayMs: 0,
      cache,
    });
    const first = await client.fetchReviewsPage(570, withFilterDefaults());
    const second = await client.fetchReviewsPage(570, withFilterDefaults());
    expect(first.reviews).toHaveLength(1);
    expect(second.reviews).toHaveLength(1);
    expect(calls).toBe(1);
    expect(client.cacheHits).toBe(1);
  });
});
