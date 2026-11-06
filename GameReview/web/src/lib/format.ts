/** 数字、百分比、时间、字节等统一格式化。 */

import type { GameMeta } from '../types';

const numberFormatter = new Intl.NumberFormat('zh-CN');

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return numberFormatter.format(value);
}

/** 后端约定 positiveRate 为 0-1 小数；同时兼容历史数据的 0-100 写法。 */
export function normalizeRate(rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  if (rate >= 0 && rate <= 1) return rate * 100;
  return rate;
}

export function formatPercent(
  rate: number | null | undefined,
  digits = 1,
): string {
  const normalized = normalizeRate(rate);
  if (normalized === null) return '—';
  return `${normalized.toFixed(digits)}%`;
}

export function formatRateDigits(rate: number | null | undefined, digits = 1): string {
  const normalized = normalizeRate(rate);
  if (normalized === null) return '—';
  return normalized.toFixed(digits);
}

export function formatCostUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatPlaytimeHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  return `${hours.toFixed(1)} 小时`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // 兼容 Unix 秒与毫秒
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatUnixDate(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  return formatDate(seconds);
}

export function formatRelativeTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  schinese: '简中',
  tschinese: '繁中',
  english: '英文',
  japanese: '日文',
  koreana: '韩文',
  russian: '俄文',
  french: '法文',
  german: '德文',
  spanish: '西班牙文',
  latam: '拉美西语',
  italian: '意大利文',
  portuguese: '葡萄牙文',
  brazilian: '巴西葡语',
  polish: '波兰文',
  turkish: '土耳其文',
  thai: '泰文',
  vietnamese: '越南文',
  ukrainian: '乌克兰文',
  czech: '捷克文',
  dutch: '荷兰文',
  swedish: '瑞典文',
  danish: '丹麦文',
  finnish: '芬兰文',
  norwegian: '挪威文',
  hungarian: '匈牙利文',
  romanian: '罗马尼亚文',
  greek: '希腊文',
  bulgarian: '保加利亚文',
  arabic: '阿拉伯文',
  indonesian: '印尼文',
  all: '全部语言',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export function gameName(game: GameMeta | string | null | undefined): string {
  if (!game) return '未知游戏';
  if (typeof game === 'string') return game;
  if (game.name && game.name.trim()) return game.name;
  return game.appid ? `AppID ${game.appid}` : '未知游戏';
}

export function formatLanguages(languages: string[] | null | undefined): string {
  if (!languages || languages.length === 0) return '全部语言';
  return languages.map(languageName).join(' + ');
}

export const REVIEW_TYPE_LABELS: Record<string, string> = {
  all: '全部',
  positive: '好评',
  negative: '差评',
};

export const SORT_LABELS: Record<string, string> = {
  helpful: '高赞优先',
  recent: '最新',
  updated: '最近更新',
};

export const PURCHASE_LABELS: Record<string, string> = {
  all: '全部',
  steam: 'Steam 购买',
  non_steam: '非 Steam',
};

export const TREND_SOURCE_LABELS: Record<string, string> = {
  official_aggregate: '官方月度聚合',
  sample_estimate: '样本估算',
  local_cache: '本地趋势缓存',
};

export const DATA_SOURCE_LABELS: Record<string, string> = {
  fresh: '本次抓取',
  local_dataset: '本地数据集',
};

export const ANALYSIS_SOURCE_LABELS: Record<string, string> = {
  fresh: '本次 AI 分析',
  local_report: '本地分析结果',
};

export const CONFIDENCE_LABELS: Record<string, string> = {
  high: '高置信度',
  medium: '中置信度',
  low: '低置信度',
};

export const PRIORITY_LABELS: Record<string, string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
};

export function periodLabel(period: string): string {
  // YYYY-MM → YYYY 年 M 月
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return `${match[1]}-${match[2]}`;
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}
