import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

/** Wrap async handlers so Express 4 forwards rejected promises to the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Translate Zod issues to short Chinese descriptions. The raw (English) issue
 * message is intentionally not used: it can carry user-supplied fragments and
 * is not part of the public contract.
 */
function describeZodIssue(issue: ZodError['issues'][number]): string {
  const field = issue.path.length > 0 ? issue.path.join('.') : '请求体';
  switch (issue.code) {
    case 'invalid_type':
      return `${field} 类型不正确`;
    case 'too_big':
      return `${field} 超出上限`;
    case 'too_small':
      return `${field} 小于下限`;
    case 'invalid_enum_value':
    case 'invalid_literal':
      return `${field} 不是允许的取值`;
    case 'unrecognized_keys':
      return `${field} 包含未知字段`;
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return `${field} 格式不正确`;
    case 'invalid_string':
      return `${field} 格式不正确`;
    case 'invalid_date':
      return `${field} 不是合法日期`;
    case 'not_finite':
      return `${field} 必须是有限数值`;
    case 'invalid_arguments':
    case 'invalid_return_type':
    case 'custom':
    default:
      return `${field} 不符合要求`;
  }
}

export function zodToAppError(err: ZodError): AppError {
  const publicDetail = err.issues.map(describeZodIssue).join('；');
  const internalDetail = err.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
  return new AppError('INVALID_PARAMS', internalDetail, '参数无效', {
    field: err.issues[0]?.path.length ? err.issues[0].path.join('.') : undefined,
    publicDetail,
  });
}

/** Chinese, allow-listed summary of Zod issues (safe for API responses). */
export function zodPublicDetail(err: ZodError): string {
  return err.issues.map(describeZodIssue).join('；');
}

export function apiKeyFrom(req: Request): string {
  const header = req.header('x-deepseek-key');
  const key = typeof header === 'string' ? header.trim() : '';
  if (!key) throw new AppError('INVALID_AI_KEY', '缺少 X-DeepSeek-Key 请求头');
  return key;
}

export function parseTopN(value: unknown, fallback = 10): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new AppError('INVALID_PARAMS', 'topReviews 必须是 1–50 的整数', '参数无效', {
      publicDetail: 'topReviews 必须是 1–50 的整数',
    });
  }
  return n;
}

export function validateDateRange(start?: number, end?: number): void {
  const hasStart = typeof start === 'number' && Number.isFinite(start);
  const hasEnd = typeof end === 'number' && Number.isFinite(end);
  // Steam's official endpoint only applies date_range when both bounds are
  // present (design §7.1). A single-sided range would be silently ignored while
  // the report still records the condition, so reject it explicitly at the API
  // boundary (preview and job creation).
  if (hasStart !== hasEnd) {
    throw new AppError('INVALID_REQUEST', 'dateRange 必须同时提供 start 与 end', '参数无效', {
      publicDetail: 'dateRange 必须同时提供 start 与 end',
    });
  }
  if (hasStart && hasEnd && end <= start) {
    throw new AppError('INVALID_REQUEST', 'dateRange.end 必须大于 start', '参数无效', {
      publicDetail: 'dateRange.end 必须大于 start',
    });
  }
}

/** Convert unknown errors to the uniform API payload; parse errors map to INVALID_REQUEST. */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return zodToAppError(err);
  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.parse.failed') {
    return new AppError('INVALID_REQUEST', '请求体不是合法 JSON', '参数无效', {
      publicDetail: '请求体不是合法 JSON',
    });
  }
  // The title endpoint caps its body at 4 KiB (contract): report it as an
  // invalid parameter with HTTP 413 rather than a generic parse failure.
  if (anyErr?.type === 'entity.too.large') {
    return new AppError('INVALID_PARAMS', '请求体超过大小上限', '参数无效', {
      status: 413,
      publicDetail: '请求体超过大小上限',
    });
  }
  if (anyErr?.type === 'charset.unsupported') {
    return new AppError('INVALID_PARAMS', '请求体字符集不受支持', '参数无效', {
      status: 415,
      publicDetail: '请求体字符集不受支持',
    });
  }
  // Unknown exception text stays internal (logged redacted); the response only
  // carries the generic Chinese INTERNAL message.
  return new AppError('INTERNAL', anyErr?.message ? String(anyErr.message) : '未知错误');
}
