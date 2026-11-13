/**
 * 实时可视化使用的时间线阶段映射。
 *
 * 后端 SSE 的 stage 是细粒度的（resolving / fetching_reviews / analyzing /
 * validating / saving…），实时可视化需要固定的 7 个阶段节点。这里集中维护：
 * - 7 个展示阶段的顺序、中文名与权重；
 * - 后端原始 stage → 展示阶段的归并；
 * - 复用本地数据/报告时，从消息文本中识别“已跳过”的阶段。
 *
 * 不新增接口：所有输入均来自现有 SSE status / log 事件的 stage、message 字段。
 */

export type LiveStageKey =
  | 'fetch'
  | 'trend'
  | 'preprocess'
  | 'ai_map'
  | 'ai_merge'
  | 'ai_final'
  | 'report';

export interface LiveStageDefinition {
  key: LiveStageKey;
  /** 时间线节点中文名（验收要求固定 7 个节点）。 */
  label: string;
  /** 权重仅用于展示顺序与后续可能的加权进度，总和为 100。 */
  weight: number;
}

/** 固定顺序：读取/抓取 → 趋势聚合 → 预处理 → map → merge → final → 校验/报告。 */
export const LIVE_STAGE_SEQUENCE: readonly LiveStageDefinition[] = [
  { key: 'fetch', label: '读取/抓取', weight: 18 },
  { key: 'trend', label: '趋势聚合', weight: 12 },
  { key: 'preprocess', label: '预处理', weight: 5 },
  { key: 'ai_map', label: 'AI 分块 map', weight: 35 },
  { key: 'ai_merge', label: '合并 merge', weight: 10 },
  { key: 'ai_final', label: '最终 final', weight: 10 },
  { key: 'report', label: '校验/生成报告', weight: 10 },
] as const;

export const LIVE_STAGE_LABELS: Record<LiveStageKey, string> = {
  fetch: '读取/抓取',
  trend: '趋势聚合',
  preprocess: '预处理',
  ai_map: 'AI 分块 map',
  ai_merge: '合并 merge',
  ai_final: '最终 final',
  report: '校验/生成报告',
};

export const REUSE_SKIP_DETAIL = '已跳过（复用本地）';

export function liveStageLabel(key: LiveStageKey): string {
  return LIVE_STAGE_LABELS[key];
}

export function liveStageIndex(key: LiveStageKey): number {
  return LIVE_STAGE_SEQUENCE.findIndex((stage) => stage.key === key);
}

const DIRECT_STAGE_MAP: Record<string, LiveStageKey> = {
  // 读取 / 抓取
  resolving: 'fetch',
  fetch: 'fetch',
  fetching: 'fetch',
  fetching_reviews: 'fetch',
  fetch_reviews: 'fetch',
  reading: 'fetch',
  reading_reviews: 'fetch',
  scraping: 'fetch',
  scrape: 'fetch',
  reviews: 'fetch',
  // 趋势聚合
  trend: 'trend',
  trends: 'trend',
  fetching_trend: 'trend',
  fetching_trends: 'trend',
  trend_aggregate: 'trend',
  aggregating_trend: 'trend',
  // 预处理
  preparing: 'preprocess',
  prepare: 'preprocess',
  preprocessing: 'preprocess',
  preprocess: 'preprocess',
  // AI 阶段（analyzing 需要结合 message 细分）
  analyzing: 'ai_map',
  ai_analyzing: 'ai_map',
  analysing: 'ai_map',
  ai: 'ai_map',
  map: 'ai_map',
  ai_map: 'ai_map',
  merging: 'ai_merge',
  merge: 'ai_merge',
  ai_merge: 'ai_merge',
  finalizing: 'ai_final',
  final: 'ai_final',
  ai_final: 'ai_final',
  // 校验 / 生成报告
  validating: 'report',
  validation: 'report',
  generating_report: 'report',
  generating: 'report',
  report: 'report',
  saving: 'report',
  save: 'report',
  completed: 'report',
  done: 'report',
};

/** queued / failed / cancelled 等生命周期值不激活任何阶段节点。 */
const NON_STAGE_VALUES = new Set(['', 'queued', 'failed', 'error', 'cancelled', 'canceled']);

function normalizeStage(stage: string | undefined | null): string {
  return String(stage ?? '')
    .trim()
    .toLowerCase();
}

/**
 * 把后端原始 stage 归并为 7 阶段之一。
 * `analyzing` 同时承载 map / merge / final 三个子阶段，依据 message 文本细分。
 * 未知 stage 返回 null，由界面兜底显示原始文本。
 */
export function resolveLiveStage(
  stage: string | undefined | null,
  message?: string | null,
): LiveStageKey | null {
  const raw = normalizeStage(stage);
  if (!raw || NON_STAGE_VALUES.has(raw)) return null;

  const direct = DIRECT_STAGE_MAP[raw];
  if (!direct) return null;
  if (direct !== 'ai_map') return direct;

  const text = String(message ?? '').toLowerCase();
  if (/(合并|merge)/.test(text)) return 'ai_merge';
  if (/(生成结论|最终|final)/.test(text)) return 'ai_final';
  return 'ai_map';
}

/** 生命周期值没有对应时间线节点，但当前阶段条仍应给出中文说明。 */
const LIFECYCLE_LABELS: Record<string, string> = {
  queued: '排队中',
  failed: '失败',
  error: '失败',
  cancelled: '已取消',
  canceled: '已取消',
};

/**
 * 给当前阶段条展示用：已知 stage 用统一中文名；未知 stage 显示
 * 「其他阶段（原始标识）」并保留原始文本，生命周期值给出中文说明。
 */
export function liveStageDisplayLabel(
  stage: string | undefined | null,
  message?: string | null,
): string {
  const key = resolveLiveStage(stage, message);
  if (key) return LIVE_STAGE_LABELS[key];
  const raw = String(stage ?? '').trim();
  if (!raw) return '等待任务';
  const lifecycle = LIFECYCLE_LABELS[raw.toLowerCase()];
  if (lifecycle) return lifecycle;
  return `其他阶段（${raw}）`;
}

export interface ReuseDetection {
  /** 命中的复用阶段（按出现顺序去重）。 */
  stages: LiveStageKey[];
  /** 是否命中“复用本地报告 / 分析结果”。 */
  reportReused: boolean;
}

const REUSE_RULES: Array<{ pattern: RegExp; stages: LiveStageKey[]; reportReused?: boolean }> = [
  {
    pattern: /(复用本地数据|复用本地评论|复用本地数据集)/,
    stages: ['fetch'],
  },
  {
    pattern: /(复用本地趋势|本地趋势缓存)/,
    stages: ['trend'],
  },
  {
    pattern: /(复用本地分析结果|使用本地分析结果|复用本地报告|复用报告)/,
    stages: ['ai_map', 'ai_merge', 'ai_final'],
    reportReused: true,
  },
];

/**
 * 从 status / log 文本中识别复用本地数据的阶段。
 * 后端以 message / log 文案表达复用（如“复用本地数据：… 条”“复用本地趋势”），
 * 前端只做只读识别，不新增接口或字段。
 */
export function detectReuse(text: string | undefined | null): ReuseDetection {
  const stages: LiveStageKey[] = [];
  let reportReused = false;
  const value = String(text ?? '');
  if (!value) return { stages, reportReused };
  for (const rule of REUSE_RULES) {
    if (!rule.pattern.test(value)) continue;
    if (rule.reportReused) reportReused = true;
    for (const stage of rule.stages) {
      if (!stages.includes(stage)) stages.push(stage);
    }
  }
  return { stages, reportReused };
}
