import type {
  AiOptions,
  ClientFilters,
  Conclusion,
  GameMeta,
  KpiSource,
  KpiWindows,
  Recommendation,
  Report,
  Review,
  ScrapeFilters,
  SteamSummary,
  Theme,
  TokenUsage,
  TopReview,
  TrendDataset,
} from '../types';
import { estimateCostUsd } from '../ai/pricing';
import { buildReportNote, PROMPT_VERSION } from '../ai/prompts';
import { topReviewFromReview } from '../storage/report';
import { sampleWindows as sampleKpiWindows } from '../steam/kpi';
import {
  buildCaveats,
  buildNumericFacts,
  conclusionLabel,
  confidenceFor,
  sanitizeNarrative,
  scoreDescForRate,
  windowedKpiFromWindow,
  type NumericFacts,
  type WindowedKpi,
} from './conclusion';
import { splitThemes, type ValidatedAnalysis } from './evidence';

export interface ReportMethodologyInput {
  dataSource: 'fresh' | 'local_dataset';
  trendSource: 'official_aggregate' | 'local_cache' | 'sample_estimate';
  analysisSource: 'fresh' | 'local_report';
  dataDir: string;
  datasetFetchedAt?: string;
  aggregatesComputedAt?: string;
  reviewsHash?: string;
  trendHash?: string;
  steamRequests: number;
  cacheHits: number;
}

export interface BuildReportInput {
  game: GameMeta;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  reviews: Review[];
  usedForAI?: number;
  /** Steam-side matching total after filters; falls back to the fetched sample size. */
  matchedTotal?: number;
  trend: TrendDataset;
  /** Summary from the filtered fetch; only used for matchingTotal/endpoint. */
  summary: SteamSummary | null;
  /**
   * Independent all-time aggregate (`review_type=all`, no date range). The
   * filtered fetch summary is deliberately NOT used as a fallback: a
   * positive-only or date-filtered sample must never be presented as an
   * all-time KPI (review Major 3). When absent the result is explicitly
   * labelled `sample_estimate`.
   */
  allTimeSummary?: SteamSummary | null;
  /** True rolling 30/90-day windows (review Major 7). */
  rollingKpis?: KpiWindows;
  analysis: ValidatedAnalysis;
  usage: TokenUsage;
  aiOptions: AiOptions;
  includeTranslations: boolean;
  topReviews: number;
  methodology: ReportMethodologyInput;
  now?: Date;
}

export interface AllTimeKpi {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
  reviewScoreDesc: string;
}

export interface AllTimeKpiResult {
  kpi: AllTimeKpi;
  source: KpiSource;
}

/**
 * All-time KPI. Only an independent official all-time aggregate may be labelled
 * `official_aggregate`; otherwise the filtered review sample is used and
 * labelled `sample_estimate` (review Major 3).
 */
export function allTimeKpiWithSource(
  allTimeSummary: SteamSummary | null | undefined,
  reviews: Review[],
): AllTimeKpiResult {
  if (allTimeSummary && (allTimeSummary.total > 0 || allTimeSummary.negative > 0)) {
    return {
      source: 'official_aggregate',
      kpi: {
        total: allTimeSummary.total,
        positive: allTimeSummary.positive,
        negative: allTimeSummary.negative,
        positiveRate: allTimeSummary.positiveRate,
        reviewScoreDesc:
          allTimeSummary.reviewScoreDesc || scoreDescForRate(allTimeSummary.positiveRate, allTimeSummary.total),
      },
    };
  }
  const positive = reviews.filter((r) => r.votedUp).length;
  const total = reviews.length;
  const negative = total - positive;
  const rate = total > 0 ? positive / total : 0;
  return {
    source: 'sample_estimate',
    kpi: { total, positive, negative, positiveRate: rate, reviewScoreDesc: scoreDescForRate(rate, total) },
  };
}

function windowsFromKpis(kpis: KpiWindows): { last30d: WindowedKpi; last90d: WindowedKpi } {
  return {
    last30d: windowedKpiFromWindow(kpis.last30d),
    last90d: windowedKpiFromWindow(kpis.last90d),
  };
}

function dateCoverage(reviews: Review[]): { start: number; end: number } | undefined {
  const times = reviews.map((r) => r.createdAt).filter((t) => t > 0);
  if (times.length === 0) return undefined;
  return { start: Math.min(...times), end: Math.max(...times) };
}

