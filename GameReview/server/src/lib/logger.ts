/** Structured logging with key redaction. Never logs request headers or bodies that may carry keys. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***'],
  [/(sk-[A-Za-z0-9_\-]{4,})/g, 'sk-***'],
  [/(authorization["':=\s]+)[^"',\s}]+/gi, '$1***'],
  [/(x-deepseek-key["':=\s]+)[^"',\s}]+/gi, '$1***'],
];

/**
 * Filesystem paths may reveal unconfigured/unauthorised directories, so
 * diagnostics log them as placeholders. URLs (https://host/path) are left
 * intact because the POSIX pattern requires a path segment immediately after
 * a single slash.
 */
const PATH_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z]:[\\/][^\s"',;}]*/g, '<path>'],
  [/\\\\[^\s"',;}]+/g, '<path>'],
  [/(^|[\s"'(=:])\/(?:[^\s"'/]+\/)+[^\s"',;}]*/g, '$1<path>'],
];

/** Redact credentials, bearer tokens and filesystem paths from any log string. */
export function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  for (const [pattern, replacement] of PATH_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|deepseek[-_]?key|api[-_]?key|bearer/i.test(k)) out[k] = '***';
      else out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = (l) => console.error(l)): Logger {
  const min = LEVEL_WEIGHT[level] ?? 20;
  const emit = (lvl: LogLevel, msg: string, extra?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[lvl] < min) return;
    const record: Record<string, unknown> = {
      level: lvl,
      time: new Date().toISOString(),
      msg: redact(msg),
    };
    if (extra) {
      const safe = redactDeep(extra) as Record<string, unknown>;
      for (const [k, v] of Object.entries(safe)) record[k] = v;
    }
    sink(redact(JSON.stringify(record)));
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
