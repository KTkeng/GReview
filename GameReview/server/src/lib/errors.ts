/** Error codes and HTTP mappings (design doc §10.5). */

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
  | 'JOB_NOT_FOUND'
  | 'NO_REVIEWS'
  | 'STEAM_RATE_LIMITED'
  | 'AI_RATE_LIMITED'
  | 'JOB_LIMIT'
  | 'INVALID_AI_KEY'
  | 'CANCELLED'
  | 'CONFLICT'
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
  JOB_NOT_FOUND: 404,
  NO_REVIEWS: 422,
  STEAM_RATE_LIMITED: 429,
  AI_RATE_LIMITED: 429,
  JOB_LIMIT: 429,
  INVALID_AI_KEY: 401,
  CANCELLED: 409,
  CONFLICT: 409,
  STEAM_UNAVAILABLE: 502,
  STEAM_ENDPOINT_CHANGED: 502,
  AI_INVALID_RESPONSE: 502,
  AI_TIMEOUT: 504,
  AI_CONTEXT_TOO_LARGE: 413,
  INTERNAL: 500,
};

const MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: '无法解析 Steam 链接或 AppID',
  INVALID_REQUEST: '请求参数无效',
  INVALID_PARAMS: '参数无效',
  DATA_DIR_NOT_ABSOLUTE: '数据目录必须是绝对路径',
  DATA_DIR_FORBIDDEN: '数据目录不能位于源码或受保护目录',
  DATA_DIR_INVALID: '数据目录或参数无效',
  FORBIDDEN: '请求来源不受信任',
  APP_NOT_FOUND: '未找到该 Steam 游戏',
  NOT_FOUND: '资源不存在',
  JOB_NOT_FOUND: '任务不存在或已被清理',
  NO_REVIEWS: '筛选后没有匹配的评论',
  STEAM_RATE_LIMITED: 'Steam 请求过于频繁，请稍后重试',
  AI_RATE_LIMITED: 'AI 服务请求过于频繁，请稍后重试',
  JOB_LIMIT: '同时运行的任务过多，请等待现有任务结束',
  INVALID_AI_KEY: 'DeepSeek API Key 无效',
  CANCELLED: '任务已取消',
  CONFLICT: '当前状态下无法执行该操作',
  STEAM_UNAVAILABLE: 'Steam 服务暂时不可用',
  STEAM_ENDPOINT_CHANGED: 'Steam 接口响应结构异常，可能已变更',
  AI_INVALID_RESPONSE: 'AI 返回内容无法解析或缺少有效证据',
  AI_TIMEOUT: 'AI 请求超时',
  AI_CONTEXT_TOO_LARGE: 'AI 样本超出模型上下文限制',
  INTERNAL: '服务器内部错误',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: string;
  /** Human readable Chinese message; `message` intentionally equals the code so
   * tests and logs can match on a stable token. */
  readonly displayMessage: string;

  constructor(code: ErrorCode, detail?: string, message?: string) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.detail = detail;
    this.displayMessage = message ?? MESSAGES[code] ?? '服务器内部错误';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function statusForCode(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

export function messageForCode(code: ErrorCode): string {
  return MESSAGES[code] ?? '服务器内部错误';
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL', message);
}

export function errorPayload(err: AppError): { error: { code: string; message: string; detail?: string } } {
  return {
    error: {
      code: err.code,
      message: err.displayMessage,
      ...(err.detail ? { detail: err.detail } : {}),
    },
  };
}
