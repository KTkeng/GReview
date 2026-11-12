/** Shared contract types for the GReview backend (design doc §7.4, §9.4, §10.4). */

export type ReviewType = 'all' | 'positive' | 'negative';
export type SortMode = 'helpful' | 'recent' | 'updated';
export type PurchaseType = 'all' | 'steam' | 'non_steam';
export type SourceEndpoint = 'official' | 'storefront';

export interface DateRange {
  start?: number;
  end?: number;
}

export interface ScrapeFilters {
  languages: string[];
  reviewType: ReviewType;
  sort: SortMode;
  purchaseType: PurchaseType;
  dateRange: DateRange | null;
  minPlaytimeHours?: number;
  maxPlaytimeHours?: number;
  excludeOffTopic: boolean;
  useReviewQuality: boolean;
}

export interface ClientFilters {
  minVotes: number;
  minLength: number;
  includeKeywords: string[];
  excludeKeywords: string[];
  excludeEarlyAccess: boolean;
  excludeFree: boolean;
}

export interface Review {
  id: string;
  language: string;
  votedUp: boolean;
  votesUp: number;
  weightedVoteScore: number;
  playtimeAtReviewMinutes: number;
  createdAt: number;
  text: string;
  writtenDuringEarlyAccess: boolean;
  receivedForFree: boolean;
}

export interface SteamSummary {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
  reviewScoreDesc: string;
  matchingTotal: number;
  sourceEndpoint: SourceEndpoint;
  /** Aliases matching Steam's raw total_positive/total_negative field names. */
  totalPositive?: number;
  totalNegative?: number;
}

export interface SteamPage {
  reviews: Review[];
  cursor: string | null;
  summary: SteamSummary | null;
  matchingTotal: number;
  source: SourceEndpoint;
}

export interface GameMeta {
  appid: number;
  name: string;
  headerImage?: string;
  shortDescription?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  releaseDate?: string;
  price?: string;
}

/** Source of the displayed title (contract GamePresentation.titleSource). */
export type TitleSource = '自定义' | '自动读取' | '编号占位';

/**
 * Unified presentation model resolved on every read path (dataset list/detail,
 * preview, reports, job completion). `name` always equals `displayTitle` so
 * legacy consumers that only read `game.name` keep working.
 */
export interface GamePresentation extends GameMeta {
  steamName: string | null;
  customTitle: string | null;
  displayTitle: string;
  titleSource: TitleSource;
  /** 0 when title.json is absent; null when the file is unreadable/corrupt. */
  titleRevision: number | null;
  titleUpdatedAt: string | null;
  titleEditable: boolean;
  coverUrl: string | null;
  coverPlaceholder: string;
  warnings: string[];
}

/** Persisted at <dataDir>/<appid>/title.json (schema v1). */
export interface GameTitleOverride {
  schemaVersion: 1;
  appid: number;
  customTitle: string | null;
  revision: number;
  updatedAt: string;
}

export interface TitleUpdateRequest {
  customTitle: string | null;
  expectedRevision: number;
}

export interface TitleUpdateResult {
  game: GamePresentation;
  changed: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  estimatedCostUsd?: number;
}

export interface PreviewEstimate {
  pages: number;
  seconds: number;
  trendRequests: number;
  inputTokens: number;
  outputTokens: number;
  chunks: number;
  costUsd?: number;
  sampleSize: number;
}

export interface DatasetHint {
  reviewsHash: string;
  reviewCount: number;
  fetchedAt: string;
  game?: string;
  staleDays?: number;
}

export interface ReportHint {
  analysisHash: string;
  generatedAt?: string;
  model?: string;
  /** `exact` only when the current dataset/trend/AI options reproduce the hash. */
  match: 'exact' | 'historical';
  reusable: boolean;
}

export interface PreviewResult {
  appid: number;
  game: GamePresentation;
  summary: SteamSummary;
  steamMatchingTotal: number;
  clientFilterNotice: string;
  estimate: PreviewEstimate;
  reuse: {
    dataset: DatasetHint | null;
    report: ReportHint | null;
    canUseLocalDataset: boolean;
    canUseLocalReport: boolean;
  };
  trend: { months: number; requests: number; sourceNote: string };
}

export interface TrendPoint {
  period: string;
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
}

export interface TrendDataset {
  granularity: 'month';
  source: 'official_aggregate' | 'sample_estimate';
  points: TrendPoint[];
  coverage: { start: string; end: string; note: string };
  timezone: string;
  sourceEndpoint: SourceEndpoint;
  fetchedAt: string;
  trendHash: string;
  trendContentHash: string;
}

export interface ThemeQuote {
  reviewId: string;
  original: string;
  zh?: string;
  votesUp: number;
  votedUp: boolean;
}

export interface Theme {
  id?: string;
  name: string;
  category?: string;
  sentiment?: 'positive' | 'negative' | 'neutral' | 'mixed';
  mentions?: number;
  /** True when `mentions` is the AI's count rather than a server evidence count. */
  mentionsEstimated?: boolean;
  summary: string;
  evidenceIds: string[];
  quotes: ThemeQuote[];
  keywords?: string[];
}

export interface Recommendation {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
  evidenceIds: string[];
}

export interface Conclusion {
  label: string;
  headline: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
  /**
   * Raw AI-supplied caveats, persisted separately so a refreshed report never
   * re-merges server-generated dynamic caveats as if they were AI content.
   */
  aiCaveats?: string[];
}

