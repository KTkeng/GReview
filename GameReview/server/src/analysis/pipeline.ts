import { AppError } from '../lib/errors';
import type { AiOptions, GameMeta, KpiWindows, Review, ScrapeFilters, SteamSummary, TokenUsage, TrendDataset } from '../types';
import type { AIProvider } from '../ai/deepseek';
import { buildFinalPrompt, buildHolisticPrompt, buildMapPrompt, buildMergePrompt, type KpiSummaryInput } from '../ai/prompts';
import { parseAnalysis, type ParsedAnalysis } from '../ai/schema';
import { splitThemes, validateEvidence, type ValidatedAnalysis } from './evidence';
import { buildChunks, DEFAULT_MAX_CHUNKS, DEFAULT_MAX_TOKENS_PER_CHUNK } from './chunk';
import { scoreDescForRate } from './conclusion';
import { sampleWindows } from '../steam/kpi';
import type { ClientFilters } from '../types';

export interface AnalyzeProgress {
  stage: string;
  progress: number;
  message: string;
  counts?: Record<string, number>;
}

export interface AnalyzeInput {
  game?: GameMeta;
  reviews: Review[];
  trend: TrendDataset;
  summary: SteamSummary | null;
  /** Independent all-time aggregate; keeps the AI prompt's KPI honest. */
  allTimeSummary?: SteamSummary | null;
  /** True rolling 30/90-day windows from the job manager. */
  rollingKpis?: KpiWindows;
  filters: ScrapeFilters;
  clientFilters?: ClientFilters;
  ai: AIProvider;
  aiOptions: AiOptions;
  includeTranslations: boolean;
  maxTokensPerChunk?: number;
  maxChunks?: number;
  signal?: AbortSignal;
  onProgress?: (info: AnalyzeProgress) => void;
}

export interface AnalyzeResult {
  analysis: ValidatedAnalysis;
  usage: TokenUsage;
  usedForAI: number;
}

export function buildKpiPromptInput(
  reviews: Review[],
  allTimeSummary: SteamSummary | null,
  _trend: TrendDataset,
  rollingKpis?: KpiWindows,
): KpiSummaryInput {
  // Only an independent all-time aggregate may feed the AI's "all-time" KPI.
  // The filtered fetch summary must not be relabelled as all-time (review
  // Major 3); without the aggregate the prompt uses a sample estimate.
  const allTimeTotal = allTimeSummary?.total && allTimeSummary.total > 0 ? allTimeSummary.total : reviews.length;
  const allTimePositive = allTimeSummary?.total && allTimeSummary.total > 0
    ? allTimeSummary.positive
    : reviews.filter((r) => r.votedUp).length;
  const allTimeRate = allTimeTotal > 0 ? allTimePositive / allTimeTotal : 0;
  const desc = allTimeSummary?.reviewScoreDesc || scoreDescForRate(allTimeRate, allTimeTotal);
  // Rolling 30/90-day windows, never natural-month approximations (review Major 7).
  const windows = rollingKpis ?? sampleWindows(reviews);
  return {
    allTime: { total: allTimeTotal, positiveRate: allTimeRate, reviewScoreDesc: desc },
    last30d: { total: windows.last30d.total, positiveRate: windows.last30d.positiveRate },
    last90d: { total: windows.last90d.total, positiveRate: windows.last90d.positiveRate },
    sampleSize: reviews.length,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output };
}

function mergeAnalyses(parts: ParsedAnalysis[]): ParsedAnalysis {
  return {
    themes: parts.flatMap((p) => p.themes),
    expectationGaps: parts.flatMap((p) => p.expectationGaps),
    updateImpact: parts.flatMap((p) => p.updateImpact),
    recommendations: parts.flatMap((p) => p.recommendations),
    conclusion: null,
  };
}

function normalizeThemeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * The final stage may only restate themes produced by the merge stage (design
 * §8.4: "不得引入新主题"). Themes are matched by id first, then by normalized
 * name; anything else is discarded and the merged theme set is used instead.
 */
export function restrictThemesToMerge<T extends { id?: string; name: string }>(
  finalThemes: T[],
  mergeThemes: Array<{ id?: string; name: string }>,
): T[] {
  const byId = new Map<string, { id?: string; name: string }>();
  const byName = new Map<string, { id?: string; name: string }>();
  for (const theme of mergeThemes) {
    if (theme.id) byId.set(theme.id, theme);
    const key = normalizeThemeName(theme.name);
    if (key && !byName.has(key)) byName.set(key, theme);
  }
  const selected = new Set<{ id?: string; name: string }>();
  const result: T[] = [];
  for (const theme of finalThemes) {
    const match = (theme.id ? byId.get(theme.id) : undefined) ?? byName.get(normalizeThemeName(theme.name));
    if (!match || selected.has(match)) continue;
    selected.add(match);
    result.push(theme);
  }
  return result;
}

/**
 * Preprocess, chunk and run the map/merge/final (or holistic) AI analysis.
 * The AI only supplies narrative content and evidence; numbers and labels are
 * computed by the server later in buildReport.
 */
