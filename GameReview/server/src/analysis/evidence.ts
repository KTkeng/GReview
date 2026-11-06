import type { Recommendation, Review, Theme, ThemeQuote } from '../types';
import { parseAnalysis, type ParsedAnalysis, type RawRecommendation, type RawTheme } from '../ai/schema';

/** Normalize text for quote matching: case, width, whitespace, punctuation insensitive. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function isQuoteSubstring(quote: string, reviewText: string): boolean {
  const q = normalizeForMatch(quote);
  if (!q) return false;
  return normalizeForMatch(reviewText).includes(q);
}

function validateTheme(
  raw: RawTheme,
  reviewMap: Map<string, Review>,
  index: number,
  includeTranslations: boolean,
): Theme | null {
  const evidenceIds = raw.evidenceIds.filter((id) => reviewMap.has(id));
  const uniqueEvidence = [...new Set(evidenceIds)];
  if (uniqueEvidence.length === 0) return null;

  const evidenceSet = new Set(uniqueEvidence);
  const quotes: ThemeQuote[] = [];
  const seen = new Set<string>();
  for (const quote of raw.quotes) {
    if (!evidenceSet.has(quote.reviewId)) continue;
    const review = reviewMap.get(quote.reviewId);
    if (!review) continue;
    const original = quote.original?.trim() ?? '';
    if (!isQuoteSubstring(original, review.text)) continue;
    const key = `${quote.reviewId}\u0000${normalizeForMatch(original)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({
      reviewId: quote.reviewId,
      original,
      // With translations disabled the server never trusts a model-supplied
      // translation, even if the model ignored the prompt and returned one.
      ...(includeTranslations && quote.zh ? { zh: quote.zh } : {}),
      votesUp: review.votesUp,
      votedUp: review.votedUp,
    });
    if (quotes.length >= 5) break;
  }

  // Prefer a server-side count from valid evidence IDs. The AI's own count is
  // only kept when it is larger (it may include comments it did not cite), and
  // then it is explicitly marked as an estimate in the report and exports.
  const evidenceCount = uniqueEvidence.length;
  const aiMentions =
    typeof raw.mentions === 'number' && Number.isFinite(raw.mentions)
      ? Math.max(0, Math.floor(raw.mentions))
      : undefined;
  const keepAiMentions = aiMentions !== undefined && aiMentions > evidenceCount;

  return {
    id: raw.id || `t${index + 1}`,
    name: raw.name,
    ...(raw.category ? { category: raw.category } : {}),
    ...(raw.sentiment ? { sentiment: raw.sentiment } : {}),
    mentions: keepAiMentions ? aiMentions : evidenceCount,
    mentionsEstimated: keepAiMentions ? true : undefined,
    summary: raw.summary,
    evidenceIds: uniqueEvidence,
    quotes,
    ...(raw.keywords ? { keywords: raw.keywords } : {}),
  };
}

function validateThemes(
  rawThemes: RawTheme[],
  reviewMap: Map<string, Review>,
  offset = 0,
  includeTranslations = true,
): Theme[] {
  const out: Theme[] = [];
  for (let i = 0; i < rawThemes.length; i += 1) {
    const theme = validateTheme(rawThemes[i], reviewMap, offset + i, includeTranslations);
    if (theme) out.push(theme);
  }
  return out;
}

function validateRecommendations(raw: RawRecommendation[], reviewMap: Map<string, Review>): Recommendation[] {
  return raw.map((rec) => ({
    title: rec.title,
    detail: rec.detail,
    priority: rec.priority,
    evidenceIds: [...new Set(rec.evidenceIds.filter((id) => reviewMap.has(id)))],
  }));
}

export interface ValidatedAnalysis {
  themes: Theme[];
  expectationGaps: Theme[];
  updateImpact: Theme[];
  recommendations: Recommendation[];
  conclusion: ParsedAnalysis['conclusion'];
}

/**
 * Server-side evidence validation (design §8.5):
 * - keep only evidence IDs present in the AI sample;
 * - keep only quotes that appear as normalized substrings of the cited review;
 * - drop quotes whose reviewId is not in the theme's evidenceIds;
 * - drop themes that lose all evidence; trust votes/up only from the source review.
 */
export interface ValidateEvidenceOptions {
  /**
   * When false, any model-supplied `zh` translation is removed at the evidence
   * boundary. Defaults to true for backwards compatibility with stored data.
   */
  includeTranslations?: boolean;
}

export function validateEvidence(
  analysis: unknown | ParsedAnalysis,
  reviews: Review[],
  options: ValidateEvidenceOptions = {},
): ValidatedAnalysis {
  const includeTranslations = options.includeTranslations !== false;
  const parsed: ParsedAnalysis =
    analysis && typeof analysis === 'object' && 'themes' in analysis && 'expectationGaps' in analysis && 'updateImpact' in analysis
      ? (analysis as ParsedAnalysis)
      : parseAnalysis(analysis);
  const reviewMap = new Map(reviews.map((r) => [r.id, r]));
  return {
    themes: validateThemes(parsed.themes, reviewMap, 0, includeTranslations),
    expectationGaps: validateThemes(parsed.expectationGaps, reviewMap, 0, includeTranslations),
    updateImpact: validateThemes(parsed.updateImpact, reviewMap, 1000, includeTranslations),
    recommendations: validateRecommendations(parsed.recommendations, reviewMap),
    conclusion: parsed.conclusion ?? null,
  };
}

/** Split validated themes into the report's positive/negative groups. */
export function splitThemes(themes: Theme[]): { appealPoints: Theme[]; frictionPoints: Theme[] } {
  const appealPoints: Theme[] = [];
  const frictionPoints: Theme[] = [];
  for (const theme of themes) {
    if (theme.sentiment === 'negative') frictionPoints.push(theme);
    else appealPoints.push(theme);
  }
  return { appealPoints, frictionPoints };
}
