import path from 'node:path';
import { AppError } from '../src/lib/errors';
import type { ServerConfig } from '../src/lib/config';
import type { AIProvider, AIChatRequest, AIChatResult, AITestResult } from '../src/ai/deepseek';
import type { SteamService } from '../src/steam/service';
import type { FetchReviewsOptions, FetchReviewsResult, PageRequestOptions, TrendSampleOptions } from '../src/steam/client';
import type { RequestBudget } from '../src/steam/budget';
import type { GameMeta, Review, ScrapeFilters, SteamPage, SteamSummary } from '../src/types';

export function makeReview(overrides: Partial<Review> & { id: string }): Review {
  return {
    language: 'english',
    votedUp: true,
    votesUp: 10,
    weightedVoteScore: 0.5,
    playtimeAtReviewMinutes: 120,
    createdAt: Math.floor(Date.now() / 1000) - 86400,
    text: `Review ${overrides.id} text`,
    writtenDuringEarlyAccess: false,
    receivedForFree: false,
    ...overrides,
  };
}

export const SAMPLE_REVIEWS: Review[] = [
  makeReview({
    id: 'r1',
    text: 'Combat feels great and the boss fights are fun',
    votesUp: 50,
    createdAt: Math.floor(Date.now() / 1000) - 5 * 86400,
  }),
  makeReview({
    id: 'r2',
    text: 'Too expensive for the amount of content',
    votedUp: false,
    votesUp: 20,
    createdAt: Math.floor(Date.now() / 1000) - 10 * 86400,
  }),
  makeReview({
    id: 'r3',
    text: 'Performance is great on my PC',
    votesUp: 5,
    createdAt: Math.floor(Date.now() / 1000) - 40 * 86400,
  }),
];

export const SAMPLE_SUMMARY: SteamSummary = {
  total: 1000,
  positive: 900,
  negative: 100,
  positiveRate: 0.9,
  reviewScoreDesc: '特别好评',
  matchingTotal: 1000,
  sourceEndpoint: 'official',
};

export const SAMPLE_ANALYSIS = {
  themes: [
    {
      name: '战斗手感',
      category: 'gameplay',
      sentiment: 'positive',
      summary: '玩家认可战斗与 Boss 设计',
      evidenceIds: ['r1'],
      quotes: [{ reviewId: 'r1', original: 'Combat feels great' }],
    },
    {
      name: '价格偏高',
      category: 'price',
      sentiment: 'negative',
      summary: '部分玩家认为内容量与价格不匹配',
      evidenceIds: ['r2'],
      quotes: [{ reviewId: 'r2', original: 'Too expensive' }],
    },
  ],
  expectationGaps: [],
  updateImpact: [],
  recommendations: [
    { title: '保持战斗设计', detail: '战斗与 Boss 是核心卖点', priority: 'high', evidenceIds: ['r1'] },
  ],
  conclusion: {
    label: 'AI 建议标签（应被覆盖）',
    headline: '战斗获认可，价格存在争议',
    summary: '样本玩家认可战斗手感，但认为价格偏高。',
    confidence: 'high',
    caveats: ['AI 附加局限'],
  },
};

export interface FakeSteamOptions {
  reviews?: Review[];
  summary?: SteamSummary;
  fetchDelayMs?: number;
  notFound?: boolean;
  aggregateFail?: boolean;
  allTimeFail?: boolean;
  trendSampleFail?: boolean;
  empty?: boolean;
}

export class FakeSteam implements SteamService {
  reviews: Review[];
  summary: SteamSummary;
  fetchDelayMs: number;
  notFound: boolean;
  aggregateFail: boolean;
  allTimeFail: boolean;
  trendSampleFail: boolean;
  empty: boolean;
  resolveCalls = 0;
  fetchCalls = 0;
  aggregateCalls = 0;
  aggregateOptions: PageRequestOptions[] = [];
  trendSampleCalls = 0;
  trendSampleFilters: ScrapeFilters[] = [];
  steamRequests = 0;
  cacheHits = 0;
  cacheCleared = 0;

