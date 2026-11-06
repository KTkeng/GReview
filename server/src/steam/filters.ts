import type { ClientFilters, PurchaseType, ScrapeFilters } from '../types';

export const DEFAULT_SCRAPE_FILTERS: ScrapeFilters = {
  languages: ['schinese', 'english'],
  reviewType: 'all',
  sort: 'helpful',
  purchaseType: 'all',
  dateRange: null,
  excludeOffTopic: true,
  useReviewQuality: true,
};

export const DEFAULT_CLIENT_FILTERS: ClientFilters = {
  minVotes: 0,
  minLength: 0,
  includeKeywords: [],
  excludeKeywords: [],
  excludeEarlyAccess: false,
  excludeFree: false,
};

export function withFilterDefaults(filters?: Partial<ScrapeFilters> | null): ScrapeFilters {
  const merged = { ...DEFAULT_SCRAPE_FILTERS, ...(filters ?? {}) };
  const rawRange = merged.dateRange;
  const hasRange =
    rawRange !== null &&
    rawRange !== undefined &&
    ((typeof rawRange.start === 'number' && Number.isFinite(rawRange.start)) ||
      (typeof rawRange.end === 'number' && Number.isFinite(rawRange.end)));
  return {
    ...merged,
    languages: Array.isArray(merged.languages) && merged.languages.length ? merged.languages : ['schinese', 'english'],
    // Preserve a single-sided range (including start=0) so route validation can
    // reject it explicitly instead of silently dropping the user's filter.
    dateRange: hasRange ? { ...rawRange } : null,
    minPlaytimeHours: typeof merged.minPlaytimeHours === 'number' ? merged.minPlaytimeHours : undefined,
    maxPlaytimeHours: typeof merged.maxPlaytimeHours === 'number' ? merged.maxPlaytimeHours : undefined,
  };
}

export function withClientFilterDefaults(filters?: Partial<ClientFilters> | null): ClientFilters {
  const merged = { ...DEFAULT_CLIENT_FILTERS, ...(filters ?? {}) };
  return {
    ...merged,
    minVotes: Number.isFinite(merged.minVotes) ? Math.max(0, merged.minVotes) : 0,
    minLength: Number.isFinite(merged.minLength) ? Math.max(0, merged.minLength) : 0,
    includeKeywords: (merged.includeKeywords ?? []).map((k) => String(k)).filter(Boolean),
    excludeKeywords: (merged.excludeKeywords ?? []).map((k) => String(k)).filter(Boolean),
  };
}

const SORT_TO_OFFICIAL: Record<ScrapeFilters['sort'], number> = { helpful: 0, recent: 1, updated: 2 };
const SORT_TO_STOREFRONT: Record<ScrapeFilters['sort'], string> = { helpful: 'all', recent: 'recent', updated: 'updated' };
const REVIEW_TYPE_OFFICIAL: Record<ScrapeFilters['reviewType'], number> = { all: 0, positive: 1, negative: 2 };
const REVIEW_TYPE_STOREFRONT: Record<ScrapeFilters['reviewType'], string> = {
  all: 'all',
  positive: 'positive',
  negative: 'negative',
};
const PURCHASE_OFFICIAL: Record<PurchaseType, number> = { steam: 0, all: 1, non_steam: 2 };
const PURCHASE_STOREFRONT: Record<PurchaseType, string> = {
  steam: 'steam',
  all: 'all',
  non_steam: 'non_steam_purchase',
};

export interface OfficialInputOptions {
  cursor?: string;
  numPerPage?: number;
  reviewTypeOverride?: ScrapeFilters['reviewType'];
  dateRangeOverride?: { start?: number; end?: number } | null;
  /** Override Steam's helpful-review window in days (0 = unlimited). */
  dayRangeOverride?: number | null;
}

