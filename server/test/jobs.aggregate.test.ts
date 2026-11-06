import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, type AIFactory } from '../src/jobs/manager';
import { silentLogger } from '../src/lib/logger';
import { createSteamService } from '../src/steam/service';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import { buildReviewsHash, metaFilePath } from '../src/storage/dataset';
import { readJsonFile } from '../src/lib/fs';
import type { CreateJobRequest, DatasetMeta, JobSnapshot, Review, ScrapeFilters } from '../src/types';
import { FakeAIProvider, SAMPLE_ANALYSIS, makeConfig } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-aggregate-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const APPID = 570;

const SAMPLE_REVIEWS: Review[] = [
  {
    id: 'r1',
    language: 'english',
    votedUp: true,
    votesUp: 50,
    weightedVoteScore: 0.5,
    playtimeAtReviewMinutes: 120,
    createdAt: Math.floor(Date.now() / 1000) - 5 * 86400,
    text: 'Combat feels great and the boss fights are fun',
    writtenDuringEarlyAccess: false,
    receivedForFree: false,
  },
  {
    id: 'r2',
    language: 'english',
    votedUp: false,
    votesUp: 20,
    weightedVoteScore: 0.2,
    playtimeAtReviewMinutes: 60,
    createdAt: Math.floor(Date.now() / 1000) - 10 * 86400,
    text: 'Too expensive for the amount of content',
    writtenDuringEarlyAccess: false,
    receivedForFree: false,
  },
  {
    id: 'r3',
    language: 'english',
    votedUp: true,
    votesUp: 5,
    weightedVoteScore: 0.1,
    playtimeAtReviewMinutes: 200,
    createdAt: Math.floor(Date.now() / 1000) - 40 * 86400,
    text: 'Performance is great on my PC',
    writtenDuringEarlyAccess: false,
    receivedForFree: false,
  },
];

interface Counts {
  total: number;
  positive: number;
  negative: number;
  reviewScoreDesc: string;
}

/** Distinct summaries per window so an accidental 30/90-day fallback is visible. */
function summaryFor(params: Record<string, unknown>): Counts {
  if (params.date_range_start !== undefined || params.start_date !== undefined) {
    return { total: 100, positive: 80, negative: 20, reviewScoreDesc: '好评' };
  }
  if (params.day_range !== undefined) {
    const days = Number(params.day_range);
    if (days === 30) return { total: 300, positive: 240, negative: 60, reviewScoreDesc: '好评' };
    if (days === 90) return { total: 600, positive: 420, negative: 180, reviewScoreDesc: '多半好评' };
    if (days === 0) return { total: 1000, positive: 900, negative: 100, reviewScoreDesc: '特别好评' };
  }
  return { total: 1000, positive: 900, negative: 100, reviewScoreDesc: '特别好评' };
}

function officialSummary(params: Record<string, unknown>): Record<string, unknown> {
  const counts = summaryFor(params);
  return {
    num_reviews: counts.total,
    review_score: 8,
    review_score_desc: counts.reviewScoreDesc,
    total_positive: counts.positive,
    total_negative: counts.negative,
    total_reviews: counts.total,
  };
}

function storefrontSummary(params: Record<string, unknown>): Record<string, unknown> {
  const counts = summaryFor(params);
  return {
    review_score: 8,
    review_score_desc: counts.reviewScoreDesc,
    total_positive: counts.positive,
    total_negative: counts.negative,
    total_reviews: counts.total,
  };
}

function rawReviews(): unknown[] {
  return SAMPLE_REVIEWS.map((review) => ({
    recommendationid: review.id,
    language: review.language,
    voted_up: review.votedUp,
    votes_up: review.votesUp,
    weighted_vote_score: String(review.weightedVoteScore),
    author: { playtime_at_review: review.playtimeAtReviewMinutes },
    timestamp_created: review.createdAt,
    review: review.text,
    written_during_early_access: review.writtenDuringEarlyAccess,
    received_for_free: review.receivedForFree,
  }));
}

interface Captured {
  official: Array<Record<string, unknown>>;
  storefront: Array<Record<string, string>>;
}

interface MockOptions {
  /** Force every official aggregate (num_per_page=1) request to 503. */
  officialAggregatesDown?: boolean;
}

