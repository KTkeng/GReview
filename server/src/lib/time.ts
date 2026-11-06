const DAY_MS = 86_400_000;

export interface WindowBounds {
  start: string;
  end: string;
}

/**
 * Boundaries of a rolling window ending at the aggregate computation time.
 * Persisted 30/90-day aggregates are frozen at `aggregatesComputedAt`, so the
 * export must state both the computation time and these boundaries instead of
 * implying a live "last 30/90 days" window.
 */
export function rollingWindowBounds(computedAt: string | undefined, days: number): WindowBounds | null {
  if (!computedAt || !Number.isFinite(days) || days <= 0) return null;
  const endMs = Date.parse(computedAt);
  if (!Number.isFinite(endMs)) return null;
  return {
    start: new Date(endMs - days * DAY_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}
