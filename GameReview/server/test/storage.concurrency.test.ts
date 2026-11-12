import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../src/lib/hash';
import { readJsonFile } from '../src/lib/fs';
import { ensureDataDir } from '../src/storage/paths';
import {
  buildReviewsHash,
  clearDataDir,
  deleteDataset,
  metaFilePath,
  readDataset,
  setDatasetWriteHookForTests,
  updateDatasetMeta,
  writeDataset,
} from '../src/storage/dataset';
import { readTitleOverride, updateGameTitle } from '../src/storage/game-title';
import { captureStorageEpoch, setStorageMutationHookForTests } from '../src/storage/lock';
import { reportFilePaths, saveReport } from '../src/storage/report';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { DatasetMeta, KpiWindows, Report, Review } from '../src/types';
import { SAMPLE_REVIEWS, SAMPLE_SUMMARY, makeReview } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-concurrency-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setDatasetWriteHookForTests(null);
  setStorageMutationHookForTests(null);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const APPID = 570;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashFor(): string {
  return buildReviewsHash({
    appid: APPID,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    maxReviews: 200,
  });
}

function metaFor(reviewsHash: string): Parameters<typeof writeDataset>[1] {
  return {
    appid: APPID,
    game: { appid: APPID, name: 'Test Game' },
    reviewsHash,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    maxReviews: 200,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    sourceEndpoint: 'official',
    summary: SAMPLE_SUMMARY,
  };
}

const KPI_WINDOWS: KpiWindows = {
  last30d: { total: 300, positive: 240, negative: 60, positiveRate: 0.8 },
  last90d: { total: 600, positive: 420, negative: 180, positiveRate: 0.7 },
  source: 'official_aggregate',
  sources: { last30d: 'official_aggregate', last90d: 'official_aggregate' },
};

const REVIEWS_A: Review[] = SAMPLE_REVIEWS;

const REVIEWS_B: Review[] = [
  makeReview({ id: 'b1', text: 'first new review', votesUp: 1, createdAt: 1_700_000_000 }),
  makeReview({ id: 'b2', text: 'second new review', votesUp: 2, createdAt: 1_700_000_100 }),
];

const REPORT_HASH = 'a'.repeat(16);

function reportFor(reviewsHash: string): Report {
  return {
    version: '1.0',
    generatedAt: '2026-01-02T00:00:00.000Z',
    game: { appid: APPID, name: 'Test Game' },
    sample: {
      filters: { ...withFilterDefaults(), ...withClientFilterDefaults() },
      fetched: 3,
      matchedTotal: 1000,
      usedForAI: 3,
      languages: ['english'],
      sourceEndpoint: 'official',
    },
    kpis: {
      allTime: { total: 1000, positive: 900, negative: 100, positiveRate: 0.9, reviewScoreDesc: '特别好评' },
      last30d: { total: 100, positiveRate: 0.9, reviewScoreDesc: '特别好评' },
      last90d: { total: 300, positiveRate: 0.9, reviewScoreDesc: '特别好评' },
      samplePositiveRate: 0.67,
    },
    trend: {
      granularity: 'month',
      source: 'official_aggregate',
      points: [],
      coverage: { start: '2025-01', end: '2025-12', note: '' },
    },
    conclusion: { label: '特别好评', headline: 'h', summary: 's', confidence: 'medium', caveats: [] },
    ai: { appealPoints: [], frictionPoints: [], expectationGaps: [], updateImpact: [], recommendations: [] },
    topReviews: [],
    methodology: {
      note: '',
      steamRequests: 1,
      cacheHits: 0,
      reviewsHash,
      dataSource: 'fresh',
      trendSource: 'official_aggregate',
      analysisSource: 'fresh',
      dataDir: '/tmp/data',
      aiModel: 'deepseek-flash',
      thinkingEnabled: true,
      promptVersion: 'greview-prompt-v1',
      generatedBy: 'test',
    },
  };
}

