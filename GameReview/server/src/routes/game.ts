import { Router } from 'express';
import type { ServerConfig } from '../lib/config';
import { AppError } from '../lib/errors';
import type { SteamService } from '../steam/service';
import { parseSteamUrl } from '../steam/url';
import { resolveDataDir } from '../storage/paths';
import { buildReviewsHash, readDataset } from '../storage/dataset';
import { readTrend } from '../storage/dataset';
import { resolveGamePresentation } from '../storage/presentation';
import { buildAnalysisHash, listReportFiles, readReport } from '../storage/report';
import { estimateCostUsd } from '../ai/pricing';
import { PROMPT_VERSION } from '../ai/prompts';
import { baseUrlHost } from '../ai/deepseek';
import { estimateChunkCount, PREVIEW_AVERAGE_TOKENS_PER_REVIEW } from '../analysis/chunk';
import { withClientFilterDefaults, withFilterDefaults } from '../steam/filters';
import { anchorMonthOf, buildTrendHash } from '../steam/trend';
import type { DatasetHint, GameMeta, PreviewResult, ReportHint, SteamSummary } from '../types';
import { asyncHandler, validateDateRange, zodToAppError } from './helpers';
import { previewSchema, resolveSchema } from './schemas';

export interface GameRouteDeps {
  config: ServerConfig;
  steam: SteamService;
}

const CLIENT_FILTER_NOTICE =
  '预览匹配数为 Steam 侧聚合，未计入客户端二次筛选（最低赞数、关键词、最短字数、排除抢先体验/免费获得）；实际样本量可能更少。';

/** Base output-token estimate; thinking mode includes reasoning tokens (design §8.6). */
const BASE_OUTPUT_TOKENS = 2000;
const THINKING_OUTPUT_MULTIPLIER = 1.75;
/** Additional output for quote translations when the task enables them. */
const TRANSLATION_OUTPUT_TOKENS = 800;

interface ReportHintOptions {
  /** Exact analysis hash for the current dataset/trend/AI options, if computable. */
  analysisHash?: string;
  /** Prefer historical reports produced from the same dataset. */
  reviewsHash?: string;
}

async function reportHintFor(
  dataDir: string,
  appid: number,
  opts: ReportHintOptions = {},
): Promise<ReportHint | null> {
  if (opts.analysisHash) {
    const exact = await readReport(dataDir, appid, opts.analysisHash);
    if (exact) {
      return {
        analysisHash: opts.analysisHash,
        ...(exact.generatedAt ? { generatedAt: exact.generatedAt } : {}),
        ...(exact.methodology?.aiModel ? { model: exact.methodology.aiModel } : {}),
        match: 'exact',
        reusable: true,
      };
    }
  }
  const hashes = await listReportFiles(dataDir, appid);
  let best: ReportHint | null = null;
  let bestSameDataset: ReportHint | null = null;
  for (const analysisHash of hashes.slice(0, 40)) {
    const report = await readReport(dataDir, appid, analysisHash);
    if (!report) continue;
    const hint: ReportHint = {
      analysisHash,
      ...(report.generatedAt ? { generatedAt: report.generatedAt } : {}),
      ...(report.methodology?.aiModel ? { model: report.methodology.aiModel } : {}),
      // Without a matching analysisHash this is history only: it must never be
      // presented as reusable (review Major 11).
      match: 'historical',
      reusable: false,
    };
    if (!best || (hint.generatedAt ?? '') > (best.generatedAt ?? '')) best = hint;
    if (
      opts.reviewsHash &&
      report.methodology?.reviewsHash === opts.reviewsHash &&
      (!bestSameDataset || (hint.generatedAt ?? '') > (bestSameDataset.generatedAt ?? ''))
    ) {
      bestSameDataset = hint;
    }
  }
  return bestSameDataset ?? best;
}

function datasetHint(fetchedAt: string, reviewCount: number, reviewsHash: string, game?: string): DatasetHint {
  const ageDays = fetchedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 86400000)) : undefined;
  return { reviewsHash, reviewCount, fetchedAt, ...(game ? { game } : {}), ...(ageDays !== undefined ? { staleDays: ageDays } : {}) };
}

