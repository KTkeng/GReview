import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, isAppError } from '../lib/errors';
import { canonicalJson, contentHash, shortHash } from '../lib/hash';
import { atomicWriteJson, dirSize, fileSize, isDirectory } from '../lib/fs';
import {
  DATA_DIR_MARKER,
  assertPathWithinDataDir,
  assertSafeDeletePath,
  assertSafeExistingDataDir,
  assertSafeReadPath,
  assertSafeWritePath,
  readContainedDir,
  readContainedJson,
  readDataDirMarker,
  type DataDirOptions,
} from './paths';
import type {
  ClientFilters,
  DatasetMeta,
  DatasetSummary,
  GameMeta,
  GamePresentation,
  PublicDatasetStatus,
  Review,
  ScrapeFilters,
  TrendDataset,
} from '../types';
import { withClientFilterDefaults, withFilterDefaults } from '../steam/filters';
import {
  isValidDatasetMeta,
  isValidReviews,
  isValidTrendDataset,
} from './validation';
import { appDir, gameFilePath, readGameMeta, writeGameMetaLocked } from './game-meta';
import { localGameExists, readTitleOverride, titleFilePath } from './game-title';
import { buildGamePresentation } from './presentation';
import { runStorageMutationHook, storageRootKey, withStorageLock } from './lock';

// Kept as re-exports: existing callers (and tests) import these from dataset.ts.
export { appDir, gameFilePath, readGameMeta, writeGameMeta } from './game-meta';
export type DatasetListItem = DatasetSummary;

export interface ReviewsHashInput {
  appid: number;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  maxReviews: number;
}

/** reviewsHash = sha256(appid + canonical(fetch config) + canonical(client filters) + maxReviews). */
export function buildReviewsHash(input: ReviewsHashInput): string {
  return shortHash(
    canonicalJson({
      appid: input.appid,
      filters: withFilterDefaults(input.filters),
      clientFilters: withClientFilterDefaults(input.clientFilters),
      maxReviews: input.maxReviews,
    }),
  );
}

export function reviewsDir(dataDir: string, appid: number, reviewsHash: string): string {
  return path.join(appDir(dataDir, appid), 'reviews', reviewsHash);
}

export function reviewsFilePath(dataDir: string, appid: number, reviewsHash: string): string {
  return path.join(reviewsDir(dataDir, appid, reviewsHash), 'reviews.json');
}

export function metaFilePath(dataDir: string, appid: number, reviewsHash: string): string {
  return path.join(reviewsDir(dataDir, appid, reviewsHash), 'meta.json');
}

export function trendsDir(dataDir: string, appid: number): string {
  return path.join(appDir(dataDir, appid), 'trends');
}

export function reportsDir(dataDir: string, appid: number): string {
  return path.join(appDir(dataDir, appid), 'reports');
}

function publicStatus(status: 'complete' | 'corrupted'): PublicDatasetStatus {
  return status === 'complete' ? '完整' : '损坏';
}

/** Epoch captured by a job; stale epochs are cancelled by the unified lock. */
export interface DatasetMutationOptions {
  epoch?: number;
}

// ---------------------------------------------------------------------------
// Per-dataset serialization
//
// reviews.json/meta.json are replaced atomically one file at a time, but a
// single dataset has multiple files that must agree. Two jobs with the same
// reviewsHash (or a stale aggregates update racing a fresh fetch) could
// otherwise interleave and leave meta describing the wrong content. Reads and
// writes for one dataset therefore go through a tiny async mutex, always under
// the unified data-root lock.
// ---------------------------------------------------------------------------

const datasetLocks = new Map<string, Promise<void>>();

function datasetLockKey(dataDir: string, appid: number, reviewsHash: string): string {
  // Same rule as the unified root lock: preserve real case where the
  // filesystem is case-sensitive so distinct roots never share a mutex.
  return `${storageRootKey(dataDir)}|${appid}|${reviewsHash}`;
}

async function withDatasetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = datasetLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  datasetLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (datasetLocks.get(key) === current) datasetLocks.delete(key);
  }
}

