import { AppError } from '../lib/errors';
import type { Review } from '../types';

/**
 * Token estimate per design §8.3: CJK ≈ 1 token/char, other ≈ 4 chars/token,
 * then a conservative 1.1 safety factor.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g) ?? []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil((cjk + rest / 4) * 1.1));
}

export const PER_REVIEW_OVERHEAD_TOKENS = 30;
export const HOLISTIC_TOKEN_LIMIT = 80000;
export const DEFAULT_MAX_TOKENS_PER_CHUNK = 60000;
export const DEFAULT_MAX_CHUNKS = 8;

export function reviewTokens(review: Review): number {
  return estimateTokens(review.text) + PER_REVIEW_OVERHEAD_TOKENS;
}

export function totalTokens(reviews: Review[]): number {
  return reviews.reduce((sum, r) => sum + reviewTokens(r), 0);
}

export interface ChunkOptions {
  maxTokensPerChunk?: number;
  maxChunks?: number;
}

/**
 * Group reviews into chunks, each within the token budget. A sample small
 * enough for one holistic call stays in a single chunk. Overflow beyond the
 * chunk limit fails with AI_CONTEXT_TOO_LARGE instead of silently dropping.
 */
export function buildChunks(reviews: Review[], opts: ChunkOptions = {}): Review[][] {
  if (reviews.length === 0) return [];
  const maxTokensPerChunk = opts.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK;
  const maxChunks = Math.max(1, opts.maxChunks ?? DEFAULT_MAX_CHUNKS);
  const total = totalTokens(reviews);

  if (total <= Math.min(HOLISTIC_TOKEN_LIMIT, maxTokensPerChunk)) return [reviews];

  const chunks: Review[][] = [];
  let current: Review[] = [];
  let currentTokens = 0;
  for (const review of reviews) {
    const tokens = reviewTokens(review);
    if (current.length > 0 && currentTokens + tokens > maxTokensPerChunk) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(review);
    currentTokens += tokens;
  }
  if (current.length) chunks.push(current);
  if (chunks.length > maxChunks) {
    throw new AppError('AI_CONTEXT_TOO_LARGE', `需要 ${chunks.length} 块，超过上限 ${maxChunks}`);
  }
  return chunks;
}

/** Estimate the number of chunks for preview before fetching comments. */
export function estimateChunkCount(totalTokenEstimate: number, maxTokensPerChunk = DEFAULT_MAX_TOKENS_PER_CHUNK, maxChunks = DEFAULT_MAX_CHUNKS): number {
  if (totalTokenEstimate <= Math.min(HOLISTIC_TOKEN_LIMIT, maxTokensPerChunk)) return 1;
  return Math.max(1, Math.min(maxChunks, Math.ceil(totalTokenEstimate / maxTokensPerChunk)));
}

/** Average token estimate per review used by preview (≈300 tokens including overhead). */
export const PREVIEW_AVERAGE_TOKENS_PER_REVIEW = 300;