function samplePositiveRateOf(reviews: Review[]): number {
  if (reviews.length === 0) return 0;
  return reviews.filter((r) => r.votedUp).length / reviews.length;
}

function numericFacts(input: {
  allTime: AllTimeKpi;
  windows: { last30d: WindowedKpi; last90d: WindowedKpi };
  samplePositiveRate: number;
  reviews: Review[];
  usedForAI: number;
  matchedTotal: number;
  trend: TrendDataset;
}): NumericFacts {
  return buildNumericFacts({
    allTime: input.allTime,
    last30d: input.windows.last30d,
    last90d: input.windows.last90d,
    sampleCount: input.reviews.length,
    samplePositive: input.reviews.filter((r) => r.votedUp).length,
    samplePositiveRate: input.samplePositiveRate,
    usedForAI: input.usedForAI,
    matchedTotal: input.matchedTotal,
    trendPoints: input.trend.points,
  });
}

interface ConclusionContext {
  aiConclusion?: Conclusion;
  trend: TrendDataset;
  includeTranslations: boolean;
  allTime: AllTimeKpi;
  allTimeSource: KpiSource;
  windows: { last30d: WindowedKpi; last90d: WindowedKpi };
  kpiSources: KpiWindows['sources'];
  samplePositiveRate: number;
  usedForAI: number;
  matchedTotal: number;
  reviews: Review[];
  facts: NumericFacts;
  /** Set when non-conclusion AI narrative had sentences removed. */
  narrativeSanitized?: boolean;
  /** Set when such removals were caused by unverifiable numbers. */
  narrativeNumericMismatch?: boolean;
}

/** Legacy reports/tests may omit per-window sources; fall back to the summary source. */
function sourcesOf(kpis: KpiWindows): KpiWindows['sources'] {
  return kpis.sources ?? { last30d: kpis.source, last90d: kpis.source };
}

function kpiSampleCaveats(sources: KpiWindows['sources']): string[] {
  const estimated: string[] = [];
  if (sources.last30d === 'sample_estimate') estimated.push('最近 30 天');
  if (sources.last90d === 'sample_estimate') estimated.push('最近 90 天');
  if (estimated.length === 0) return [];
  return [`${estimated.join('、')} KPI 为筛选样本估算，不代表 Steam 全站口径。`];
}