type DatasetWriteHook = () => void | Promise<void>;
let afterReviewsWriteHook: DatasetWriteHook | null = null;

/**
 * @internal Test hook: simulate a failure after reviews.json was replaced but
 * before meta.json has been committed, without having to make the filesystem
 * read-only (which is platform-dependent).
 */
export function setDatasetWriteHookForTests(hook: DatasetWriteHook | null): void {
  afterReviewsWriteHook = hook;
}

export async function writeDataset(
  dataDir: string,
  meta: Omit<DatasetMeta, 'reviewsContentHash' | 'reviewCount' | 'status'> & Partial<Pick<DatasetMeta, 'reviewsContentHash' | 'reviewCount' | 'status'>>,
  reviews: Review[],
  options: DatasetMutationOptions = {},
): Promise<DatasetMeta> {
  if (!isValidReviews(reviews)) {
    throw new AppError('INTERNAL', '评论数据结构无效，拒绝写入数据集');
  }
  const key = datasetLockKey(dataDir, meta.appid, meta.reviewsHash);
  return withStorageLock(
    dataDir,
    async () => {
      await runStorageMutationHook({ operation: 'writeDataset', dataDir, appid: meta.appid });
      return withDatasetLock(key, async () => {
        const reviewsContentHash = contentHash(reviews);
        const fullMeta: DatasetMeta = {
          ...meta,
          reviewsContentHash,
          reviewCount: reviews.length,
          status: 'complete',
        };
        await writeGameMetaLocked(dataDir, meta.game);
        const reviewsPath = reviewsFilePath(dataDir, meta.appid, meta.reviewsHash);
        const metaPath = metaFilePath(dataDir, meta.appid, meta.reviewsHash);
        // Validate every existing level (570, reviews, hash dir) before creating or
        // writing through it; a junction here must never redirect writes (review Major 5).
        await assertSafeWritePath(dataDir, reviewsPath);
        await assertSafeWritePath(dataDir, metaPath);
        await fsp.mkdir(reviewsDir(dataDir, meta.appid, meta.reviewsHash), { recursive: true });

        // Keep the previous committed reviews so a failure while committing the
        // new metadata can roll the pair back. A failed write must never leave a
        // dataset in a half-updated state.
        let previousReviews: unknown;
        let hadPrevious = false;
        try {
          previousReviews = await readContainedJson(dataDir, reviewsPath);
          hadPrevious = previousReviews !== null;
        } catch (err) {
          if (isAppError(err)) throw err;
          // First write for this dataset (or an unparseable leftover).
        }

        try {
          await atomicWriteJson(reviewsPath, reviews);
          if (afterReviewsWriteHook) await afterReviewsWriteHook();
          await atomicWriteJson(metaPath, fullMeta);
          return fullMeta;
        } catch (err) {
          try {
            if (hadPrevious) await atomicWriteJson(reviewsPath, previousReviews);
            else await fsp.rm(reviewsPath, { force: true });
          } catch {
            // Best effort: the original error is more useful to the caller.
          }
          throw err;
        }
      });
    },
    { epoch: options.epoch },
  );
}

/**
 * Persist updated aggregate metadata. The write is version-checked: it only
 * commits when the dataset still contains exactly the reviews content the
 * caller saw. A stale update (for example after another job rewrote the same
 * reviewsHash) returns null instead of overwriting newer content metadata.
 */
