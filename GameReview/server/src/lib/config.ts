import path from 'node:path';

export interface ServerConfig {
  projectRoot: string;
  serverRoot: string;
  port: number;
  host: '127.0.0.1';
  cacheDir: string;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  steamRequestDelayMs: number;
  /** Per-request Steam timeout; upstream hangs must not hold concurrency slots. */
  steamTimeoutMs: number;
  aiTimeoutMs: number;
  aiMaxChunks: number;
  maxPagesPerJob: number;
  maxPagesForScrape: number;
  maxConcurrentJobs: number;
  jobRetentionMs: number;
  timezone: string;
  webDist: string;
  version: string;
  nodeEnv: string;
}

export const VERSION = '0.1.1';

function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the project root without trusting the process cwd.
 * Modules live in `server/src/<subdir>` or `server/dist/<subdir>` (for example
 * `server/dist/lib/config.js`), so the server root is two levels above this
 * file's directory and the repository root is its parent.
 */
export function detectRoots(moduleDir: string = __dirname): { serverRoot: string; projectRoot: string } {
  const serverRoot = path.resolve(moduleDir, '..', '..');
  return { serverRoot, projectRoot: path.resolve(serverRoot, '..') };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const { serverRoot, projectRoot } = detectRoots();
  const dataDir = env.DATA_DIR
    ? path.resolve(projectRoot, env.DATA_DIR)
    : path.join(projectRoot, 'data');
  const cacheDir = env.CACHE_DIR
    ? path.resolve(projectRoot, env.CACHE_DIR)
    : path.join(serverRoot, '.cache');
  const requestedHost = env.HOST && env.HOST.trim();
  const host: '127.0.0.1' =
    requestedHost === 'localhost' || requestedHost === '127.0.0.1' ? '127.0.0.1' : '127.0.0.1';
  return {
    projectRoot,
    serverRoot,
    port: intFromEnv(env.PORT, 53821),
    host,
    cacheDir,
    dataDir,
    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(env.LOG_LEVEL as never)
      ? (env.LOG_LEVEL as ServerConfig['logLevel'])
      : 'info',
    steamRequestDelayMs: intFromEnv(env.STEAM_REQUEST_DELAY_MS, 400),
    steamTimeoutMs: intFromEnv(env.STEAM_TIMEOUT_MS, 30000),
    aiTimeoutMs: intFromEnv(env.AI_TIMEOUT_MS, 120000),
    aiMaxChunks: intFromEnv(env.AI_MAX_CHUNKS, 8),
    maxPagesPerJob: intFromEnv(env.MAX_PAGES_PER_JOB, 60),
    maxPagesForScrape: 30,
    maxConcurrentJobs: 2,
    jobRetentionMs: 60 * 60 * 1000,
    timezone: env.TZ && env.TZ.trim() ? env.TZ.trim() : 'Asia/Shanghai',
    webDist: path.join(projectRoot, 'web', 'dist'),
    version: VERSION,
    nodeEnv: env.NODE_ENV ?? 'development',
  };
}
