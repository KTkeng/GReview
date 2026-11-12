import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { contentHash } from '../src/lib/hash';
import { readJsonFile } from '../src/lib/fs';
import { resolveDataDir, ensureDataDir } from '../src/storage/paths';
import {
  buildReviewsHash,
  writeDataset,
  writeGameMeta,
  readDataset,
  updateDatasetMeta,
  deleteDataset,
  listDatasets,
  getDatasetDetail,
  latestDataset,
  saveTrend,
  readTrend,
  clearDataDir,
  reviewsFilePath,
  reviewsDir,
  reportsDir,
  type ReviewsHashInput,
} from '../src/storage/dataset';
import {
  buildAnalysisHash,
  saveReport,
  readReport,
  readServedReport,
  rebuildTopReviewsFromDataset,
  reportFilePaths,
} from '../src/storage/report';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { DatasetMeta, Report, Review, TrendDataset } from '../src/types';
import { SAMPLE_REVIEWS, SAMPLE_SUMMARY, makeReview } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(prefix = 'greview-storage-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Create a directory symlink/junction; junctions are the Windows fallback. */
function makeDirLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Known platform/permission restrictions on link creation. Only these may turn
 * a symlink security test into an explicit skip; every other error must fail
 * the test (review Major 10). Linux CI (ubuntu-latest) can create both kinds.
 */
const KNOWN_LINK_RESTRICTIONS = new Set([
  'EPERM',
  'EACCES',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EINVAL',
  'UNKNOWN',
]);

function isKnownLinkRestriction(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && KNOWN_LINK_RESTRICTIONS.has(code);
}

/** @returns true when created, false only for a known restriction. */
function tryCreateDirLink(target: string, link: string): boolean {
  const types: Array<'junction' | 'dir'> = process.platform === 'win32' ? ['junction', 'dir'] : ['dir'];
  for (const type of types) {
    try {
      fs.symlinkSync(target, link, type);
      return true;
    } catch (err) {
      if (!isKnownLinkRestriction(err)) throw err;
    }
  }
  return false;
}

/** @returns true when created, false only for a known restriction. */
function tryCreateFileLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (err) {
    if (!isKnownLinkRestriction(err)) throw err;
    return false;
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HASH_A = 'a'.repeat(16);
const HASH_B = 'b'.repeat(16);

function datasetInput(overrides: Partial<ReviewsHashInput> = {}): ReviewsHashInput {
  return {
    appid: 570,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    maxReviews: 200,
    ...overrides,
  };
}

function metaFor(appid: number, reviewsHash: string): Omit<DatasetMeta, 'reviewsContentHash' | 'reviewCount' | 'status'> {
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

function reportFor(reviewsHash: string, topReviews: Report['topReviews'] = []): Report {
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
    topReviews,
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

describe('data directory validation', () => {
  it('rejects relative paths, traversal, protected segments and roots', () => {
    const projectRoot = path.join(tmpDir(), 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    expect(() => resolveDataDir('data', { projectRoot })).toThrow('DATA_DIR_NOT_ABSOLUTE');
    expect(() =>
      resolveDataDir(`${projectRoot}${path.sep}..${path.sep}..${path.sep}escape`, { projectRoot }),
    ).toThrow('DATA_DIR_INVALID');
    expect(() => resolveDataDir(path.join(projectRoot, 'node_modules', 'data'), { projectRoot })).toThrow(
      'DATA_DIR_FORBIDDEN',
    );
    expect(() => resolveDataDir(path.join(projectRoot, 'server', 'src', 'data'), { projectRoot })).toThrow(
      'DATA_DIR_FORBIDDEN',
    );
    expect(() => resolveDataDir(path.join(projectRoot, 'web', 'src'), { projectRoot })).toThrow('DATA_DIR_FORBIDDEN');
    expect(() => resolveDataDir(projectRoot, { projectRoot })).toThrow('DATA_DIR_FORBIDDEN');
    expect(() => resolveDataDir(path.parse(projectRoot).root, { projectRoot })).toThrow('DATA_DIR_FORBIDDEN');
  });

  it('defaults to <projectRoot>/data and allows safe custom directories', async () => {
    const projectRoot = path.join(tmpDir(), 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    expect(resolveDataDir(undefined, { projectRoot })).toBe(path.resolve(projectRoot, 'data'));

    const custom = path.join(projectRoot, 'custom-data');
    const created = await ensureDataDir(custom, { projectRoot });
    expect(created).toBe(path.resolve(custom));
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(fs.readdirSync(created)).toEqual(['.greview-data.json']);
    const marker = JSON.parse(fs.readFileSync(path.join(created, '.greview-data.json'), 'utf8'));
    expect(marker).toMatchObject({ app: 'greview', version: 1 });
    expect(typeof marker.createdAt).toBe('string');
  });

  it('reports AppError codes', () => {
    try {
      resolveDataDir('relative');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('DATA_DIR_NOT_ABSOLUTE');
      expect((err as AppError).status).toBe(400);
    }
  });
});

describe('data directory marker and deletion safety', () => {
  it('refuses to adopt or clear an ordinary directory', async () => {
    const projectRoot = tmpDir('greview-data-root-');
    const ordinary = path.join(projectRoot, 'my-stuff');
    fs.mkdirSync(ordinary, { recursive: true });
    fs.writeFileSync(path.join(ordinary, 'important.txt'), 'keep me');

    await expect(ensureDataDir(ordinary, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(path.join(ordinary, 'important.txt'), 'utf8')).toBe('keep me');

    await expect(clearDataDir(ordinary, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(path.join(ordinary, 'important.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(ordinary, '.greview-data.json'))).toBe(false);
  });

  it('adopts legacy numeric app directories only when they are GReview-shaped', async () => {
    const projectRoot = tmpDir('greview-legacy-root-');
    const legacy = path.join(projectRoot, 'legacy-data');
    fs.mkdirSync(path.join(legacy, '570', 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(legacy, '570', 'game.json'), '{"appid":570,"name":"Legacy"}');
    const created = await ensureDataDir(legacy, { projectRoot });
    expect(created).toBe(path.resolve(legacy));
    expect(fs.existsSync(path.join(legacy, '.greview-data.json'))).toBe(true);

    const impostor = path.join(projectRoot, 'impostor-data');
    fs.mkdirSync(path.join(impostor, '570'), { recursive: true });
    fs.writeFileSync(path.join(impostor, '570', 'notes.txt'), 'not greview');
    await expect(ensureDataDir(impostor, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(path.join(impostor, '570', 'notes.txt'), 'utf8')).toBe('not greview');
  });

  it('clears only marked GReview app directories and keeps the marker', async () => {
    const projectRoot = tmpDir('greview-clear-root-');
    const dataDir = await ensureDataDir(path.join(projectRoot, 'data'), { projectRoot });
    fs.mkdirSync(path.join(dataDir, '570', 'reviews', HASH_A), { recursive: true });
    fs.writeFileSync(path.join(dataDir, '570', 'reviews', HASH_A, 'reviews.json'), '[]');

    expect(await clearDataDir(dataDir, { projectRoot })).toBe(1);
    expect(fs.readdirSync(dataDir)).toEqual(['.greview-data.json']);

    // A non-GReview entry blocks the whole clear operation before anything is
    // deleted, even when a marker exists.
    fs.mkdirSync(path.join(dataDir, '570'));
    fs.writeFileSync(path.join(dataDir, 'README.txt'), 'not ours');
    await expect(clearDataDir(dataDir, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.existsSync(path.join(dataDir, '570'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'README.txt'), 'utf8')).toBe('not ours');
  });

  it('rejects symlink/junction aliases and re-checks resolved paths before deletion', async (ctx) => {
    const projectRoot = tmpDir('greview-link-root-');
    const sourceDir = path.join(projectRoot, 'server', 'src');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'source');

    const link = path.join(projectRoot, 'data-link');
    if (!tryCreateDirLink(sourceDir, link)) {
      // Known platform/permission restriction: only this explicit skip is allowed.
      ctx.skip();
      return;
    }
    await expect(ensureDataDir(link, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(path.join(sourceDir, 'index.ts'), 'utf8')).toBe('source');

    // A junction inside a valid data dir must not let deletion escape it.
    const dataDir = await ensureDataDir(path.join(projectRoot, 'data'), { projectRoot });
    const outside = tmpDir('greview-outside-');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(dataDir, '570', 'reviews'), { recursive: true });
    const victim = path.join(dataDir, '570', 'reviews', HASH_A);
    if (!tryCreateDirLink(outside, victim)) {
      // Known platform/permission restriction: only this explicit skip is allowed.
      ctx.skip();
      return;
    }
    await expect(deleteDataset(dataDir, 570, HASH_A, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');

    const dataDir2 = await ensureDataDir(path.join(projectRoot, 'data2'), { projectRoot });
    const escape = path.join(dataDir2, '570');
    if (!tryCreateDirLink(outside, escape)) {
      // Known platform/permission restriction: only this explicit skip is allowed.
      ctx.skip();
      return;
    }
    await expect(clearDataDir(dataDir2, { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('validates the deepest existing ancestor before creating directories or probe files', async (ctx) => {
    const projectRoot = tmpDir('greview-probe-root-');
    const sourceDir = path.join(projectRoot, 'server', 'src');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'source');
    const link = path.join(projectRoot, 'data-link');
    if (!tryCreateDirLink(sourceDir, link)) {
      // Known platform/permission restriction: only this explicit skip is allowed.
      ctx.skip();
      return;
    }

    const entriesBefore = fs.readdirSync(sourceDir).sort();
    // The literal path contains no protected segment, but its deepest existing
    // ancestor is a junction into server/src. Validation must run before mkdir,
    // so neither `generated`, `child`, a marker nor a .tmp probe may appear.
    await expect(ensureDataDir(path.join(link, 'generated', 'child'), { projectRoot })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readdirSync(sourceDir).sort()).toEqual(entriesBefore);
    expect(fs.existsSync(path.join(sourceDir, 'generated'))).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, '.greview-data.json'))).toBe(false);
  });
});

describe('content hashes', () => {
  it('is stable for identical inputs and changes when fetch configuration changes', () => {
    const base = buildReviewsHash(datasetInput());
    expect(base).toMatch(/^[a-f0-9]{16}$/);
    expect(buildReviewsHash(datasetInput())).toBe(base);
    expect(buildReviewsHash(datasetInput({ maxReviews: 100 }))).not.toBe(base);
    expect(buildReviewsHash(datasetInput({ filters: withFilterDefaults({ sort: 'recent' }) }))).not.toBe(base);
    expect(
      buildReviewsHash(datasetInput({ clientFilters: withClientFilterDefaults({ minVotes: 10 }) })),
    ).not.toBe(base);
    expect(buildReviewsHash(datasetInput({ appid: 730 }))).not.toBe(base);
  });

  it('analysis hash covers AI configuration but not Top N', () => {
    const input = {
      reviewsContentHash: 'r'.repeat(16),
      trendContentHash: 't'.repeat(16),
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrlHost: 'api.deepseek.com',
      promptVersion: 'greview-prompt-v1',
      thinking: true,
      includeTranslations: false,
    };
    const base = buildAnalysisHash(input);
    expect(base).toMatch(/^[a-f0-9]{16}$/);
    expect(buildAnalysisHash({ ...input })).toBe(base);
    expect(buildAnalysisHash({ ...input, thinking: false })).not.toBe(base);
    expect(buildAnalysisHash({ ...input, model: 'deepseek-v4-pro' })).not.toBe(base);
    expect(buildAnalysisHash({ ...input, trendContentHash: 'u'.repeat(16) })).not.toBe(base);
    expect(buildAnalysisHash({ ...input, includeTranslations: true })).not.toBe(base);
    expect(buildAnalysisHash({ ...input, baseUrlHost: 'other.example' })).not.toBe(base);
    // Temperature changes sampling output, so it must change the cache key.
    expect(buildAnalysisHash({ ...input, temperature: 0.7 })).not.toBe(base);
    expect(buildAnalysisHash({ ...input, temperature: 0.7 })).not.toBe(
      buildAnalysisHash({ ...input, temperature: 0.2 }),
    );
    // Presentation-only options are not part of the cache key, even if a caller
    // accidentally passes them through.
    expect(buildAnalysisHash({ ...input, topReviews: 50 } as typeof input)).toBe(base);
  });
});

describe('dataset storage', () => {
  it('writes atomically and reads back a complete dataset', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    const meta = await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);
    expect(meta.status).toBe('complete');
    expect(meta.reviewCount).toBe(3);
    expect(meta.reviewsContentHash).toBe(contentHash(SAMPLE_REVIEWS));
    expect(fs.existsSync(path.join(dataDir, '570', 'game.json'))).toBe(true);

    const loaded = await readDataset(dataDir, 570, reviewsHash);
    expect(loaded?.status).toBe('complete');
    expect(loaded?.reviews.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    const dirEntries = fs.readdirSync(reviewsDir(dataDir, 570, reviewsHash));
    expect(dirEntries.some((f) => f.endsWith('.tmp'))).toBe(false);

    const latest = await latestDataset(dataDir, 570);
    expect(latest?.meta.reviewsHash).toBe(reviewsHash);

    const listed = await listDatasets(dataDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      appid: 570,
      reviewsHash,
      reviewCount: 3,
      status: '完整',
      game: expect.objectContaining({
        appid: 570,
        name: 'Test Game',
        steamName: 'Test Game',
        customTitle: null,
        displayTitle: 'Test Game',
        titleSource: '自动读取',
        titleRevision: 0,
        titleEditable: true,
        coverPlaceholder: 'AppID 570',
      }),
    });
  });

  it('flags corrupted or tampered datasets and never treats them as complete', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);

    fs.writeFileSync(reviewsFilePath(dataDir, 570, reviewsHash), '{not json', 'utf8');
    const broken = await readDataset(dataDir, 570, reviewsHash);
    expect(broken?.status).toBe('corrupted');
    expect(broken?.reviews).toEqual([]);

    const altered: Review[] = [...SAMPLE_REVIEWS, makeReview({ id: 'r4', text: 'injected' })];
    fs.writeFileSync(reviewsFilePath(dataDir, 570, reviewsHash), JSON.stringify(altered), 'utf8');
    const tampered = await readDataset(dataDir, 570, reviewsHash);
    expect(tampered?.status).toBe('corrupted');
    expect(tampered?.reviews).toHaveLength(4);
    expect(await latestDataset(dataDir, 570)).toBeNull();
    const listed = await listDatasets(dataDir);
    expect(listed[0].status).toBe('损坏');
  });

  it('accepts mixed sentiment in a persisted report', async () => {
    const dataDir = tmpDir();
    const report = reportFor(HASH_A);
    report.ai.appealPoints = [
      {
        id: 't1',
        name: '争议主题',
        mentions: 1,
        summary: '玩家评价褒贬不一',
        evidenceIds: ['r1'],
        quotes: [],
        sentiment: 'mixed',
      },
    ];
    await saveReport(dataDir, 570, HASH_A, report);
    const loaded = await readReport(dataDir, 570, HASH_A);
    expect(loaded?.ai.appealPoints[0].sentiment).toBe('mixed');
  });

  it('deletes a dataset together with reports that reference its content hash', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);
    await saveReport(dataDir, 570, HASH_A, reportFor(reviewsHash));
    await saveReport(dataDir, 570, HASH_B, reportFor('f'.repeat(16)));

    const result = await deleteDataset(dataDir, 570, reviewsHash);
    expect(result).toEqual({ deleted: true, reportsDeleted: 1 });
    expect(fs.existsSync(reviewsDir(dataDir, 570, reviewsHash))).toBe(false);
    expect(fs.existsSync(reportFilePaths(dataDir, 570, HASH_A).json)).toBe(false);
    expect(fs.existsSync(reportFilePaths(dataDir, 570, HASH_A).md)).toBe(false);
    expect(fs.existsSync(reportFilePaths(dataDir, 570, HASH_B).json)).toBe(true);

    await expect(deleteDataset(dataDir, 570, reviewsHash)).rejects.toThrow('NOT_FOUND');
  });

  it('describes a dataset with trend and report metadata', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);
    const trend: TrendDataset = {
      granularity: 'month',
      source: 'official_aggregate',
      points: [
        { period: '2025-12', total: 10, positive: 9, negative: 1, positiveRate: 0.9 },
      ],
      coverage: { start: '2025-01', end: '2025-12', note: 'ok' },
      timezone: 'Asia/Shanghai',
      sourceEndpoint: 'official',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      trendHash: HASH_A,
      trendContentHash: contentHash([{ period: '2025-12', total: 10, positive: 9, negative: 1, positiveRate: 0.9 }]),
    };
    await saveTrend(dataDir, 570, trend);
    await saveReport(dataDir, 570, HASH_B, reportFor(reviewsHash));

    const detail = await getDatasetDetail(dataDir, 570, reviewsHash);
    expect(detail?.reviewCount).toBe(3);
    expect(detail?.trends[0]).toMatchObject({ trendHash: HASH_A, points: 1 });
    expect(detail?.reports.map((r) => r.analysisHash)).toEqual([HASH_B]);
    expect(detail?.status).toBe('完整');
  });
});

describe('trend and report storage', () => {
  it('rejects a trend whose content hash no longer matches', async () => {
    const dataDir = tmpDir();
    const points = [{ period: '2025-12', total: 10, positive: 9, negative: 1, positiveRate: 0.9 }];
    const trend: TrendDataset = {
      granularity: 'month',
      source: 'official_aggregate',
      points,
      coverage: { start: '2025-01', end: '2025-12', note: '' },
      timezone: 'Asia/Shanghai',
      sourceEndpoint: 'official',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      trendHash: HASH_A,
      trendContentHash: contentHash(points),
    };
    await saveTrend(dataDir, 570, trend);
    expect((await readTrend(dataDir, 570, HASH_A))?.trendHash).toBe(HASH_A);
    expect(await readTrend(dataDir, 570, HASH_A, { timezone: 'Asia/Shanghai' })).not.toBeNull();
    // Month boundaries depend on the timezone: never reuse across zones.
    expect(await readTrend(dataDir, 570, HASH_A, { timezone: 'UTC' })).toBeNull();

    fs.writeFileSync(
      path.join(dataDir, '570', 'trends', `${HASH_A}.json`),
      JSON.stringify({ ...trend, points: [...points, { period: '2026-01', total: 5, positive: 2, negative: 3, positiveRate: 0.4 }] }),
      'utf8',
    );
    expect(await readTrend(dataDir, 570, HASH_A)).toBeNull();
    expect(await readTrend(dataDir, 570, '../escape')).toBeNull();
  });

  it('serves a stored report with Top N rebuilt in memory only', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);
    await saveReport(dataDir, 570, HASH_A, reportFor(reviewsHash, []));

    const rawBefore = await readJsonFile<Report>(reportFilePaths(dataDir, 570, HASH_A).json);
    expect(rawBefore.topReviews).toEqual([]);

    const served = await readServedReport(dataDir, 570, HASH_A, 2);
    expect(served?.topReviews.map((r) => r.reviewId)).toEqual(['r1', 'r2']);
    expect(served?.methodology.analysisSource).toBe('local_report');
    expect(served?.methodology.servedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(served?.methodology.reviewsHash).toBe(reviewsHash);

    const rawAfter = await readJsonFile<Report>(reportFilePaths(dataDir, 570, HASH_A).json);
    expect(rawAfter.topReviews).toEqual([]);
    const rebuilt = await rebuildTopReviewsFromDataset(dataDir, 570, reviewsHash, 1);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].reviewId).toBe('r1');
    expect(rebuilt[0].playtimeHours).toBe(2);
    expect(fs.existsSync(reportFilePaths(dataDir, 570, HASH_A).md)).toBe(true);
    expect(await readReport(dataDir, 570, 'invalid-hash')).toBeNull();
  });
});

describe('write path safety', () => {
  it('rejects a linked app directory before writing game metadata', async () => {
    const dataDir = tmpDir();
    const outside = tmpDir();
    makeDirLink(outside, path.join(dataDir, '570'));
    await expect(writeGameMeta(dataDir, { appid: 570, name: 'Test Game' })).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a linked reviews directory before writing a dataset', async () => {
    const dataDir = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(dataDir, '570'), { recursive: true });
    makeDirLink(outside, path.join(dataDir, '570', 'reviews'));
    await expect(writeDataset(dataDir, metaFor(570, HASH_A), SAMPLE_REVIEWS)).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readdirSync(outside)).toEqual([]);
    // game.json was written to the real app dir before the linked level was hit.
    expect(fs.existsSync(path.join(dataDir, '570', 'game.json'))).toBe(true);
  });

  it('rejects a linked dataset hash directory before updating metadata', async () => {
    const dataDir = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(dataDir, '570', 'reviews'), { recursive: true });
    makeDirLink(outside, path.join(dataDir, '570', 'reviews', HASH_A));
    const meta: DatasetMeta = {
      ...metaFor(570, HASH_A),
      reviewsContentHash: contentHash(SAMPLE_REVIEWS),
      reviewCount: SAMPLE_REVIEWS.length,
      status: 'complete',
    };
    await expect(updateDatasetMeta(dataDir, meta)).rejects.toMatchObject({ code: 'DATA_DIR_FORBIDDEN' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a linked trends directory before writing a trend', async () => {
    const dataDir = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(dataDir, '570'), { recursive: true });
    makeDirLink(outside, path.join(dataDir, '570', 'trends'));
    const points = [{ period: '2025-12', total: 10, positive: 9, negative: 1, positiveRate: 0.9 }];
    const trend: TrendDataset = {
      granularity: 'month',
      source: 'official_aggregate',
      points,
      coverage: { start: '2025-01', end: '2025-12', note: '' },
      timezone: 'Asia/Shanghai',
      sourceEndpoint: 'official',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      trendHash: HASH_A,
      trendContentHash: contentHash(points),
    };
    await expect(saveTrend(dataDir, 570, trend)).rejects.toMatchObject({ code: 'DATA_DIR_FORBIDDEN' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a linked reports directory before writing a report', async () => {
    const dataDir = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(dataDir, '570'), { recursive: true });
    makeDirLink(outside, path.join(dataDir, '570', 'reports'));
    await expect(saveReport(dataDir, 570, HASH_A, reportFor('c'.repeat(16)))).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to delete reports through a linked reports directory', async () => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);

    const outside = tmpDir();
    const externalReport = path.join(outside, `${HASH_A}.json`);
    fs.writeFileSync(
      externalReport,
      JSON.stringify({ version: '1.0', conclusion: {}, methodology: { reviewsHash } }),
      'utf8',
    );
    makeDirLink(outside, path.join(dataDir, '570', 'reports'));

    // deleteDataset must validate the reports directory itself, not only the
    // reviews directory: following a reports junction would delete external JSON.
    await expect(deleteDataset(dataDir, 570, reviewsHash)).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.readFileSync(externalReport, 'utf8')).toContain('reviewsHash');
    // The dataset is left intact because deletion aborted before any rm.
    expect(fs.existsSync(reviewsDir(dataDir, 570, reviewsHash))).toBe(true);
  });

  it('refuses to delete a report file that is a symlink pointing outside', async (ctx) => {
    const dataDir = tmpDir();
    const reviewsHash = buildReviewsHash(datasetInput());
    await writeDataset(dataDir, metaFor(570, reviewsHash), SAMPLE_REVIEWS);
    const reports = path.join(dataDir, '570', 'reports');
    fs.mkdirSync(reports, { recursive: true });

    const outside = tmpDir();
    const externalReport = path.join(outside, `${HASH_A}.json`);
    fs.writeFileSync(
      externalReport,
      JSON.stringify({ version: '1.0', conclusion: {}, methodology: { reviewsHash } }),
      'utf8',
    );
    if (!tryCreateFileLink(externalReport, path.join(reports, `${HASH_A}.json`))) {
      // Explicit skip only for a known platform restriction (Windows file
      // symlinks need SeCreateSymbolicLinkPrivilege; some CI filesystems forbid
      // them). Any other creation error is rethrown by tryCreateFileLink.
      // Known platform/permission restriction: only this explicit skip is allowed.
      ctx.skip();
      return;
    }

    await expect(deleteDataset(dataDir, 570, reviewsHash)).rejects.toMatchObject({
      code: 'DATA_DIR_FORBIDDEN',
    });
    expect(fs.existsSync(externalReport)).toBe(true);
    expect(fs.existsSync(reviewsDir(dataDir, 570, reviewsHash))).toBe(true);
  });
});
