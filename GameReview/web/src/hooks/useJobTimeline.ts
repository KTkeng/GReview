/**
 * 把现有 JobState（由 SSE status/log + GET /api/jobs/:id 快照合并而成）
 * 归并为实时可视化需要的 { stages, chunks, logs, current } 状态。
 *
 * `reduceProgress` 是纯函数，便于单测；`useJobTimeline` 只是把 App 维护的
 * JobState 同步进 reducer。本文件不创建任何网络请求。
 */

import { useEffect, useReducer } from 'react';
import type {
  JobCounts,
  JobLogEntry,
  JobState,
} from '../types';
import {
  LIVE_STAGE_SEQUENCE,
  REUSE_SKIP_DETAIL,
  detectReuse,
  liveStageDisplayLabel,
  liveStageLabel,
  resolveLiveStage,
  type LiveStageKey,
} from '../lib/stageMap';

/** 日志流 DOM 中最多渲染的条数。 */
export const MAX_TIMELINE_LOGS = 200;
/** 适配层缓存上限；超出后丢弃最早日志并累计到 omittedLogs。 */
export const MAX_TIMELINE_LOG_CACHE = 500;
/** 单条日志展示的最大字符数，超出时截断并追加标记。 */
export const MAX_TIMELINE_LOG_MESSAGE = 2000;
export const LOG_TRUNCATION_MARK = '…（已截断）';

export type LiveStageStatus =
  /** 从未收到过该阶段的事件：不得推断为已完成。 */
  | 'unobserved'
  | 'pending'
  | 'active'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface TimelineStage {
  key: LiveStageKey;
  label: string;
  status: LiveStageStatus;
  /** 覆盖默认状态文案，例如「已跳过（复用本地）」「失败 · AI_TIMEOUT」。 */
  detail?: string;
}

export interface TimelineChunks {
  /** null 表示后端尚未提供分块规划；0 表示已规划但暂无分块。 */
  total: number | null;
  completed: number | null;
  /** 计数非法：负数、非整数，或 completed > total。界面显示「分块进度暂不可用」。 */
  invalid: boolean;
}

export interface TimelineCurrent {
  key: LiveStageKey | null;
  /** 未知 stage 时保留原始文本，界面不得崩溃。 */
  rawStage: string | null;
  label: string;
  progress: number;
  message: string;
}

export type TimelineTerminal = 'done' | 'cancelled' | 'failed' | null;

export interface TimelineState {
  /** 当前时间线所属任务；sync 时 jobId 变化先重置，避免旧任务阶段/计数残留。 */
  jobId: string | null;
  stages: TimelineStage[];
  chunks: TimelineChunks;
  logs: JobLogEntry[];
  /** 缓存超过 500 条而丢弃的较早日志累计数；渲染层再叠加最近 200 条之外的省略数。 */
  omittedLogs: number;
  current: TimelineCurrent;
  terminal: TimelineTerminal;
  errorCode: string | null;
  /** 已识别为“复用本地”的阶段（不依赖颜色，同时给出文字说明）。 */
  reusedStages: LiveStageKey[];
  /** 已产生过 status 的阶段，用于 done 时确定“已执行阶段”。 */
  visited: LiveStageKey[];
}

export type TimelineAction =
  | {
      type: 'status';
      stage?: string;
      progress?: number;
      message?: string;
      counts?: JobCounts;
    }
  | { type: 'log'; level?: string; message?: string; at?: string; id?: string }
  | { type: 'done' }
  | { type: 'error'; code?: string; message?: string }
  | { type: 'cancelled'; message?: string }
  | { type: 'sync'; job: JobState }
  | { type: 'reset' };

const EMPTY_CURRENT: TimelineCurrent = {
  key: null,
  rawStage: null,
  label: '等待任务',
  progress: 0,
  message: '',
};

export function createInitialTimelineState(): TimelineState {
  return {
    jobId: null,
    stages: LIVE_STAGE_SEQUENCE.map((stage) => ({
      key: stage.key,
      label: stage.label,
      status: 'pending',
    })),
    chunks: { total: null, completed: null, invalid: false },
    logs: [],
    omittedLogs: 0,
    current: { ...EMPTY_CURRENT },
    terminal: null,
    errorCode: null,
    reusedStages: [],
    visited: [],
  };
}

/* ---------------- 纯函数工具 ---------------- */

