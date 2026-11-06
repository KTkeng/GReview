import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../src/lib/hash';
import { readJsonFile } from '../src/lib/fs';
import {
  buildReviewsHash,
  metaFilePath,
  readDataset,
  setDatasetWriteHookForTests,
  updateDatasetMeta,
  writeDataset,
} from '../src/storage/dataset';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { DatasetMeta, KpiWindows, Review } from '../src/types';
import { SAMPLE_REVIEWS, SAMPLE_SUMMARY, makeReview } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-concurrency-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setDatasetWriteHookForTests(null);
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
    // The queued operations run in call order: second write then read.
    expect(loaded!.reviews.map((r) => r.id)).toEqual(['b1', 'b2']);
    expect(loaded!.meta.reviewsContentHash).toBe(contentHash(loaded!.reviews));
    expect(loaded!.meta.reviewCount).toBe(loaded!.reviews.length);
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