export async function updateDatasetMeta(
  dataDir: string,
  meta: DatasetMeta,
  options: DatasetMutationOptions = {},
): Promise<DatasetMeta | null> {
  const key = datasetLockKey(dataDir, meta.appid, meta.reviewsHash);
  return withStorageLock(
    dataDir,
    async () => {
      await runStorageMutationHook({ operation: 'updateDatasetMeta', dataDir, appid: meta.appid });
      return withDatasetLock(key, async () => {
        const target = metaFilePath(dataDir, meta.appid, meta.reviewsHash);
        await assertSafeWritePath(dataDir, target);
        let current: DatasetMeta;
        try {
          current = await readContainedJson<DatasetMeta>(dataDir, target) as DatasetMeta;
        } catch (err) {
          if (isAppError(err)) throw err;
          return null;
        }
        if (!current || !isValidDatasetMeta(current, { appid: meta.appid, reviewsHash: meta.reviewsHash })) return null;
        if (current.status !== 'complete') return null;
        if (current.reviewsContentHash !== meta.reviewsContentHash) return null;

        // Meta and reviews must still agree at commit time.
        let reviews: unknown;
        try {
          reviews = await readContainedJson(dataDir, reviewsFilePath(dataDir, meta.appid, meta.reviewsHash));
        } catch (err) {
          if (isAppError(err)) throw err;
          return null;
        }
        if (!isValidReviews(reviews) || contentHash(reviews) !== meta.reviewsContentHash) return null;

        const merged: DatasetMeta = {
          ...current,
          allTimeSummary: meta.allTimeSummary,
          rollingKpis: meta.rollingKpis,
          aggregatesComputedAt: meta.aggregatesComputedAt,
          status: 'complete',
        };
        await atomicWriteJson(target, merged);
        return merged;
      });
    },
    { epoch: options.epoch },
  );
}

export interface LoadedDataset {
  meta: DatasetMeta;
  reviews: Review[];
  status: 'complete' | 'corrupted';
}

/** Read a dataset; corrupted JSON/content-hash/schema mismatch is flagged and never reused. */
export async function readDataset(
  dataDir: string,
  appid: number,
  reviewsHash: string,
): Promise<LoadedDataset | null> {
  const key = datasetLockKey(dataDir, appid, reviewsHash);
  return withDatasetLock(key, () => readDatasetUnlocked(dataDir, appid, reviewsHash));
}

async function readDatasetUnlocked(
  dataDir: string,
  appid: number,
  reviewsHash: string,
): Promise<LoadedDataset | null> {
  if (!(await readContainedDir(dataDir, reviewsDir(dataDir, appid, reviewsHash)))) return null;
  let meta: DatasetMeta;
  try {
    meta = await readContainedJson<DatasetMeta>(dataDir, metaFilePath(dataDir, appid, reviewsHash)) as DatasetMeta;
    // Structural and numeric validation of every persisted field. A meta
    // object such as `{ rollingKpis: {} }` or one whose reviewCount disagrees
    // with the content hash must not be reused as complete (review Major 5).
    if (!meta || !isValidDatasetMeta(meta, { appid, reviewsHash })) throw new Error('meta invalid');
  } catch (err) {
    if (isAppError(err)) throw err;
    const fallbackMeta: DatasetMeta = {
      appid,
      game: { appid, name: `App ${appid}` },
      reviewsHash,
      reviewsContentHash: '',
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 0,
      fetchedAt: '',
      sourceEndpoint: 'official',
      reviewCount: 0,
      summary: null,
      status: 'corrupted',
    };
    return { meta: fallbackMeta, reviews: [], status: 'corrupted' };
  }

  try {
    const reviews = await readContainedJson<unknown>(dataDir, reviewsFilePath(dataDir, appid, reviewsHash));
    if (!isValidReviews(reviews)) throw new Error('reviews invalid');
    if (meta.reviewCount !== reviews.length) {
      return { meta: { ...meta, status: 'corrupted' }, reviews, status: 'corrupted' };
    }
    if (contentHash(reviews) !== meta.reviewsContentHash) {
      return { meta: { ...meta, status: 'corrupted' }, reviews, status: 'corrupted' };
    }
    return { meta: { ...meta, status: 'complete' }, reviews, status: 'complete' };
  } catch (err) {
    if (isAppError(err)) throw err;
    return { meta: { ...meta, status: 'corrupted' }, reviews: [], status: 'corrupted' };
  }
}

export async function findDataset(
  dataDir: string,
  appid: number,
  reviewsHash: string,
): Promise<LoadedDataset | null> {
  return readDataset(dataDir, appid, reviewsHash);
}

