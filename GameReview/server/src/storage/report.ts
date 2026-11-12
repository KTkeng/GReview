import path from 'node:path';
import { AppError, isAppError, isSecurityError } from '../lib/errors';
import { canonicalJson, shortHash } from '../lib/hash';
import { atomicWriteFile, atomicWriteJson } from '../lib/fs';
import type { DatasetMeta, GameMeta, Report, Review, Theme, ThemeQuote, TopReview } from '../types';
import { readDataset, reportsDir, reviewsDir } from './dataset';
import {
  assertSafeReadPath,
  assertSafeWritePath,
  readContainedDir,
  readContainedText,
} from './paths';
import { runStorageMutationHook, withStorageLock } from './lock';
import { reportToMarkdown } from './markdown';
import {
  buildNumericFacts,
  checkNumericConsistency,
  containsForbiddenClaim,
  type NumericFacts,
} from '../analysis/conclusion';
import {
  isFiniteNumber,
  isHash,
  isIsoDate,
  isNonEmptyString,
  isNonNegativeInt,
  isRecord,
  isValidGameMeta,
  isValidKpiWindow,
  isValidScrapeFilters,
  isStringArray,
  isValidTrendPoint,
} from './validation';

export interface AnalysisHashInput {
  reviewsContentHash: string;
  trendContentHash: string;
  provider: string;
  model: string;
  baseUrlHost: string;
  promptVersion: string;
  thinking: boolean;
  includeTranslations: boolean;
  /**
   * Sampling temperature changes AI output, so it belongs in the cache key
   * (review Major 13). `undefined` and the provider default are distinct from
   * any explicit value.
   */
  temperature?: number;
}

/** analysisHash includes everything that changes AI output except Top N (design §6.9). */
export function buildAnalysisHash(input: AnalysisHashInput): string {
  // Pick fields explicitly so callers cannot accidentally pull Top N (or any
  // other presentation-only option) into the cache key.
  return shortHash(
    canonicalJson({
      reviewsContentHash: input.reviewsContentHash,
      trendContentHash: input.trendContentHash,
      provider: input.provider,
      model: input.model,
      baseUrlHost: input.baseUrlHost,
      promptVersion: input.promptVersion,
      thinking: input.thinking,
      includeTranslations: input.includeTranslations,
      temperature: input.temperature ?? null,
    }),
  );
}

export function reportFilePaths(dataDir: string, appid: number, analysisHash: string): { json: string; md: string } {
  const dir = reportsDir(dataDir, appid);
  return { json: path.join(dir, `${analysisHash}.json`), md: path.join(dir, `${analysisHash}.md`) };
}

export interface SaveReportOptions {
  /**
   * Job epoch. When provided, the report is only written if the dataset it
   * was generated from still exists — a delete/clear that happened while the
   * AI call was running must not resurrect a report (and then remove the title
   * while leaving orphan output behind).
   */
  epoch?: number;
}

export async function saveReport(
  dataDir: string,
  appid: number,
  analysisHash: string,
  report: Report,
  options: SaveReportOptions = {},
): Promise<void> {
  // A report is public output: never persist narrative/caveats that have not
  // passed the runtime numeric/structure validation (review Major 3/5).
  if (!isValidReport(report, appid)) {
    throw new AppError('INTERNAL', '报告内容未通过运行时校验，拒绝写入');
  }
  const paths = reportFilePaths(dataDir, appid, analysisHash);
  await withStorageLock(
    dataDir,
    async () => {
      await runStorageMutationHook({ operation: 'saveReport', dataDir, appid });
      if (options.epoch !== undefined) {
        const reviewsHash = report.methodology?.reviewsHash;
        if (reviewsHash && /^[a-f0-9]{16}$/.test(reviewsHash)) {
          const datasetExists = await assertSafeReadPath(dataDir, reviewsDir(dataDir, appid, reviewsHash));
          if (!datasetExists) {
            throw new AppError('CANCELLED', '评论数据集已被删除，报告未保存');
          }
        }
      }
      // Reject symlink/junction levels such as 570/reports before writing.
      await assertSafeWritePath(dataDir, paths.json);
      await assertSafeWritePath(dataDir, paths.md);
      await atomicWriteJson(paths.json, report);
      await atomicWriteFile(paths.md, `${reportToMarkdown(report)}\n`);
    },
    { epoch: options.epoch },
  );
}

