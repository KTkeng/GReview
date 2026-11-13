/** Error codes and HTTP mappings (design doc §10.5, feature contract ApiError). */

import type { GamePresentation } from '../types';

export type ErrorCode =
  | 'INVALID_URL'
  | 'INVALID_REQUEST'
  | 'INVALID_PARAMS'
  | 'DATA_DIR_NOT_ABSOLUTE'
  | 'DATA_DIR_FORBIDDEN'
  | 'DATA_DIR_INVALID'
  | 'FORBIDDEN'
  | 'APP_NOT_FOUND'
  | 'NOT_FOUND'
  | 'GAME_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'NO_REVIEWS'
  | 'STEAM_RATE_LIMITED'
  | 'AI_RATE_LIMITED'
  | 'JOB_LIMIT'
  | 'INVALID_AI_KEY'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'TITLE_CONFLICT'
  | 'TITLE_CORRUPTED'
  | 'TITLE_NOT_WRITABLE'
  | 'TITLE_NO_SPACE'
  | 'TITLE_BUSY'
  | 'STORAGE_NOT_WRITABLE'
  | 'REPORT_NOT_FOUND'
  | 'JOB_NOT_COMPLETED'
  | 'STEAM_UNAVAILABLE'
  | 'STEAM_ENDPOINT_CHANGED'
  | 'AI_INVALID_RESPONSE'
  | 'AI_TIMEOUT'
  | 'AI_CONTEXT_TOO_LARGE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  INVALID_REQUEST: 400,
  INVALID_PARAMS: 400,
  DATA_DIR_NOT_ABSOLUTE: 400,
  DATA_DIR_FORBIDDEN: 400,
  DATA_DIR_INVALID: 400,
  FORBIDDEN: 403,
  APP_NOT_FOUND: 404,
  NOT_FOUND: 404,
  GAME_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  NO_REVIEWS: 422,
  STEAM_RATE_LIMITED: 429,
  AI_RATE_LIMITED: 429,
  JOB_LIMIT: 429,
  INVALID_AI_KEY: 401,
  CANCELLED: 409,
  CONFLICT: 409,
  TITLE_CONFLICT: 409,
  TITLE_CORRUPTED: 409,
  TITLE_NOT_WRITABLE: 503,
  TITLE_NO_SPACE: 503,
  TITLE_BUSY: 503,
  STORAGE_NOT_WRITABLE: 503,
  REPORT_NOT_FOUND: 404,
  JOB_NOT_COMPLETED: 409,
  STEAM_UNAVAILABLE: 502,
  STEAM_ENDPOINT_CHANGED: 502,
  AI_INVALID_RESPONSE: 502,
  AI_TIMEOUT: 504,
  AI_CONTEXT_TOO_LARGE: 413,
  INTERNAL: 500,
};

const MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: '无法解析 Steam 链接或 AppID',
  INVALID_REQUEST: '参数无效',
  INVALID_PARAMS: '参数无效',
  DATA_DIR_NOT_ABSOLUTE: '数据目录必须是绝对路径',
  DATA_DIR_FORBIDDEN: '数据目录无效',
  DATA_DIR_INVALID: '数据目录无效',
  FORBIDDEN: '来源不允许',
  APP_NOT_FOUND: '未找到该 Steam 游戏',
  NOT_FOUND: '资源不存在',
  GAME_NOT_FOUND: '本地游戏不存在',
  JOB_NOT_FOUND: '任务不存在或已清理',
  NO_REVIEWS: '筛选后没有匹配的评论',
  STEAM_RATE_LIMITED: 'Steam 请求过于频繁，请稍后重试',
  AI_RATE_LIMITED: 'AI 服务请求过于频繁，请稍后重试',
  JOB_LIMIT: '同时运行的任务过多，请等待现有任务结束',
  INVALID_AI_KEY: 'DeepSeek API Key 无效',
  CANCELLED: '任务已取消',
  CONFLICT: '当前状态下无法执行该操作',
  TITLE_CONFLICT: '标题版本冲突，请重新加载后再保存',
  TITLE_CORRUPTED: '标题文件损坏或版本不受支持，无法修改',
  TITLE_NOT_WRITABLE: '存储不可写',
  TITLE_NO_SPACE: '存储空间不足',
  TITLE_BUSY: '存储忙，请稍后重试',
  STORAGE_NOT_WRITABLE: '存储不可写',
  REPORT_NOT_FOUND: '报告不存在',
  JOB_NOT_COMPLETED: '任务未完成',
  STEAM_UNAVAILABLE: 'Steam 服务暂时不可用',
  STEAM_ENDPOINT_CHANGED: 'Steam 接口响应结构异常，可能已变更',
  AI_INVALID_RESPONSE: 'AI 返回内容无法解析或缺少有效证据',
  AI_TIMEOUT: 'AI 请求超时',
  AI_CONTEXT_TOO_LARGE: 'AI 样本超出模型上下文限制',
  INTERNAL: '服务器内部错误',
};

