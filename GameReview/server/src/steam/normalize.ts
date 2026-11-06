import { AppError } from '../lib/errors';
import type { Review, SourceEndpoint, SteamPage, SteamSummary } from '../types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Unlike `num`, keeps "absent" distinct from an explicit numeric zero. */
function optionalNum(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return '';
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const BBCODE_TAG = /\[\/?(b|i|u|s|strike|h1|h2|h3|url|img|quote|code|list|olist|table|tr|td|th|hr|noparse|spoiler|previewyoutube|video|youtube|carousel)(=[^\]]*)?\]/gi;

/**
 * Clean Steam BBCode/HTML, decode entities, collapse whitespace while keeping
 * paragraph breaks (design §7.5). Stored text is untrusted content.
 */
export function cleanText(input: unknown): string {
  if (typeof input !== 'string') return '';
  // Strip markup before decoding entities so a literal "&lt;tag&gt;" typed by a
  // player survives as text instead of being mistaken for an HTML tag.
  let text = input.replace(BBCODE_TAG, '').replace(/\[\*\]/g, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[\t\f\v  ]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function normalizeReview(raw: unknown): Review | null {
  const r = asRecord(raw);
  if (!r) return null;
  const idRaw = r.recommendationid ?? r.recommendation_id ?? r.id;
  if (idRaw === undefined || idRaw === null || String(idRaw).trim() === '') return null;
  const author = asRecord(r.author) ?? {};
  const playtime =
    r.playtime_at_review ?? r.playtime_forever ?? author.playtime_at_review ?? author.playtime_forever ?? 0;
  const created = r.timestamp_created ?? r.created_at ?? 0;
  const text = cleanText(r.review ?? r.review_text ?? r.text ?? '');
  return {
    id: String(idRaw),
    language: typeof r.language === 'string' && r.language ? r.language : 'english',
    votedUp: bool(r.voted_up),
    votesUp: Math.max(0, num(r.votes_up)),
    weightedVoteScore: num(r.weighted_vote_score),
    playtimeAtReviewMinutes: Math.max(0, num(playtime)),
    createdAt: Math.max(0, num(created)),
    text,
    writtenDuringEarlyAccess: bool(r.written_during_early_access),
    receivedForFree: bool(r.received_for_free),
  };
}

function buildSummary(
  rawSummary: unknown,
  matchingTotal: number | undefined,
  source: SourceEndpoint,
  fallbackReviewCount: number,
): SteamSummary | null {
  const qs = asRecord(rawSummary);
  if (!qs) return null;
  const positive = Math.max(0, num(qs.total_positive));
  const negative = Math.max(0, num(qs.total_negative));
  const rawTotal = optionalNum(qs.total_reviews);
  const derived = positive + negative;
  // An explicit total_reviews=0 must not be replaced by derived/fallback values.
  const total = rawTotal !== undefined ? rawTotal : derived > 0 ? derived : Math.max(0, fallbackReviewCount);
  const matching = matchingTotal !== undefined ? matchingTotal : total;
  return {
    total,
    positive,
    negative,
    positiveRate: total > 0 ? positive / total : 0,
    reviewScoreDesc: typeof qs.review_score_desc === 'string' ? qs.review_score_desc : '',
    matchingTotal: matching,
    sourceEndpoint: source,
    totalPositive: positive,
    totalNegative: negative,
  };
}

/**
 * Normalize both Steam response shapes into the internal SteamPage contract.
 * Official responses are wrapped in `response`; storefront responses are root
 * objects containing `success`. Anything else is an endpoint change.
 */
export function normalizeSteamPage(raw: unknown, source: SourceEndpoint): SteamPage {
  const root = asRecord(raw);
  if (!root) throw new AppError('STEAM_ENDPOINT_CHANGED', '响应不是 JSON 对象');

  let container: Record<string, unknown>;
  if (source === 'official') {
    const response = asRecord(root.response);
    if (!response) throw new AppError('STEAM_ENDPOINT_CHANGED', '官方响应缺少 response 包装');
    container = response;
  } else {
    if ('success' in root && !bool(root.success) && !Array.isArray(root.reviews)) {
      throw new AppError('STEAM_ENDPOINT_CHANGED', '回退端点返回 success != 1');
    }
    container = root;
  }

  const hasReviews = Array.isArray(container.reviews);
  const hasSummary = asRecord(container.query_summary) !== null;
  const rawMatchingTotal = optionalNum(container.total_matching);
  const hasMatching = rawMatchingTotal !== undefined;
  if (!hasReviews && !hasSummary && !hasMatching) {
    throw new AppError('STEAM_ENDPOINT_CHANGED', '响应缺少 reviews/query_summary/total_matching');
  }

  const rawReviews = hasReviews ? (container.reviews as unknown[]) : [];
  const reviews: Review[] = [];
  for (const item of rawReviews) {
    const review = normalizeReview(item);
    if (review) reviews.push(review);
  }
  if (rawReviews.length > 0 && reviews.length === 0) {
    throw new AppError('STEAM_ENDPOINT_CHANGED', '评论字段结构不符合预期');
  }

  const summary = buildSummary(container.query_summary, rawMatchingTotal, source, reviews.length);
  const cursor = typeof container.cursor === 'string' && container.cursor ? container.cursor : null;

  return {
    reviews,
    cursor,
    summary,
    matchingTotal: summary?.matchingTotal ?? rawMatchingTotal ?? reviews.length,
    source,
  };
}

export function mergeReviews(pages: Review[][]): Review[] {
  const map = new Map<string, Review>();
  for (const page of pages) {
    for (const review of page) {
      const existing = map.get(review.id);
      if (!existing || review.text.length > existing.text.length) map.set(review.id, review);
    }
  }
  return [...map.values()];
}