function isValidThemeQuote(value: unknown): value is ThemeQuote {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.reviewId) &&
    typeof value.original === 'string' &&
    value.original.trim().length > 0 &&
    (value.zh === undefined || typeof value.zh === 'string') &&
    isNonNegativeInt(value.votesUp) &&
    typeof value.votedUp === 'boolean'
  );
}

function isValidTheme(value: unknown): value is Theme {
  if (!isRecord(value)) return false;
  return (
    (value.id === undefined || typeof value.id === 'string') &&
    isNonEmptyString(value.name) &&
    (value.category === undefined || typeof value.category === 'string') &&
    (value.sentiment === undefined ||
      value.sentiment === 'positive' ||
      value.sentiment === 'negative' ||
      value.sentiment === 'neutral' ||
      value.sentiment === 'mixed') &&
    (value.mentions === undefined || isNonNegativeInt(value.mentions)) &&
    (value.mentionsEstimated === undefined || typeof value.mentionsEstimated === 'boolean') &&
    typeof value.summary === 'string' &&
    isStringArray(value.evidenceIds) &&
    Array.isArray(value.quotes) &&
    value.quotes.every(isValidThemeQuote) &&
    (value.keywords === undefined || isStringArray(value.keywords))
  );
}

function isValidRecommendation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.title) &&
    typeof value.detail === 'string' &&
    (value.priority === 'high' || value.priority === 'medium' || value.priority === 'low') &&
    isStringArray(value.evidenceIds)
  );
}

function isValidTokenUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInt(value.input) &&
    isNonNegativeInt(value.output) &&
    (value.estimatedCostUsd === undefined ||
      (isFiniteNumber(value.estimatedCostUsd) && value.estimatedCostUsd >= 0))
  );
}

function isValidDateCoverage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInt(value.start) &&
    isNonNegativeInt(value.end) &&
    value.start <= value.end
  );
}

function isValidKpiSource(value: unknown): boolean {
  return value === 'official_aggregate' || value === 'sample_estimate';
}

function isValidReportKpis(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allTime = value.allTime;
  if (!isRecord(allTime)) return false;
  if (typeof allTime.reviewScoreDesc !== 'string') return false;
  if (!isValidKpiWindow(allTime)) return false;
  for (const key of ['last30d', 'last90d'] as const) {
    const window = value[key];
    if (!isRecord(window)) return false;
    if (!isNonNegativeInt(window.total)) return false;
    if (!isFiniteNumber(window.positiveRate) || window.positiveRate < 0 || window.positiveRate > 1) return false;
    if (typeof window.reviewScoreDesc !== 'string') return false;
  }
  if (!isFiniteNumber(value.samplePositiveRate) || value.samplePositiveRate < 0 || value.samplePositiveRate > 1) {
    return false;
  }
  if (value.allTimeSource !== undefined && !isValidKpiSource(value.allTimeSource)) return false;
  if (value.sources !== undefined) {
    if (!isRecord(value.sources)) return false;
    if (!isValidKpiSource(value.sources.last30d) || !isValidKpiSource(value.sources.last90d)) return false;
  }
  return true;
}

function isValidReportMethodology(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.note === 'string' &&
    isNonNegativeInt(value.steamRequests) &&
    isNonNegativeInt(value.cacheHits) &&
    (value.reviewsHash === undefined || isHash(value.reviewsHash)) &&
    (value.trendHash === undefined || isHash(value.trendHash)) &&
    (value.dataSource === 'fresh' || value.dataSource === 'local_dataset') &&
    (value.trendSource === 'official_aggregate' ||
      value.trendSource === 'local_cache' ||
      value.trendSource === 'sample_estimate') &&
    (value.analysisSource === 'fresh' || value.analysisSource === 'local_report') &&
    isNonEmptyString(value.dataDir) &&
    (value.datasetFetchedAt === undefined || isIsoDate(value.datasetFetchedAt)) &&
    (value.aggregatesComputedAt === undefined || isIsoDate(value.aggregatesComputedAt)) &&
    (value.reportGeneratedAt === undefined || isIsoDate(value.reportGeneratedAt)) &&
    (value.servedAt === undefined || isIsoDate(value.servedAt)) &&
    isNonEmptyString(value.aiModel) &&
    typeof value.thinkingEnabled === 'boolean' &&
    typeof value.promptVersion === 'string' &&
    typeof value.generatedBy === 'string'
  );
}