export interface TopReview {
  reviewId: string;
  text: string;
  votesUp: number;
  votedUp: boolean;
  language: string;
  playtimeHours: number;
  createdAt: number;
}

export interface Report {
  version: '1.0';
  generatedAt: string;
  game: GameMeta;
  sample: {
    filters: ScrapeFilters & Partial<ClientFilters>;
    fetched: number;
    matchedTotal: number;
    usedForAI: number;
    languages: string[];
    dateCoverage?: { start: number; end: number };
    sourceEndpoint: SourceEndpoint;
    tokenUsage?: TokenUsage;
  };
  kpis: {
    allTime: {
      total: number;
      positive: number;
      negative: number;
      positiveRate: number;
      reviewScoreDesc: string;
    };
    last30d: { total: number; positiveRate: number; reviewScoreDesc: string };
    last90d: { total: number; positiveRate: number; reviewScoreDesc: string };
    samplePositiveRate: number;
    /** Provenance of the all-time KPI (never a filtered sample silently labelled all-time). */
    allTimeSource?: KpiSource;
    /** Per-window provenance for the rolling KPIs. */
    sources?: { last30d: KpiSource; last90d: KpiSource };
  };
  trend: {
    granularity: 'month';
    source: 'official_aggregate' | 'sample_estimate';
    points: TrendPoint[];
    coverage: { start: string; end: string; note: string };
  };
  conclusion: Conclusion;
  ai: {
    appealPoints: Theme[];
    frictionPoints: Theme[];
    expectationGaps: Theme[];
    updateImpact: Theme[];
    recommendations: Recommendation[];
  };
  topReviews: TopReview[];
  methodology: {
    note: string;
    steamRequests: number;
    cacheHits: number;
    reviewsHash?: string;
    trendHash?: string;
    dataSource: 'fresh' | 'local_dataset';
    trendSource: 'official_aggregate' | 'local_cache' | 'sample_estimate';
    analysisSource: 'fresh' | 'local_report';
    dataDir: string;
    datasetFetchedAt?: string;
    /** When the persisted all-time/rolling KPI aggregates were fetched. */
    aggregatesComputedAt?: string;
    reportGeneratedAt?: string;
    servedAt?: string;
    aiModel: string;
    thinkingEnabled: boolean;
    promptVersion: string;
    generatedBy: string;
  };
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobCounts {
  fetched?: number;
  target?: number;
  total?: number;
  pages?: number;
  chunks?: number;
  [key: string]: number | undefined;
}

export interface JobSnapshot {
  jobId: string;
  status: JobStatus;
  stage: string;
  progress: number;
  counts: JobCounts;
  logs: Array<{ level: string; message: string; at: string }>;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string; detail?: string };
  report?: Report;
}

export interface AiOptions {
  baseUrl?: string;
  model: string;
  temperature?: number;
  thinking: boolean;
}

export interface JobOptions {
  maxReviews: number;
  includeTranslations: boolean;
  topReviews: number;
}

export interface JobDataOptions {
  dataDir?: string;
  reuseDataset?: boolean;
  reuseReport?: boolean;
  forceFetch?: boolean;
  forceAnalyze?: boolean;
  /** Refresh only the official trend aggregate; reviews may still be reused. */
  forceTrend?: boolean;
}

export interface CreateJobRequest {
  appid: number;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  trend: { months: number };
  ai: AiOptions;
  options: JobOptions;
  data: JobDataOptions;
}

export interface DatasetMeta {
  appid: number;
  game: GameMeta;
  reviewsHash: string;
  reviewsContentHash: string;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  maxReviews: number;
  fetchedAt: string;
  sourceEndpoint: SourceEndpoint;
  reviewCount: number;
  /** Summary from the filtered fetch; only reliable for matchingTotal. */
  summary: SteamSummary | null;
  /** Independent all-time aggregate (review_type=all, no date range). */
  allTimeSummary?: SteamSummary | null;
  /** Locally persisted true rolling 30/90-day windows, reused without Steam. */
  rollingKpis?: KpiWindows;
  /** When the persisted all-time/rolling aggregates were last fetched. */
  aggregatesComputedAt?: string;
  status: 'complete' | 'corrupted';
  bytes?: number;
}

/** A true rolling-window aggregate from Steam's review summary. */
export interface KpiWindow {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
}

/** Provenance of one KPI figure: official Steam aggregate or labelled sample estimate. */
export type KpiSource = 'official_aggregate' | 'sample_estimate';

export interface KpiWindows {
  last30d: KpiWindow;
  last90d: KpiWindow;
  /** Aggregate summary; `official_aggregate` only when both windows are official. */
  source: KpiSource;
  /** Per-window provenance so one successful official window is not mislabelled. */
  sources: { last30d: KpiSource; last90d: KpiSource };
}

/**
 * Public dataset integrity value required by the feature contract. The
 * internal storage status remains 'complete'/'corrupted' and is translated at
 * the response boundary.
 */
export type PublicDatasetStatus = '完整' | '损坏';

export interface DatasetSummary {
  appid: number;
  game: GamePresentation;
  reviewsHash: string;
  reviewCount: number;
  fetchedAt: string | null;
  trendCoverage?: { start: string; end: string };
  reportCount: number;
  sizeBytes: number;
  /** Retained for older frontends that read `bytes`. */
  bytes: number;
  status: PublicDatasetStatus;
}

export type DatasetListItem = DatasetSummary;