export async function latestDataset(dataDir: string, appid: number): Promise<LoadedDataset | null> {
  const entries = await readContainedDir(dataDir, path.join(appDir(dataDir, appid), 'reviews'));
  if (!entries) return null;
  const loaded: LoadedDataset[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() && /^[a-f0-9]{16}$/.test(entry.name)) {
      throw new AppError('DATA_DIR_FORBIDDEN', '评论数据集目录包含符号链接/联接点');
    }
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
    const dataset = await readDataset(dataDir, appid, entry.name);
    if (dataset && dataset.status === 'complete') loaded.push(dataset);
  }
  loaded.sort((a, b) => (a.meta.fetchedAt < b.meta.fetchedAt ? 1 : -1));
  return loaded[0] ?? null;
}

async function readTrendFiles(dataDir: string, appid: number): Promise<TrendDataset[]> {
  const dir = trendsDir(dataDir, appid);
  const files = await readContainedDir(dataDir, dir);
  if (!files) return [];
  const trends: TrendDataset[] = [];
  for (const entry of files) {
    if (entry.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(entry.name)) {
      throw new AppError('DATA_DIR_FORBIDDEN', '趋势目录包含符号链接/联接点');
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fileHash = entry.name.replace(/\.json$/, '');
    if (!/^[a-f0-9]{16}$/.test(fileHash)) continue;
    try {
      const trend = await readContainedJson<unknown>(dataDir, path.join(dir, entry.name));
      // Validate the full trend dataset, including required content hash and
      // numeric consistency. Corrupted files are ignored individually and must
      // not break data listings.
      if (!isValidTrendDataset(trend) || trend.trendHash !== fileHash) continue;
      trends.push(trend);
    } catch (err) {
      // Security failures abort the read; malformed content degrades locally.
      if (isAppError(err)) throw err;
    }
  }
  trends.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
  return trends;
}

export async function countReports(dataDir: string, appid: number): Promise<number> {
  const files = await readContainedDir(dataDir, reportsDir(dataDir, appid));
  if (!files) return 0;
  for (const entry of files) {
    if (entry.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(entry.name)) {
      throw new AppError('DATA_DIR_FORBIDDEN', '报告目录包含符号链接/联接点');
    }
  }
  return files.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
}

interface ReportIndexEntry {
  analysisHash: string;
  reviewsHash?: string;
  trendHash?: string;
  bytes: number;
}

/** Index report files by the dataset they were generated from (review Major 11). */
async function readReportIndex(dataDir: string, appid: number): Promise<ReportIndexEntry[]> {
  const dir = reportsDir(dataDir, appid);
  const files = await readContainedDir(dataDir, dir);
  if (!files) return [];
  const entries: ReportIndexEntry[] = [];
  for (const entry of files) {
    if (entry.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(entry.name)) {
      throw new AppError('DATA_DIR_FORBIDDEN', '报告目录包含符号链接/联接点');
    }
    if (!entry.isFile() || !/^[a-f0-9]{16}\.json$/.test(entry.name)) continue;
    const jsonPath = path.join(dir, entry.name);
    let reviewsHash: string | undefined;
    let trendHash: string | undefined;
    try {
      const report = await readContainedJson<{ methodology?: { reviewsHash?: string; trendHash?: string } }>(dataDir, jsonPath);
      reviewsHash = report?.methodology?.reviewsHash;
      trendHash = report?.methodology?.trendHash;
    } catch (err) {
      // Unreadable reports still occupy space but are not associated.
      if (isAppError(err)) throw err;
    }
    const mdPath = path.join(dir, entry.name.replace(/\.json$/, '.md'));
    const mdBytes = (await assertSafeReadPath(dataDir, mdPath)) ? await fileSize(mdPath) : 0;
    entries.push({ analysisHash: entry.name.replace(/\.json$/, ''), reviewsHash, trendHash, bytes: (await fileSize(jsonPath)) + mdBytes });
  }
  return entries;
}

/**
 * Space accounting for one dataset row:
 *   reviews/<hash>/ + game.json + reports whose methodology.reviewsHash
 *   matches + trend files those reports reference.
 * Shared app-level files are thus attributed through the report that used
 * them; app trend caches never referenced by a stored report are not counted
 * in any single dataset row. reportCount is likewise per reviewsHash, never
 * the app-wide report count.
 */
interface AppListingContext {
  presentation: GamePresentation;
  trends: TrendDataset[];
  trendSizes: Map<string, number>;
  reportIndex: ReportIndexEntry[];
  /** game.json + title.json, attributed to every dataset row of the game. */
  staticBytes: number;
}

/** Read the shared per-game inputs exactly once for a list/detail response. */
async function loadAppListingContext(dataDir: string, appid: number): Promise<AppListingContext> {
  const [gameMeta, titleState, trends, reportIndex] = await Promise.all([
    readGameMeta(dataDir, appid),
    readTitleOverride(dataDir, appid),
    readTrendFiles(dataDir, appid),
    readReportIndex(dataDir, appid),
  ]);
  const trendSizes = new Map<string, number>();
  for (const trend of trends) {
    const trendPath = path.join(trendsDir(dataDir, appid), `${trend.trendHash}.json`);
    if (await assertSafeReadPath(dataDir, trendPath)) {
      trendSizes.set(trend.trendHash, await fileSize(trendPath));
    }
  }
  const staticBytes =
    (await fileSize(gameFilePath(dataDir, appid))) + (await fileSize(titleFilePath(dataDir, appid)));
  return {
    presentation: buildGamePresentation(gameMeta, appid, titleState),
    trends,
    trendSizes,
    reportIndex,
    staticBytes,
  };
}

async function datasetSummaryFor(
  dataDir: string,
  appid: number,
  dataset: LoadedDataset,
  ctx: AppListingContext,
): Promise<DatasetSummary> {
  const reports = ctx.reportIndex.filter((r) => r.reviewsHash === dataset.meta.reviewsHash);
  const referencedTrends = new Set(
    reports.map((r) => r.trendHash).filter((h): h is string => Boolean(h && ctx.trendSizes.has(h))),
  );
  let trendBytes = 0;
  for (const hash of referencedTrends) trendBytes += ctx.trendSizes.get(hash) ?? 0;
  const reportBytes = reports.reduce((sum, r) => sum + r.bytes, 0);
  const bytes =
    (await dirSize(reviewsDir(dataDir, appid, dataset.meta.reviewsHash))) +
    ctx.staticBytes +
    reportBytes +
    trendBytes;
  const coverageTrend = ctx.trends[0];
  return {
    appid,
    game: ctx.presentation,
    reviewsHash: dataset.meta.reviewsHash,
    reviewCount: dataset.meta.reviewCount,
    fetchedAt: dataset.meta.fetchedAt || null,
    ...(coverageTrend
      ? { trendCoverage: { start: coverageTrend.coverage.start, end: coverageTrend.coverage.end } }
      : {}),
    reportCount: reports.length,
    sizeBytes: bytes,
    // Retained for older frontends that read the pre-contract field name.
    bytes,
    status: publicStatus(dataset.status),
  };
}

// ---------------------------------------------------------------------------
// Root-listing error injection (tests). A real ENOENT is never injected: the
// contract requires a missing directory to stay an empty list.
// ---------------------------------------------------------------------------

let injectedRootListError: NodeJS.ErrnoException | null = null;

/** @internal Test hook: make the root readdir fail with a specific OS error. */
export function setRootListErrorForTests(err: NodeJS.ErrnoException | null): void {
  injectedRootListError = err;
}

/**
 * List every dataset. Only a genuinely missing data directory yields []; any
 * other read failure (permissions, I/O, not-a-directory) becomes a path-free
 * 500 instead of pretending the user has no data.
 */
export async function listDatasets(dataDir: string): Promise<DatasetSummary[]> {
  const root = path.resolve(dataDir);
  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new AppError('INTERNAL', '读取数据目录失败');
  }
  if (!rootStat.isDirectory()) throw new AppError('INTERNAL', '读取数据目录失败');

  let realDir: string;
  try {
    realDir = await assertSafeExistingDataDir(root);
  } catch (err) {
    if (
      isAppError(err) &&
      (err.code === 'DATA_DIR_INVALID' || err.code === 'STORAGE_NOT_WRITABLE')
    ) {
      // The directory exists but cannot be resolved/read: a real I/O or
      // permission failure, not "no data". The list contract maps both to
      // 500 INTERNAL.
      throw new AppError('INTERNAL', '读取数据目录失败');
    }
    throw err;
  }

  let appEntries: import('node:fs').Dirent[];
  try {
    if (injectedRootListError) throw injectedRootListError;
    appEntries = await fsp.readdir(realDir, { withFileTypes: true });
  } catch {
    throw new AppError('INTERNAL', '读取数据目录失败');
  }

  const items: DatasetSummary[] = [];
  for (const entry of appEntries) {
    // A linked app directory would let list/preview/report reads escape the
    // data root; reject it instead of silently skipping or following it.
    if (entry.isSymbolicLink()) {
      throw new AppError('DATA_DIR_FORBIDDEN', '数据目录包含符号链接/联接点条目');
    }
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const appid = Number(entry.name);
    const reviewRoot = path.join(appDir(realDir, appid), 'reviews');
    const hashes = await readContainedDir(realDir, reviewRoot);
    if (!hashes) continue;
    const ctx = await loadAppListingContext(realDir, appid);
    for (const hashEntry of hashes) {
      if (hashEntry.isSymbolicLink() && /^[a-f0-9]{16}$/.test(hashEntry.name)) {
        throw new AppError('DATA_DIR_FORBIDDEN', '评论数据集目录包含符号链接/联接点');
      }
      if (!hashEntry.isDirectory() || !/^[a-f0-9]{16}$/.test(hashEntry.name)) continue;
      const dataset = await readDataset(realDir, appid, hashEntry.name);
      if (!dataset) continue;
      items.push(await datasetSummaryFor(realDir, appid, dataset, ctx));
    }
  }
  items.sort((a, b) => ((a.fetchedAt ?? '') < (b.fetchedAt ?? '') ? 1 : -1));
  return items;
}

