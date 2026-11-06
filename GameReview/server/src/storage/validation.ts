import { contentHash } from '../lib/hash';
import type {
  ClientFilters,
  DatasetMeta,
  GameMeta,
  KpiWindow,
  KpiWindows,
  Review,
  ScrapeFilters,
  SteamSummary,
  TrendDataset,
  TrendPoint,
} from '../types';

const HASH_RE = /^[a-f0-9]{16}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const RATE_TOLERANCE = 0.001;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function rateMatches(rate: unknown, positive: number, total: number): boolean {
  if (!isFiniteNumber(rate) || rate < 0 || rate > 1) return false;
  const expected = total > 0 ? positive / total : 0;
  return Math.abs(rate - expected) <= RATE_TOLERANCE;
}

export function isValidScrapeFilters(value: unknown): value is ScrapeFilters {
  if (!isRecord(value)) return false;
  const dateRange = value.dateRange;
  const validDateRange =
    dateRange === null ||
    (isRecord(dateRange) &&
      (dateRange.start === undefined || isNonNegativeInt(dateRange.start)) &&
      (dateRange.end === undefined || isNonNegativeInt(dateRange.end)));
  return (
    isStringArray(value.languages) &&
    (value.reviewType === 'all' || value.reviewType === 'positive' || value.reviewType === 'negative') &&
    (value.sort === 'helpful' || value.sort === 'recent' || value.sort === 'updated') &&
    (value.purchaseType === 'all' || value.purchaseType === 'steam' || value.purchaseType === 'non_steam') &&
    validDateRange &&
    (value.minPlaytimeHours === undefined || isFiniteNumber(value.minPlaytimeHours)) &&
    (value.maxPlaytimeHours === undefined || isFiniteNumber(value.maxPlaytimeHours)) &&
    typeof value.excludeOffTopic === 'boolean' &&
    typeof value.useReviewQuality === 'boolean'
  );
}

export function isValidClientFilters(value: unknown): value is ClientFilters {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInt(value.minVotes) &&
    isNonNegativeInt(value.minLength) &&
    isStringArray(value.includeKeywords) &&
    isStringArray(value.excludeKeywords) &&
    typeof value.excludeEarlyAccess === 'boolean' &&
    typeof value.excludeFree === 'boolean'
  );
}

export function isValidGameMeta(value: unknown): value is GameMeta {
  if (!isRecord(value)) return false;
  return (
    isPositiveInt(value.appid) &&
    isNonEmptyString(value.name) &&
    (value.headerImage === undefined || typeof value.headerImage === 'string') &&
    (value.shortDescription === undefined || typeof value.shortDescription === 'string') &&
    (value.developers === undefined || isStringArray(value.developers)) &&
    (value.publishers === undefined || isStringArray(value.publishers)) &&
    (value.genres === undefined || isStringArray(value.genres)) &&
    (value.releaseDate === undefined || typeof value.releaseDate === 'string') &&
    (value.price === undefined || typeof value.price === 'string')
  );
}

function isValidSourceEndpoint(value: unknown): boolean {
  return value === 'official' || value === 'storefront';
}

export function isValidSteamSummary(value: unknown): value is SteamSummary {
  if (!isRecord(value)) return false;
  if (
    !isNonNegativeInt(value.total) ||
    !isNonNegativeInt(value.positive) ||
    !isNonNegativeInt(value.negative) ||
    value.total !== value.positive + value.negative ||
    !rateMatches(value.positiveRate, value.positive, value.total) ||
    typeof value.reviewScoreDesc !== 'string' ||
    !isNonNegativeInt(value.matchingTotal) ||
    !isValidSourceEndpoint(value.sourceEndpoint)
  ) {
    return false;
  }
  if (value.totalPositive !== undefined && value.totalPositive !== value.positive) return false;
  if (value.totalNegative !== undefined && value.totalNegative !== value.negative) return false;
  return true;
}

export function isValidKpiWindow(value: unknown): value is KpiWindow {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInt(value.total) &&
    isNonNegativeInt(value.positive) &&
    isNonNegativeInt(value.negative) &&
    value.total === value.positive + value.negative &&
    rateMatches(value.positiveRate, value.positive, value.total)
  );
}

function isValidKpiSource(value: unknown): boolean {
  return value === 'official_aggregate' || value === 'sample_estimate';
}

export function isValidKpiWindows(value: unknown): value is KpiWindows {
  if (!isRecord(value)) return false;
  if (!isValidKpiWindow(value.last30d) || !isValidKpiWindow(value.last90d)) return false;
  if (!isValidKpiSource(value.source)) return false;
  if (!isRecord(value.sources)) return false;
  return isValidKpiSource(value.sources.last30d) && isValidKpiSource(value.sources.last90d);
}