function makeFetch(captured: Captured, opts: MockOptions = {}): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.includes('/api/appdetails')) {
      return jsonResponse({
        [APPID]: {
          success: true,
          data: { name: 'Mapped Game', release_date: { date: '1 Jan, 2020' } },
        },
      });
    }
    if (url.pathname.includes('/IUserReviewsService/')) {
      const raw = url.searchParams.get('input_json');
      const params = JSON.parse(raw ?? '{}') as Record<string, unknown>;
      captured.official.push(params);
      if (opts.officialAggregatesDown && Number(params.num_per_page) === 1) {
        return new Response('upstream down', { status: 503 });
      }
      return jsonResponse({
        response: {
          success: 1,
          query_summary: officialSummary(params),
          reviews: Number(params.num_per_page) > 1 ? rawReviews() : [],
          cursor: null,
        },
      });
    }
    if (url.pathname.includes('/ajaxappreviews/')) {
      const params = Object.fromEntries(url.searchParams.entries());
      captured.storefront.push(params);
      return jsonResponse({
        success: 1,
        query_summary: storefrontSummary(params),
        reviews: Number(params.num_per_page) > 1 ? rawReviews() : [],
        total_matching: summaryFor(params).total,
        cursor: null,
      });
    }
    throw new Error(`unexpected Steam URL: ${url.toString()}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jobRequest(dataDir: string, overrides: Partial<CreateJobRequest> = {}): CreateJobRequest {
  return {
    appid: APPID,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    trend: { months: 3 },
    ai: { model: 'deepseek-flash', thinking: false },
    options: { maxReviews: 50, includeTranslations: false, topReviews: 3 },
    data: {
      dataDir,
      reuseDataset: true,
      reuseReport: true,
      forceFetch: false,
      forceAnalyze: false,
      forceTrend: false,
    },
    ...overrides,
  };
}

async function waitForJob(manager: JobManager, jobId: string, timeoutMs = 10000): Promise<JobSnapshot> {
  const started = Date.now();
  for (;;) {
    const snapshot = manager.getSnapshot(jobId);
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`job timeout: ${JSON.stringify(snapshot)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function buildManager(dataDir: string, fetchImpl: typeof fetch): { manager: JobManager; ai: FakeAIProvider } {
  const config = makeConfig(dataDir);
  const steam = createSteamService(config, { fetchImpl, sleep: async () => {}, delayMs: 0, cache: null });
  const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
  const aiFactory: AIFactory = () => ai;
  const manager = new JobManager({ config, steam, aiFactory, logger: silentLogger });
  return { manager, ai };
}

function allTimeOfficialRequest(captured: Captured): Record<string, unknown> {
  const matches = captured.official.filter(
    (p) => Number(p.num_per_page) === 1 && Number(p.day_range) === 0 && p.date_range_start === undefined,
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

function allTimeStorefrontRequest(captured: Captured): Record<string, string> {
  const matches = captured.storefront.filter(
    (p) => p.num_per_page === '1' && p.day_range === '0' && p.start_date === undefined,
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('real Steam parameter mapping for all-time and rolling KPIs', () => {
  it('requests an explicit unlimited all-time window and maps 30/90-day aggregates', async () => {
    const dataDir = tmpDir();
    const captured: Captured = { official: [], storefront: [] };
    const { manager, ai } = buildManager(dataDir, makeFetch(captured));
    const request = jobRequest(dataDir);
    const { jobId } = manager.createJob(request, 'sk-test-aggregate', dataDir);

    const snapshot = await waitForJob(manager, jobId);
    expect(snapshot.status).toBe('completed');
    const report = manager.getReport(jobId);

    // The all-time aggregate must never rely on Steam's helpful-sort default
    // 30-day window: day_range=0 plus review_type=all and no date range.
    const allTime = allTimeOfficialRequest(captured);
    expect(allTime.day_range).toBe(0);
    expect(allTime.review_type).toBe(0);
    expect(allTime.date_range_start).toBeUndefined();
    expect(allTime.date_range_end).toBeUndefined();

    const kpi30 = captured.official.find((p) => Number(p.day_range) === 30);
    const kpi90 = captured.official.find((p) => Number(p.day_range) === 90);
    expect(kpi30).toMatchObject({ review_type: 0, num_per_page: 1 });
    expect(kpi90).toMatchObject({ review_type: 0, num_per_page: 1 });
    expect(kpi30?.date_range_start).toBeUndefined();
    expect(kpi90?.date_range_start).toBeUndefined();

    // Distinct all-time/30-day/90-day summaries flow all the way into the report.
    expect(report.kpis.allTime).toMatchObject({ total: 1000, positiveRate: 0.9, reviewScoreDesc: '特别好评' });
    expect(report.kpis.last30d).toMatchObject({ total: 300, positiveRate: 0.8, reviewScoreDesc: '好评' });
    expect(report.kpis.last90d).toMatchObject({ total: 600, positiveRate: 0.7, reviewScoreDesc: '多半好评' });
    expect(report.kpis.sources).toEqual({ last30d: 'official_aggregate', last90d: 'official_aggregate' });
    expect(report.sample.fetched).toBe(3);
    expect(report.sample.matchedTotal).toBe(1000);
    expect(ai.calls.length).toBeGreaterThan(0);

    // The exact aggregate snapshot is persisted with the dataset, together with
    // the computation time that makes the rolling windows auditable.
    const reviewsHash = buildReviewsHash({
      appid: APPID,
      filters: request.filters,
      clientFilters: request.clientFilters,
      maxReviews: 50,
    });
    const meta = await readJsonFile<DatasetMeta>(metaFilePath(dataDir, APPID, reviewsHash));
    expect(meta.allTimeSummary).toMatchObject({
      total: 1000,
      positive: 900,
      negative: 100,
      positiveRate: 0.9,
      sourceEndpoint: 'official',
    });
    expect(meta.rollingKpis?.last30d).toMatchObject({ total: 300, positive: 240, negative: 60, positiveRate: 0.8 });
    expect(meta.rollingKpis?.last90d).toMatchObject({ total: 600, positive: 420, negative: 180, positiveRate: 0.7 });
    expect(meta.aggregatesComputedAt).toBeTruthy();
    expect(report.methodology.aggregatesComputedAt).toBe(meta.aggregatesComputedAt);
  });

  it('maps the same explicit unlimited window to the storefront fallback endpoint', async () => {
    const dataDir = tmpDir();
    const captured: Captured = { official: [], storefront: [] };
    const { manager } = buildManager(dataDir, makeFetch(captured, { officialAggregatesDown: true }));
    const request = jobRequest(dataDir);
    const { jobId } = manager.createJob(request, 'sk-test-aggregate', dataDir);

    const snapshot = await waitForJob(manager, jobId);
    expect(snapshot.status).toBe('completed');
    const report = manager.getReport(jobId);

    // The official all-time request was attempted and failed; the storefront
    // fallback must carry the same explicit unlimited window.
    expect(
      captured.official.some(
        (p) => Number(p.num_per_page) === 1 && Number(p.day_range) === 0 && p.date_range_start === undefined,
      ),
    ).toBe(true);
    const allTime = allTimeStorefrontRequest(captured);
    expect(allTime.day_range).toBe('0');
    expect(allTime.review_type).toBe('all');
    expect(allTime.start_date).toBeUndefined();
    expect(allTime.end_date).toBeUndefined();
    const kpi30 = captured.storefront.find((p) => p.num_per_page === '1' && p.day_range === '30');
    const kpi90 = captured.storefront.find((p) => p.num_per_page === '1' && p.day_range === '90');
    expect(kpi30).toMatchObject({ review_type: 'all' });
    expect(kpi90).toMatchObject({ review_type: 'all' });
    expect(kpi30?.start_date).toBeUndefined();
    expect(kpi90?.start_date).toBeUndefined();

    expect(report.sample.sourceEndpoint).toBe('official');
    expect(report.kpis.allTime).toMatchObject({ total: 1000, positiveRate: 0.9 });
    expect(report.kpis.last30d).toMatchObject({ total: 300, positiveRate: 0.8 });
    expect(report.kpis.last90d).toMatchObject({ total: 600, positiveRate: 0.7 });
    expect(report.kpis.sources).toEqual({ last30d: 'official_aggregate', last90d: 'official_aggregate' });
  });

  it('keeps the legacy helpful-sort mapping when no override is supplied', async () => {
    // Guard the underlying mapping helper directly: removing the explicit 0
    // must be the only way to lose the unlimited window.
    const { toOfficialInput, toStorefrontQuery } = await import('../src/steam/filters');
    const filters: ScrapeFilters = withFilterDefaults();
    expect(toOfficialInput(APPID, filters).day_range).toBe(0);
    expect(toStorefrontQuery(filters).day_range).toBe('0');
  });
});
