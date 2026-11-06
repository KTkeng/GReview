import type { AnalysisConfig, ClientFilters, DateRange, ScrapeFilters } from '../types';

export const INVALID_LINK_MESSAGE = '链接或 AppID 无效';
export const ABSOLUTE_PATH_MESSAGE = '必须是绝对路径';
export const SOURCE_DIR_MESSAGE = '不能设置为源码目录';

const MAX_APPID = 2147483647;

/**
 * 从用户输入中提取 AppID。
 * 只接受纯正整数、Steam 商店链接、Steam 社区链接；
 * 不会请求用户输入的 URL（仅做字符串解析）。
 */
export function extractAppId(input: string): number | null {
  const value = input.trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    return validateAppIdNumber(value);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  const isStore = host === 'store.steampowered.com' || host === 'www.store.steampowered.com';
  const isCommunity = host === 'steamcommunity.com' || host === 'www.steamcommunity.com';
  const isHelp = host === 'help.steampowered.com';
  if (!isStore && !isCommunity && !isHelp) return null;

  const match = /\/app\/(\d+)(?:[/?#]|$)/.exec(url.pathname);
  if (!match) return null;
  return validateAppIdNumber(match[1]);
}

function validateAppIdNumber(raw: string): number | null {
  const normalized = raw.replace(/^0+(?=\d)/, '');
  if (normalized.length > 10) return null;
  const appid = Number(normalized);
  if (!Number.isSafeInteger(appid) || appid <= 0 || appid > MAX_APPID) return null;
  return appid;
}

export function normalizeDataDirInput(value: string): string {
  return value.trim();
}

/** 前端即时校验自定义数据目录；最终以后端 /api/data/validate 结果为准。 */
export function validateDataDir(value: string): string | null {
  const dir = normalizeDataDirInput(value);
  if (!dir) return null; // 空 = 使用默认目录

  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(dir);
  const isUnc = /^\\\\[^\\]+\\[^\\]+/.test(dir);
  const isPosixAbsolute = dir.startsWith('/');
  if (!isWindowsAbsolute && !isUnc && !isPosixAbsolute) {
    return ABSOLUTE_PATH_MESSAGE;
  }

  const normalized = dir.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    return '路径不能包含 ..';
  }
  const protectedSegments = ['node_modules', '.git'];
  if (protectedSegments.some((segment) => segments.includes(segment))) {
    return SOURCE_DIR_MESSAGE;
  }
  if (/(^|\/)web\/src(\/|$)/.test(normalized) || /(^|\/)server\/src(\/|$)/.test(normalized)) {
    return SOURCE_DIR_MESSAGE;
  }
  return null;
}

export function parseKeywordList(value: string): string[] {
  return value
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateMaxReviews(value: number): string | null {
  if (!Number.isFinite(value)) return '抓取数量必须是数字';
  if (!Number.isInteger(value)) return '抓取数量必须是整数';
  if (value < 1) return '抓取数量至少为 1';
  if (value > 1000) return '抓取数量最多为 1000';
  return null;
}

export function validatePlaytimeRange(min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && (!Number.isFinite(min) || min < 0)) return '最低游玩时长不能为负数';
  if (max !== undefined && (!Number.isFinite(max) || max < 0)) return '最高游玩时长不能为负数';
  if (min !== undefined && max !== undefined && min > max) return '最低游玩时长不能大于最高游玩时长';
  return null;
}

export function validateDateRange(range: DateRange | null): string | null {
  if (!range) return null;
  const hasStart = typeof range.start === 'number';
  const hasEnd = typeof range.end === 'number';
  if (hasStart !== hasEnd) return '自定义时间范围需要同时填写开始与结束日期';
  if (hasStart && hasEnd && range.start! > range.end!) return '开始日期不能晚于结束日期';
  return null;
}

export function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL 必须是 http 或 https 地址';
    }
  } catch {
    return 'Base URL 格式无效';
  }
  return null;
}

export interface ConfigErrors {
  game?: string;
  apiKey?: string;
  maxReviews?: string;
  playtime?: string;
  dateRange?: string;
  baseUrl?: string;
  dataDir?: string;
  customRange?: string;
}

export interface ConfigValidation {
  errors: ConfigErrors;
  valid: boolean;
  canPreview: boolean;
}

export function validateConfig(
  config: AnalysisConfig,
  resolvedAppId: number | null,
): ConfigValidation {
  const errors: ConfigErrors = {};

  if (!resolvedAppId) {
    errors.game = config.gameUrl.trim() ? INVALID_LINK_MESSAGE : '请输入 Steam 游戏链接或 AppID';
  }
  if (config.apiKey.trim().length === 0) {
    errors.apiKey = '请填写 DeepSeek API Key';
  }
  const maxReviewsError = validateMaxReviews(config.maxReviews);
  if (maxReviewsError) errors.maxReviews = maxReviewsError;
  const playtimeError = validatePlaytimeRange(
    config.scrape.minPlaytimeHours,
    config.scrape.maxPlaytimeHours,
  );
  if (playtimeError) errors.playtime = playtimeError;
  const dateError = validateDateRange(config.scrape.dateRange);
  if (dateError) errors.dateRange = dateError;
  const baseUrlError = validateBaseUrl(config.baseUrl);
  if (baseUrlError) errors.baseUrl = baseUrlError;
  const dirError = validateDataDir(config.dataDir);
  if (dirError) errors.dataDir = dirError;

  const valid = Object.keys(errors).length === 0;
  return { errors, valid, canPreview: valid };
}

/** 时间范围的快捷选项（Unix 秒）。 */
export type DateRangePreset = 'all' | '30d' | '90d' | '365d' | 'custom';

export function dateRangeForPreset(preset: DateRangePreset, custom: DateRange): DateRange | null {
  if (preset === 'custom') return custom;
  if (preset === 'all') return null;
  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
  const now = Math.floor(Date.now() / 1000);
  return { start: now - days * 86400, end: now };
}

export function presetForDateRange(range: DateRange | null): DateRangePreset {
  if (!range) return 'all';
  if (range.start && range.end) {
    const days = Math.round((range.end - range.start) / 86400);
    if (Math.abs(days - 30) <= 1) return '30d';
    if (Math.abs(days - 90) <= 1) return '90d';
    if (Math.abs(days - 365) <= 2) return '365d';
  }
  return 'custom';
}

export function toUnixSeconds(value: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00`);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.floor(timestamp / 1000);
}

export function fromUnixSeconds(value: number | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildScrapeFilters(config: AnalysisConfig): ScrapeFilters {
  return {
    ...config.scrape,
    dateRange: config.scrape.dateRange ? { ...config.scrape.dateRange } : null,
  };
}

export function buildClientFilters(config: AnalysisConfig): ClientFilters {
  return { ...config.client };
}