function buildConclusion(ctx: ConclusionContext): Conclusion {
  const ai = ctx.aiConclusion;
  const label = conclusionLabel({
    reviewScoreDesc: ctx.allTime.reviewScoreDesc,
    allTimeRate: ctx.allTime.positiveRate,
    last90dRate: ctx.windows.last90d.positiveRate,
  });
  const nonZero = ctx.trend.points.filter((p) => p.total > 0).length;
  const confidence = confidenceFor({
    sampleSize: ctx.usedForAI,
    trendMonths: ctx.trend.points.length,
    nonZeroMonths: nonZero,
  });
  const allTimeLabel = ctx.allTimeSource === 'official_aggregate' ? '全部时间好评率' : '全部时间好评率（样本估算）';
  const fallbackHeadline = `${label}：基于 ${ctx.usedForAI} 条评论样本的口碑归纳`;
  const fallbackSummary =
    `本次分析基于 ${ctx.usedForAI} 条筛选后的评论样本，样本好评率为 ${(ctx.samplePositiveRate * 100).toFixed(1)}%。` +
    `${allTimeLabel} ${(ctx.allTime.positiveRate * 100).toFixed(1)}%，最近 90 天好评率 ${(ctx.windows.last90d.positiveRate * 100).toFixed(1)}%。` +
    '具体主题与证据原话见下方 AI 归纳；数字均由服务端计算。';
  const extraCaveats: string[] = [];
  if (ctx.trend.source === 'sample_estimate') {
    extraCaveats.push('趋势数据为样本估算，仅作方向参考，不代表 Steam 全站口径。');
  }
  if (ctx.allTimeSource === 'sample_estimate') {
    extraCaveats.push('全部时间 KPI 缺少独立官方聚合，当前使用筛选样本估算，不代表 Steam 全站口径。');
  }
  extraCaveats.push(...kpiSampleCaveats(ctx.kpiSources));
  if (ctx.includeTranslations) extraCaveats.push('非中文引用附带的“AI 翻译”仅辅助理解，以原文为准。');

  // Scrubbing applies to the conclusion prose just like every other AI
  // narrative field (review R3 Major): drop sentences that infer commercial
  // outcomes or quote numbers that the server cannot verify.
  const headlineResult = sanitizeNarrative(ai?.headline || fallbackHeadline, ctx.facts, fallbackHeadline);
  const summaryResult = sanitizeNarrative(ai?.summary || fallbackSummary, ctx.facts, fallbackSummary);
  const numericMismatch = headlineResult.numericMismatch || summaryResult.numericMismatch;
  if (numericMismatch) {
    extraCaveats.push('AI 文本中的数字与服务器 KPI/趋势不一致，已删除或替换为服务端模板摘要。');
  } else if (headlineResult.forbiddenRemoved || summaryResult.forbiddenRemoved) {
    extraCaveats.push('AI 结论包含商业成败推断，相关句子已删除。');
  }
  if (ctx.narrativeNumericMismatch) {
    extraCaveats.push('AI 归纳中的数字与服务器 KPI/趋势不一致，相关句子已删除或降级处理。');
  } else if (ctx.narrativeSanitized) {
    extraCaveats.push('AI 归纳包含无法核实的内容或商业推断，相关句子已删除。');
  }
  // AI caveats are public report content too. They must pass the same
  // commercial/numeric scrub as every other narrative field before they can
  // enter `Report.conclusion` (review Major 3). Raw strings are never kept.
  const rawAiCaveats = Array.isArray(ai?.caveats)
    ? ai.caveats.filter((c): c is string => typeof c === 'string')
    : [];
  const aiCaveats: string[] = [];
  let aiCaveatSanitized = false;
  for (const raw of rawAiCaveats) {
    const cleaned = sanitizeNarrative(raw, ctx.facts, '');
    if (cleaned.changed) aiCaveatSanitized = true;
    if (cleaned.text && !aiCaveats.includes(cleaned.text)) aiCaveats.push(cleaned.text);
  }
  if (aiCaveatSanitized) {
    extraCaveats.push('AI 附加局限中的无法核实内容已被删除。');
  }
  return {
    label,
    headline: headlineResult.text,
    summary: summaryResult.text,
    confidence,
    caveats: buildCaveats(aiCaveats, extraCaveats),
    aiCaveats,
  };
}

function kpiReportFields(allTime: AllTimeKpiResult, kpis: KpiWindows, windows: ReturnType<typeof windowsFromKpis>, samplePositiveRate: number): Report['kpis'] {
  return {
    allTime: {
      total: allTime.kpi.total,
      positive: allTime.kpi.positive,
      negative: allTime.kpi.negative,
      positiveRate: allTime.kpi.positiveRate,
      reviewScoreDesc: allTime.kpi.reviewScoreDesc,
    },
    last30d: {
      total: windows.last30d.total,
      positiveRate: windows.last30d.positiveRate,
      reviewScoreDesc: windows.last30d.reviewScoreDesc,
    },
    last90d: {
      total: windows.last90d.total,
      positiveRate: windows.last90d.positiveRate,
      reviewScoreDesc: windows.last90d.reviewScoreDesc,
    },
    samplePositiveRate,
    allTimeSource: allTime.source,
    sources: { ...sourcesOf(kpis) },
  };
}

/**
 * Apply the numeric/commercial-claim scrub to every AI narrative field, not
 * only the conclusion headline and summary (review R3 Major). Sentences that
 * cannot be verified against server facts are deleted; a field left empty is
 * replaced with a neutral fallback (or the recommendation is dropped).
 */
function sanitizeThemeNarrative(
  theme: Theme,
  facts: NumericFacts,
): { theme: Theme; changed: boolean; numericMismatch: boolean } {
  const name = sanitizeNarrative(theme.name, facts, '未命名主题');
  const summary = sanitizeNarrative(
    theme.summary,
    facts,
    '该主题的具体描述包含无法核实的内容，已省略；请查看证据原文。',
  );
  return {
    theme: { ...theme, name: name.text, summary: summary.text },
    changed: name.changed || summary.changed,
    numericMismatch: name.numericMismatch || summary.numericMismatch,
  };
}

function sanitizeThemes(
  themes: Theme[],
  facts: NumericFacts,
): { themes: Theme[]; changed: boolean; numericMismatch: boolean } {
  let changed = false;
  let numericMismatch = false;
  const out: Theme[] = [];
  for (const theme of themes) {
    const sanitized = sanitizeThemeNarrative(theme, facts);
    changed = changed || sanitized.changed;
    numericMismatch = numericMismatch || sanitized.numericMismatch;
    out.push(sanitized.theme);
  }
  return { themes: out, changed, numericMismatch };
}