/** Map internal filters to the official IUserReviewsService input_json fields (design §7.4). */
export function toOfficialInput(
  appid: number,
  filters: ScrapeFilters,
  opts: OfficialInputOptions = {},
): Record<string, unknown> {
  const reviewType = opts.reviewTypeOverride ?? filters.reviewType;
  const dateRange = opts.dateRangeOverride === undefined ? filters.dateRange : opts.dateRangeOverride;
  const input: Record<string, unknown> = {
    appid,
    filter: SORT_TO_OFFICIAL[filters.sort],
    languages: filters.languages.length ? filters.languages : ['english'],
    review_type: REVIEW_TYPE_OFFICIAL[reviewType],
    purchase_type: PURCHASE_OFFICIAL[filters.purchaseType],
    num_per_page: Math.min(100, Math.max(1, opts.numPerPage ?? 100)),
    cursor: opts.cursor && opts.cursor.length ? opts.cursor : '*',
    // Steam reads filter_offtopic_activity=true as "filter off-topic reviews
    // out" (design §7.1); the design's mapping table row is internally
    // inconsistent and is superseded by the field definition. This matches the
    // storefront `filter_offtopic_activity=1` semantics checked below.
    filter_offtopic_activity: filters.excludeOffTopic,
    display_language: 'schinese',
    use_review_quality: filters.useReviewQuality,
  };
  // High-helpfulness ordering defaults to a 30-day window; 0 means unlimited.
  if (filters.sort === 'helpful') input.day_range = 0;
  if (opts.dayRangeOverride !== undefined) {
    if (opts.dayRangeOverride === null) {
      delete input.day_range;
    } else {
      input.day_range = Math.min(365, Math.max(0, Math.floor(opts.dayRangeOverride)));
    }
  }
  if (dateRange?.start !== undefined && dateRange?.end !== undefined) {
    input.date_range_start = dateRange.start;
    input.date_range_end = dateRange.end;
  }
  if (typeof filters.minPlaytimeHours === 'number') input.playtime_min_hours = filters.minPlaytimeHours;
  if (typeof filters.maxPlaytimeHours === 'number') input.playtime_max_hours = filters.maxPlaytimeHours;
  return input;
}

export interface StorefrontQueryOptions {
  cursor?: string;
  numPerPage?: number;
  reviewTypeOverride?: ScrapeFilters['reviewType'];
  dateRangeOverride?: { start?: number; end?: number } | null;
  dayRangeOverride?: number | null;
}

/** Map internal filters to /ajaxappreviews query-string enums (design §7.4). */
export function toStorefrontQuery(
  filters: ScrapeFilters,
  opts: StorefrontQueryOptions = {},
): Record<string, string> {
  const reviewType = opts.reviewTypeOverride ?? filters.reviewType;
  const dateRange = opts.dateRangeOverride === undefined ? filters.dateRange : opts.dateRangeOverride;
  const languages = filters.languages.length ? filters.languages.join(',') : 'english';
  const query: Record<string, string> = {
    json: '1',
    filter: SORT_TO_STOREFRONT[filters.sort],
    language: languages,
    review_type: REVIEW_TYPE_STOREFRONT[reviewType],
    purchase_type: PURCHASE_STOREFRONT[filters.purchaseType],
    num_per_page: String(Math.min(100, Math.max(1, opts.numPerPage ?? 100))),
    cursor: opts.cursor && opts.cursor.length ? opts.cursor : '*',
    // 1 filters off-topic activity out, 0 includes it — the same meaning as the
    // official boolean above.
    filter_offtopic_activity: filters.excludeOffTopic ? '1' : '0',
    use_review_quality: filters.useReviewQuality ? '1' : '0',
  };
  if (filters.sort === 'helpful') query.day_range = '0';
  if (opts.dayRangeOverride !== undefined) {
    if (opts.dayRangeOverride === null) {
      delete query.day_range;
    } else {
      query.day_range = String(Math.min(365, Math.max(0, Math.floor(opts.dayRangeOverride))));
    }
  }
  if (dateRange?.start !== undefined && dateRange?.end !== undefined) {
    query.start_date = String(dateRange.start);
    query.end_date = String(dateRange.end);
    query.date_range_type = 'include';
  }
  if (typeof filters.minPlaytimeHours === 'number') query.playtime_filter_min = String(filters.minPlaytimeHours);
  if (typeof filters.maxPlaytimeHours === 'number') query.playtime_filter_max = String(filters.maxPlaytimeHours);
  return query;
}

export function officialUrl(input: Record<string, unknown>): string {
  return `https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?input_json=${encodeURIComponent(
    JSON.stringify(input),
  )}`;
}

export function storefrontUrl(appid: number, query: Record<string, string>): string {
  const params = new URLSearchParams(query).toString();
  return `https://store.steampowered.com/ajaxappreviews/${appid}?${params}`;
}

/** Apply client-side secondary filters (design §6.2). */
export function applyClientFilters<T extends {
  votesUp: number;
  text: string;
  writtenDuringEarlyAccess: boolean;
  receivedForFree: boolean;
}>(reviews: T[], filters: ClientFilters): T[] {
  const includes = filters.includeKeywords.map((k) => k.toLowerCase()).filter(Boolean);
  const excludes = filters.excludeKeywords.map((k) => k.toLowerCase()).filter(Boolean);
  return reviews.filter((review) => {
    if (review.votesUp < filters.minVotes) return false;
    if (review.text.length < filters.minLength) return false;
    if (filters.excludeEarlyAccess && review.writtenDuringEarlyAccess) return false;
    if (filters.excludeFree && review.receivedForFree) return false;
    const lower = review.text.toLowerCase();
    if (includes.length && !includes.every((k) => lower.includes(k))) return false;
    if (excludes.length && excludes.some((k) => lower.includes(k))) return false;
    return true;
  });
}
