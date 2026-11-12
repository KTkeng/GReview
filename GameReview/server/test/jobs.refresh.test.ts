import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, type AIFactory } from '../src/jobs/manager';
import { silentLogger } from '../src/lib/logger';
import { SteamCache } from '../src/cache/file';
import { SteamClient } from '../src/steam/client';
import { DefaultSteamService } from '../src/steam/service';
import { buildReviewsHash, readDataset, reportsDir } from '../src/storage/dataset';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { ClientFilters, CreateJobRequest, JobSnapshot, ScrapeFilters } from '../src/types';
import { FakeAIProvider, SAMPLE_ANALYSIS, makeConfig } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-refresh-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const APPID = 570;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function officialSummary(total: number): Record<string, unknown> {
  const positive = Math.round(total * 0.8);
  return {
    response: {
      reviews: [],
      query_summary: {
        review_score_desc: '特别好评',
        total_positive: positive,
        total_negative: total - positive,
        total_reviews: total,
      },
      total_matching: total,
    },
  };
}

interface MutableState {
  gameName: string;
  reviewText: string;
  reviewTotal: number;
  trendTotal: number;
  allTimeTotal: number;
  kpi30: number;
  kpi90: number;
}

interface Calls {
  appdetails: number;
  reviews: number;
  monthly: number;
  allTime: number;
  kpi30: number;
  kpi90: number;
  other: number;
}

interface Harness {
  manager: JobManager;
  calls: Calls;
  state: MutableState;
  dataDir: string;
  cacheDir: string;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
}

function build(): Harness {
  const dataDir = tmpDir();
  const cacheDir = path.join(dataDir, 'steam-cache');
  const cache = new SteamCache(cacheDir);
  const state: MutableState = {
    gameName: 'Test Game v1',
    reviewText: 'Combat feels great v1',
    reviewTotal: 100,
    trendTotal: 11,
    allTimeTotal: 100,
    kpi30: 30,
    kpi90: 90,
  };
  const calls: Calls = { appdetails: 0, reviews: 0, monthly: 0, allTime: 0, kpi30: 0, kpi90: 0, other: 0 };

  const fetchImpl = (async (url: string) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'store.steampowered.com' && parsed.pathname === '/api/appdetails') {
      calls.appdetails += 1;
      return json({
        [APPID]: {
          success: true,
          data: { name: state.gameName, release_date: { date: '1 Jan, 2020' } },
        },
      });
    }
    if (parsed.pathname.includes('/IUserReviewsService/')) {
      const input = JSON.parse(parsed.searchParams.get('input_json') ?? '{}') as Record<string, unknown>;
      if (input.date_range_start !== undefined) {
        calls.monthly += 1;
        return json(officialSummary(state.trendTotal));
      }
      if (Number(input.num_per_page) === 1) {
        if (input.day_range === 0) {
          calls.allTime += 1;
          return json(officialSummary(state.allTimeTotal));
        }
        if (input.day_range === 30) {
          calls.kpi30 += 1;
          return json(officialSummary(state.kpi30));
        }
        if (input.day_range === 90) {
          calls.kpi90 += 1;
          return json(officialSummary(state.kpi90));
        }
      }
      if (Number(input.num_per_page) >= 100) {
        calls.reviews += 1;
        const total = state.reviewTotal;
        return json({
          response: {
            reviews: [
              {
                recommendationid: 'r1',
                language: 'english',
                review: state.reviewText,
                timestamp_created: 1700000000,
                voted_up: true,
                votes_up: 5,
                weighted_vote_score: '0.5',
                author: { playtime_at_review: 120 },
              },
              {
                recommendationid: 'r2',
                language: 'english',
                review: 'Too expensive v1',
                timestamp_created: 1700000100,
                voted_up: false,
                votes_up: 2,
                weighted_vote_score: '0.4',
                author: { playtime_at_review: 60 },
              },
            ],
            query_summary: {
              review_score_desc: '特别好评',
              total_positive: Math.round(total * 0.8),
              total_negative: total - Math.round(total * 0.8),
              total_reviews: total,
            },
            total_matching: total,
          },
        });
      }
      calls.other += 1;
      return json({}, 503);
    }
    calls.other += 1;
    return json({}, 503);
  }) as unknown as typeof fetch;

  const client = new SteamClient({
    fetchImpl,
    cache,
    sleep: async () => undefined,
    delayMs: 0,
    timeoutMs: 5000,
  });
  const steam = new DefaultSteamService(client, cache);
  const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
  const aiFactory: AIFactory = () => ai;
  let tick = Date.parse('2026-03-01T00:00:00.000Z');
  const now = () => {
    tick += 1000;
    return tick;
  };
  const manager = new JobManager({ config: makeConfig(dataDir), steam, aiFactory, logger: silentLogger, now });
  return {
    manager,
    calls,
    state,
    dataDir,
    cacheDir,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
  };
}

