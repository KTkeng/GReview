import type {
  AnalysisConfig,
  ClientFilters,
  GameMeta,
  PreviewResult,
  ReusableDataset,
  ReusableReport,
  ScrapeFilters,
} from '../types';
import type { PreviewRequest } from './api';

export interface ReuseInfo {
  /** 后端确认可复用的本地评论数据集。 */
  dataset: ReusableDataset | null;
  /** 后端确认 exact 命中、会真正跳过 AI 的本地报告。 */
  report: ReusableReport | null;
  /**
   * 存在历史报告但当前数据集/趋势/模型/提示词/思考模式与它不一致。
   * 它绝不能作为“本次未消耗 token”的依据，只用于提示用户。
   */
  historicalReport: ReusableReport | null;
}

function isReusableReport(result: PreviewResult | null | undefined, report: ReusableReport): boolean {
  if (!result) return false;
  // 后端显式判定优先；历史报告（reusable=false / match=historical）必须排除。
  if (report.reusable === false) return false;
  if (result.reuse?.canUseLocalReport === false) return false;
  if (result.reuse?.canUseLocalReport === true) return true;
  if (report.reusable === true) return true;
  // 兼容没有显式标志的旧后端：只有明确 exact 才视为可复用。
  return report.match === 'exact';
}

export function getReuseInfo(result: PreviewResult | null | undefined): ReuseInfo {
  if (!result) return { dataset: null, report: null, historicalReport: null };
  const rawDataset =
    result.reuse?.dataset ??
    result.reusableDataset ??
    result.dataset ??
    null;
  const rawReport =
    result.reuse?.report ??
    result.reusableReport ??
    result.report ??
    null;

  const dataset = result.reuse?.canUseLocalDataset === false ? null : rawDataset;
  const report = rawReport && isReusableReport(result, rawReport) ? rawReport : null;
  const historicalReport = rawReport && !report ? rawReport : null;
  return { dataset, report, historicalReport };
}

export interface PreviewConfigSlice {
  baseUrl: string;
  model: string;
  thinking: boolean;
  maxReviews: number;
  includeTranslations: boolean;
  topReviews: number;
  trendMonths: number;
  dataDir: string;
}

/**
 * 构造 `POST /api/game/preview` 请求体（F2）。
 *
 * 预览必须是“实际任务”的预演：后端用 options.maxReviews 计算 reviewsHash、
 * 页数与输入 token，用 ai.thinking/model 计算输出 token 与精确 analysisHash。
 * 只传 appid/filters/clientFilters/trend 会让非默认配置按默认值估算，
 * 从而低估费用并误判可复用报告。
 */
export function buildPreviewRequest(params: {
  appid: number;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  config: PreviewConfigSlice;
}): PreviewRequest {
  const { appid, filters, clientFilters, config } = params;
  return {
    appid,
    filters,
    clientFilters,
    trend: { months: config.trendMonths },
    dataDir: config.dataDir.trim() || undefined,
    ai: {
      baseUrl: config.baseUrl.trim() || undefined,
      model: config.model.trim() || 'deepseek-flash',
      thinking: config.thinking,
    },
    options: {
      maxReviews: config.maxReviews,
      includeTranslations: config.includeTranslations,
      topReviews: Math.min(
        50,
        Math.max(1, Number.isFinite(config.topReviews) ? config.topReviews : 50),
      ),
    },
  };
}

export function previewConfigSlice(config: AnalysisConfig): PreviewConfigSlice {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    thinking: config.thinking,
    maxReviews: config.maxReviews,
    includeTranslations: config.includeTranslations,
    topReviews: config.topReviews,
    trendMonths: config.trendMonths,
    dataDir: config.dataDir,
  };
}

export function getMatchingTotal(result: PreviewResult | null | undefined): number {
  if (!result) return 0;
  const value =
    result.steamMatchingTotal ??
    result.summary?.matchingTotal ??
    result.summary?.total ??
    0;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export interface FallbackEstimate {
  pages: number;
  seconds: number;
  trendRequests: number;
}

export function estimateFallback(
  matching: number,
  maxReviews: number,
  trendMonths: number,
): FallbackEstimate {
  const sampleTarget = Math.min(Math.max(matching, 0), Math.max(maxReviews, 0));
  const pages = Math.ceil(sampleTarget / 100);
  const trendRequests = trendMonths;
  return {
    pages,
    seconds: pages * 0.4 + trendRequests * 0.4,
    trendRequests,
  };
}

export function gameHeaderImage(game: GameMeta | null | undefined): string | null {
  if (!game) return null;
  const candidate =
    (game.headerImage as string | undefined) ??
    (game.header_image as string | undefined) ??
    null;
  return candidate || null;
}

export function gameReleaseDate(game: GameMeta | null | undefined): string | null {
  if (!game) return null;
  const direct = game.releaseDate ?? game.release_date;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object' && typeof direct.date === 'string') return direct.date;
  return null;
}

export function gameDevelopers(game: GameMeta | null | undefined): string[] {
  if (!game) return [];
  return Array.isArray(game.developers) ? game.developers : [];
}

export function gamePublishers(game: GameMeta | null | undefined): string[] {
  if (!game) return [];
  return Array.isArray(game.publishers) ? game.publishers : [];
}

export function gameGenres(game: GameMeta | null | undefined): string[] {
  if (!game || !Array.isArray(game.genres)) return [];
  return game.genres.map((genre) => {
    if (typeof genre === 'string') return genre;
    if (genre && typeof genre === 'object' && typeof (genre as { description?: string }).description === 'string') {
      return (genre as { description: string }).description;
    }
    return '';
  }).filter(Boolean);
}
