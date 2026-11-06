import { AppError } from '../lib/errors';

/**
 * Task-level Steam request budget (design §6.4, §10.6):
 * at most `MAX_PAGES_PER_JOB` (default 60) requests per analysis, shared by the
 * review pagination, the monthly/day-range trend aggregates, the rolling KPI
 * aggregates and the lazy trend-sample fallback.
 *
 * Exhaustion is a hard boundary: the request is never sent. Callers that can
 * degrade (trend sample/rolling KPI) check `remaining` first; callers that
 * cannot complete without more requests surface STEAM_UNAVAILABLE.
 */
export class RequestBudget {
  private usedCount = 0;

  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new AppError('INTERNAL', '请求预算上限无效');
    }
  }

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  canConsume(count = 1): boolean {
    return count > 0 && this.usedCount + count <= this.limit;
  }

  /** Reserve `count` requests or throw before performing any network I/O. */
  consume(count = 1): void {
    if (count <= 0) return;
    if (!this.canConsume(count)) {
      throw new AppError(
        'STEAM_UNAVAILABLE',
        `Steam 请求预算已耗尽（本任务上限 ${this.limit} 次，已用 ${this.usedCount} 次）`,
      );
    }
    this.usedCount += count;
  }
}