describe('per-dataset write serialization and version checks', () => {
  it('serializes interleaved writes and reads for the same reviewsHash', async () => {
    const dataDir = tmpDir();
    const reviewsHash = hashFor();
    const gate = deferred();
    let pausedOnce = false;
    setDatasetWriteHookForTests(async () => {
      if (pausedOnce) return;
      pausedOnce = true;
      await gate.promise;
    });

    const first = writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_A);
    await sleep(20); // first write is paused after replacing reviews.json
    const second = writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_B);
    let readResolved = false;
    const read = readDataset(dataDir, APPID, reviewsHash).then((value) => {
      readResolved = true;
      return value;
    });
    await sleep(20);
    // Both the second write and the read must wait for the in-flight commit;
    // a read must never observe new reviews.json with the previous meta.json.
    expect(readResolved).toBe(false);

    gate.resolve();
    const [metaA, metaB, loaded] = await Promise.all([first, second, read]);
    expect(metaA.reviewsContentHash).toBe(contentHash(REVIEWS_A));
    expect(metaB.reviewsContentHash).toBe(contentHash(REVIEWS_B));
    expect(loaded?.status).toBe('complete');
    // The inline read is queued on the per-dataset mutex while the second write
    // is queued on the outer root lock (writes take root -> dataset). After the
    // first commit releases the dataset mutex the read may run before the second
    // write, so either committed version is valid; a torn mix is not.
    const observedIds = loaded!.reviews.map((r) => r.id);
    expect([['r1', 'r2', 'r3'], ['b1', 'b2']]).toContainEqual(observedIds);
    expect(loaded!.meta.reviewsContentHash).toBe(contentHash(loaded!.reviews));
    expect(loaded!.meta.reviewCount).toBe(loaded!.reviews.length);
    // Once both writes settle, the last write wins and a fresh read is whole B.
    const after = await readDataset(dataDir, APPID, reviewsHash);
    expect(after!.reviews.map((r) => r.id)).toEqual(['b1', 'b2']);
    expect(after!.meta.reviewsContentHash).toBe(contentHash(REVIEWS_B));
    expect(after!.meta.reviewCount).toBe(REVIEWS_B.length);
  });

  it('rejects a stale aggregate update instead of overwriting newer reviews content', async () => {
    const dataDir = tmpDir();
    const reviewsHash = hashFor();
    const firstMeta = await writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_A);
    const secondMeta = await writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_B);
    expect(secondMeta.reviewsContentHash).toBe(contentHash(REVIEWS_B));

    const stale: DatasetMeta = {
      ...firstMeta,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: KPI_WINDOWS,
      aggregatesComputedAt: '2026-02-01T00:00:00.000Z',
    };
    expect(await updateDatasetMeta(dataDir, stale)).toBeNull();

    const current = await readDataset(dataDir, APPID, reviewsHash);
    expect(current?.status).toBe('complete');
    expect(current!.meta.reviewsContentHash).toBe(contentHash(REVIEWS_B));
    expect(current!.meta.allTimeSummary).toBeUndefined();
    expect(current!.meta.rollingKpis).toBeUndefined();

    // A version-checked update based on the current reviews content succeeds.
    const valid: DatasetMeta = {
      ...secondMeta,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: KPI_WINDOWS,
      aggregatesComputedAt: '2026-02-01T00:00:00.000Z',
    };
    const committed = await updateDatasetMeta(dataDir, valid);
    expect(committed?.allTimeSummary?.total).toBe(1000);
    expect((await readDataset(dataDir, APPID, reviewsHash))?.meta.aggregatesComputedAt).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('leaves the previous committed version intact when a write fails midway', async () => {
    const dataDir = tmpDir();
    const reviewsHash = hashFor();
    const first = await writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_A);
    const metaPath = metaFilePath(dataDir, APPID, reviewsHash);
    const metaBefore = fs.readFileSync(metaPath, 'utf8');

    setDatasetWriteHookForTests(() => {
      throw new Error('simulated crash after reviews write');
    });
    await expect(writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_B)).rejects.toThrow('simulated crash');
    setDatasetWriteHookForTests(null);

    const loaded = await readDataset(dataDir, APPID, reviewsHash);
    expect(loaded?.status).toBe('complete');
    expect(loaded!.reviews.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(loaded!.meta.reviewsContentHash).toBe(first.reviewsContentHash);
    expect(loaded!.meta.reviewCount).toBe(3);
    // meta.json was never replaced by the failed attempt.
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(metaBefore);
    const rawMeta = await readJsonFile<DatasetMeta>(metaPath);
    expect(rawMeta.reviewsContentHash).toBe(contentHash(REVIEWS_A));
  });
});

