import type { ServerConfig } from '../lib/config';
import type { Logger } from '../lib/logger';
import { silentLogger } from '../lib/logger';
import { AppError, toAppError } from '../lib/errors';
import type { CreateJobRequest, DatasetMeta, GameMeta, KpiWindows, Report, Review, SteamSummary, TrendDataset } from '../types';
import type { SteamService } from '../steam/service';
import { DeepSeekProvider, baseUrlHost, type AIProvider } from '../ai/deepseek';
import { PROMPT_VERSION } from '../ai/prompts';
import { buildAnalysisHash, cloneReportWithServed, readReport, rebuildTopReviewsFromDataset, saveReport } from '../storage/report';
import {
  buildReviewsHash,
  readDataset,
  readTrend,
  saveTrend,
  updateDatasetMeta,
  writeDataset,
} from '../storage/dataset';
import { anchorMonthOf, buildTrendHash, computeTrend } from '../steam/trend';
import { computeRollingKpis } from '../steam/kpi';
import { RequestBudget } from '../steam/budget';
import { analyzeReviews } from '../analysis/pipeline';
import { buildReport, refreshReport } from '../analysis/report';
import { JobStore, type JobEvent, type JobRecord } from './store';

export type AIFactory = (opts: { apiKey: string; baseUrl?: string; model: string }) => AIProvider;

export interface JobManagerDeps {
  config: ServerConfig;
  steam: SteamService;
  store?: JobStore;
  aiFactory?: AIFactory;
  logger?: Logger;
  now?: () => number;
}

export interface CreateJobResult {
  jobId: string;
}

/**
 * In-memory job manager. Holds the DeepSeek key only for the lifetime of a job
 * and clears it on completion, failure or cancellation. No disk persistence.
 */
