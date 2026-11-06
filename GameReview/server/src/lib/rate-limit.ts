/** Small sleep helper; injectable so tests can avoid real backoff delays. */

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('CANCELLED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return realSleep(ms, signal);
}

/** 350–500 ms jittered inter-request pacing from design §6.4. */
export function requestDelay(baseMs: number): number {
  if (baseMs <= 0) return 0;
  const jitter = Math.floor(Math.random() * 151) - 75;
  return Math.max(350, baseMs + jitter);
}
