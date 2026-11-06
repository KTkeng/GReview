import type { Report, Review, SteamSummary, TrendPoint } from '../types';
import { rollingWindowBounds } from '../lib/time';

export const PROMPT_VERSION = 'greview-prompt-v1';

const MAX_REVIEW_CHARS = 1500;

export interface PromptReview {
  id: string;
  language: string;
  votedUp: boolean;
  votesUp: number;
  playtimeHours: number;
  createdAt: number;
  text: string;
}

export function toPromptReviews(reviews: Review[]): PromptReview[] {
  return reviews.map((r) => ({
    id: r.id,
    language: r.language,
    votedUp: r.votedUp,
    votesUp: r.votesUp,
    playtimeHours: Math.round((r.playtimeAtReviewMinutes / 60) * 10) / 10,
    createdAt: r.createdAt,
    text: r.text.slice(0, MAX_REVIEW_CHARS),
  }));
}

const JSON_RULES = `输出必须是严格合法的 json，不得包含 Markdown 代码块或解释文字。只依据给定评论，不得补充外部知识。每个主题至少提供 1 个 evidenceIds，且 ID 必须来自输入评论；quotes[].original 必须是对应评论正文的连续子串（原文摘录），不得改写或编造。sentiment 只能是 positive、negative、neutral 或 mixed；混合评价用 mixed。不要判断销量、收入、在线人数或商业成败，只分析口碑。`;

/**
 * Translation policy. When translations are enabled, every quote whose source
 * review is not Chinese must carry a faithful Simplified-Chinese `zh` field.
 * When disabled, the model must not translate or emit `zh` at all; the server
 * additionally strips any stray `zh` before the report is built.
 */
function translationRules(includeTranslations: boolean): string {
  return includeTranslations
    ? '翻译要求：quotes[].original 为非中文时，必须提供 zh 字段，将原文忠实翻译为简体中文；中文原文不得添加 zh。zh 只能是对 original 的翻译，不得添加原文没有的信息。'
    : '翻译要求：本次任务不生成翻译。不得输出 zh 字段，也不得翻译 quotes[].original；即使原文为非中文，也只保留 original 原文子串。';
}

function jsonRules(includeTranslations: boolean): string {
  return `${JSON_RULES}${translationRules(includeTranslations)}`;
}

/** Prompt schema for a quote. `zh` is only advertised when translations are on. */
export function mapSchemaExample(includeTranslations = true): string {
  const zh = includeTranslations ? ', "zh": "中文翻译（非中文时）"' : '';
  return `{
  "themes": [
    { "name": "主题名", "category": "gameplay|story|performance|price|content|community|other", "sentiment": "positive|negative|neutral|mixed", "summary": "摘要", "evidenceIds": ["评论ID"], "keywords": ["关键词"], "quotes": [{ "reviewId": "评论ID", "original": "原文子串"${zh} }] }
  ],
  "expectationMentions": [
    { "expectation": "玩家预期", "reality": "实际体验", "evidenceIds": ["评论ID"], "quotes": [{ "reviewId": "评论ID", "original": "原文子串" }] }
  ],
  "updateMentions": [
    { "change": "版本变化", "reaction": "玩家反应", "evidenceIds": ["评论ID"], "quotes": [{ "reviewId": "评论ID", "original": "原文子串" }] }
  ]
}`;
}

/** Backwards-compatible schema with translations enabled. */
export const MAP_SCHEMA_EXAMPLE = mapSchemaExample(true);

export function buildMapPrompt(
  chunk: Review[],
  chunkIndex: number,
  chunkCount: number,
  includeTranslations = true,
): { system: string; user: string } {
  const reviews = toPromptReviews(chunk);
  return {
    system: `你是资深游戏评论分析师，正在对 Steam 评论分块做主题抽取（第 ${chunkIndex + 1}/${chunkCount} 块）。${jsonRules(includeTranslations)}`,
    user: `请从以下评论中抽取玩家认可点、劝退点、预期落差与版本更新影响。输出 json，结构示例：\n${mapSchemaExample(includeTranslations)}\n\n评论数据：\n${JSON.stringify(reviews)}`,
  };
}

export function buildMergePrompt(
  themes: unknown[],
  totalReviews: number,
  includeTranslations = true,
): { system: string; user: string } {
  const preserve = includeTranslations
    ? '保留 quotes 中已有的 zh 翻译，可将其随主题一并合并；不得编造新的翻译。'
    : '丢弃 quotes 中可能存在的 zh 字段，只保留 original。';
  return {
    system: `你是分析合并器。把多个分块的主题合并去重，保留 evidenceIds 并集，按提及数与赞数加权排序。${jsonRules(includeTranslations)}${preserve}`,
    user: `样本共 ${totalReviews} 条评论。下面是各分块主题，请合并语义相近项，输出 json：{ "themes": [ ...同 map 结构... ] }\n\n${JSON.stringify(themes).slice(0, 60000)}`,
  };
}