/**
 * Public stable error codes required by the feature contract. Only codes that
 * the contract spells out in Chinese are translated; the design document's
 * codes (INVALID_URL, APP_NOT_FOUND, STEAM and AI provider codes,
 * JOB_NOT_FOUND, INTERNAL, …) keep their established spelling.
 */
const PUBLIC_CODES: Partial<Record<ErrorCode, string>> = {
  INVALID_REQUEST: '参数无效',
  INVALID_PARAMS: '参数无效',
  FORBIDDEN: '来源不允许',
  DATA_DIR_NOT_ABSOLUTE: '数据目录无效',
  DATA_DIR_FORBIDDEN: '数据目录无效',
  DATA_DIR_INVALID: '数据目录无效',
  GAME_NOT_FOUND: '本地游戏不存在',
  TITLE_CONFLICT: '标题版本冲突',
  TITLE_CORRUPTED: '标题文件损坏',
  TITLE_NOT_WRITABLE: '存储不可写',
  TITLE_NO_SPACE: '存储空间不足',
  TITLE_BUSY: '存储忙',
  STORAGE_NOT_WRITABLE: '存储不可写',
  REPORT_NOT_FOUND: '报告不存在',
  JOB_NOT_COMPLETED: '任务未完成',
};

export function publicCodeFor(code: ErrorCode): string {
  return PUBLIC_CODES[code] ?? code;
}

export interface AppErrorOptions {
  /** Override the HTTP status derived from the code (e.g. 413/415 for the same code). */
  status?: number;
  /** Request field that failed validation. */
  field?: string;
  /**
   * Original filesystem errno (EACCES, EIO, …) for ordinary I/O failures that
   * were mapped to a generic code. Internal only: never serialized to clients.
   */
  causeCode?: string;
  /** Current game presentation, only for TITLE_CONFLICT. */
  currentGame?: GamePresentation;
  /**
   * Chinese explanation that is safe to return to the client. `detail` itself
   * remains internal (logs only) because filesystem/exception text may contain
   * absolute paths or other sensitive context.
   */
  publicDetail?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Internal diagnostic detail. Never serialized to API responses. */
  readonly detail?: string;
  /** Allow-listed Chinese detail that may be serialized to API responses. */
  readonly publicDetail?: string;
  readonly field?: string;
  /** Original filesystem errno for mapped ordinary I/O failures (internal). */
  readonly causeCode?: string;
  readonly currentGame?: GamePresentation;
  /** Human readable Chinese message; `message` intentionally equals the code so
   * tests and logs can match on a stable token. */
  readonly displayMessage: string;

  constructor(code: ErrorCode, detail?: string, message?: string, options: AppErrorOptions = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS[code] ?? 500;
    this.detail = detail;
    this.publicDetail = options.publicDetail;
    this.field = options.field;
    this.causeCode = options.causeCode;
    this.currentGame = options.currentGame;
    this.displayMessage = message ?? MESSAGES[code] ?? '服务器内部错误';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** True for failures of the realpath/link containment checks. */
export function isSecurityError(err: unknown): err is AppError {
  return isAppError(err) && (err.code === 'DATA_DIR_FORBIDDEN' || err.code === 'DATA_DIR_INVALID');
}

export function statusForCode(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

export function messageForCode(code: ErrorCode): string {
  return MESSAGES[code] ?? '服务器内部错误';
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  // Unknown exception text is kept for internal diagnostics only; the public
  // payload never includes it (normalizeError/errorPayload enforce that).
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL', message);
}

export function errorPayload(err: AppError): {
  error: {
    code: string;
    message: string;
    field?: string;
    currentGame?: GamePresentation;
    detail?: string;
  };
} {
  return {
    error: {
      code: publicCodeFor(err.code),
      message: err.displayMessage,
      ...(err.field ? { field: err.field } : {}),
      ...(err.currentGame ? { currentGame: err.currentGame } : {}),
      ...(err.publicDetail ? { detail: err.publicDetail } : {}),
    },
  };
}
