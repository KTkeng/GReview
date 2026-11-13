import { AppError } from '../lib/errors';
import type { AiOptions, GameMeta, KpiWindows, Review, ScrapeFilters, SteamSummary, TokenUsage, TrendDataset } from '../types';
import type { AIProvider } from '../ai/deepseek';
import { buildFinalPrompt, buildHolisticPrompt, buildMapPrompt, buildMergePrompt, type KpiSummaryInput } from '../ai/prompts';
import { parseAnalysis, type ParsedAnalysis, type RawTheme } from '../ai/schema';
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

/**
 * Per-stage output budget. DeepSeek thinking shares `max_tokens` between
 * `reasoning_content` and the visible JSON. The API's own default is 8K
 * without thinking and 64K with thinking, so setting 8K while thinking (the
 * old behavior) silently capped reasoning far below DeepSeek's default. Use
 * the provider's thinking default explicitly; the client escalates further if
 * a response still ends with finish_reason "length".
 */
export const ANALYSIS_MAX_TOKENS = 8192;
export const ANALYSIS_THINKING_MAX_TOKENS = 65536;

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

/** Parse one stage and keep the stage name in the diagnostic. */
function parseWithStage(raw: unknown, stage: string): ParsedAnalysis {
  try {
    return parseAnalysis(raw);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError('AI_INVALID_RESPONSE', `${stage}: ${error.message}`);
    }
    throw error;
  }
}

/** A theme is usable only when at least one cited review exists in the sample. */
function hasUsableThemes(themes: RawTheme[], reviews: Review[]): boolean {
  const ids = new Set(reviews.map((r) => r.id));
  return themes.some((theme) => theme.evidenceIds.some((id) => ids.has(id)));
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
  const stageMaxTokens = input.aiOptions.thinking ? ANALYSIS_THINKING_MAX_TOKENS : ANALYSIS_MAX_TOKENS;

  if (chunks.length === 1) {
    ensureActive();
    report('analyzing', 45, 'AI 整体分析中', { chunks: 1, completed: 0 });
    const prompt = buildHolisticPrompt(sample, kpis, input.trend.points, input.includeTranslations);
    const result = await input.ai.chatJson({
      model: input.aiOptions.model,
      system: prompt.system,
      user: prompt.user,
      maxTokens: stageMaxTokens,
      temperature: input.aiOptions.temperature,
      thinking: input.aiOptions.thinking,
      signal: input.signal,
    });
    usage = addUsage(usage, result.usage);
    combined = parseWithStage(result.data, '整体分析');
    // Count the holistic call as one successfully completed chunk only after
    // its JSON parsed and passed schema validation.
    report('analyzing', 85, 'AI 整体分析完成', { chunks: 1, completed: 1 });
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
        maxTokens: stageMaxTokens,
        temperature: input.aiOptions.temperature,
        thinking: input.aiOptions.thinking,
        signal: input.signal,
      });
      usage = addUsage(usage, result.usage);
      mapped.push(parseWithStage(result.data, `分块分析 ${i + 1}/${chunks.length}`));
      // A chunk counts as completed exactly once, after its response parsed and
      // passed schema validation. Provider-level retries/repairs still yield a
      // single success here, so the count never double-adds a chunk.
      report(
        'analyzing',
        40 + Math.round(((i + 1) / chunks.length) * 25),
        `AI 分块分析 ${i + 1}/${chunks.length} 完成`,
        { chunks: chunks.length, completed: i + 1 },
      );
    }

    const combinedMap = mergeAnalyses(mapped);
    ensureActive();
    // Merge/final are not chunks: keep the task-level chunk total and the
    // successful chunk count unchanged while these stages run.
    report('analyzing', 70, 'AI 合并主题中', { chunks: chunks.length, completed: chunks.length });
    const mergePrompt = buildMergePrompt(combinedMap.themes, sample.length, input.includeTranslations);
    const mergeResult = await input.ai.chatJson({
      model: input.aiOptions.model,
      system: mergePrompt.system,
      user: mergePrompt.user,
      maxTokens: stageMaxTokens,
      temperature: input.aiOptions.temperature,
      thinking: input.aiOptions.thinking,
      signal: input.signal,
    });
    usage = addUsage(usage, mergeResult.usage);
    const merged = parseWithStage(mergeResult.data, '合并主题');
    const mergeThemes = merged.themes.length ? merged.themes : combinedMap.themes;
    // The final model is a writer, not the source of truth for themes. Use the
    // merged themes when at least one cites a real review; otherwise fall back
    // to the map themes rather than letting a bad final stage delete everything.
    const authoritativeThemes = hasUsableThemes(mergeThemes, sample) ? mergeThemes : combinedMap.themes;

    report('analyzing', 80, 'AI 生成结论中', { chunks: chunks.length, completed: chunks.length });
    ensureActive();
    const finalPrompt = buildFinalPrompt(authoritativeThemes, kpis, input.trend.points, input.includeTranslations);
    const finalResult = await input.ai.chatJson({
      model: input.aiOptions.model,
      system: finalPrompt.system,
      user: finalPrompt.user,
      maxTokens: stageMaxTokens,
      temperature: input.aiOptions.temperature,
      thinking: input.aiOptions.thinking,
      signal: input.signal,
    });
    usage = addUsage(usage, finalResult.usage);
    const final = parseWithStage(finalResult.data, '生成结论');
    // Themes, expectation gaps and update impact stay evidence-backed from the
    // map/merge stages. The final stage contributes prose and recommendations.
    combined = {
      themes: authoritativeThemes,
      expectationGaps: combinedMap.expectationGaps,
      updateImpact: combinedMap.updateImpact,
      recommendations: final.recommendations,
      conclusion: final.conclusion,
    };
    report('analyzing', 90, 'AI 分析完成', { chunks: chunks.length, completed: chunks.length });
  }

  ensureActive();
  report('validating', 93, '校验 AI 证据引用');
  const validated = validateEvidence(combined, sample, { includeTranslations: input.includeTranslations });
  if (validated.themes.length === 0) {
    throw new AppError(
      'AI_INVALID_RESPONSE',
      `所有 AI 主题均因缺少有效证据被删除（候选 ${combined.themes.length} 个，样本 ${sample.length} 条）`,
    );
  }
  const split = splitThemes(validated.themes);
  if (split.appealPoints.length === 0 && split.frictionPoints.length === 0) {
    throw new AppError('AI_INVALID_RESPONSE', 'AI 未返回可用主题');
  }
  return { analysis: validated, usage, usedForAI: sample.length };
}
