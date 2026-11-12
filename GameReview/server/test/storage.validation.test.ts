import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../src/lib/hash';
import { readJsonFile } from '../src/lib/fs';
import {
  buildReviewsHash,
  latestDataset,
  listDatasets,
  metaFilePath,
  readDataset,
  readTrend,
  saveTrend,
  trendsDir,
  writeDataset,
} from '../src/storage/dataset';
import { readReport, readServedReport, reportFilePaths, saveReport } from '../src/storage/report';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { DatasetMeta, Report, TrendDataset, TrendPoint } from '../src/types';
import { SAMPLE_REVIEWS, SAMPLE_SUMMARY } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-validation-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HASH = 'a'.repeat(16);

function datasetMetaFor(appid: number, reviewsHash: string): Parameters<typeof writeDataset>[1] {
  return {
    appid,
    game: { appid, name: 'Test Game' },
    reviewsHash,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    maxReviews: 200,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    sourceEndpoint: 'official',
    summary: SAMPLE_SUMMARY,
  };
}

const TREND_POINTS: TrendPoint[] = [
  { period: '2025-12', total: 10, positive: 9, negative: 1, positiveRate: 0.9 },
];

function trendFor(points: TrendPoint[] = TREND_POINTS): TrendDataset {
  return {
    granularity: 'month',
    source: 'official_aggregate',
    points,
    coverage: { start: '2025-01', end: '2025-12', note: '' },
    timezone: 'Asia/Shanghai',
    sourceEndpoint: 'official',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    trendHash: HASH,
    trendContentHash: contentHash(points),
  };
}

function reportFor(reviewsHash = 'c'.repeat(16)): Report {
  return {
    version: '1.0',
    generatedAt: '2026-01-02T00:00:00.000Z',
    game: { appid: 570, name: 'Test Game' },
    sample: {
      filters: { ...withFilterDefaults(), ...withClientFilterDefaults() },
      fetched: 3,
      matchedTotal: 1000,
      usedForAI: 3,
      languages: ['schinese', 'english'],
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

describe('runtime validation of persisted metadata, trends and reports', () => {
  it('marks a dataset with structurally invalid rolling KPI metadata as corrupted', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash({
      appid: 570,
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 200,
    });
    await writeDataset(dataDir, datasetMetaFor(570, reviewsHash), SAMPLE_REVIEWS);
    const metaPath = metaFilePath(dataDir, 570, reviewsHash);
    const meta = await readJsonFile<DatasetMeta>(metaPath);

    // `rollingKpis: {}` must not pass as a complete aggregate snapshot.
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, rollingKpis: {} }), 'utf8');
    const loaded = await readDataset(dataDir, 570, reviewsHash);
    expect(loaded?.status).toBe('corrupted');
    expect(loaded?.reviews).toEqual([]);
    expect(await latestDataset(dataDir, 570)).toBeNull();
    const listed = await listDatasets(dataDir);
    expect(listed[0]).toMatchObject({ status: '损坏', reviewsHash });

    // Aggregates without their computation time are equally unusable.
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        ...meta,
        rollingKpis: {
          last30d: { total: 10, positive: 9, negative: 1, positiveRate: 0.9 },
          last90d: { total: 10, positive: 9, negative: 1, positiveRate: 0.9 },
          source: 'official_aggregate',
          sources: { last30d: 'official_aggregate', last90d: 'official_aggregate' },
        },
        aggregatesComputedAt: undefined,
      }),
      'utf8',
    );
    expect((await readDataset(dataDir, 570, reviewsHash))?.status).toBe('corrupted');
  });

  it('marks a dataset whose review count disagrees with its metadata as corrupted', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash({
      appid: 570,
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 200,
    });
    await writeDataset(dataDir, datasetMetaFor(570, reviewsHash), SAMPLE_REVIEWS);
    const metaPath = metaFilePath(dataDir, 570, reviewsHash);
    const meta = await readJsonFile<DatasetMeta>(metaPath);
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, reviewCount: meta.reviewCount + 1 }), 'utf8');
    expect((await readDataset(dataDir, 570, reviewsHash))?.status).toBe('corrupted');
  });

  it('rejects trends without a content hash or with inconsistent numbers', async () => {
    const dataDir = tmpDir();
    await saveTrend(dataDir, 570, trendFor());
    expect((await readTrend(dataDir, 570, HASH))?.trendHash).toBe(HASH);

    // Missing content hash: the old file shape must never be treated as usable.
    const trendPath = path.join(trendsDir(dataDir, 570), `${HASH}.json`);
    const valid = trendFor();
    const withoutContentHash: Record<string, unknown> = { ...valid };
    delete withoutContentHash.trendContentHash;
    fs.writeFileSync(trendPath, JSON.stringify(withoutContentHash), 'utf8');
    expect(await readTrend(dataDir, 570, HASH)).toBeNull();

    // Numerically inconsistent point with a matching content hash.
    const brokenPoints = [{ period: '2025-12', total: 10, positive: 9, negative: 5, positiveRate: 0.9 }];
    fs.writeFileSync(
      trendPath,
      JSON.stringify({ ...valid, points: brokenPoints, trendContentHash: contentHash(brokenPoints) }),
      'utf8',
    );
    expect(await readTrend(dataDir, 570, HASH)).toBeNull();

    // Missing required coverage/timezone fields.
    fs.writeFileSync(
      trendPath,
      JSON.stringify({ ...valid, coverage: undefined, fetchedAt: 'not-a-date' }),
      'utf8',
    );
    expect(await readTrend(dataDir, 570, HASH)).toBeNull();

    // Corrupted trend files must be skipped by listings, not throw.
    expect(await listDatasets(dataDir)).toEqual([]);
  });

  it('refuses an incomplete or numerically unsafe report on read', async () => {
    const dataDir = tmpDir();
    const emptyReport = { version: '1.0', conclusion: {} };
    fs.mkdirSync(path.dirname(reportFilePaths(dataDir, 570, HASH).json), { recursive: true });
    fs.writeFileSync(reportFilePaths(dataDir, 570, HASH).json, JSON.stringify(emptyReport), 'utf8');
    expect(await readReport(dataDir, 570, HASH)).toBeNull();
    // A corrupt report is a 500-class failure on the serving path, not 404.
    await expect(readServedReport(dataDir, 570, HASH, 10)).rejects.toMatchObject({ code: 'INTERNAL' });

    // A structurally complete report whose caveat reuses a KPI value for the
    // wrong window must not be served either.
    const unsafe = reportFor();
    await saveReport(dataDir, 570, HASH, unsafe);
    expect(await readReport(dataDir, 570, HASH)).not.toBeNull();
    const raw = await readJsonFile<Report>(reportFilePaths(dataDir, 570, HASH).json);
    raw.conclusion.caveats = ['最近 30 天好评率 99%。'];
    fs.writeFileSync(reportFilePaths(dataDir, 570, HASH).json, JSON.stringify(raw), 'utf8');
    expect(await readReport(dataDir, 570, HASH)).toBeNull();
  });
});
