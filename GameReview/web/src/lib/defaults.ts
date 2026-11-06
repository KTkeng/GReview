import type { AnalysisConfig } from '../types';

export const DEFAULT_CONFIG: AnalysisConfig = {
  gameUrl: '',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: false,
  scrape: {
    languages: ['schinese', 'english'],
    reviewType: 'all',
    sort: 'helpful',
    purchaseType: 'all',
    dateRange: null,
    minPlaytimeHours: undefined,
    maxPlaytimeHours: undefined,
    excludeOffTopic: true,
    useReviewQuality: true,
  },
  client: {
    minVotes: 0,
    minLength: 0,
    includeKeywords: [],
    excludeKeywords: [],
    excludeEarlyAccess: false,
    excludeFree: false,
  },
  trendMonths: 12,
  maxReviews: 200,
  // UI 默认开启翻译并始终显式发送；后端 jobOptionsSchema 的默认值是 false。
  // 请求体字段优先，因此预览与任务使用同一前端口径（契约 integrationNotes 已注明）。
  includeTranslations: true,
  topReviews: 50,
  dataDir: '',
  reuseDataset: true,
  reuseReport: true,
};

export const MAX_REVIEWS_OPTIONS = [50, 100, 200, 500, 1000];

export const MODEL_FALLBACKS = ['deepseek-flash', 'deepseek-v4-pro'];

export const LANGUAGE_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'schinese', label: '简中' },
  { code: 'english', label: '英文' },
  { code: 'japanese', label: '日文' },
  { code: 'koreana', label: '韩文' },
  { code: 'russian', label: '俄文' },
  { code: 'french', label: '法文' },
  { code: 'german', label: '德文' },
  { code: 'spanish', label: '西班牙文' },
];

/** 趋势范围档位；36 个月在 UI 中标注为「全部（最多 36 个月）」，API 仍传 36。 */
export const TREND_MONTH_OPTIONS = [6, 12, 24, 36];

export const STAGE_SEQUENCE: Array<{
  key: string;
  label: string;
  weight: number;
}> = [
  { key: 'fetching_reviews', label: '抓取评论', weight: 20 },
  { key: 'fetching_trend', label: '趋势聚合', weight: 15 },
  { key: 'preprocessing', label: '预处理', weight: 5 },
  { key: 'ai_analyzing', label: 'AI 分析', weight: 55 },
  { key: 'generating_report', label: '生成报告', weight: 5 },
];

export const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  resolving: '准备任务',
  fetching_reviews: '抓取评论',
  fetching_trend: '趋势聚合',
  fetching_trends: '趋势聚合',
  preprocessing: '预处理',
  preparing: '预处理',
  ai_analyzing: 'AI 分析',
  analyzing: 'AI 分析',
  generating_report: '生成报告',
  validating: '校验证据',
  saving: '保存报告',
  done: '已完成',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

/**
 * 后端任务阶段名 → 前端五阶段进度条的标准阶段名。
 * 后端 stages：resolving / fetching_reviews / fetching_trends / preparing /
 * analyzing / validating / saving / completed / cancelled。
 */
export const STAGE_ALIASES: Record<string, string> = {
  resolving: 'fetching_reviews',
  fetching_trends: 'fetching_trend',
  preparing: 'preprocessing',
  analyzing: 'ai_analyzing',
  validating: 'generating_report',
  saving: 'generating_report',
};

export function canonicalStage(stage: string | undefined): string | undefined {
  if (!stage) return undefined;
  return STAGE_ALIASES[stage] ?? stage;
}