export async function analyzeReviews(input: AnalyzeInput): Promise<AnalyzeResult> {
  const sample = input.reviews.filter((r) => r.text.trim().length > 0);
  if (sample.length === 0) throw new AppError('NO_REVIEWS', '没有可送入 AI 的非空评论正文');

  const kpis = buildKpiPromptInput(
    sample,
    input.allTimeSummary ?? null,
    input.trend,
    input.rollingKpis,
  );
  const chunks = buildChunks(sample, {
    maxTokensPerChunk: input.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK,
    maxChunks: input.maxChunks ?? DEFAULT_MAX_CHUNKS,
  });
  const report = (stage: string, progress: number, message: string, counts?: Record<string, number>) =>
    input.onProgress?.({ stage, progress, message, counts });
  // Cancellation is checked immediately before every paid AI call and before
  // evidence validation, so a cancelled job never starts a new model request.
  const ensureActive = () => {
    if (input.signal?.aborted) throw new AppError('CANCELLED');
  };

  let usage: TokenUsage = { input: 0, output: 0 };
  let combined: ParsedAnalysis;

  if (chunks.length === 1) {
    ensureActive();
    report('analyzing', 45, 'AI 整体分析中', { chunks: 1 });
    const prompt = buildHolisticPrompt(sample, kpis, input.trend.points, input.includeTranslations);
    const result = await input.ai.chatJson({
      model: input.aiOptions.model,
      system: prompt.system,
      user: prompt.user,
      maxTokens: 8192,
      temperature: input.aiOptions.temperature,
      thinking: input.aiOptions.thinking,
      signal: input.signal,
    });
    usage = addUsage(usage, result.usage);
    combined = parseAnalysis(result.data);
    report('analyzing', 85, 'AI 整体分析完成', { chunks: 1 });
  } else {
    const mapped: ParsedAnalysis[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      ensureActive();
      report('analyzing', 40 + Math.round((i / chunks.length) * 25), `AI 分块分析 ${i + 1}/${chunks.length}`, {
        chunks: chunks.length,
        completed: i,
      });
      const prompt = buildMapPrompt(chunks[i], i, chunks.length, input.includeTranslations);
      const result = await input.ai.chatJson({
        model: input.aiOptions.model,
        system: prompt.system,
        user: prompt.user,
        maxTokens: 4096,
        temperature: input.aiOptions.temperature,
        thinking: input.aiOptions.thinking,
        signal: input.signal,
      });
      usage = addUsage(usage, result.usage);
      mapped.push(parseAnalysis(result.data));
    }

    const combinedMap = mergeAnalyses(mapped);
    ensureActive();
    report('analyzing', 70, 'AI 合并主题中', { chunks: chunks.length });
    const mergePrompt = buildMergePrompt(combinedMap.themes, sample.length, input.includeTranslations);
    const mergeResult = await input.ai.chatJson({
      model: input.aiOptions.model,
      system: mergePrompt.system,
      user: mergePrompt.user,
      maxTokens: 4096,
      temperature: input.aiOptions.temperature,
      thinking: input.aiOptions.thinking,
      signal: input.signal,
    });
    usage = addUsage(usage, mergeResult.usage);
    const merged = parseAnalysis(mergeResult.data);
    const mergeThemes = merged.themes.length ? merged.themes : combinedMap.themes;

    report('analyzing', 80, 'AI 生成结论中', { chunks: chunks.length });
    ensureActive();
    const finalPrompt = buildFinalPrompt(mergeThemes, kpis, input.trend.points, input.includeTranslations);
    const finalResult = await input.ai.chatJson({
      model: input.aiOptions.model,
      system: finalPrompt.system,
      user: finalPrompt.user,
      maxTokens: 8192,
      temperature: input.aiOptions.temperature,
      thinking: input.aiOptions.thinking,
      signal: input.signal,
    });
    usage = addUsage(usage, finalResult.usage);
    const final = parseAnalysis(finalResult.data);
    const restrictedFinalThemes = restrictThemesToMerge(final.themes, mergeThemes);
    combined = {
      themes: restrictedFinalThemes.length ? restrictedFinalThemes : mergeThemes,
      expectationGaps: final.expectationGaps.length ? final.expectationGaps : combinedMap.expectationGaps,
      updateImpact: final.updateImpact.length ? final.updateImpact : combinedMap.updateImpact,
      recommendations: final.recommendations.length ? final.recommendations : combinedMap.recommendations,
      conclusion: final.conclusion,
    };
    report('analyzing', 90, 'AI 分析完成', { chunks: chunks.length });
  }

  ensureActive();
  report('validating', 93, '校验 AI 证据引用');
  const validated = validateEvidence(combined, sample, { includeTranslations: input.includeTranslations });
  if (validated.themes.length === 0) {
    throw new AppError('AI_INVALID_RESPONSE', '所有 AI 主题均因缺少有效证据被删除');
  }
  const split = splitThemes(validated.themes);
  if (split.appealPoints.length === 0 && split.frictionPoints.length === 0) {
    throw new AppError('AI_INVALID_RESPONSE', 'AI 未返回可用主题');
  }
  return { analysis: validated, usage, usedForAI: sample.length };
}