describe('unified storage lock coordination', () => {
  it('serializes dataset deletion before a queued report commit and refuses resurrection', async () => {
    const dataDir = tmpDir();
    const reviewsHash = hashFor();
    await writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_A);
    const epoch = await captureStorageEpoch(dataDir);

    const entered = deferred();
    const release = deferred();
    let paused = false;
    setStorageMutationHookForTests(async (info) => {
      if (!paused && info.operation === 'deleteDataset') {
        paused = true;
        entered.resolve();
        await release.promise;
      }
    });

    const deletion = deleteDataset(dataDir, APPID, reviewsHash);
    await entered.promise;
    // Queued behind the deletion on the same root lock.
    const reportWrite = saveReport(dataDir, APPID, REPORT_HASH, reportFor(reviewsHash), { epoch });
    await sleep(10);
    release.resolve();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    // The dataset is gone, so the job's report write must be cancelled rather
    // than recreating reports (and a later title cleanup) for deleted data.
    await expect(reportWrite).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fs.existsSync(reportFilePaths(dataDir, APPID, REPORT_HASH).json)).toBe(false);
    expect(fs.existsSync(reportFilePaths(dataDir, APPID, REPORT_HASH).md)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, String(APPID), 'reviews'))).toBe(false);
  });

  it('invalidates a queued job write when clear-all bumps the storage epoch first', async () => {
    const dataDir = tmpDir();
    const reviewsHash = hashFor();
    await writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_A);
    // clearDataDir only operates on a marked GReview directory.
    await ensureDataDir(dataDir);
    const epoch = await captureStorageEpoch(dataDir);

    const entered = deferred();
    const release = deferred();
    let paused = false;
    setStorageMutationHookForTests(async (info) => {
      if (!paused && info.operation === 'clearDataDir') {
        paused = true;
        entered.resolve();
        await release.promise;
      }
    });

    const clearing = clearDataDir(dataDir);
    await entered.promise;
    const reportWrite = saveReport(dataDir, APPID, REPORT_HASH, reportFor(reviewsHash), { epoch });
    await sleep(10);
    release.resolve();

    await expect(clearing).resolves.toBe(1);
    await expect(reportWrite).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fs.existsSync(path.join(dataDir, String(APPID)))).toBe(false);
    expect(fs.existsSync(reportFilePaths(dataDir, APPID, REPORT_HASH).json)).toBe(false);
  });

  it('serializes a title update with a queued metadata refresh without losing either write', async () => {
    const dataDir = tmpDir();
    const reviewsHash = hashFor();
    const baseMeta = await writeDataset(dataDir, metaFor(reviewsHash), REVIEWS_A);

    const entered = deferred();
    const release = deferred();
    let paused = false;
    setStorageMutationHookForTests(async (info) => {
      if (!paused && info.operation === 'updateGameTitle') {
        paused = true;
        entered.resolve();
        await release.promise;
      }
    });

    const titleUpdate = updateGameTitle(dataDir, APPID, '并发标题', 0);
    await entered.promise;
    const nextMeta: DatasetMeta = {
      ...baseMeta,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: KPI_WINDOWS,
      aggregatesComputedAt: '2026-02-01T00:00:00.000Z',
    };
    const metaUpdate = updateDatasetMeta(dataDir, nextMeta);
    await sleep(10);
    release.resolve();

    const titleOutcome = await titleUpdate;
    expect(titleOutcome.status).toBe('ok');
    if (titleOutcome.status !== 'ok') throw new Error('title update failed');
    expect(titleOutcome.revision).toBe(1);
    const committed = await metaUpdate;
    expect(committed?.allTimeSummary?.total).toBe(1000);
    expect(committed?.rollingKpis?.last30d.total).toBe(300);

    const titleState = await readTitleOverride(dataDir, APPID);
    expect(titleState.status).toBe('ok');
    if (titleState.status !== 'ok') throw new Error('expected stored title');
    expect(titleState.title.customTitle).toBe('并发标题');
    const loaded = await readDataset(dataDir, APPID, reviewsHash);
    expect(loaded?.status).toBe('complete');
    expect(loaded!.meta.rollingKpis?.last90d.total).toBe(600);
    expect(loaded!.reviews.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });
});