function request(
  h: Harness,
  overrides: { forceFetch?: boolean; forceTrend?: boolean; forceAnalyze?: boolean } = {},
): CreateJobRequest {
  return {
    appid: APPID,
    filters: h.filters,
    clientFilters: h.clientFilters,
    trend: { months: 1 },
    ai: { model: 'deepseek-flash', thinking: false },
    options: { maxReviews: 5, includeTranslations: false, topReviews: 2 },
    data: {
      dataDir: h.dataDir,
      reuseDataset: true,
      reuseReport: true,
      forceFetch: overrides.forceFetch ?? false,
      forceTrend: overrides.forceTrend ?? false,
      forceAnalyze: overrides.forceAnalyze ?? false,
    },
  };
}

async function runJob(h: Harness, req: CreateJobRequest): Promise<JobSnapshot> {
  const { jobId } = await h.manager.createJob(req, 'sk-test-refresh', h.dataDir);
  const started = Date.now();
  for (;;) {
    const snapshot = await h.manager.getSnapshot(jobId);
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    if (Date.now() - started > 15000) throw new Error(`job timeout: ${JSON.stringify(snapshot)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function totalCalls(calls: Calls): number {
  return Object.values(calls).reduce((sum, n) => sum + n, 0);
}

function datasetHash(req: CreateJobRequest): string {
  return buildReviewsHash({
    appid: req.appid,
    filters: req.filters,
    clientFilters: req.clientFilters,
    maxReviews: req.options.maxReviews,
  });
}

/** Read every short-term cache entry and return the cached total_reviews values. */
function cachedTotals(cacheDir: string): number[] {
  const out: number[] = [];
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('.json')) continue;
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')) as {
      body?: { response?: { query_summary?: { total_reviews?: number } } };
    };
    const total = entry.body?.response?.query_summary?.total_reviews;
    if (typeof total === 'number') out.push(total);
  }
  return out;
}

function reportCount(dataDir: string): number {
  try {
    return fs.readdirSync(reportsDir(dataDir, APPID)).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

describe('forceFetch / forceTrend penetrate the Steam short-term cache', () => {
  it('keeps normal reuse offline, refreshes through cache on forceFetch, and refreshes only the trend on forceTrend', async () => {
    const h = build();
    const normal = request(h);

    const first = await runJob(h, normal);
    expect(first.status).toBe('completed');
    expect(h.calls.appdetails).toBe(1);
    expect(h.calls.reviews).toBe(1);
    expect(h.calls.monthly).toBe(1);
    expect(h.calls.allTime).toBe(1);
    expect(h.calls.kpi30).toBe(1);
    expect(h.calls.kpi90).toBe(1);
    expect(h.calls.other).toBe(0);

    const report1 = h.manager.getReport(first.jobId);
    expect(report1.game.name).toBe('Test Game v1');
    expect(report1.kpis.allTime.total).toBe(100);
    expect(report1.kpis.last30d.total).toBe(30);
    expect(report1.kpis.last90d.total).toBe(90);
    expect(report1.trend.points[0].total).toBe(11);
    expect(cachedTotals(h.cacheDir)).toEqual(expect.arrayContaining([100, 30, 90, 11]));
    const hash = datasetHash(normal);
    const dataset1 = await readDataset(h.dataDir, APPID, hash);
    expect(dataset1?.status).toBe('complete');
    expect(dataset1?.meta.allTimeSummary?.total).toBe(100);
    expect(dataset1?.meta.rollingKpis?.last30d.total).toBe(30);
    const fetchedAt = dataset1!.meta.fetchedAt;
    const beforeSecond = totalCalls(h.calls);

    // No force flags: dataset, trend, persisted KPI aggregates and the cached
    // report are all reused, so not a single Steam request may happen.
    const second = await runJob(h, normal);
    expect(second.status).toBe('completed');
    expect(totalCalls(h.calls)).toBe(beforeSecond);
    const report2 = h.manager.getReport(second.jobId);
    expect(report2.methodology.dataSource).toBe('local_dataset');
    expect(report2.methodology.steamRequests).toBe(0);
    expect(report2.kpis.allTime.total).toBe(100);

    // The network now serves different values. forceFetch must bypass both the
    // local dataset and the short-term cache and update the report.
    h.state.gameName = 'Test Game v2';
    h.state.reviewText = 'Combat feels great v2';
    h.state.reviewTotal = 200;
    h.state.trendTotal = 77;
    h.state.allTimeTotal = 200;
    h.state.kpi30 = 33;
    h.state.kpi90 = 44;

    const third = await runJob(h, request(h, { forceFetch: true }));
    expect(third.status).toBe('completed');
    expect(h.calls.appdetails).toBe(2);
    expect(h.calls.reviews).toBe(2);
    // forceFetch does not touch the trend: it is a separate control.
    expect(h.calls.monthly).toBe(1);
    expect(h.calls.allTime).toBe(2);
    expect(h.calls.kpi30).toBe(2);
    expect(h.calls.kpi90).toBe(2);

    const report3 = h.manager.getReport(third.jobId);
    expect(report3.game.name).toBe('Test Game v2');
    expect(report3.kpis.allTime.total).toBe(200);
    expect(report3.kpis.last30d.total).toBe(33);
    expect(report3.kpis.last90d.total).toBe(44);

    const dataset3 = await readDataset(h.dataDir, APPID, hash);
    expect(dataset3?.status).toBe('complete');
    expect(dataset3!.reviews[0].text).toBe('Combat feels great v2');
    expect(dataset3!.meta.game.name).toBe('Test Game v2');
    expect(dataset3!.meta.fetchedAt).not.toBe(fetchedAt);
    expect(dataset3!.meta.allTimeSummary?.total).toBe(200);
    expect(dataset3!.meta.rollingKpis?.last30d.total).toBe(33);
    expect(dataset3!.meta.rollingKpis?.last90d.total).toBe(44);
    // The explicit refresh wrote the new bodies back to the short-term cache.
    expect(cachedTotals(h.cacheDir)).toEqual(expect.arrayContaining([200, 33, 44]));

    const beforeTrendRefresh = totalCalls(h.calls);
    const reportCountBefore = reportCount(h.dataDir);

    // forceTrend refreshes only the official trend aggregate; the dataset and
    // its KPI aggregates are reused.
    const fourth = await runJob(h, request(h, { forceTrend: true }));
    expect(fourth.status).toBe('completed');
    expect(totalCalls(h.calls)).toBe(beforeTrendRefresh + 1);
    expect(h.calls.monthly).toBe(2);
    expect(h.calls.reviews).toBe(2);
    expect(h.calls.allTime).toBe(2);

    const report4 = h.manager.getReport(fourth.jobId);
    expect(report4.trend.points[0].total).toBe(77);
    expect(report4.methodology.dataSource).toBe('local_dataset');
    expect(report4.kpis.allTime.total).toBe(200);
    // The refreshed trend was also written back to the short-term cache.
    expect(cachedTotals(h.cacheDir)).toEqual(expect.arrayContaining([77]));

    const dataset4 = await readDataset(h.dataDir, APPID, hash);
    expect(dataset4!.meta.fetchedAt).toBe(dataset3!.meta.fetchedAt);
    expect(dataset4!.reviews[0].text).toBe('Combat feels great v2');
    // A new trend content hash legitimately creates its own report file.
    expect(reportCount(h.dataDir)).toBeGreaterThanOrEqual(reportCountBefore);

    // A following normal job reuses the refreshed dataset, trend and report
    // without any Steam request.
    const beforeFifth = totalCalls(h.calls);
    const fifth = await runJob(h, normal);
    expect(fifth.status).toBe('completed');
    expect(totalCalls(h.calls)).toBe(beforeFifth);
    expect(h.manager.getReport(fifth.jobId).trend.points[0].total).toBe(77);
  });
});