function normalizeProgress(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  // 契约 progress 为 0–100；只做钳制与取整，不做小数换算。
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 单条日志展示截断：超过 2000 字符时明确标记。 */
export function truncateLogMessage(message: string): string {
  if (message.length <= MAX_TIMELINE_LOG_MESSAGE) return message;
  return `${message.slice(0, MAX_TIMELINE_LOG_MESSAGE)}${LOG_TRUNCATION_MARK}`;
}

function normalizeLogLevel(level: string | undefined): JobLogEntry['level'] {
  const value = String(level ?? 'info').toLowerCase();
  if (value === 'warn' || value === 'warning') return 'warn';
  if (value === 'error') return 'error';
  if (value === 'debug') return 'debug';
  return 'info';
}

export function normalizeTimelineLogs(
  logs: Array<JobLogEntry | string> | undefined,
): JobLogEntry[] {
  if (!Array.isArray(logs)) return [];
  const result: JobLogEntry[] = [];
  const seenIds = new Set<string>();
  for (const entry of logs) {
    if (typeof entry === 'string') {
      if (entry) result.push({ level: 'info', message: truncateLogMessage(entry) });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const message = String(entry.message ?? '');
    if (!message) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : undefined;
    // 有服务端日志标识时按 id 去重；没有标识时保留重复文本（重试可能产生相同日志）。
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    result.push({
      level: normalizeLogLevel(entry.level),
      message: truncateLogMessage(message),
      at: typeof entry.at === 'string' ? entry.at : undefined,
      id,
      observedAt: typeof entry.observedAt === 'string' ? entry.observedAt : undefined,
    });
  }
  return result;
}

function capLogs(logs: JobLogEntry[]): { logs: JobLogEntry[]; omitted: number } {
  if (logs.length <= MAX_TIMELINE_LOG_CACHE) return { logs, omitted: 0 };
  const omitted = logs.length - MAX_TIMELINE_LOG_CACHE;
  return { logs: logs.slice(logs.length - MAX_TIMELINE_LOG_CACHE), omitted };
}

function rawCount(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function isValidCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function finalizeChunks(total: number | null, completed: number | null): TimelineChunks {
  const invalid =
    (total !== null && !isValidCount(total)) ||
    (completed !== null && !isValidCount(completed)) ||
    (total !== null && completed !== null && completed > total);
  return { total, completed, invalid };
}

/**
 * counts 按字段合并：未携带的字段保留上一值，阶段变化不清空已知计数。
 * 只记录后端明确提供的值，不补全、不钳制；非法值由 invalid 标记。
 */
function mergeChunks(previous: TimelineChunks, counts?: JobCounts): TimelineChunks {
  if (!counts) return previous;
  let total = previous.total;
  let completed = previous.completed;
  if (counts.chunks !== undefined) total = rawCount(counts.chunks);
  else if (counts.totalChunks !== undefined) total = rawCount(counts.totalChunks);
  if (counts.completed !== undefined) completed = rawCount(counts.completed);
  return finalizeChunks(total, completed);
}

function addUnique<T>(list: T[], values: T[]): T[] {
  if (values.length === 0) return list;
  const result = [...list];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function markStage(
  stages: TimelineStage[],
  key: LiveStageKey,
  patch: Partial<TimelineStage>,
): TimelineStage[] {
  return stages.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage));
}

function firstPendingKey(stages: TimelineStage[]): LiveStageKey | null {
  const stage = stages.find((item) => item.status === 'pending');
  return stage ? stage.key : null;
}

/**
 * 标记复用阶段为 skipped。复用是既成事实，可覆盖 pending/active/done，
 * 但不覆盖已经失败或取消的节点。
 */
function applyReuse(state: TimelineState, keys: LiveStageKey[]): TimelineState {
  if (keys.length === 0) return state;
  const stages: TimelineStage[] = state.stages.map((stage) => {
    if (!keys.includes(stage.key)) return stage;
    if (stage.status === 'failed' || stage.status === 'cancelled') return stage;
    return { ...stage, status: 'skipped', detail: REUSE_SKIP_DETAIL };
  });
  return {
    ...state,
    stages,
    reusedStages: addUnique(state.reusedStages, keys),
    visited: addUnique(state.visited, keys),
  };
}

function detectAndApplyReuse(state: TimelineState, text: string | undefined): TimelineState {
  const detection = detectReuse(text);
  if (detection.stages.length === 0) return state;
  return applyReuse(state, detection.stages);
}

/* ---------------- 各类事件 ---------------- */

function applyStatus(
  state: TimelineState,
  payload: {
    stage?: string;
    progress?: number;
    message?: string;
    counts?: JobCounts;
  },
): TimelineState {
  if (state.terminal) return state;

  // 不做单调约束：aria-valuenow 必须跟随事件值；只有非法值才回退上一值。
  const progress = normalizeProgress(payload.progress, state.current.progress);
  const rawStage = payload.stage ?? state.current.rawStage;
  const message = payload.message ?? state.current.message ?? '';
  let key = resolveLiveStage(rawStage, message);
  // 后端在 final 之后还会发送 “AI 分析完成”（仍属于 analyzing）。该文案不含
  // 合并/最终关键词，默认会回落到 map；已进入 merge/final 后不允许子阶段回退。
  if (
    key === 'ai_map' &&
    (state.current.key === 'ai_merge' || state.current.key === 'ai_final') &&
    !/(分块|整体|map)/i.test(message)
  ) {
    key = state.current.key;
  }
  // 仅合并后端明确提供的计数，不在进入 merge/final/report 时补全 completed。
  const chunks = mergeChunks(state.chunks, payload.counts);

  let stages = state.stages;
  let visited = state.visited;
  if (key) {
    const currentIndex = LIVE_STAGE_SEQUENCE.findIndex((item) => item.key === key);
    stages = stages.map((stage, index) => {
      if (index < currentIndex) {
        if (stage.status === 'skipped' || stage.status === 'failed' || stage.status === 'cancelled') {
          return stage;
        }
        // 只有观察过（visited）或已有 done/active 的节点，才可确认已完成；
        // 中途进入等路径中从未收到事件的阶段显示「未观察」，不得推断成功。
        if (
          visited.includes(stage.key) ||
          stage.status === 'done' ||
          stage.status === 'active'
        ) {
          return { ...stage, status: 'done', detail: undefined };
        }
        if (stage.status === 'pending') {
          return { ...stage, status: 'unobserved', detail: undefined };
        }
        return stage;
      }
      if (index === currentIndex) {
        if (stage.status === 'skipped' || stage.status === 'cancelled') return stage;
        return { ...stage, status: 'active', detail: undefined };
      }
      return stage;
    });
    visited = addUnique(visited, [key]);
  }

  let next: TimelineState = {
    ...state,
    stages,
    chunks,
    visited,
    current: {
      key,
      rawStage: rawStage ?? null,
      label: key ? liveStageLabel(key) : liveStageDisplayLabel(rawStage, message),
      progress,
      message,
    },
  };

  next = detectAndApplyReuse(next, message);
  return next;
}

function applyLog(
  state: TimelineState,
  entry: JobLogEntry,
): TimelineState {
  if (state.terminal) return state;
  if (!entry.message) return state;
  // 有服务端 id 时按 id 去重（断线恢复后快照与重放可能重复）。
  if (entry.id && state.logs.some((log) => log.id === entry.id)) return state;
  const merged = capLogs([...state.logs, entry]);
  let next: TimelineState = {
    ...state,
    logs: merged.logs,
    omittedLogs: state.omittedLogs + merged.omitted,
  };
  next = detectAndApplyReuse(next, entry.message);
  return next;
}

function applyDone(state: TimelineState): TimelineState {
  if (state.terminal) return state;
  const stages = state.stages.map((stage) => {
    if (
      stage.status === 'skipped' ||
      stage.status === 'failed' ||
      stage.status === 'cancelled' ||
      stage.status === 'unobserved' ||
      stage.status === 'pending'
    ) {
      return stage;
    }
    // 只完成已观察到的阶段；未观察节点不得因为 done 事件被推断为成功。
    if (stage.status === 'active' || stage.status === 'done' || state.visited.includes(stage.key)) {
      return { ...stage, status: 'done' as const, detail: undefined };
    }
    return stage;
  });
  return {
    ...state,
    stages,
    terminal: 'done',
    current: { ...state.current, progress: 100, label: '已完成' },
  };
}

function applyError(
  state: TimelineState,
  code: string | undefined,
  message: string | undefined,
): TimelineState {
  if (state.terminal) return state;
  const errorCode = code ?? 'ERROR';
  const targetKey =
    state.current.key ??
    state.stages.find((stage) => stage.status === 'active')?.key ??
    firstPendingKey(state.stages) ??
    state.stages[state.stages.length - 1]?.key ??
    null;
  const stages = targetKey
    ? markStage(state.stages, targetKey, {
        status: 'failed',
        detail: `失败 · ${errorCode}`,
      })
    : state.stages;
  return {
    ...state,
    stages,
    terminal: 'failed',
    errorCode,
    current: {
      ...state.current,
      label: state.current.label || '失败',
      message: message || state.current.message,
    },
  };
}

function applyCancelled(state: TimelineState, message?: string): TimelineState {
  if (state.terminal) return state;
  const targetKey =
    state.current.key ??
    state.stages.find((stage) => stage.status === 'active')?.key ??
    state.visited[state.visited.length - 1] ??
    firstPendingKey(state.stages);
  const stages = targetKey
    ? markStage(state.stages, targetKey, {
        status: 'cancelled',
        detail: '已取消',
      })
    : state.stages;
  return {
    ...state,
    stages,
    terminal: 'cancelled',
    current: {
      ...state.current,
      message: message ?? state.current.message,
    },
  };
}

function applySync(state: TimelineState, job: JobState): TimelineState {
  const incomingJobId =
    typeof job.jobId === 'string' && job.jobId ? job.jobId : null;
  // 切换任务时先重置，避免旧任务的阶段、进度、计数与日志残留。
  if (incomingJobId && state.jobId && incomingJobId !== state.jobId) {
    state = createInitialTimelineState();
  }

  if (state.terminal) {
    // 重试会先把任务重置为 queued/0/空日志；这是新一轮分析而非旧任务的
    // 非终态更新，需要重置时间线。其余终态后的更新一律忽略。
    const freshStart =
      job.status === 'queued' &&
      job.progress <= 0 &&
      !job.error &&
      !job.cancelled &&
      (job.logs?.length ?? 0) === 0;
    if (!freshStart) return state;
    state = createInitialTimelineState();
  }

  if (incomingJobId) state = { ...state, jobId: incomingJobId };

  let next = state;
  if (typeof job.stage === 'string' && job.stage) {
    next = applyStatus(next, {
      stage: job.stage,
      progress: job.progress,
      message: job.message,
      counts: job.counts,
    });
  }

  if (Array.isArray(job.logs)) {
    const logs = normalizeTimelineLogs(job.logs);
    const capped = capLogs(logs);
    // App 已在合并时丢弃并累计的条数 + 本次快照自身溢出条数。
    const carriedOmitted =
      typeof job.logOmitted === 'number' && Number.isFinite(job.logOmitted) && job.logOmitted > 0
        ? Math.floor(job.logOmitted)
        : 0;
    next = {
      ...next,
      logs: capped.logs,
      omittedLogs: carriedOmitted + capped.omitted,
    };
    for (const entry of capped.logs) {
      next = detectAndApplyReuse(next, entry.message);
    }
  }

  if (job.cancelled || job.status === 'cancelled') {
    return applyCancelled(next, job.message);
  }
  if (job.status === 'failed' || job.error) {
    return applyError(next, job.error?.code, job.error?.message ?? job.message);
  }
  if (job.status === 'completed') {
    return applyDone(next);
  }
  return next;
}

/** 纯 reducer：所有状态迁移均可单测，不依赖 React / 网络 / 时钟。 */
export function reduceProgress(
  state: TimelineState,
  action: TimelineAction,
): TimelineState {
  switch (action.type) {
    case 'status':
      return applyStatus(state, action);
    case 'log':
      return applyLog(state, {
        level: normalizeLogLevel(action.level),
        message: truncateLogMessage(String(action.message ?? '')),
        at: action.at,
        id: action.id,
      });
    case 'done':
      return applyDone(state);
    case 'error':
      return applyError(state, action.code, action.message);
    case 'cancelled':
      return applyCancelled(state, action.message);
    case 'sync':
      return applySync(state, action.job);
    case 'reset':
      return createInitialTimelineState();
    default:
      return state;
  }
}

/** 订阅 App 维护的 JobState，把它同步进可视化 reducer。 */
export function useJobTimeline(job: JobState): TimelineState {
  const [state, dispatch] = useReducer(
    reduceProgress,
    job,
    (initialJob) =>
      reduceProgress(createInitialTimelineState(), { type: 'sync', job: initialJob }),
  );

  useEffect(() => {
    dispatch({ type: 'sync', job });
  }, [job]);

  return state;
}
