import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReport, refreshReport, type BuildReportInput } from '../src/analysis/report';
import { validateEvidence } from '../src/analysis/evidence';
import { reportToMarkdown } from '../src/storage/markdown';
import { readReport, readServedReport, reportFilePaths, saveReport } from '../src/storage/report';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { ClientFilters, Report, ScrapeFilters, TrendDataset } from '../src/types';
import { SAMPLE_ANALYSIS, SAMPLE_REVIEWS, SAMPLE_SUMMARY } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-caveats-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TREND: TrendDataset = {
  granularity: 'month',
  source: 'official_aggregate',
  points: [
    { period: '2025-11', total: 100, positive: 80, negative: 20, positiveRate: 0.8 },
    { period: '2025-12', total: 100, positive: 85, negative: 15, positiveRate: 0.85 },
    { period: '2026-01', total: 100, positive: 95, negative: 5, positiveRate: 0.95 },
  ],
  coverage: { start: '2025-11', end: '2026-01', note: 'official' },
  timezone: 'Asia/Shanghai',
  sourceEndpoint: 'official',
  fetchedAt: '2026-01-05T00:00:00.000Z',
  trendHash: 'a'.repeat(16),
  trendContentHash: 'b'.repeat(16),
};

const AI_OPTIONS = { model: 'deepseek-flash', thinking: true };

const ROLLING = {
  last30d: { total: 300, positive: 240, negative: 60, positiveRate: 0.8 },
  last90d: { total: 600, positive: 420, negative: 180, positiveRate: 0.7 },
  source: 'official_aggregate' as const,
  sources: { last30d: 'official_aggregate' as const, last90d: 'official_aggregate' as const },
};

function input(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    game: { appid: 570, name: 'Test Game' },
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    reviews: SAMPLE_REVIEWS,
    usedForAI: 3,
    trend: TREND,
    summary: SAMPLE_SUMMARY,
    allTimeSummary: SAMPLE_SUMMARY,
    rollingKpis: ROLLING,
    analysis: validateEvidence(SAMPLE_ANALYSIS, SAMPLE_REVIEWS),
    usage: { input: 100, output: 50 },
    aiOptions: AI_OPTIONS,
    includeTranslations: false,
    topReviews: 2,
    methodology: {
      dataSource: 'fresh',
      trendSource: 'official_aggregate',
      analysisSource: 'fresh',
      dataDir: '/tmp/data',
      datasetFetchedAt: '2026-01-05T00:00:00.000Z',
      aggregatesComputedAt: '2026-01-05T00:00:00.000Z',
      reviewsHash: 'c'.repeat(16),
      trendHash: 'd'.repeat(16),
      steamRequests: 12,
      cacheHits: 1,
    },
    now: new Date('2026-01-06T00:00:00.000Z'),
    ...overrides,
  };
}

function analysisWithCaveats(caveats: string[]) {
  return validateEvidence(
    {
      ...SAMPLE_ANALYSIS,
      conclusion: { ...SAMPLE_ANALYSIS.conclusion, caveats },
    },
    SAMPLE_REVIEWS,
  );
}