export function gameRoutes(deps: GameRouteDeps): Router {
  const router = Router();
  const dataDirOptions = { projectRoot: deps.config.projectRoot, defaultDataDir: deps.config.dataDir };

  router.post(
    '/game/resolve',
    asyncHandler(async (req, res) => {
      const body = resolveSchema.parse(req.body ?? {});
      const appid = parseSteamUrl(body.url);
      const game = await deps.steam.resolveGame(appid);
      res.json({ appid, game });
    }),
  );

  router.post(
    '/game/preview',
    asyncHandler(async (req, res) => {
      let body: ReturnType<typeof previewSchema.parse>;
      try {
        body = previewSchema.parse(req.body ?? {});
      } catch (err) {
        throw zodToAppError(err as never);
      }
      const appid = body.appid;
      const filters = withFilterDefaults(body.filters);
      const clientFilters = withClientFilterDefaults(body.clientFilters);
      validateDateRange(filters.dateRange?.start, filters.dateRange?.end);
      const dataDir = resolveDataDir(body.dataDir, dataDirOptions);
      const months = body.trend.months;

      const reviewsHash = buildReviewsHash({
        appid,
        filters,
        clientFilters,
        maxReviews: body.options.maxReviews,
      });
      const local = await readDataset(dataDir, appid, reviewsHash);
      const reusable = local && local.status === 'complete' ? local : null;

      // Reusing a local dataset must not touch Steam at all; game metadata is
      // read from the stored dataset instead of appdetails. When Steam metadata
      // is unavailable (name/cover only), the preview still works and can show
      // a local custom title resolved from the same directory.
      let gameMeta: GameMeta | null | undefined;
      if (reusable) {
        gameMeta = reusable.meta.game;
      } else {
        try {
          gameMeta = await deps.steam.resolveGame(appid);
        } catch (err) {
          if (err instanceof AppError && (err.code === 'CANCELLED' || err.code === 'STEAM_RATE_LIMITED')) throw err;
          gameMeta = undefined;
        }
      }
      const game = await resolveGamePresentation(dataDir, appid, gameMeta);

      let summary: SteamSummary | null = reusable?.meta.summary ?? null;
      let source: 'official' | 'storefront' = summary?.sourceEndpoint ?? 'official';
      if (!summary) {
        const page = await deps.steam.fetchAggregate(appid, filters);
        if (!page.summary) throw new AppError('STEAM_ENDPOINT_CHANGED', '聚合查询缺少 query_summary');
        summary = page.summary;
        source = page.source;
      }
      if (!summary) throw new AppError('STEAM_ENDPOINT_CHANGED', '无可用聚合汇总');
      // An explicit matchingTotal=0 must stay zero and disable analysis.
      const matching = summary.matchingTotal;
      if (matching <= 0) {
        res.status(422).json({ error: { code: 'NO_REVIEWS', message: '筛选后没有匹配的评论' } });
        return;
      }

      // Estimates follow the actual task rules: quantity cap, 100 reviews/page,
      // one official aggregate per trend month, thinking-aware output tokens.
      const sampleSize = Math.min(matching, body.options.maxReviews);
      const pages = Math.ceil(sampleSize / 100);
      const trendRequests = months;
      const inputTokens = sampleSize * PREVIEW_AVERAGE_TOKENS_PER_REVIEW + 2500;
      const outputTokens = Math.round(
        BASE_OUTPUT_TOKENS * (body.ai.thinking ? THINKING_OUTPUT_MULTIPLIER : 1) +
          (body.options.includeTranslations ? TRANSLATION_OUTPUT_TOKENS : 0),
      );
      const chunks = estimateChunkCount(inputTokens);
      const estimate = {
        pages,
        seconds: Math.round((pages * 0.4 + trendRequests * 0.4) * 10) / 10,
        trendRequests,
        inputTokens,
        outputTokens,
        chunks,
        // outputTokens already contains the thinking multiplier; the cost must
        // be calculated from the displayed token estimate exactly once.
        costUsd: estimateCostUsd(body.ai.model, inputTokens, outputTokens),
        sampleSize,
      };

      // Exact report reuse: only when the current dataset content hash, the
      // cached trend content hash and all AI options reproduce the analysis
      // hash. Everything else is historical-only.
      let exactAnalysisHash: string | undefined;
      if (reusable) {
        const timezone = deps.config.timezone;
        const trendHash = buildTrendHash(
          appid,
          months,
          anchorMonthOf(new Date(), timezone),
          timezone,
          filters,
        );
        const trend = await readTrend(dataDir, appid, trendHash, { timezone });
        if (trend) {
          exactAnalysisHash = buildAnalysisHash({
            reviewsContentHash: reusable.meta.reviewsContentHash,
            trendContentHash: trend.trendContentHash,
            provider: 'deepseek',
            model: body.ai.model,
            baseUrlHost: baseUrlHost(body.ai.baseUrl),
            promptVersion: PROMPT_VERSION,
            thinking: body.ai.thinking,
            includeTranslations: body.options.includeTranslations,
            temperature: body.ai.temperature,
          });
        }
      }

      const hint = reusable
        ? datasetHint(reusable.meta.fetchedAt, reusable.reviews.length, reviewsHash, game.displayTitle)
        : null;
      const reportHint = await reportHintFor(dataDir, appid, {
        ...(exactAnalysisHash ? { analysisHash: exactAnalysisHash } : {}),
        ...(reusable ? { reviewsHash } : {}),
      });
      const result: PreviewResult = {
        appid,
        game,
        summary: { ...summary, sourceEndpoint: source },
        steamMatchingTotal: matching,
        clientFilterNotice: CLIENT_FILTER_NOTICE,
        estimate,
        reuse: {
          dataset: hint,
          report: reportHint,
          canUseLocalDataset: Boolean(hint),
          canUseLocalReport: reportHint?.reusable === true,
        },
        trend: {
          months,
          requests: trendRequests,
          sourceNote: '趋势独立于 AI 样本的时间范围，默认使用官方月度聚合；报告将标注数据源与覆盖区间。',
        },
      };
      res.json(result);
    }),
  );

  return router;
}