export function isValidReview(value: unknown): value is Review {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    typeof value.language === 'string' &&
    typeof value.votedUp === 'boolean' &&
    isNonNegativeInt(value.votesUp) &&
    isFiniteNumber(value.weightedVoteScore) &&
    isNonNegativeInt(value.playtimeAtReviewMinutes) &&
    isNonNegativeInt(value.createdAt) &&
    typeof value.text === 'string' &&
    typeof value.writtenDuringEarlyAccess === 'boolean' &&
    typeof value.receivedForFree === 'boolean'
  );
}

export function isValidReviews(value: unknown): value is Review[] {
  return Array.isArray(value) && value.every(isValidReview);
}

export function isValidTrendPoint(value: unknown): value is TrendPoint {
  if (!isRecord(value)) return false;
  if (
    typeof value.period !== 'string' ||
    !PERIOD_RE.test(value.period) ||
    !isNonNegativeInt(value.total) ||
    !isNonNegativeInt(value.positive) ||
    !isNonNegativeInt(value.negative) ||
    value.total !== value.positive + value.negative ||
    !rateMatches(value.positiveRate, value.positive, value.total)
  ) {
    return false;
  }
  return true;
}

function isValidCoverage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.start) && isNonEmptyString(value.end) && typeof value.note === 'string';
}

export interface TrendValidationOptions {
  /** Report trends may legitimately be empty for a game with no reviews in range. */
  allowEmpty?: boolean;
}

export function isValidTrendDataset(value: unknown, options: TrendValidationOptions = {}): value is TrendDataset {
  if (!isRecord(value)) return false;
  if (value.granularity !== 'month') return false;
  if (value.source !== 'official_aggregate' && value.source !== 'sample_estimate') return false;
  if (!Array.isArray(value.points)) return false;
  if (!options.allowEmpty && value.points.length === 0) return false;
  if (!value.points.every(isValidTrendPoint)) return false;
  if (!isValidCoverage(value.coverage)) return false;
  if (!isNonEmptyString(value.timezone)) return false;
  if (!isValidSourceEndpoint(value.sourceEndpoint)) return false;
  if (!isIsoDate(value.fetchedAt)) return false;
  if (!isHash(value.trendHash)) return false;
  if (!isHash(value.trendContentHash)) return false;
  if (value.trendContentHash !== contentHash(value.points)) return false;
  return true;
}

/**
 * Validate a dataset metadata document, including aggregate windows and numeric
 * consistency. This is deliberately strict: a metadata object with, say,
 * `rollingKpis: {}` must be marked corrupted instead of reused as complete.
 */
export function isValidDatasetMeta(
  value: unknown,
  expected: { appid: number; reviewsHash: string },
): value is DatasetMeta {
  if (!isRecord(value)) return false;
  if (value.appid !== expected.appid || value.reviewsHash !== expected.reviewsHash) return false;
  if (!isHash(value.reviewsContentHash)) return false;
  if (!isValidGameMeta(value.game) || value.game.appid !== expected.appid) return false;
  if (!isValidScrapeFilters(value.filters) || !isValidClientFilters(value.clientFilters)) return false;
  if (!isNonNegativeInt(value.maxReviews)) return false;
  if (!isIsoDate(value.fetchedAt)) return false;
  if (!isValidSourceEndpoint(value.sourceEndpoint)) return false;
  if (!isNonNegativeInt(value.reviewCount)) return false;
  if (value.summary !== null && !isValidSteamSummary(value.summary)) return false;
  if (value.allTimeSummary !== undefined && value.allTimeSummary !== null && !isValidSteamSummary(value.allTimeSummary)) {
    return false;
  }
  if (value.rollingKpis !== undefined && !isValidKpiWindows(value.rollingKpis)) return false;
  if (value.aggregatesComputedAt !== undefined && !isIsoDate(value.aggregatesComputedAt)) return false;
  // Persisted aggregates are frozen snapshots; without their computation time
  // the export cannot state which 30/90-day window they describe.
  if ((value.rollingKpis !== undefined || (value.allTimeSummary !== undefined && value.allTimeSummary !== null)) &&
    value.aggregatesComputedAt === undefined) {
    return false;
  }
  if (value.status !== 'complete' && value.status !== 'corrupted') return false;
  if (value.bytes !== undefined && !isNonNegativeInt(value.bytes)) return false;
  return true;
}