  constructor(opts: FakeSteamOptions = {}) {
    this.reviews = opts.reviews ?? SAMPLE_REVIEWS;
    this.summary = opts.summary ?? SAMPLE_SUMMARY;
    this.fetchDelayMs = opts.fetchDelayMs ?? 0;
    this.notFound = opts.notFound ?? false;
    this.aggregateFail = opts.aggregateFail ?? false;
    this.allTimeFail = opts.allTimeFail ?? false;
    this.trendSampleFail = opts.trendSampleFail ?? false;
    this.empty = opts.empty ?? false;
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      if (this.fetchDelayMs > 0) await new Promise((r) => setTimeout(r, this.fetchDelayMs));
      return;
    }
    if (signal.aborted) throw new AppError('CANCELLED');
    if (this.fetchDelayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.fetchDelayMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new AppError('CANCELLED'));
        },
        { once: true },
      );
    });
  }

  async resolveGame(appid: number, _signal?: AbortSignal, _budget?: RequestBudget): Promise<GameMeta> {
    this.resolveCalls += 1;
    this.steamRequests += 1;
    if (this.notFound) throw new AppError('APP_NOT_FOUND');
    return { appid, name: 'Test Game', releaseDate: '1 Jan, 2020' };
  }

  async fetchAggregate(appid: number, filters: ScrapeFilters, opts: PageRequestOptions = {}): Promise<SteamPage> {
    this.aggregateCalls += 1;
    this.aggregateOptions.push(opts);
    this.steamRequests += 1;
    await this.delay(opts.signal);
    if (this.aggregateFail) throw new AppError('STEAM_UNAVAILABLE');
    // Fail only the independent all-time aggregate, leaving trend months and
    // rolling 30/90-day windows unaffected.
    if (
      this.allTimeFail &&
      opts.reviewTypeOverride === 'all' &&
      opts.dayRangeOverride === 0 &&
      opts.dateRangeOverride === null
    ) {
      throw new AppError('STEAM_UNAVAILABLE', 'all-time aggregate down');
    }
    const summary: SteamSummary = this.empty
      ? { ...this.summary, total: 0, positive: 0, negative: 0, positiveRate: 0, matchingTotal: 0 }
      : this.summary;
    return {
      reviews: [],
      cursor: null,
      summary,
      matchingTotal: summary.matchingTotal,
      source: 'official',
    };
  }

  async fetchReviews(appid: number, opts: FetchReviewsOptions): Promise<FetchReviewsResult> {
    this.fetchCalls += 1;
    this.steamRequests += 1;
    await this.delay(opts.signal);
    const reviews = this.empty ? [] : this.reviews.slice(0, opts.maxReviews);
    opts.onProgress?.({ fetched: reviews.length, target: opts.maxReviews, pages: 1, total: this.summary.matchingTotal });
    return {
      reviews,
      pages: 1,
      sourceEndpoint: 'official',
      summary: this.empty ? { ...this.summary, matchingTotal: 0, total: 0 } : this.summary,
      matchedTotal: reviews.length,
    };
  }

  async fetchTrendSample(appid: number, filters: ScrapeFilters, opts: TrendSampleOptions): Promise<Review[]> {
    this.trendSampleCalls += 1;
    this.trendSampleFilters.push(filters);
    this.steamRequests += 1;
    await this.delay(opts.signal);
    if (this.trendSampleFail) throw new AppError('STEAM_UNAVAILABLE');
    const max = Math.max(1, opts.maxPages) * 100;
    return this.empty ? [] : this.reviews.slice(0, max);
  }

  async pace(signal?: AbortSignal): Promise<void> {
    await this.delay(signal);
  }

  resetCounters(): void {
    this.steamRequests = 0;
    this.cacheHits = 0;
  }

  counters(): { steamRequests: number; cacheHits: number } {
    return { steamRequests: this.steamRequests, cacheHits: this.cacheHits };
  }

  async clearCache(appid?: number): Promise<number> {
    this.cacheCleared += 1;
    return appid === undefined ? 3 : 1;
  }
}

export class FakeAIProvider implements AIProvider {
  calls: AIChatRequest[] = [];
  response: unknown | ((req: AIChatRequest) => unknown);
  delayMs: number;

  constructor(response: unknown | ((req: AIChatRequest) => unknown) = SAMPLE_ANALYSIS, delayMs = 0) {
    this.response = response;
    this.delayMs = delayMs;
  }

  async listModels(): Promise<string[]> {
    return ['deepseek-flash', 'deepseek-v4-pro'];
  }

  async testConnection(): Promise<AITestResult> {
    return { ok: true, latencyMs: 7, models: await this.listModels() };
  }

  async chatJson<T = unknown>(req: AIChatRequest): Promise<AIChatResult<T>> {
    this.calls.push(req);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (req.signal?.aborted) throw new AppError('CANCELLED');
    const data = typeof this.response === 'function' ? (this.response as (r: AIChatRequest) => unknown)(req) : this.response;
    const raw = JSON.stringify(data);
    return { data: data as T, usage: { input: 100, output: 50 }, raw };
  }
}

export function makeConfig(tmpDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    projectRoot: tmpDir,
    serverRoot: tmpDir,
    port: 53821,
    host: '127.0.0.1',
    cacheDir: path.join(tmpDir, '.cache'),
    dataDir: path.join(tmpDir, 'data'),
    logLevel: 'error',
    steamRequestDelayMs: 0,
    steamTimeoutMs: 5000,
    aiTimeoutMs: 5000,
    aiMaxChunks: 8,
    maxPagesPerJob: 60,
    maxPagesForScrape: 30,
    maxConcurrentJobs: 2,
    jobRetentionMs: 60 * 60 * 1000,
    timezone: 'Asia/Shanghai',
    webDist: path.join(tmpDir, 'web-dist'),
    version: '0.1.3',
    nodeEnv: 'test',
    ...overrides,
  };
}