export interface KpiSummaryInput {
  allTime: { total: number; positiveRate: number; reviewScoreDesc: string };
  last30d: { total: number; positiveRate: number };
  last90d: { total: number; positiveRate: number };
  sampleSize: number;
}

export function buildFinalPrompt(
  themes: unknown[],
  kpis: KpiSummaryInput,
  trendPoints: TrendPoint[],
  includeTranslations = true,
): { system: string; user: string } {
  const preserve = includeTranslations
    ? '保留服务端主题 quotes 中已有的 zh 翻译；不得为中文原文添加 zh。'
    : '输出中不得包含 zh 字段，也不得翻译 quotes[].original。';
  return {
    system: `你是报告结论撰写者。基于已合并主题、KPI 与月度趋势，输出结论、置信度解释、局限和可行动建议。不得引入新主题，不得改写数字，不得判断销量/收入/商业成败。${jsonRules(includeTranslations)}${preserve}`,
    user: `主题：\n${JSON.stringify(themes).slice(0, 60000)}\n\nKPI：${JSON.stringify(kpis)}\n\n月度趋势：${JSON.stringify(
      trendPoints.map((p) => ({ period: p.period, total: p.total, positiveRate: Number(p.positiveRate.toFixed(4)) })),
    )}\n\n请只输出 json：{ "conclusion": { "label": "建议标签", "headline": "一句话结论", "summary": "2-4 段中文分析", "confidence": "high|medium|low", "caveats": ["局限"] }, "recommendations": [{ "title": "建议", "detail": "依据", "priority": "high|medium|low", "evidenceIds": ["评论ID"] }] }。不要输出 themes、expectationGaps 或 updateImpact；服务端会使用已校验的合并主题与分块结果。`,
  };
}

export function buildHolisticPrompt(
  reviews: Review[],
  kpis: KpiSummaryInput,
  trendPoints: TrendPoint[],
  includeTranslations = true,
): { system: string; user: string } {
  return {
    system: `你是资深游戏评论分析师，需要一次性完成主题归纳、预期落差、更新影响与结论建议。${jsonRules(includeTranslations)}`,
    user: `请分析以下 Steam 评论样本并输出 json，结构：\n${mapSchemaExample(includeTranslations).slice(0, -2)}\n  , "conclusion": { "label": "建议标签", "headline": "一句话结论", "summary": "2-4 段中文分析", "confidence": "high|medium|low", "caveats": ["局限"] }, "recommendations": [{ "title": "建议", "detail": "依据", "priority": "high|medium|low", "evidenceIds": ["评论ID"] }] }\n\nKPI：${JSON.stringify(kpis)}\n趋势：${JSON.stringify(trendPoints.map((p) => ({ period: p.period, total: p.total, positiveRate: Number(p.positiveRate.toFixed(4)) })))}\n\n评论数据：\n${JSON.stringify(toPromptReviews(reviews))}`,
  };
}

export function buildReportNote(
  allTimeSummary: SteamSummary | null,
  allTimeSource: 'official_aggregate' | 'sample_estimate',
  sampleCount: number,
  trendSource: string,
  aggregatesComputedAt?: string,
): string {
  const allTimeText =
    allTimeSource === 'official_aggregate' && allTimeSummary
      ? `全部时间好评率为 ${(allTimeSummary.positiveRate * 100).toFixed(1)}%（Steam 官方聚合）`
      : '全部时间 KPI 缺少独立官方聚合，当前为筛选样本估算（非 Steam 全站口径）';
  const w30 = rollingWindowBounds(aggregatesComputedAt, 30);
  const w90 = rollingWindowBounds(aggregatesComputedAt, 90);
  const aggregateText =
    aggregatesComputedAt && w30 && w90
      ? `滚动 KPI 聚合计算于 ${aggregatesComputedAt}；最近30天窗口 ${w30.start} 至 ${w30.end}，最近90天窗口 ${w90.start} 至 ${w90.end}，聚合结果在重新抓取前保持不变。`
      : aggregatesComputedAt
        ? `滚动 KPI 聚合计算于 ${aggregatesComputedAt}，聚合结果在重新抓取前保持不变。`
        : '';
  return `本报告基于 ${sampleCount} 条高赞/筛选样本评论与 ${trendSource} 月度趋势生成；KPI、标签与置信度由服务端计算。高赞样本可能低估长尾玩家，评论不代表全部玩家，且无法据此推断销量、收入或商业成败。${allTimeText}。${aggregateText}`;
}

export type ReportTemplate = Pick<Report, 'conclusion'>;