export interface DatasetDetail {
  appid: number;
  reviewsHash: string;
  meta: DatasetMeta;
  game: GamePresentation;
  dataset: DatasetSummary;
  reviewCount: number;
  trends: Array<{ trendHash: string; source: string; coverage: TrendDataset['coverage']; fetchedAt: string; points: number }>;
  reports: Array<{ analysisHash: string; generatedAt?: string; model?: string }>;
  status: PublicDatasetStatus;
}

export async function getDatasetDetail(
  dataDir: string,
  appid: number,
  reviewsHash: string,
): Promise<DatasetDetail | null> {
  const dataset = await readDataset(dataDir, appid, reviewsHash);
  if (!dataset) return null;
  const ctx = await loadAppListingContext(dataDir, appid);
  const summary = await datasetSummaryFor(dataDir, appid, dataset, ctx);
  const reports: DatasetDetail['reports'] = [];
  const files = await readContainedDir(dataDir, reportsDir(dataDir, appid));
  if (files) {
    for (const entry of files) {
      if (entry.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(entry.name)) {
        throw new AppError('DATA_DIR_FORBIDDEN', '报告目录包含符号链接/联接点');
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const report = await readContainedJson<{ generatedAt?: string; methodology?: { aiModel?: string; reviewsHash?: string } }>(
          dataDir,
          path.join(reportsDir(dataDir, appid), entry.name),
        );
        if (report?.methodology?.reviewsHash && report.methodology.reviewsHash !== reviewsHash) continue;
        reports.push({ analysisHash: entry.name.replace(/\.json$/, ''), generatedAt: report?.generatedAt, model: report?.methodology?.aiModel });
      } catch (err) {
        if (isAppError(err)) throw err;
        reports.push({ analysisHash: entry.name.replace(/\.json$/, '') });
      }
    }
  }
  return {
    appid,
    reviewsHash,
    meta: dataset.meta,
    game: ctx.presentation,
    dataset: summary,
    reviewCount: dataset.reviews.length,
    trends: ctx.trends.map((t) => ({
      trendHash: t.trendHash,
      source: t.source,
      coverage: t.coverage,
      fetchedAt: t.fetchedAt,
      points: t.points.length,
    })),
    reports,
    status: publicStatus(dataset.status),
  };
}

