import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, isAppError } from '../lib/errors';
import { canonicalJson, contentHash, shortHash } from '../lib/hash';
import { atomicWriteJson, dirSize, fileSize, isDirectory, pathExists, readJsonFile } from '../lib/fs';
import {
  DATA_DIR_MARKER,
  assertPathWithinDataDir,
  assertSafeDeletePath,
  assertSafeExistingDataDir,
  assertSafeWritePath,
  readDataDirMarker,
  type DataDirOptions,
} from './paths';
import type {
  ClientFilters,
  DatasetListItem,
  DatasetMeta,
  GameMeta,
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

export function appDir(dataDir: string, appid: number): string {
  return path.join(dataDir, String(appid));
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

export function gameFilePath(dataDir: string, appid: number): string {
  return path.join(appDir(dataDir, appid), 'game.json');
}

export async function writeGameMeta(dataDir: string, game: GameMeta): Promise<void> {
  const target = gameFilePath(dataDir, game.appid);
  await assertSafeWritePath(dataDir, target);
  await atomicWriteJson(target, game);
}

export async function readGameMeta(dataDir: string, appid: number): Promise<GameMeta | null> {
  try {
    return await readJsonFile<GameMeta>(gameFilePath(dataDir, appid));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-dataset serialization
//
// reviews.json/meta.json are replaced atomically one file at a time, but a
// single dataset has multiple files that must agree. Two jobs with the same
// reviewsHash (or a stale aggregates update racing a fresh fetch) could
// otherwise interleave and leave meta describing the wrong content. Reads and
// writes for one dataset therefore go through a tiny async mutex.
// ---------------------------------------------------------------------------

const datasetLocks = new Map<string, Promise<void>>();

function datasetLockKey(dataDir: string, appid: number, reviewsHash: string): string {
  return `${path.resolve(dataDir).replace(/[\\/]+/g, '/').toLowerCase()}|${appid}|${reviewsHash}`;
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
): Promise<DatasetMeta> {
  if (!isValidReviews(reviews)) {
    throw new AppError('INTERNAL', '评论数据结构无效，拒绝写入数据集');
  }
  const key = datasetLockKey(dataDir, meta.appid, meta.reviewsHash);
  return withDatasetLock(key, async () => {
    const reviewsContentHash = contentHash(reviews);
    const fullMeta: DatasetMeta = {
      ...meta,
      reviewsContentHash,
      reviewCount: reviews.length,
      status: 'complete',
    };
    await writeGameMeta(dataDir, meta.game);
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
      previousReviews = await readJsonFile(reviewsPath);
      hadPrevious = true;
    } catch {
      // First write for this dataset.
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
}

/**
 * Persist updated aggregate metadata. The write is version-checked: it only
 * commits when the dataset still contains exactly the reviews content the
 * caller saw. A stale update (for example after another job rewrote the same
 * reviewsHash) returns null instead of overwriting newer content metadata.
 */
export async function updateDatasetMeta(dataDir: string, meta: DatasetMeta): Promise<DatasetMeta | null> {
  const key = datasetLockKey(dataDir, meta.appid, meta.reviewsHash);
  return withDatasetLock(key, async () => {
    const target = metaFilePath(dataDir, meta.appid, meta.reviewsHash);
    await assertSafeWritePath(dataDir, target);
    let current: DatasetMeta;
    try {
      current = await readJsonFile<DatasetMeta>(target);
    } catch {
      return null;
    }
    if (!isValidDatasetMeta(current, { appid: meta.appid, reviewsHash: meta.reviewsHash })) return null;
    if (current.status !== 'complete') return null;
    if (current.reviewsContentHash !== meta.reviewsContentHash) return null;

    // Meta and reviews must still agree at commit time.
    let reviews: unknown;
    try {
      reviews = await readJsonFile(reviewsFilePath(dataDir, meta.appid, meta.reviewsHash));
    } catch {
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
  if (!(await isDirectory(reviewsDir(dataDir, appid, reviewsHash)))) return null;
  let meta: DatasetMeta;
  try {
    meta = await readJsonFile<DatasetMeta>(metaFilePath(dataDir, appid, reviewsHash));
    // Structural and numeric validation of every persisted field. A meta
    // object such as `{ rollingKpis: {} }` or one whose reviewCount disagrees
    // with the content hash must not be reused as complete (review Major 5).
    if (!isValidDatasetMeta(meta, { appid, reviewsHash })) throw new Error('meta invalid');
  } catch {
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
    const reviews = await readJsonFile<unknown>(reviewsFilePath(dataDir, appid, reviewsHash));
    if (!isValidReviews(reviews)) throw new Error('reviews invalid');
    if (meta.reviewCount !== reviews.length) {
      return { meta: { ...meta, status: 'corrupted' }, reviews, status: 'corrupted' };
    }
    if (contentHash(reviews) !== meta.reviewsContentHash) {
      return { meta: { ...meta, status: 'corrupted' }, reviews, status: 'corrupted' };
    }
    return { meta: { ...meta, status: 'complete' }, reviews, status: 'complete' };
  } catch {
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
  const dir = path.join(appDir(dataDir, appid), 'reviews');
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const loaded: LoadedDataset[] = [];
  for (const hash of entries) {
    if (!/^[a-f0-9]{16}$/.test(hash)) continue;
    const dataset = await readDataset(dataDir, appid, hash);
    if (dataset && dataset.status === 'complete') loaded.push(dataset);
  }
  loaded.sort((a, b) => (a.meta.fetchedAt < b.meta.fetchedAt ? 1 : -1));
  return loaded[0] ?? null;
}

async function readTrendFiles(dataDir: string, appid: number): Promise<TrendDataset[]> {
  const dir = trendsDir(dataDir, appid);
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const trends: TrendDataset[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fileHash = file.replace(/\.json$/, '');
    if (!/^[a-f0-9]{16}$/.test(fileHash)) continue;
    try {
      const trend = await readJsonFile<unknown>(path.join(dir, file));
      // Validate the full trend dataset, including required content hash and
      // numeric consistency. Corrupted files are ignored individually and must
      // not break data listings.
      if (!isValidTrendDataset(trend) || trend.trendHash !== fileHash) continue;
      trends.push(trend);
    } catch {
      // corrupted trend files are ignored individually
    }
  }
  trends.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
  return trends;
}

export async function countReports(dataDir: string, appid: number): Promise<number> {
  try {
    const files = await fsp.readdir(reportsDir(dataDir, appid));
    return files.filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
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
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const entries: ReportIndexEntry[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
    const jsonPath = path.join(dir, file);
    let reviewsHash: string | undefined;
    let trendHash: string | undefined;
    try {
      const report = await readJsonFile<{ methodology?: { reviewsHash?: string; trendHash?: string } }>(jsonPath);
      reviewsHash = report?.methodology?.reviewsHash;
      trendHash = report?.methodology?.trendHash;
    } catch {
      // Unreadable reports still occupy space but are not associated.
    }
    const bytes =
      (await fileSize(jsonPath)) +
      (await fileSize(path.join(dir, file.replace(/\.json$/, '.md'))));
    entries.push({ analysisHash: file.replace(/\.json$/, ''), reviewsHash, trendHash, bytes });
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
export async function listDatasets(dataDir: string): Promise<DatasetListItem[]> {
  let appEntries: string[];
  try {
    appEntries = await fsp.readdir(dataDir);
  } catch {
    return [];
  }
  const items: DatasetListItem[] = [];
  for (const appidName of appEntries) {
    if (!/^\d+$/.test(appidName)) continue;
    const appid = Number(appidName);
    const reviewRoot = path.join(appDir(dataDir, appid), 'reviews');
    let hashes: string[];
    try {
      hashes = await fsp.readdir(reviewRoot);
    } catch {
      continue;
    }
    const gameMeta = await readGameMeta(dataDir, appid);
    const trends = await readTrendFiles(dataDir, appid);
    const trendSizes = new Map<string, number>();
    for (const trend of trends) {
      trendSizes.set(trend.trendHash, await fileSize(path.join(trendsDir(dataDir, appid), `${trend.trendHash}.json`)));
    }
    const reportIndex = await readReportIndex(dataDir, appid);
    const gameBytes = await fileSize(gameFilePath(dataDir, appid));
    for (const reviewsHash of hashes) {
      if (!/^[a-f0-9]{16}$/.test(reviewsHash)) continue;
      const dataset = await readDataset(dataDir, appid, reviewsHash);
      if (!dataset) continue;
      const reports = reportIndex.filter((r) => r.reviewsHash === reviewsHash);
      const referencedTrends = new Set(
        reports.map((r) => r.trendHash).filter((h): h is string => Boolean(h && trendSizes.has(h))),
      );
      let trendBytes = 0;
      for (const hash of referencedTrends) trendBytes += trendSizes.get(hash) ?? 0;
      const reportBytes = reports.reduce((sum, r) => sum + r.bytes, 0);
      const dir = reviewsDir(dataDir, appid, reviewsHash);
      const bytes = (await dirSize(dir)) + gameBytes + reportBytes + trendBytes;
      const coverageTrend = trends[0];
      items.push({
        appid,
        game: dataset.meta.game?.name || gameMeta?.name || `App ${appid}`,
        reviewsHash,
        reviewCount: dataset.meta.reviewCount,
        fetchedAt: dataset.meta.fetchedAt,
        ...(coverageTrend ? { trendCoverage: { start: coverageTrend.coverage.start, end: coverageTrend.coverage.end } } : {}),
        reportCount: reports.length,
        bytes,
        status: dataset.status,
      });
    }
  }
  items.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
  return items;
}

export interface DatasetDetail {
  appid: number;
  reviewsHash: string;
  meta: DatasetMeta;
  reviewCount: number;
  trends: Array<{ trendHash: string; source: string; coverage: TrendDataset['coverage']; fetchedAt: string; points: number }>;
  reports: Array<{ analysisHash: string; generatedAt?: string; model?: string }>;
  status: 'complete' | 'corrupted';
}

export async function getDatasetDetail(
  dataDir: string,
  appid: number,
  reviewsHash: string,
): Promise<DatasetDetail | null> {
  const dataset = await readDataset(dataDir, appid, reviewsHash);
  if (!dataset) return null;
  const trends = await readTrendFiles(dataDir, appid);
  const reports: DatasetDetail['reports'] = [];
  try {
    const files = await fsp.readdir(reportsDir(dataDir, appid));
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const report = await readJsonFile<{ generatedAt?: string; methodology?: { aiModel?: string; reviewsHash?: string } }>(
          path.join(reportsDir(dataDir, appid), file),
        );
        if (report?.methodology?.reviewsHash && report.methodology.reviewsHash !== reviewsHash) continue;
        reports.push({ analysisHash: file.replace(/\.json$/, ''), generatedAt: report?.generatedAt, model: report?.methodology?.aiModel });
      } catch {
        reports.push({ analysisHash: file.replace(/\.json$/, '') });
      }
    }
  } catch {
    // no reports directory
  }
  return {
    appid,
    reviewsHash,
    meta: dataset.meta,
    reviewCount: dataset.reviews.length,
    trends: trends.map((t) => ({
      trendHash: t.trendHash,
      source: t.source,
      coverage: t.coverage,
      fetchedAt: t.fetchedAt,
      points: t.points.length,
    })),
    reports,
    status: dataset.status,
  };
}

/** Delete one dataset directory plus reports that reference its content hash. */
export async function deleteDataset(
  dataDir: string,
  appid: number,
  reviewsHash: string,
  opts: DataDirOptions = {},
): Promise<{ deleted: true; reportsDeleted: number }> {
  const dir = reviewsDir(dataDir, appid, reviewsHash);
  if (!(await pathExists(dir))) throw new AppError('NOT_FOUND', '数据集不存在');
  // Re-check the real path and every link level right before deletion: a
  // junction inside the data directory (including `570/reports`) must never
  // let deletion escape it.
  await assertSafeExistingDataDir(dataDir, opts);
  await assertPathWithinDataDir(dataDir, dir);
  await assertSafeDeletePath(dataDir, dir);

  let reportsDeleted = 0;
  const rdir = reportsDir(dataDir, appid);
  if (await pathExists(rdir)) {
    // `reports` is a sibling of the dataset directory, so validating only the
    // dataset path is insufficient: a junction at `570/reports` would redirect
    // the readdir/rm below to external files.
    await assertSafeDeletePath(dataDir, rdir);
    let files: string[];
    try {
      files = await fsp.readdir(rdir);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
      const filePath = path.join(rdir, file);
      const mdPath = path.join(rdir, file.replace(/\.json$/, '.md'));
      try {
        const report = await readJsonFile<{ methodology?: { reviewsHash?: string } }>(filePath);
        if (report?.methodology?.reviewsHash !== reviewsHash) continue;
        // Re-validate each file immediately before unlinking it.
        await assertSafeDeletePath(dataDir, filePath);
        if (await pathExists(mdPath)) await assertSafeDeletePath(dataDir, mdPath);
        await fsp.rm(filePath, { force: true });
        await fsp.rm(mdPath, { force: true });
        reportsDeleted += 1;
      } catch (err) {
        // Security violations must abort the whole deletion; unreadable
        // reports are simply left in place because they are not reusable.
        if (isAppError(err) && err.code === 'DATA_DIR_FORBIDDEN') throw err;
      }
    }
  }
  // Final re-check immediately before the recursive delete.
  await assertSafeDeletePath(dataDir, dir);
  await fsp.rm(dir, { recursive: true, force: true });
  const parent = path.dirname(dir);
  try {
    const remaining = await fsp.readdir(parent);
    if (remaining.length === 0) await fsp.rmdir(parent);
  } catch {
    // ignore
  }
  return { deleted: true, reportsDeleted };
}

export async function saveTrend(dataDir: string, appid: number, trend: TrendDataset): Promise<string> {
  const filePath = path.join(trendsDir(dataDir, appid), `${trend.trendHash}.json`);
  await assertSafeWritePath(dataDir, filePath);
  await atomicWriteJson(filePath, trend);
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
    const trend = await readJsonFile<unknown>(path.join(trendsDir(dataDir, appid), `${trendHash}.json`));
    // Full structural and numeric validation, including a *required*
    // trendContentHash that still describes the points (review Major 5).
    if (!isValidTrendDataset(trend)) return null;
    // The filename key must match the stored key, and the timezone must match
    // the current one.
    if (trend.trendHash !== trendHash) return null;
    if (expected.timezone && trend.timezone !== expected.timezone) return null;
    return trend;
  } catch {
    return null;
  }
}

/**
 * Clear all entries inside a validated GReview data directory (never the
 * directory itself). A directory is only cleared when it carries the GReview
 * marker and every top-level entry is a numeric app directory owned by this
 * tool; ordinary directories are rejected untouched.
 */
export async function clearDataDir(dataDir: string, opts: DataDirOptions = {}): Promise<number> {
  const dir = path.resolve(dataDir);
  if (!(await isDirectory(dir))) return 0;
  await assertSafeExistingDataDir(dir, opts);

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;
  if (!(await readDataDirMarker(dir))) {
    throw new AppError('DATA_DIR_FORBIDDEN', '数据目录缺少 GReview 标记，拒绝清空');
  }

  const toDelete: string[] = [];
  for (const entry of entries) {
    if (entry === DATA_DIR_MARKER) continue;
    if (!/^\d+$/.test(entry)) {
      throw new AppError('DATA_DIR_FORBIDDEN', `数据目录包含非 GReview 条目 ${entry}，拒绝清空`);
    }
    const full = path.join(dir, entry);
    const stat = await fsp.lstat(full);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AppError('DATA_DIR_FORBIDDEN', `数据目录条目 ${entry} 不是普通目录，拒绝清空`);
    }
    await assertPathWithinDataDir(dir, full);
    toDelete.push(full);
  }

  // Second check immediately before deleting anything.
  await assertSafeExistingDataDir(dir, opts);
  if (!(await readDataDirMarker(dir))) {
    throw new AppError('DATA_DIR_FORBIDDEN', 'GReview 标记在删除前消失，拒绝清空');
  }

  let removed = 0;
  for (const full of toDelete) {
    await fsp.rm(full, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