function reportNumericFacts(report: Report): NumericFacts {
  const derivedPositive = (window: { total: number; positiveRate: number }): number =>
    Math.round(window.total * window.positiveRate);
  const samplePositive = Math.round(report.kpis.samplePositiveRate * report.sample.fetched);
  return buildNumericFacts({
    allTime: report.kpis.allTime,
    last30d: {
      total: report.kpis.last30d.total,
      positive: derivedPositive(report.kpis.last30d),
      negative: report.kpis.last30d.total - derivedPositive(report.kpis.last30d),
      positiveRate: report.kpis.last30d.positiveRate,
    },
    last90d: {
      total: report.kpis.last90d.total,
      positive: derivedPositive(report.kpis.last90d),
      negative: report.kpis.last90d.total - derivedPositive(report.kpis.last90d),
      positiveRate: report.kpis.last90d.positiveRate,
    },
    sampleCount: report.sample.fetched,
    samplePositive,
    samplePositiveRate: report.kpis.samplePositiveRate,
    usedForAI: report.sample.usedForAI,
    matchedTotal: report.sample.matchedTotal,
    trendPoints: report.trend.points,
  });
}

function narrativeIsSafe(text: string, facts: NumericFacts, checkCommercial = true): boolean {
  if (checkCommercial && containsForbiddenClaim(text)) return false;
  return checkNumericConsistency(text, facts).ok;
}

function reportNarrativeIsSafe(report: Report): boolean {
  const facts = reportNumericFacts(report);
  // Server-generated baseline caveats deliberately mention 销量/收入 while
  // disclaiming them, so only numeric binding is enforced for that list.
  for (const caveat of report.conclusion.caveats) {
    if (!narrativeIsSafe(caveat, facts, false)) return false;
  }
  // AI-origin caveats must be fully safe; otherwise a legacy report with raw
  // unvalidated caveats must not be reused or served (review Major 3).
  for (const caveat of report.conclusion.aiCaveats ?? []) {
    if (!narrativeIsSafe(caveat, facts, true)) return false;
  }
  if (!narrativeIsSafe(report.conclusion.headline, facts) || !narrativeIsSafe(report.conclusion.summary, facts)) {
    return false;
  }
  const themes = [
    ...report.ai.appealPoints,
    ...report.ai.frictionPoints,
    ...report.ai.expectationGaps,
    ...report.ai.updateImpact,
  ];
  for (const theme of themes) {
    if (!narrativeIsSafe(theme.name, facts) || !narrativeIsSafe(theme.summary, facts)) return false;
  }
  for (const rec of report.ai.recommendations) {
    if (!narrativeIsSafe(rec.title, facts) || !narrativeIsSafe(rec.detail, facts)) return false;
  }
  return true;
}

/**
 * Full runtime validation of a persisted report. Structural completeness is
 * not enough: KPI totals/rates and trend points must be internally consistent,
 * and persisted AI narrative/caveats must still pass the numeric binding rules,
 * or a truncated/corrupted JSON document could be served as a valid report
 * (review Major 5). Invalid reports are treated exactly like missing ones.
 */