/** Delete one dataset directory plus reports that reference its content hash. */
export async function deleteDataset(
  dataDir: string,
  appid: number,
  reviewsHash: string,
  opts: DataDirOptions = {},
): Promise<{ deleted: true; reportsDeleted: number }> {
  // The unified root lock serializes this deletion with title edits, dataset
  // writes, trend/report commits and clear-all, so a report cannot be written
  // back after the dataset was removed.
  return withStorageLock(dataDir, async () => {
    await runStorageMutationHook({ operation: 'deleteDataset', dataDir, appid });
    const dir = reviewsDir(dataDir, appid, reviewsHash);
    if (!(await assertSafeReadPath(dataDir, dir))) throw new AppError('NOT_FOUND', '数据集不存在');
    // Re-check the real path and every link level right before deletion: a
    // junction inside the data directory (including `570/reports`) must never
    // let deletion escape it.
    await assertSafeExistingDataDir(dataDir, opts);
    await assertPathWithinDataDir(dataDir, dir);
    await assertSafeDeletePath(dataDir, dir);

    let reportsDeleted = 0;
    const rdir = reportsDir(dataDir, appid);
    // `reports` is a sibling of the dataset directory, so validating only the
    // dataset path is insufficient: a junction at `570/reports` would redirect
    // the readdir/rm below to external files.
    const files = await readContainedDir(dataDir, rdir);
    if (files) {
      for (const entry of files) {
        if (entry.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(entry.name)) {
          // Never follow a report symlink; abort before deleting anything.
          throw new AppError('DATA_DIR_FORBIDDEN', '报告目录包含符号链接/联接点，拒绝删除');
        }
        if (!entry.isFile() || !/^[a-f0-9]{16}\.json$/.test(entry.name)) continue;
        const filePath = path.join(rdir, entry.name);
        const mdPath = path.join(rdir, entry.name.replace(/\.json$/, '.md'));
        try {
          const report = await readContainedJson<{ methodology?: { reviewsHash?: string } }>(dataDir, filePath);
          if (report?.methodology?.reviewsHash !== reviewsHash) continue;
          // Re-validate each file immediately before unlinking it.
          await assertSafeDeletePath(dataDir, filePath);
          if (await assertSafeReadPath(dataDir, mdPath)) await assertSafeDeletePath(dataDir, mdPath);
          await fsp.rm(filePath, { force: true });
          await fsp.rm(mdPath, { force: true });
          reportsDeleted += 1;
        } catch (err) {
          // Security violations must abort the whole deletion; unreadable
          // reports are simply left in place because they are not reusable.
          if (isAppError(err)) throw err;
        }
      }
    }
    // Final re-check immediately before the recursive delete.
    await assertSafeDeletePath(dataDir, dir);
    await fsp.rm(dir, { recursive: true, force: true });
    // Keep the whole game directory (title.json, game.json, trend cache and
    // reviews/) while any dataset or report remains. Once the last dataset and
    // report are gone, clean the entire game directory under the same root
    // lock so no stale title, metadata or trend cache outlives its data.
    if (!(await localGameExists(dataDir, appid))) {
      const appPath = appDir(dataDir, appid);
      await assertPathWithinDataDir(dataDir, appPath);
      // Validates every level up to and including the game directory: a
      // junction swapped in for 570 aborts the cleanup instead of redirecting
      // it outside the data root. fs.rm removes nested symlinks themselves and
      // never follows them to an external target.
      await assertSafeDeletePath(dataDir, appPath);
      if (await isDirectory(appPath)) {
        await fsp.rm(appPath, { recursive: true, force: true });
      }
    }
    return { deleted: true, reportsDeleted };
  });
}