/** Drop model-supplied translations when the request disabled them. */
function stripThemeTranslations(themes: Theme[]): Theme[] {
  return themes.map((theme) => {
    if (!theme.quotes.some((quote) => quote.zh !== undefined)) return theme;
    return {
      ...theme,
      quotes: theme.quotes.map((quote) => {
        if (quote.zh === undefined) return quote;
        const copy = { ...quote };
        delete copy.zh;
        return copy;
      }),
    };
  });
}

function stripAnalysisTranslations(
  analysis: ValidatedAnalysis,
  includeTranslations: boolean,
): ValidatedAnalysis {
  if (includeTranslations) return analysis;
  return {
    ...analysis,
    themes: stripThemeTranslations(analysis.themes),
    expectationGaps: stripThemeTranslations(analysis.expectationGaps),
    updateImpact: stripThemeTranslations(analysis.updateImpact),
  };
}

function sanitizeRecommendations(
  recommendations: Recommendation[],
  facts: NumericFacts,
): { recommendations: Recommendation[]; changed: boolean; numericMismatch: boolean } {
  let changed = false;
  let numericMismatch = false;
  const out: Recommendation[] = [];
  for (const rec of recommendations) {
    const title = sanitizeNarrative(rec.title, facts, '');
    const detail = sanitizeNarrative(rec.detail, facts, '');
    changed = changed || title.changed || detail.changed;
    numericMismatch = numericMismatch || title.numericMismatch || detail.numericMismatch;
    // A recommendation whose title is entirely unverifiable is dropped
    // instead of being presented with an empty or fabricated heading.
    if (!title.text) {
      changed = true;
      continue;
    }
    out.push({ ...rec, title: title.text, detail: detail.text || '详见证据原文。' });
  }
  return { recommendations: out, changed, numericMismatch };
}

function sanitizeValidatedAnalysis(
  analysis: ValidatedAnalysis,
  facts: NumericFacts,
): { analysis: ValidatedAnalysis; changed: boolean; numericMismatch: boolean } {
  const themes = sanitizeThemes(analysis.themes, facts);
  const gaps = sanitizeThemes(analysis.expectationGaps, facts);
  const updates = sanitizeThemes(analysis.updateImpact, facts);
  const recommendations = sanitizeRecommendations(analysis.recommendations, facts);
  return {
    analysis: {
      ...analysis,
      themes: themes.themes,
      expectationGaps: gaps.themes,
      updateImpact: updates.themes,
      recommendations: recommendations.recommendations,
    },
    changed: themes.changed || gaps.changed || updates.changed || recommendations.changed,
    numericMismatch: themes.numericMismatch || gaps.numericMismatch || updates.numericMismatch || recommendations.numericMismatch,
  };
}