export function isValidReport(value: unknown, expectedAppid?: number): value is Report {
  if (!isRecord(value)) return false;
  if (value.version !== '1.0' || !isIsoDate(value.generatedAt)) return false;
  if (!isValidGameMeta(value.game)) return false;
  if (expectedAppid !== undefined && value.game.appid !== expectedAppid) return false;

  const sample = value.sample;
  if (!isRecord(sample)) return false;
  if (!isValidScrapeFilters(sample.filters)) return false;
  if (!isNonNegativeInt(sample.fetched) || !isNonNegativeInt(sample.matchedTotal) || !isNonNegativeInt(sample.usedForAI)) {
    return false;
  }
  if (sample.usedForAI > sample.fetched) return false;
  if (!isStringArray(sample.languages)) return false;
  if (sample.dateCoverage !== undefined && !isValidDateCoverage(sample.dateCoverage)) return false;
  if (sample.sourceEndpoint !== 'official' && sample.sourceEndpoint !== 'storefront') return false;
  if (sample.tokenUsage !== undefined && !isValidTokenUsage(sample.tokenUsage)) return false;

  if (!isValidReportKpis(value.kpis)) return false;

  const trend = value.trend;
  if (!isRecord(trend)) return false;
  if (trend.granularity !== 'month') return false;
  if (trend.source !== 'official_aggregate' && trend.source !== 'sample_estimate') return false;
  if (!Array.isArray(trend.points) || !trend.points.every(isValidTrendPoint)) return false;
  if (!isRecord(trend.coverage)) return false;
  if (
    !isNonEmptyString(trend.coverage.start) ||
    !isNonEmptyString(trend.coverage.end) ||
    typeof trend.coverage.note !== 'string'
  ) {
    return false;
  }

  const conclusion = value.conclusion;
  if (!isRecord(conclusion)) return false;
  if (
    typeof conclusion.label !== 'string' ||
    typeof conclusion.headline !== 'string' ||
    typeof conclusion.summary !== 'string'
  ) {
    return false;
  }
  if (conclusion.confidence !== 'high' && conclusion.confidence !== 'medium' && conclusion.confidence !== 'low') {
    return false;
  }
  if (!isStringArray(conclusion.caveats)) return false;
  if (conclusion.aiCaveats !== undefined && !isStringArray(conclusion.aiCaveats)) return false;

  const ai = value.ai;
  if (!isRecord(ai)) return false;
  for (const key of ['appealPoints', 'frictionPoints', 'expectationGaps', 'updateImpact'] as const) {
    if (!Array.isArray(ai[key]) || !ai[key].every(isValidTheme)) return false;
  }
  if (!Array.isArray(ai.recommendations) || !ai.recommendations.every(isValidRecommendation)) return false;

  if (!Array.isArray(value.topReviews)) return false;
  for (const top of value.topReviews) {
    if (!isRecord(top)) return false;
    if (
      !isNonEmptyString(top.reviewId) ||
      typeof top.text !== 'string' ||
      !isNonNegativeInt(top.votesUp) ||
      typeof top.votedUp !== 'boolean' ||
      typeof top.language !== 'string' ||
      !isFiniteNumber(top.playtimeHours) ||
      top.playtimeHours < 0 ||
      !isNonNegativeInt(top.createdAt)
    ) {
      return false;
    }
  }

  if (!isValidReportMethodology(value.methodology)) return false;
  return reportNarrativeIsSafe(value as unknown as Report);
}

/**
 * Distinguishes the three outcomes the report endpoint must tell apart:
 * genuinely missing (404), present but corrupt (500), readable and valid.
 * Path-safety failures (link/traversal) and ordinary read failures
 * (permission/I/O) are thrown: the former as DATA_DIR_FORBIDDEN, the latter as
 * INTERNAL. Neither may masquerade as "not found".
 */
export type ReportReadState =
  | { status: 'ok'; report: Report }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string };

export async function readReportState(
  dataDir: string,
  appid: number,
  analysisHash: string,
): Promise<ReportReadState> {
  if (!/^[a-f0-9]{16}$/.test(analysisHash)) return { status: 'missing' };
  let text: string | null;
  try {
    text = await readContainedText(dataDir, reportFilePaths(dataDir, appid, analysisHash).json);
  } catch (err) {
    // Link/traversal and ordinary read failures must never become 404.
    if (isAppError(err)) throw err;
    return { status: 'corrupt', reason: 'JSON 无法解析' };
  }
  // A missing file is the only 404. A file whose content is literal `null` is
  // present but corrupt and must be a 500-class failure.
  if (text === null) return { status: 'missing' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', reason: 'JSON 无法解析' };
  }
  if (!isValidReport(raw, appid)) return { status: 'corrupt', reason: '内容不符合报告模型' };
  return { status: 'ok', report: raw };
}

/**
 * Tolerant entry for reuse flows (job cache reuse, preview hints): a missing,
 * corrupt or unreadable report simply means "not reusable". Security failures
 * still propagate so a compromised data root is never silently ignored.
 */