export async function saveTrend(
  dataDir: string,
  appid: number,
  trend: TrendDataset,
  options: DatasetMutationOptions = {},
): Promise<string> {
  const filePath = path.join(trendsDir(dataDir, appid), `${trend.trendHash}.json`);
  await withStorageLock(
    dataDir,
    async () => {
      await runStorageMutationHook({ operation: 'saveTrend', dataDir, appid });
      await assertSafeWritePath(dataDir, filePath);
      await atomicWriteJson(filePath, trend);
    },
    { epoch: options.epoch },
  );
  return filePath;
}

export interface ReadTrendExpectations {
  /** Trend month boundaries depend on the timezone; never reuse across zones. */
  timezone?: string;
}

export async function readTrend(
  dataDir: string,
  appid: number,
  trendHash: string,
  expected: ReadTrendExpectations = {},
): Promise<TrendDataset | null> {
  if (!/^[a-f0-9]{16}$/.test(trendHash)) return null;
  try {
    const trend = await readContainedJson<unknown>(dataDir, path.join(trendsDir(dataDir, appid), `${trendHash}.json`));
    // Full structural and numeric validation, including a *required*
    // trendContentHash that still describes the points (review Major 5).
    if (!isValidTrendDataset(trend)) return null;
    // The filename key must match the stored key, and the timezone must match
    // the current one.
    if (trend.trendHash !== trendHash) return null;
    if (expected.timezone && trend.timezone !== expected.timezone) return null;
    return trend;
  } catch (err) {
    if (isAppError(err)) throw err;
    return null;
  }
}

