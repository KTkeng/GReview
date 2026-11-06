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

export function zodToAppError(err: ZodError): AppError {
  const detail = err.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
  return new AppError('INVALID_REQUEST', detail);
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
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new AppError('INVALID_PARAMS', 'topReviews 必须是 1–50 的整数');
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
    throw new AppError('INVALID_REQUEST', 'dateRange 必须同时提供 start 与 end');
  }
  if (hasStart && hasEnd && end <= start) {
    throw new AppError('INVALID_REQUEST', 'dateRange.end 必须大于 start');
  }
}

/** Convert unknown errors to the uniform API payload; parse errors map to INVALID_REQUEST. */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return zodToAppError(err);
  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.parse.failed') return new AppError('INVALID_REQUEST', '请求体不是合法 JSON');
  if (anyErr?.type === 'entity.too.large') return new AppError('INVALID_REQUEST', '请求体过大');
  return new AppError('INTERNAL', anyErr?.message ? String(anyErr.message) : '未知错误');
}
