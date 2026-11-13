/**
 * GReview 前端类型定义。
 * 与设计文档 9.4 / 契约 7、8 节的后端 JSON 保持字段一致。
 */

export type ReviewType = 'all' | 'positive' | 'negative';
export type SortMode = 'helpful' | 'recent' | 'updated';
export type PurchaseType = 'all' | 'steam' | 'non_steam';

export interface DateRange {
  start?: number; // Unix 秒
  end?: number; // Unix 秒
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

export interface GameMeta {
  appid?: number;
  name: string;
  headerImage?: string;
  header_image?: string;
  shortDescription?: string;
  short_description?: string;
  developers?: string[];
  publishers?: string[];
  genres?: Array<string | { id?: string; description?: string }>;
  releaseDate?: string;
  release_date?: string | { date?: string; coming_soon?: boolean };
  price?: string;
  price_overview?: { final_formatted?: string; currency?: string; initial?: number; final?: number };
  [key: string]: unknown;
}

/** 契约 GamePresentation.titleSource 的枚举值（兼容旧后端的英文枚举）。 */
export type TitleSource = '自定义' | '自动读取' | '编号占位' | 'custom' | 'steam' | 'placeholder';

/**
 * 后端统一展示模型：列表、详情、预览、复用提示、任务报告与已保存报告
 * 均通过同一解析器组装这些字段。`name` 恒等于 `displayTitle`。
 */
export interface GamePresentation extends GameMeta {
  appid: number;
  name: string;
  steamName: string | null;
  customTitle: string | null;
  displayTitle: string;
  titleSource: TitleSource;
  /** 非负安全整数；标题文件缺失时为 0，损坏时为 null。 */
  titleRevision: number | null;
  titleUpdatedAt: string | null;
  titleEditable: boolean;
  coverUrl: string | null;
  coverPlaceholder: string;
  warnings: string[];
}

export interface SteamSummary {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number; // 后端返回 0-1 小数；展示层统一用 normalizeRate 转百分比
  reviewScoreDesc: string;
  matchingTotal?: number;
  sourceEndpoint?: 'official' | 'storefront';
}

export interface CostEstimate {
  pages?: number;
  seconds?: number;
  trendRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  chunks?: number;
  costUsd?: number;
}

export interface ReusableDataset {
  reviewsHash?: string;
  appid?: number;
  game?: GamePresentation | GameMeta | string;
  reviewCount: number;
  fetchedAt: string;
  trendCoverage?: { start: string; end: string; note?: string };
  status?: string;
}

export interface ReusableReport {
  analysisHash?: string;
  appid?: number;
  game?: GamePresentation | GameMeta | string;
  generatedAt: string;
  reportCount?: number;
  /** 后端只在 analysisHash 完全命中（数据集/趋势/AI 选项一致）时返回 true。 */
  reusable?: boolean;
  /** `historical` 表示存在历史报告，但当前配置无法复用它。 */
  match?: 'exact' | 'historical';
  model?: string;
}

export interface PreviewResult {
  appid: number;
  game: GameMeta;
  summary: SteamSummary;
  steamMatchingTotal: number;
  clientFilterNotice?: string;
  estimate?: CostEstimate;
  // 后端可能使用的复用信息组织方式，做兼容读取
  reuse?: {
    dataset?: ReusableDataset | null;
    report?: ReusableReport | null;
    /** 明确的复用判定；只有 true 时才可承诺“本次不消耗 token”。 */
    canUseLocalDataset?: boolean;
    canUseLocalReport?: boolean;
  };
  reusableDataset?: ReusableDataset | null;
  reusableReport?: ReusableReport | null;
  dataset?: ReusableDataset | null;
  report?: ReusableReport | null;
  [key: string]: unknown;
}

export interface Quote {
  reviewId: string;
  original: string;
  zh?: string;
  votesUp?: number;
  votedUp?: boolean;
}

export interface Theme {
  id: string;
  name: string;
  category?: string;
  sentiment?: 'positive' | 'negative' | 'neutral' | 'mixed';
  mentions: number;
  summary: string;
  evidenceIds: string[];
  quotes?: Quote[];
}

export interface Recommendation {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
  evidenceIds?: string[];
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

export interface SampleInfo {
  filters: ScrapeFilters & Partial<ClientFilters>;
  fetched: number;
  matchedTotal: number;
  usedForAI: number;
  languages: string[];
  dateCoverage?: { start: number; end: number };
  sourceEndpoint: 'official' | 'storefront';
  tokenUsage?: { input: number; output: number; estimatedCostUsd?: number };
}

export interface KpiBucket {
  total: number;
  positive?: number;
  negative?: number;
  positiveRate: number;
  reviewScoreDesc: string;
}

export interface Kpis {
  allTime: KpiBucket;
  last30d: KpiBucket;
  last90d: KpiBucket;
  samplePositiveRate: number;
}

export interface TrendPoint {
  period: string; // YYYY-MM
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
}

export interface TrendInfo {
  granularity: 'month';
  source: 'official_aggregate' | 'sample_estimate';
  points: TrendPoint[];
  coverage: { start: string; end: string; note: string };
  /** 月份边界时区；契约 8.6 允许存在，后端旧版本可能不返回。 */
  timezone?: string;
}

export interface Conclusion {
  label: string;
  headline: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
}

export interface Methodology {
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
  reportGeneratedAt?: string;
  servedAt?: string;
  aiModel: string;
  thinkingEnabled: boolean;
  promptVersion: string;
  generatedBy: string;
}

export interface AiInsights {
  appealPoints: Theme[];
  frictionPoints: Theme[];
  expectationGaps: Theme[];
  updateImpact: Theme[];
  recommendations: Recommendation[];
}

/**
 * 历史报告的定位信息。Top N 不进入 analysisHash，前端在展开高赞评论时
 * 可凭 analysisHash 调用 GET /api/reports/:appid/:analysisHash?topReviews=50
 * 从数据集重建完整列表。
 */
export interface ReportSource {
  appid: number;
  analysisHash: string;
  dataDir?: string;
}

export interface Report {
  version: '1.0';
  generatedAt: string;
  game: GameMeta;
  sample: SampleInfo;
  kpis: Kpis;
  trend: TrendInfo;
  conclusion: Conclusion;
  ai: AiInsights;
  topReviews: TopReview[];
  methodology: Methodology;
}

/* ---------- 任务与 SSE ---------- */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobStage =
  | 'queued'
  | 'fetching_reviews'
  | 'fetching_trend'
  | 'preprocessing'
  | 'ai_analyzing'
  | 'generating_report'
  | 'done';

export interface JobCounts {
  fetched?: number;
  target?: number;
  matchingTotal?: number;
  chunks?: number;
  /** 已完成并通过解析校验的分块数；重试不重复计数。 */
  completed?: number;
  chunk?: number;
  totalChunks?: number;
  /** 可选实时计数：仅在后端 counts 提供时渲染。 */
  themes?: number;
  evidence?: number;
  tokens?: number;
  [key: string]: number | undefined;
}

export interface JobLogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  /** 服务端可选时间戳；缺失时不补写为服务端时间。 */
  at?: string;
  /** 服务端可选日志标识；存在时用于断线恢复后的去重。 */
  id?: string;
  /** 浏览器接收时间，仅表示本页观察时间，不冒充服务端时间。 */
  observedAt?: string;
}

export interface JobSnapshot {
  jobId: string;
  status: JobStatus | string;
  stage: JobStage | string;
  progress: number;
  counts?: JobCounts;
  logs?: Array<JobLogEntry | string>;
  error?: ApiErrorPayload;
  report?: Report;
  message?: string;
}

export interface SseStatusPayload {
  stage: JobStage | string;
  progress: number;
  message?: string;
  counts?: JobCounts;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  field?: string;
  detail?: unknown;
  /** 仅在 409 标题版本冲突时返回；前端不得用它自动覆盖用户草稿。 */
  currentGame?: GamePresentation;
}

/* ---------- 本地数据 ---------- */

export interface DatasetSummary {
  appid: number;
  game: GamePresentation | GameMeta | string;
  reviewsHash: string;
  reviewCount: number;
  /** 后端契约允许 null（损坏数据集或缺失抓取时间）。 */
  fetchedAt: string | null;
  trendCoverage?: { start: string; end: string };
  reportCount: number;
  /** 兼容旧后端字段 `bytes`；新契约字段为 `sizeBytes`。 */
  bytes?: number;
  sizeBytes?: number;
  status: 'complete' | 'corrupted' | 'incomplete' | '完整' | '损坏' | string;
}

export interface DatasetListResponse {
  dataDir: string;
  datasets: DatasetSummary[];
}

/** PATCH /api/datasets/:appid/title 的严格请求体（拒绝未知字段）。 */
export interface TitleUpdateRequest {
  customTitle: string | null;
  expectedRevision: number;
}

/** PATCH /api/datasets/:appid/title 的成功响应。 */
export interface TitleUpdateResponse {
  game: GamePresentation;
  changed: boolean;
}

export interface DatasetReportRef {
  analysisHash: string;
  generatedAt?: string;
  aiModel?: string;
  [key: string]: unknown;
}

export interface DatasetDetail {
  appid: number;
  reviewsHash: string;
  meta?: unknown;
  reviewCount: number;
  trends?: unknown;
  reports: DatasetReportRef[] | number;
  status: string;
}

/* ---------- 配置 ---------- */

export interface AnalysisConfig {
  gameUrl: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: boolean;
  scrape: ScrapeFilters;
  client: ClientFilters;
  trendMonths: number;
  maxReviews: number;
  includeTranslations: boolean;
  topReviews: number;
  dataDir: string;
  reuseDataset: boolean;
  reuseReport: boolean;
}

export type AppPhase =
  | 'idle'
  | 'configuring'
  | 'previewing'
  | 'analyzing'
  | 'completed'
  | 'error';

export type PreviewStatus = 'idle' | 'loading' | 'success' | 'no_match' | 'error';

export interface PreviewState {
  status: PreviewStatus;
  result?: PreviewResult;
  error?: ApiErrorPayload;
  requestedAt?: number;
}

export interface JobState {
  jobId?: string;
  status?: JobStatus | string;
  stage?: JobStage | string;
  progress: number;
  counts?: JobCounts;
  logs: JobLogEntry[];
  /** App 日志缓存（500 条）中已丢弃的累计条数，用于「已省略较早 N 条」。 */
  logOmitted?: number;
  message?: string;
  error?: ApiErrorPayload;
  report?: Report;
  cancelRequested?: boolean;
  cancelled?: boolean;
}

export interface GameResolveResult {
  appid: number;
  game: GameMeta;
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
}

export interface HealthResult {
  ok: boolean;
  version: string;
}