/**
 * Clear all entries inside a validated GReview data directory (never the
 * directory itself). A directory is only cleared when it carries the GReview
 * marker and every top-level entry is a numeric app directory owned by this
 * tool; ordinary directories are rejected untouched.
 *
 * Runs under the unified root lock and bumps the storage epoch, so a job that
 * captured the previous epoch cannot write data back after the clear.
 */
export async function clearDataDir(dataDir: string, opts: DataDirOptions = {}): Promise<number> {
  const dir = path.resolve(dataDir);
  return withStorageLock(
    dir,
    async () => {
      await runStorageMutationHook({ operation: 'clearDataDir', dataDir: dir });
      if (!(await isDirectory(dir))) return 0;
      const realDir = await assertSafeExistingDataDir(dir, opts);

      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(realDir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw new AppError('INTERNAL', '读取数据目录失败');
      }
      if (entries.length === 0) return 0;
      if (!(await readDataDirMarker(realDir))) {
        throw new AppError('DATA_DIR_FORBIDDEN', '数据目录缺少 GReview 标记，拒绝清空');
      }

      const toDelete: Array<{ appid: number; full: string }> = [];
      for (const entry of entries) {
        if (entry.name === DATA_DIR_MARKER) continue;
        if (!/^\d+$/.test(entry.name)) {
          throw new AppError('DATA_DIR_FORBIDDEN', `数据目录包含非 GReview 条目 ${entry.name}，拒绝清空`);
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new AppError('DATA_DIR_FORBIDDEN', `数据目录条目 ${entry.name} 不是普通目录，拒绝清空`);
        }
        const full = path.join(realDir, entry.name);
        await assertPathWithinDataDir(realDir, full);
        await assertSafeDeletePath(realDir, full);
        toDelete.push({ appid: Number(entry.name), full });
      }

      // Second check immediately before deleting anything.
      await assertSafeExistingDataDir(realDir, opts);
      if (!(await readDataDirMarker(realDir))) {
        throw new AppError('DATA_DIR_FORBIDDEN', 'GReview 标记在删除前消失，拒绝清空');
      }

      let removed = 0;
      for (const { full } of toDelete) {
        await assertSafeDeletePath(realDir, full);
        await fsp.rm(full, { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
    { bumpEpoch: true },
  );
}