/** Assemble the final Report. All KPIs, labels and confidence are server-computed. */
export function buildReport(input: BuildReportInput): Report {
  const now = input.now ?? new Date();
  const allTime = allTimeKpiWithSource(input.allTimeSummary, input.reviews);
  const kpis: KpiWindows = input.rollingKpis ?? sampleKpiWindows(input.reviews, now);
  const windows = windowsFromKpis(kpis);
  const samplePositiveRate = samplePositiveRateOf(input.reviews);
  const usedForAI = input.usedForAI ?? input.reviews.filter((r) => r.text.trim()).length;
  const matchedTotal = input.matchedTotal ?? input.summary?.matchingTotal ?? input.reviews.length;
  const facts = numericFacts({
    allTime: allTime.kpi,
    windows,
    samplePositiveRate,
    reviews: input.reviews,
    usedForAI,
    matchedTotal,
    trend: input.trend,
  });
  const sanitized = sanitizeValidatedAnalysis(input.analysis, facts);
  const publicAnalysis = stripAnalysisTranslations(sanitized.analysis, input.includeTranslations);
  const split = splitThemes(publicAnalysis.themes);
  const conclusion = buildConclusion({
    aiConclusion: publicAnalysis.conclusion ?? undefined,
    trend: input.trend,
    includeTranslations: input.includeTranslations,
    allTime: allTime.kpi,
    allTimeSource: allTime.source,
    windows,
    kpiSources: sourcesOf(kpis),
    samplePositiveRate,
    usedForAI,
    matchedTotal,
    reviews: input.reviews,
    facts,
    narrativeSanitized: sanitized.changed,
    narrativeNumericMismatch: sanitized.numericMismatch,
  });
  const topN = Math.max(1, Math.min(50, Math.floor(input.topReviews) || 10));
  const topReviews: TopReview[] = [...input.reviews]
    .filter((r) => r.text.trim().length > 0)
    .sort((a, b) => b.votesUp - a.votesUp || b.weightedVoteScore - a.weightedVoteScore)
    .slice(0, topN)
    .map(topReviewFromReview);
  const usage: TokenUsage = {
    ...input.usage,
    estimatedCostUsd: estimateCostUsd(input.aiOptions.model, input.usage.input, input.usage.output),
  };
  const coverage = dateCoverage(input.reviews);
  const generatedAt = now.toISOString();

  return {
    version: '1.0',
    generatedAt,
    game: input.game,
    sample: {
      filters: { ...input.filters, ...input.clientFilters },
      fetched: input.reviews.length,
      matchedTotal,
      usedForAI,
      languages: input.filters.languages,
      ...(coverage ? { dateCoverage: coverage } : {}),
      sourceEndpoint: input.summary?.sourceEndpoint ?? input.trend.sourceEndpoint,
      tokenUsage: usage,
    },
    kpis: kpiReportFields(allTime, kpis, windows, samplePositiveRate),
    trend: {
      granularity: 'month',
      source: input.trend.source,
      points: input.trend.points,
      coverage: input.trend.coverage,
    },
    conclusion,
    ai: {
      appealPoints: split.appealPoints,
      frictionPoints: split.frictionPoints,
      expectationGaps: publicAnalysis.expectationGaps,
      updateImpact: publicAnalysis.updateImpact,
      recommendations: publicAnalysis.recommendations,
    },
    topReviews,
    methodology: {
      note: buildReportNote(
        input.allTimeSummary ?? null,
        allTime.source,
        usedForAI,
        input.trend.source === 'official_aggregate' ? '官方聚合' : '样本估算',
        input.methodology.aggregatesComputedAt,
      ),
      steamRequests: input.methodology.steamRequests,
      cacheHits: input.methodology.cacheHits,
      reviewsHash: input.methodology.reviewsHash,
      trendHash: input.methodology.trendHash,
      dataSource: input.methodology.dataSource,
      trendSource: input.methodology.trendSource,
      analysisSource: input.methodology.analysisSource,
      dataDir: input.methodology.dataDir,
      datasetFetchedAt: input.methodology.datasetFetchedAt,
      ...(input.methodology.aggregatesComputedAt
        ? { aggregatesComputedAt: input.methodology.aggregatesComputedAt }
        : {}),
      reportGeneratedAt: generatedAt,
      aiModel: input.aiOptions.model,
      thinkingEnabled: input.aiOptions.thinking,
      promptVersion: PROMPT_VERSION,
      generatedBy: 'GReview 0.2.0',
    },
  };
}

export interface RefreshReportInput {
  reviews: Review[];
  allTimeSummary: SteamSummary | null;
  rollingKpis: KpiWindows;
  trend: TrendDataset;
  /** Current request filters, so a reused report never advertises stale attribution. */
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  sourceEndpoint?: Report['sample']['sourceEndpoint'];
  matchedTotal?: number;
  includeTranslations: boolean;
  methodology: {
    trendSource: 'official_aggregate' | 'local_cache' | 'sample_estimate';
    steamRequests: number;
    cacheHits: number;
    aggregatesComputedAt?: string;
    dataSource: 'fresh' | 'local_dataset';
    dataDir: string;
    datasetFetchedAt?: string;
    reviewsHash?: string;
  };
  now?: Date;
}

/**
 * Refresh a cached report before reuse (review Major 4). AI narrative is
 * reused without spending tokens, but every dynamic KPI, label, caveat,
 * trend snapshot and methodology field is recomputed from current data so a
 * cached analysisHash can never serve stale KPIs.
 */
