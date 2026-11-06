import { z } from 'zod';
import { AppError } from '../lib/errors';

const idList = z
  .array(z.union([z.string(), z.number()]))
  .default([])
  .transform((ids) => ids.map((id) => String(id)).filter(Boolean));

/**
 * Sentiment is narrative metadata, not a validation gate. Models sometimes
 * answer `mixed` (or a localised variant) for a theme that contains both
 * praise and criticism; accepting and normalising it keeps a useful analysis
 * from failing outright. Unknown values are ignored rather than rejecting the
 * whole response.
 */
const sentimentSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().toLowerCase();
  if (s === 'positive' || s === '正向' || s === '正面') return 'positive';
  if (s === 'negative' || s === '负向' || s === '负面') return 'negative';
  if (s === 'neutral' || s === '中性' || s === '中立') return 'neutral';
  if (s === 'mixed' || s === 'both' || s.includes('褒贬') || s.includes('争议') || s.includes('混合')) return 'mixed';
  return undefined;
}, z.enum(['positive', 'negative', 'neutral', 'mixed']).optional());

const QuoteSchema = z
  .object({
    reviewId: z.union([z.string(), z.number()]).optional(),
    original: z.string().optional().default(''),
    zh: z.string().optional(),
    votesUp: z.number().optional(),
    votedUp: z.boolean().optional(),
  })
  .passthrough()
  .transform((q) => ({
    reviewId: q.reviewId === undefined ? '' : String(q.reviewId),
    original: q.original ?? '',
    ...(q.zh ? { zh: q.zh } : {}),
  }));

export const ThemeSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional().default(''),
    category: z.string().optional(),
    sentiment: sentimentSchema,
    mentions: z.number().optional(),
    summary: z.string().optional().default(''),
    evidenceIds: idList,
    quotes: z.array(QuoteSchema).optional().default([]),
    keywords: z.array(z.string()).optional(),
  })
  .passthrough()
  .transform((t) => ({
    ...(t.id !== undefined ? { id: String(t.id) } : {}),
    name: t.name || '未命名主题',
    ...(t.category ? { category: t.category } : {}),
    ...(t.sentiment ? { sentiment: t.sentiment } : {}),
    ...(t.mentions !== undefined ? { mentions: t.mentions } : {}),
    summary: t.summary ?? '',
    evidenceIds: t.evidenceIds,
    quotes: t.quotes,
    ...(t.keywords ? { keywords: t.keywords } : {}),
  }));

const GapSchema = z
  .object({
    name: z.string().optional(),
    expectation: z.string().optional(),
    reality: z.string().optional(),
    summary: z.string().optional(),
    evidenceIds: idList,
    quotes: z.array(QuoteSchema).optional().default([]),
    sentiment: sentimentSchema,
    category: z.string().optional(),
  })
  .passthrough()
  .transform((g) => ({
    name: g.name || g.expectation || '预期落差',
    summary: g.summary || `预期：${g.expectation ?? '未说明'}；实际：${g.reality ?? '未说明'}`,
    evidenceIds: g.evidenceIds,
    quotes: g.quotes,
    ...(g.sentiment ? { sentiment: g.sentiment } : {}),
    ...(g.category ? { category: g.category } : { category: 'expectation' }),
  }));

const UpdateSchema = z
  .object({
    name: z.string().optional(),
    change: z.string().optional(),
    reaction: z.string().optional(),
    summary: z.string().optional(),
    evidenceIds: idList,
    quotes: z.array(QuoteSchema).optional().default([]),
    sentiment: sentimentSchema,
    category: z.string().optional(),
  })
  .passthrough()
  .transform((u) => ({
    name: u.name || u.change || '版本更新影响',
    summary: u.summary || `变化：${u.change ?? '未说明'}；反应：${u.reaction ?? '未说明'}`,
    evidenceIds: u.evidenceIds,
    quotes: u.quotes,
    ...(u.sentiment ? { sentiment: u.sentiment } : {}),
    ...(u.category ? { category: u.category } : { category: 'update' }),
  }));

const RecommendationSchema = z
  .object({
    title: z.string().optional().default(''),
    detail: z.string().optional().default(''),
    priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
    evidenceIds: idList,
  })
  .passthrough()
  .transform((r) => ({ title: r.title || '建议', detail: r.detail ?? '', priority: r.priority, evidenceIds: r.evidenceIds }));

const ConclusionSchema = z
  .object({
    label: z.string().optional().default(''),
    headline: z.string().optional().default(''),
    summary: z.string().optional().default(''),
    confidence: z.enum(['high', 'medium', 'low']).optional().default('low'),
    caveats: z.array(z.string()).optional().default([]),
  })
  .passthrough();

const AnalysisSchema = z
  .object({
    themes: z.array(ThemeSchema).optional().default([]),
    appealPoints: z.array(ThemeSchema).optional().default([]),
    frictionPoints: z.array(ThemeSchema).optional().default([]),
    expectationGaps: z.array(GapSchema).optional().default([]),
    expectationMentions: z.array(GapSchema).optional().default([]),
    updateImpact: z.array(UpdateSchema).optional().default([]),
    updateMentions: z.array(UpdateSchema).optional().default([]),
    recommendations: z.array(RecommendationSchema).optional().default([]),
    conclusion: ConclusionSchema.optional(),
  })
  .passthrough();

export interface RawQuote {
  reviewId: string;
  original: string;
  zh?: string;
}

export interface RawTheme {
  id?: string;
  name: string;
  category?: string;
  sentiment?: 'positive' | 'negative' | 'neutral' | 'mixed';
  mentions?: number;
  summary: string;
  evidenceIds: string[];
  quotes: RawQuote[];
  keywords?: string[];
}

export interface RawRecommendation {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
  evidenceIds: string[];
}

export interface RawConclusion {
  label: string;
  headline: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
}

export interface ParsedAnalysis {
  themes: RawTheme[];
  expectationGaps: RawTheme[];
  updateImpact: RawTheme[];
  recommendations: RawRecommendation[];
  conclusion: RawConclusion | null;
}

/**
 * Parse and coerce AI output into a predictable analysis shape. Supports both
 * the flat `themes` and the grouped `appealPoints`/`frictionPoints` variants.
 */
export function parseAnalysis(raw: unknown): ParsedAnalysis {
  const result = AnalysisSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new AppError('AI_INVALID_RESPONSE', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const v = result.data;
  const themes: RawTheme[] = [...v.themes];
  if (v.appealPoints.length || v.frictionPoints.length) {
    themes.push(...v.appealPoints.map((t) => ({ ...t, sentiment: t.sentiment ?? 'positive' })));
    themes.push(...v.frictionPoints.map((t) => ({ ...t, sentiment: t.sentiment ?? 'negative' })));
  }
  const gaps = v.expectationGaps.length ? v.expectationGaps : v.expectationMentions;
  const updates = v.updateImpact.length ? v.updateImpact : v.updateMentions;
  return {
    themes,
    expectationGaps: gaps,
    updateImpact: updates,
    recommendations: v.recommendations,
    conclusion: v.conclusion ?? null,
  };
}

export type { ThemeSchema as RawThemeSchema, GapSchema as RawGapSchema, RecommendationSchema as RawRecommendationSchema };