describe('AI caveats are public report content and are validated before storage', () => {
  it('keeps only verifiable AI caveat sentences in report JSON and Markdown', () => {
    const report = buildReport(
      input({
        analysis: analysisWithCaveats([
          '全部时间好评率 90.0%。样本涵盖 99.9% 的玩家。',
          '最近 30 天好评率 90%。',
          '销量增长',
          '全部时间共 900 条好评',
        ]),
      }),
    );

    expect(report.conclusion.aiCaveats).toEqual(['全部时间好评率 90.0%。', '全部时间共 900 条好评']);
    expect(report.conclusion.caveats).toContain('AI 附加局限中的无法核实内容已被删除。');
    const publicJson = JSON.stringify(report);
    expect(publicJson).not.toContain('99.9');
    expect(publicJson).not.toContain('销量增长');
    expect(publicJson).not.toContain('最近 30 天好评率 90%');

    const markdown = reportToMarkdown(report);
    expect(markdown).not.toContain('99.9');
    expect(markdown).not.toContain('销量增长');
    expect(markdown).not.toContain('最近 30 天好评率 90%');
    expect(markdown).toContain('全部时间好评率 90.0%。');
  });

  it('refuses to persist a report whose AI caveats are still unsafe', async () => {
    const dataDir = tmpDir();
    const report = buildReport(input());
    report.conclusion.aiCaveats = ['销量增长', '样本涵盖 99.9% 的玩家。'];
    await expect(saveReport(dataDir, 570, 'a'.repeat(16), report)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(fs.existsSync(reportFilePaths(dataDir, 570, 'a'.repeat(16)).json)).toBe(false);
    expect(fs.existsSync(reportFilePaths(dataDir, 570, 'a'.repeat(16)).md)).toBe(false);
  });

  it('does not reuse a legacy report with raw unsafe AI caveats', async () => {
    const dataDir = tmpDir();
    const report = buildReport(input());
    await saveReport(dataDir, 570, 'a'.repeat(16), report);
    expect(await readReport(dataDir, 570, 'a'.repeat(16))).not.toBeNull();

    const file = reportFilePaths(dataDir, 570, 'a'.repeat(16)).json;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Report;
    raw.conclusion.aiCaveats = ['样本涵盖 99.9% 的玩家。'];
    raw.conclusion.caveats = [...raw.conclusion.caveats, '样本涵盖 99.9% 的玩家。'];
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    expect(await readReport(dataDir, 570, 'a'.repeat(16))).toBeNull();
    expect(await readServedReport(dataDir, 570, 'a'.repeat(16), 2)).toBeNull();
  });
});

describe('refreshReport attribution', () => {
  it('adopts the current request/dataset attribution without rewriting the original', () => {
    const original = buildReport(input());
    const before = JSON.stringify(original);
    const filters: ScrapeFilters = withFilterDefaults({
      languages: ['english'],
      reviewType: 'negative',
      purchaseType: 'steam',
      dateRange: { start: 100, end: 200 },
    });
    const clientFilters: ClientFilters = withClientFilterDefaults({
      minVotes: 5,
      excludeFree: true,
    });

    const refreshed = refreshReport(original, {
      reviews: SAMPLE_REVIEWS,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: {
        last30d: { total: 100, positive: 90, negative: 10, positiveRate: 0.9 },
        last90d: { total: 300, positive: 270, negative: 30, positiveRate: 0.9 },
        source: 'official_aggregate',
        sources: { last30d: 'official_aggregate', last90d: 'official_aggregate' },
      },
      trend: { ...TREND, trendHash: 'f'.repeat(16) },
      filters,
      clientFilters,
      sourceEndpoint: 'storefront',
      matchedTotal: 42,
      includeTranslations: true,
      methodology: {
        trendSource: 'local_cache',
        steamRequests: 2,
        cacheHits: 3,
        aggregatesComputedAt: '2026-02-01T00:00:00.000Z',
        dataSource: 'local_dataset',
        dataDir: '/new/data',
        datasetFetchedAt: '2026-01-31T00:00:00.000Z',
        reviewsHash: 'e'.repeat(16),
      },
      now: new Date('2026-02-02T00:00:00.000Z'),
    });

    // The cached AI narrative keeps its original generation time; only the
    // serving metadata records that this response was refreshed.
    expect(refreshed.generatedAt).toBe('2026-01-06T00:00:00.000Z');
    expect(refreshed.methodology.reportGeneratedAt).toBe('2026-01-06T00:00:00.000Z');
    expect(refreshed.methodology.servedAt).toBe('2026-02-02T00:00:00.000Z');
    // The serving layer (`cloneReportWithServed`) marks the clone as replayed;
    // refresh itself only updates the attribution of the underlying analysis.
    expect(refreshed.methodology.analysisSource).toBe('fresh');

    expect(refreshed.sample.filters).toMatchObject({
      languages: ['english'],
      reviewType: 'negative',
      purchaseType: 'steam',
      dateRange: { start: 100, end: 200 },
      minVotes: 5,
      excludeFree: true,
    });
    expect(refreshed.sample.languages).toEqual(['english']);
    expect(refreshed.sample.fetched).toBe(3);
    expect(refreshed.sample.matchedTotal).toBe(42);
    expect(refreshed.sample.sourceEndpoint).toBe('storefront');
    expect(refreshed.methodology).toMatchObject({
      trendHash: 'f'.repeat(16),
      trendSource: 'local_cache',
      dataSource: 'local_dataset',
      dataDir: '/new/data',
      datasetFetchedAt: '2026-01-31T00:00:00.000Z',
      reviewsHash: 'e'.repeat(16),
      aggregatesComputedAt: '2026-02-01T00:00:00.000Z',
      steamRequests: 2,
      cacheHits: 3,
    });
    expect(refreshed.methodology.note).toContain('滚动 KPI 聚合计算于 2026-02-01T00:00:00.000Z');
    expect(refreshed.conclusion.caveats.some((c) => c.includes('AI 翻译'))).toBe(true);
    // Dynamic KPI values are recomputed from the supplied current windows.
    expect(refreshed.kpis.last30d).toMatchObject({ total: 100, positiveRate: 0.9 });
    expect(refreshed.kpis.last90d).toMatchObject({ total: 300, positiveRate: 0.9 });

    // The cached report object itself is never mutated.
    expect(JSON.stringify(original)).toBe(before);
  });

  it('drops unsafe legacy AI caveats during refresh instead of re-serving them', () => {
    const legacy = buildReport(input());
    legacy.conclusion.aiCaveats = [
      '最近 30 天好评率 90%。',
      '销量增长',
      '全部时间好评率 90.0%',
    ];
    const refreshed = refreshReport(legacy, {
      reviews: SAMPLE_REVIEWS,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: ROLLING,
      trend: TREND,
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      sourceEndpoint: 'official',
      matchedTotal: 1000,
      includeTranslations: false,
      methodology: {
        trendSource: 'official_aggregate',
        steamRequests: 0,
        cacheHits: 0,
        aggregatesComputedAt: '2026-01-05T00:00:00.000Z',
        dataSource: 'fresh',
        dataDir: '/tmp/data',
        datasetFetchedAt: '2026-01-05T00:00:00.000Z',
        reviewsHash: 'c'.repeat(16),
      },
      now: new Date('2026-02-02T00:00:00.000Z'),
    });

    expect(refreshed.conclusion.aiCaveats).toEqual(['全部时间好评率 90.0%']);
    expect(refreshed.conclusion.caveats).toContain('AI 附加局限中的无法核实内容已被删除。');
    expect(JSON.stringify(refreshed)).not.toContain('销量增长');
    expect(JSON.stringify(refreshed)).not.toContain('最近 30 天好评率 90%');
  });
});