export class JobManager {
  readonly store: JobStore;
  private readonly config: ServerConfig;
  private readonly steam: SteamService;
  private readonly aiFactory: AIFactory;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: JobManagerDeps) {
    this.config = deps.config;
    this.steam = deps.steam;
    this.store = deps.store ?? new JobStore({ retentionMs: deps.config.jobRetentionMs, maxActive: deps.config.maxConcurrentJobs });
    this.aiFactory =
      deps.aiFactory ??
      ((opts) =>
        new DeepSeekProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, timeoutMs: deps.config.aiTimeoutMs }));
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
  }

  createJob(request: CreateJobRequest, apiKey: string, dataDir: string): CreateJobResult {
    const record = this.store.create({ request, apiKey, dataDir });
    void this.run(record);
    return { jobId: record.id };
  }

  getSnapshot(id: string) {
    return this.store.snapshot(this.store.require(id));
  }

  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    return this.store.subscribe(id, listener);
  }

  cancel(id: string): void {
    this.store.cancel(id);
  }

  getReport(id: string): Report {
    return this.store.getReport(id);
  }

  private counters(): { steamRequests: number; cacheHits: number } {
    return this.steam.counters();
  }

  private delta(before: { steamRequests: number; cacheHits: number }): { steamRequests: number; cacheHits: number } {
    const after = this.steam.counters();
    return {
      steamRequests: Math.max(0, after.steamRequests - before.steamRequests),
      cacheHits: Math.max(0, after.cacheHits - before.cacheHits),
    };
  }

  private async run(record: JobRecord): Promise<void> {
    const store = this.store;
    const request = record.request;
    const dataDir = record.dataDir;
    const startedCounters = this.counters();
    // One shared hard request cap for the whole analysis task (design §6.4,
    // review Major 6): app details, review pages, trend aggregates, KPI windows
    // and the lazy trend fallback all deduct from this same budget.
    const budget = new RequestBudget(this.config.maxPagesPerJob);
    const nowIso = () => new Date(this.now()).toISOString();
    const forceFetch = request.data.forceFetch === true;
    const forceTrend = request.data.forceTrend === true;
    // Cancellation boundary: never begin a paid AI call, a report build or a
    // disk write after the job has been cancelled.
    const ensureActive = () => {
      if (record.abort.signal.aborted || record.status === 'cancelled') throw new AppError('CANCELLED');
    };

    try {
      if (record.abort.signal.aborted || record.status === 'cancelled') return;
      store.update(record, { status: 'running', stage: 'resolving', progress: 2, message: '准备任务' });

      let game: GameMeta | null = null;
      const reviewsHash = buildReviewsHash({
        appid: request.appid,
        filters: request.filters,
        clientFilters: request.clientFilters,
        maxReviews: request.options.maxReviews,
      });
      const allowReviewReuse = request.data.reuseDataset !== false && !forceFetch;
      // Review reuse and trend reuse are independent controls (review Major 10):
      // forceFetch/reuseDataset only affect reviews; only forceTrend refreshes
      // the official trend aggregate.
      const allowTrendReuse = !forceTrend;
      let reviews: Review[] | null = null;
      let meta: DatasetMeta | null = null;
      let dataSource: 'fresh' | 'local_dataset' = 'fresh';

      if (allowReviewReuse) {
        const local = await readDataset(dataDir, request.appid, reviewsHash);
        if (local && local.status === 'complete' && local.reviews.length > 0) {
          reviews = local.reviews;
          meta = local.meta;
          game = local.meta.game;
          dataSource = 'local_dataset';
          store.update(record, {
            stage: 'fetching_reviews',
            progress: 20,
            message: `复用本地数据：${reviews.length} 条，抓取于 ${meta.fetchedAt}`,
            counts: { fetched: reviews.length, target: request.options.maxReviews },
          });
          store.log(record, 'info', `复用本地评论数据集 ${reviewsHash}，未请求 Steam`);
        }
      }

      if (!reviews || !meta) {
        game = await this.steam.resolveGame(request.appid, record.abort.signal, budget, forceFetch);
        store.log(record, 'info', `游戏：${game.name}（AppID ${game.appid}）`);
        store.update(record, {
          stage: 'fetching_reviews',
          progress: 5,
          message: '抓取 Steam 评论',
          counts: { fetched: 0, target: request.options.maxReviews },
        });
        const result = await this.steam.fetchReviews(request.appid, {
          filters: request.filters,
          clientFilters: request.clientFilters,
          maxReviews: request.options.maxReviews,
          maxPages: this.config.maxPagesForScrape,
          budget,
          signal: record.abort.signal,
          // Explicit "重新抓取" must penetrate SteamClient's short-term cache,
          // not merely skip the local dataset.
          refresh: forceFetch,
          onProgress: (info) => {
            const pct = 5 + Math.min(15, (info.fetched / Math.max(1, info.target)) * 15);
            store.update(record, {
              stage: 'fetching_reviews',
              progress: pct,
              message: `已抓取 ${info.fetched}/${info.target} 条（第 ${info.pages} 页）`,
              counts: { fetched: info.fetched, target: info.target, pages: info.pages, total: info.total ?? 0 },
            });
          },
        });
        if (result.reviews.length === 0) throw new AppError('NO_REVIEWS');
        dataSource = 'fresh';
        reviews = result.reviews;
        meta = await writeDataset(
          dataDir,
          {
            appid: request.appid,
            game,
            reviewsHash,
            filters: request.filters,
            clientFilters: request.clientFilters,
            maxReviews: request.options.maxReviews,
            fetchedAt: nowIso(),
            sourceEndpoint: result.sourceEndpoint,
            summary: result.summary,
          },
          result.reviews,
        );
        store.log(record, 'info', `抓取完成：${reviews.length} 条，${result.pages} 页，端点 ${result.sourceEndpoint}`);
        store.update(record, {
          stage: 'fetching_reviews',
          progress: 20,
          message: `抓取完成：${reviews.length} 条`,
          counts: { fetched: reviews.length, target: request.options.maxReviews, pages: result.pages },
        });
      }

      if (!reviews || !meta || !game) throw new AppError('INTERNAL', '评论数据集未就绪');
      const summary: SteamSummary | null = meta.summary;
      const months = request.trend.months;
      const timezone = this.config.timezone;
      const trendHash = buildTrendHash(
        request.appid,
        months,
        anchorMonthOf(new Date(this.now()), timezone),
        timezone,
        request.filters,
      );
      let trend: TrendDataset | null = null;
      let trendReused = false;
      if (allowTrendReuse) {
        trend = await readTrend(dataDir, request.appid, trendHash, { timezone });
        if (trend) {
          trendReused = true;
          store.log(record, 'info', `复用本地趋势 ${trendHash}`);
        }
      }
      if (!trend) {
        store.update(record, { stage: 'fetching_trends', progress: 25, message: `获取 ${months} 个月官方趋势` });
        trend = await computeTrend(request.appid, {
          months,
          timezone,
          client: this.steam,
          filters: request.filters,
          releaseDate: game.releaseDate,
          budget,
          signal: record.abort.signal,
          refresh: forceTrend,
          now: new Date(this.now()),
        });
        await saveTrend(dataDir, request.appid, trend);
        store.log(record, 'info', `趋势获取完成：${trend.points.length} 个月（${trend.source}）`);
      }
      store.update(record, {
        stage: 'preparing',
        progress: 38,
        message: '准备分析样本',
        counts: { fetched: reviews.length, target: request.options.maxReviews, months: trend.points.length },
      });

      const analysisHash = buildAnalysisHash({
        reviewsContentHash: meta.reviewsContentHash,
        trendContentHash: trend.trendContentHash,
        provider: 'deepseek',
        model: request.ai.model,
        baseUrlHost: baseUrlHost(request.ai.baseUrl),
        promptVersion: PROMPT_VERSION,
        thinking: request.ai.thinking,
        includeTranslations: request.options.includeTranslations,
        temperature: request.ai.temperature,
      });

      // All-time and rolling 30/90-day aggregates are persisted with the local
      // dataset and reused without touching Steam when a complete dataset is
      // reused (review R3 Major). They are only re-fetched on explicit refresh
      // (`forceFetch`) or when the stored data is missing/unusable.
      let allTimeSummary: SteamSummary | null = meta.allTimeSummary ?? null;
      let rollingKpis: KpiWindows | null = meta.rollingKpis ?? null;
      let aggregatesComputedAt = meta.aggregatesComputedAt;
      if (request.data.forceFetch === true) {
        allTimeSummary = null;
        rollingKpis = null;
        aggregatesComputedAt = undefined;
      }
      let aggregatesDirty = false;

      if (!allTimeSummary) {
        try {
          const page = await this.steam.fetchAggregate(request.appid, request.filters, {
            reviewTypeOverride: 'all',
            dateRangeOverride: null,
            // The all-time KPI must not fall back to Steam's helpful-sort
            // default 30-day window. `day_range=0` is the explicit unlimited
            // window, mapped to both official and storefront endpoints.
            dayRangeOverride: 0,
            numPerPage: 1,
            budget,
            signal: record.abort.signal,
            refresh: forceFetch,
          });
          allTimeSummary = page.summary;
          aggregatesDirty = Boolean(allTimeSummary);
        } catch (err) {
          if (err instanceof AppError && (err.code === 'CANCELLED' || err.code === 'STEAM_RATE_LIMITED')) throw err;
          allTimeSummary = null;
          store.log(record, 'warn', '全部时间官方聚合不可用，全部时间 KPI 将显式标记为样本估算');
        }
      }

      // True rolling 30/90-day KPI windows (review Major 7), independent of the
      // trend's natural months and of the AI sample's review-type/date filters.
      if (!rollingKpis) {
        rollingKpis = await computeRollingKpis({
          appid: request.appid,
          client: this.steam,
          filters: request.filters,
          sampleReviews: reviews,
          budget,
          signal: record.abort.signal,
          refresh: forceFetch,
          now: new Date(this.now()),
        });
        aggregatesDirty = true;
      }

      if (aggregatesDirty) {
        aggregatesComputedAt = nowIso();
        const nextMeta: DatasetMeta = { ...meta, allTimeSummary, rollingKpis, aggregatesComputedAt };
        const committed = await updateDatasetMeta(dataDir, nextMeta);
        if (committed) {
          meta = committed;
        } else {
          store.log(record, 'warn', '评论数据集已被并发更新，本次 KPI 聚合未写回磁盘（不会覆盖较新的数据）');
        }
      } else if (aggregatesComputedAt) {
        store.log(record, 'info', `复用本地 KPI 聚合（计算于 ${aggregatesComputedAt}），未请求 Steam`);
      }

      if (request.data.reuseReport !== false && request.data.forceAnalyze !== true) {
        const cached = await readReport(dataDir, request.appid, analysisHash);
        if (cached) {
          const reuseCounters = this.delta(startedCounters);
          // Refresh all dynamic KPI/label/methodology fields before serving;
          // only the AI narrative is reused (and costs no tokens). A cached
          // report that cannot be refreshed safely falls through to a fresh
          // analysis instead of failing the job (review Major 5).
          try {
            const refreshed = refreshReport(cached, {
              reviews,
              allTimeSummary,
              rollingKpis,
              trend,
              filters: request.filters,
              clientFilters: request.clientFilters,
              sourceEndpoint: meta.sourceEndpoint,
              matchedTotal: meta.summary?.matchingTotal ?? reviews.length,
              includeTranslations: request.options.includeTranslations,
              methodology: {
                trendSource: trendReused ? 'local_cache' : trend.source,
                steamRequests: reuseCounters.steamRequests,
                cacheHits: reuseCounters.cacheHits,
                ...(aggregatesComputedAt ? { aggregatesComputedAt } : {}),
                dataSource,
                dataDir,
                datasetFetchedAt: meta.fetchedAt || undefined,
                reviewsHash: meta.reviewsHash,
              },
              now: new Date(this.now()),
            });
            const topReviews = await rebuildTopReviewsFromDataset(
              dataDir,
              request.appid,
              meta.reviewsHash,
              request.options.topReviews,
              refreshed.topReviews,
            );
            const served = cloneReportWithServed(refreshed, topReviews, new Date(this.now()));
            store.log(record, 'info', '使用本地分析结果（KPI 已按本次数据刷新），本次未消耗 token');
            store.update(record, {
              stage: 'saving',
              progress: 98,
              message: '复用本地分析结果',
            });
            store.complete(record, served);
            return;
          } catch (err) {
            store.log(
              record,
              'warn',
              `本地分析结果无法安全刷新，改为重新分析：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      if (!record.apiKey) throw new AppError('INVALID_AI_KEY', '任务缺少 API Key');
      ensureActive();
      const provider = this.aiFactory({
        apiKey: record.apiKey,
        baseUrl: request.ai.baseUrl,
        model: request.ai.model,
      });

      store.update(record, { stage: 'analyzing', progress: 40, message: 'AI 分块分析中' });
      const analysis = await analyzeReviews({
        game,
        reviews,
        trend,
        summary,
        allTimeSummary,
        rollingKpis,
        filters: request.filters,
        clientFilters: request.clientFilters,
        ai: provider,
        aiOptions: request.ai,
        includeTranslations: request.options.includeTranslations,
        maxChunks: this.config.aiMaxChunks,
        signal: record.abort.signal,
        onProgress: (info) => {
          store.update(record, {
            stage: info.stage,
            progress: info.progress,
            message: info.message,
            counts: info.counts ?? record.counts,
          });
        },
      });
      store.update(record, { stage: 'validating', progress: 96, message: '校验证据并计算 KPI' });
      ensureActive();

      const counters = this.delta(startedCounters);
      const report = buildReport({
        game,
        filters: request.filters,
        clientFilters: request.clientFilters,
        reviews,
        usedForAI: analysis.usedForAI,
        matchedTotal: meta.summary?.matchingTotal ?? reviews.length,
        trend,
        summary,
        allTimeSummary,
        rollingKpis,
        analysis: analysis.analysis,
        usage: analysis.usage,
        aiOptions: request.ai,
        includeTranslations: request.options.includeTranslations,
        topReviews: request.options.topReviews,
        methodology: {
          dataSource,
          trendSource: trendReused ? 'local_cache' : trend.source,
          analysisSource: 'fresh',
          dataDir,
          datasetFetchedAt: meta.fetchedAt,
          ...(aggregatesComputedAt ? { aggregatesComputedAt } : {}),
          reviewsHash: meta.reviewsHash,
          trendHash: trend.trendHash,
          steamRequests: counters.steamRequests,
          cacheHits: counters.cacheHits,
        },
        now: new Date(this.now()),
      });

      store.update(record, { stage: 'saving', progress: 98, message: '保存报告' });
      ensureActive();
      await saveReport(dataDir, request.appid, analysisHash, report);
      store.log(record, 'info', `报告已保存：${analysisHash}`);
      store.complete(record, report);
    } catch (err) {
      if (record.status === 'cancelled' || record.abort.signal.aborted) {
        if (record.status !== 'cancelled') {
          store.cancel(record.id);
        }
        return;
      }
      const appErr = toAppError(err);
      this.logger.warn('job failed', { jobId: record.id, code: appErr.code });
      store.fail(record, { code: appErr.code, message: appErr.displayMessage, ...(appErr.detail ? { detail: appErr.detail } : {}) });
    }
  }
}