export async function readReport(dataDir: string, appid: number, analysisHash: string): Promise<Report | null> {
  try {
    const state = await readReportState(dataDir, appid, analysisHash);
    return state.status === 'ok' ? state.report : null;
  } catch (err) {
    if (isSecurityError(err)) throw err;
    return null;
  }
}

export function topReviewFromReview(review: Review): TopReview {
  return {
    reviewId: review.id,
    text: review.text,
    votesUp: review.votesUp,
    votedUp: review.votedUp,
    language: review.language,
    playtimeHours: Math.round((review.playtimeAtReviewMinutes / 60) * 10) / 10,
    createdAt: review.createdAt,
  };
}

/** Rebuild Top N from the dataset; Top N is not part of the analysis hash. */
export async function rebuildTopReviewsFromDataset(
  dataDir: string,
  appid: number,
  reviewsHash: string | undefined,
  topN: number,
  fallback: TopReview[] = [],
): Promise<TopReview[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(topN) || 10));
  if (!reviewsHash) return fallback.slice(0, limit);
  const dataset = await readDataset(dataDir, appid, reviewsHash);
  if (!dataset || dataset.status !== 'complete' || dataset.reviews.length === 0) return fallback.slice(0, limit);
  const sorted = [...dataset.reviews]
    .filter((r) => r.text.trim().length > 0)
    .sort((a, b) => b.votesUp - a.votesUp || b.weightedVoteScore - a.weightedVoteScore)
    .slice(0, limit)
    .map(topReviewFromReview);
  return sorted.length ? sorted : fallback.slice(0, limit);
}

export function cloneReportWithServed(report: Report, topReviews: TopReview[], now = new Date()): Report {
  const clone: Report = JSON.parse(JSON.stringify(report)) as Report;
  clone.topReviews = topReviews;
  clone.methodology = {
    ...clone.methodology,
    analysisSource: 'local_report',
    servedAt: now.toISOString(),
  };
  return clone;
}

/**
 * Read a stored report for API serving, rebuilding Top N from the dataset in
 * memory only. Unlike the tolerant `readReport`, a present-but-corrupt report
 * is an explicit INTERNAL failure (the contract requires 500, not 404), and an
 * ordinary read failure propagates as INTERNAL from the path layer.
 */
export async function readServedReport(
  dataDir: string,
  appid: number,
  analysisHash: string,
  topN: number,
): Promise<Report | null> {
  const state = await readReportState(dataDir, appid, analysisHash);
  if (state.status === 'missing') return null;
  if (state.status === 'corrupt') {
    throw new AppError('INTERNAL', `报告损坏：${state.reason}`);
  }
  const report = state.report;
  const reviewsHash = report.methodology?.reviewsHash;
  const topReviews = await rebuildTopReviewsFromDataset(dataDir, appid, reviewsHash, topN, report.topReviews);
  return cloneReportWithServed(report, topReviews);
}

export async function listReportFiles(dataDir: string, appid: number): Promise<string[]> {
  const files = await readContainedDir(dataDir, reportsDir(dataDir, appid));
  if (!files) return [];
  for (const entry of files) {
    if (entry.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(entry.name)) {
      throw new AppError('DATA_DIR_FORBIDDEN', '报告目录包含符号链接/联接点');
    }
  }
  return files
    .filter((entry) => entry.isFile() && /^[a-f0-9]{16}\.json$/.test(entry.name))
    .map((entry) => entry.name.replace(/\.json$/, ''));
}

/** Find a usable dataset for a preview by appid and hash; never returns corrupted data. */
export async function previewDataset(
  dataDir: string,
  appid: number,
  reviewsHash: string,
): Promise<{ meta: DatasetMeta; game: GameMeta } | null> {
  const dataset = await readDataset(dataDir, appid, reviewsHash);
  if (!dataset || dataset.status !== 'complete') return null;
  return { meta: dataset.meta, game: dataset.meta.game };
}

/** Serialize the evidence-bearing subsets of a report for tests and secondary analysis. */
export function reportThemeQuotes(themes: Theme[]): ThemeQuote[] {
  return themes.flatMap((t) => t.quotes ?? []);
}