export function refreshReport(report: Report, input: RefreshReportInput): Report {
  const now = input.now ?? new Date();
  const clone: Report = JSON.parse(JSON.stringify(report)) as Report;
  const allTime = allTimeKpiWithSource(input.allTimeSummary, input.reviews);
  const kpis = input.rollingKpis;
  const windows = windowsFromKpis(kpis);
  const samplePositiveRate = samplePositiveRateOf(input.reviews);
  const usedForAI = clone.sample.usedForAI ?? clone.sample.fetched ?? input.reviews.length;
  const matchedTotal = input.matchedTotal ?? clone.sample.matchedTotal ?? input.reviews.length;
  const facts = numericFacts({
    allTime: allTime.kpi,
    windows,
    samplePositiveRate,
    reviews: input.reviews,
    usedForAI,
    matchedTotal,
    trend: input.trend,
  });
  const sanitized = sanitizeValidatedAnalysis(
    {
      themes: [...clone.ai.appealPoints, ...clone.ai.frictionPoints],
      expectationGaps: clone.ai.expectationGaps,
      updateImpact: clone.ai.updateImpact,
      recommendations: clone.ai.recommendations,
      conclusion: clone.conclusion,
    },
    facts,
  );
  // Only the raw AI caveats may be reused. Server-generated dynamic caveats
  // (trend/KPI source warnings) are recomputed from the current sources; using
  // `clone.conclusion.caveats` here would re-merge stale warnings forever
  // (review R3 Major). Legacy reports without `aiCaveats` contribute none.
  const aiCaveats = Array.isArray(clone.conclusion.aiCaveats)
    ? clone.conclusion.aiCaveats.filter((c): c is string => typeof c === 'string')
    : [];
  const conclusion = buildConclusion({
    aiConclusion: { ...clone.conclusion, caveats: aiCaveats },
    trend: input.trend,
    includeTranslations: input.includeTranslations,
    allTime: allTime.kpi,
    allTimeSource: allTime.source,
    windows,
    kpiSources: sourcesOf(kpis),
    samplePositiveRate,
    usedForAI,
    matchedTotal,
    reviews: input.reviews,
    facts,
    narrativeSanitized: sanitized.changed,
    narrativeNumericMismatch: sanitized.numericMismatch,
  });
  const publicAnalysis = stripAnalysisTranslations(sanitized.analysis, input.includeTranslations);
  const split = splitThemes(publicAnalysis.themes);
  const coverage = dateCoverage(input.reviews);
  clone.kpis = kpiReportFields(allTime, kpis, windows, samplePositiveRate);
  clone.trend = {
    granularity: 'month',
    source: input.trend.source,
    points: input.trend.points,
    coverage: input.trend.coverage,
  };
  clone.conclusion = conclusion;
  clone.ai = {
    appealPoints: split.appealPoints,
    frictionPoints: split.frictionPoints,
    expectationGaps: publicAnalysis.expectationGaps,
    updateImpact: publicAnalysis.updateImpact,
    recommendations: publicAnalysis.recommendations,
  };
  clone.sample = {
    ...clone.sample,
    // Contenthash-keyed reports can be reused under a different filter config;
    // attribution must always describe the request that produced this response.
    filters: { ...input.filters, ...input.clientFilters },
    fetched: input.reviews.length,
    matchedTotal,
    usedForAI,
    languages: [...input.filters.languages],
    sourceEndpoint: input.sourceEndpoint ?? clone.sample.sourceEndpoint,
    ...(coverage ? { dateCoverage: coverage } : {}),
  };
  if (!coverage) delete clone.sample.dateCoverage;
  clone.methodology = {
    ...clone.methodology,
    note: buildReportNote(
      input.allTimeSummary,
      allTime.source,
      usedForAI,
      input.trend.source === 'official_aggregate' ? '官方聚合' : '样本估算',
      input.methodology.aggregatesComputedAt,
    ),
    trendHash: input.trend.trendHash,
    trendSource: input.methodology.trendSource,
    steamRequests: input.methodology.steamRequests,
    cacheHits: input.methodology.cacheHits,
    dataSource: input.methodology.dataSource,
    dataDir: input.methodology.dataDir,
    datasetFetchedAt: input.methodology.datasetFetchedAt,
    reviewsHash: input.methodology.reviewsHash,
    aggregatesComputedAt: input.methodology.aggregatesComputedAt,
    // The original generation time is immutable across reuse; only `servedAt`
    // records that this response was refreshed from the local report cache.
    reportGeneratedAt: clone.methodology.reportGeneratedAt ?? clone.generatedAt,
    servedAt: now.toISOString(),
  };
  return clone;
}
