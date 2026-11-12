import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, type AIFactory } from '../src/jobs/manager';
import { silentLogger } from '../src/lib/logger';
import { readJsonFile } from '../src/lib/fs';
import { buildReviewsHash, metaFilePath, readDataset, reportsDir } from '../src/storage/dataset';
import { reportFilePaths, readReport } from '../src/storage/report';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { ClientFilters, CreateJobRequest, DatasetMeta, JobSnapshot, ScrapeFilters } from '../src/types';
import { FakeAIProvider, FakeSteam, SAMPLE_ANALYSIS, makeConfig } from './helpers';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-reuse-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const APPID = 570;

interface Harness {
  manager: JobManager;
  steam: FakeSteam;
  ai: FakeAIProvider;
  dataDir: string;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
}

function build(): Harness {
  const dataDir = tmpDir();
  const config = makeConfig(dataDir);
  const steam = new FakeSteam();
  const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
  const aiFactory: AIFactory = () => ai;
  // Deterministic, strictly increasing clock so fetchedAt/servedAt comparisons
  // cannot be flaky on millisecond collisions.
  let tick = Date.parse('2026-03-01T00:00:00.000Z');
  const now = () => {
    tick += 1000;
    return tick;
  };
  const manager = new JobManager({ config, steam, aiFactory, logger: silentLogger, now });
  return {
    manager,
    steam,
    ai,
    dataDir,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
  };
}

function request(
  harness: Harness,
  overrides: {
    filters?: ScrapeFilters;
    clientFilters?: ClientFilters;
    forceFetch?: boolean;
    forceAnalyze?: boolean;
  } = {},
): CreateJobRequest {
  return {
    appid: APPID,
    filters: overrides.filters ?? harness.filters,
    clientFilters: overrides.clientFilters ?? harness.clientFilters,
    trend: { months: 3 },
    ai: { model: 'deepseek-flash', thinking: false },
    options: { maxReviews: 50, includeTranslations: false, topReviews: 3 },
    data: {
      dataDir: harness.dataDir,
      reuseDataset: true,
      reuseReport: true,
      forceFetch: overrides.forceFetch ?? false,
      forceAnalyze: overrides.forceAnalyze ?? false,
      forceTrend: false,
    },
  };
}

async function runJob(harness: Harness, req: CreateJobRequest): Promise<JobSnapshot> {
  const { jobId } = await harness.manager.createJob(req, 'sk-test-reuse', harness.dataDir);
  const started = Date.now();
  for (;;) {
    const snapshot = await harness.manager.getSnapshot(jobId);
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    if (Date.now() - started > 10000) throw new Error(`job timeout: ${JSON.stringify(snapshot)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function hashFor(req: CreateJobRequest): string {
  return buildReviewsHash({
    appid: req.appid,
    filters: req.filters,
    clientFilters: req.clientFilters,
    maxReviews: req.options.maxReviews,
  });
}

function onlyReportFile(dataDir: string): string {
  const files = fs.readdirSync(reportsDir(dataDir, APPID)).filter((f) => f.endsWith('.json'));
  expect(files).toHaveLength(1);
  return files[0].replace(/\.json$/, '');
}

describe('cached report reuse attribution', () => {
  it('refreshes filters, dataset metadata and data source without rewriting the stored report', async () => {
    const h = build();
    const baseRequest = request(h);

    const first = await runJob(h, baseRequest);
    expect(first.status).toBe('completed');
    const report1 = h.manager.getReport(first.jobId);
    const analysisHash = onlyReportFile(h.dataDir);
    const jsonPath = reportFilePaths(h.dataDir, APPID, analysisHash).json;
    const mdPath = reportFilePaths(h.dataDir, APPID, analysisHash).md;
    const storedJson = fs.readFileSync(jsonPath, 'utf8');
    const storedMarkdown = fs.readFileSync(mdPath, 'utf8');
    const callsAfterFirst = h.ai.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const firstDataset = await readDataset(h.dataDir, APPID, hashFor(baseRequest));
    expect(firstDataset?.status).toBe('complete');
    const firstFetchedAt = firstDataset!.meta.fetchedAt;

    // Normal second run: dataset + report reuse. The refreshed report must
    // describe the current data source and dataset, not the original fetch.
    const second = await runJob(h, baseRequest);
    expect(second.status).toBe('completed');
    const report2 = h.manager.getReport(second.jobId);
    expect(h.ai.calls.length).toBe(callsAfterFirst);
    expect(report2.generatedAt).toBe(report1.generatedAt);
    expect(report2.methodology.reportGeneratedAt).toBe(report1.generatedAt);
    expect(report2.methodology.analysisSource).toBe('local_report');
    expect(report2.methodology.dataSource).toBe('local_dataset');
    expect(report2.methodology.datasetFetchedAt).toBe(firstFetchedAt);
    expect(report2.methodology.servedAt).not.toBe(report1.methodology.servedAt);
    expect(report2.sample.filters).toMatchObject({
      languages: baseRequest.filters.languages,
      reviewType: baseRequest.filters.reviewType,
      sort: baseRequest.filters.sort,
      purchaseType: baseRequest.filters.purchaseType,
      dateRange: baseRequest.filters.dateRange,
      excludeOffTopic: baseRequest.filters.excludeOffTopic,
      useReviewQuality: baseRequest.filters.useReviewQuality,
      minVotes: baseRequest.clientFilters.minVotes,
      minLength: baseRequest.clientFilters.minLength,
      excludeEarlyAccess: baseRequest.clientFilters.excludeEarlyAccess,
      excludeFree: baseRequest.clientFilters.excludeFree,
    });
    expect(report2.sample.languages).toEqual(baseRequest.filters.languages);
    expect(fs.readFileSync(jsonPath, 'utf8')).toBe(storedJson);
    expect(fs.readFileSync(mdPath, 'utf8')).toBe(storedMarkdown);

    // forceFetch with identical content: content key is unchanged, but the
    // report must expose the new fresh source and dataset fetch time.
    const third = await runJob(h, request(h, { forceFetch: true }));
    expect(third.status).toBe('completed');
    const report3 = h.manager.getReport(third.jobId);
    expect(h.ai.calls.length).toBe(callsAfterFirst);
    expect(report3.generatedAt).toBe(report1.generatedAt);
    expect(report3.methodology.reportGeneratedAt).toBe(report1.generatedAt);
    expect(report3.methodology.dataSource).toBe('fresh');
    const thirdDataset = await readDataset(h.dataDir, APPID, hashFor(baseRequest));
    expect(thirdDataset?.status).toBe('complete');
    expect(thirdDataset!.meta.fetchedAt).not.toBe(firstFetchedAt);
    expect(report3.methodology.datasetFetchedAt).toBe(thirdDataset!.meta.fetchedAt);
    expect(report3.methodology.aggregatesComputedAt).toBe(thirdDataset!.meta.aggregatesComputedAt);
    expect(fs.readFileSync(jsonPath, 'utf8')).toBe(storedJson);
    expect(fs.readFileSync(mdPath, 'utf8')).toBe(storedMarkdown);
  });

  it('updates attribution when identical content is reached under a different reviewsHash', async () => {
    const h = build();
    const baseRequest = request(h);
    const first = await runJob(h, baseRequest);
    expect(first.status).toBe('completed');
    const report1 = h.manager.getReport(first.jobId);
    const callsAfterFirst = h.ai.calls.length;

    const changedClientFilters = withClientFilterDefaults({ minVotes: 10 });
    const changed = request(h, { clientFilters: changedClientFilters });
    const second = await runJob(h, changed);
    expect(second.status).toBe('completed');
    const report2 = h.manager.getReport(second.jobId);

    expect(h.ai.calls.length).toBe(callsAfterFirst); // content-keyed report reused
    expect(report2.generatedAt).toBe(report1.generatedAt);
    expect(report2.methodology.reviewsHash).toBe(hashFor(changed));
    expect(report2.methodology.reviewsHash).not.toBe(hashFor(baseRequest));
    expect(report2.methodology.dataSource).toBe('fresh');
    expect(report2.sample.filters).toMatchObject({ minVotes: 10 });
    expect(report2.sample.filters).not.toMatchObject({ minVotes: 0 });
    const secondDataset = await readDataset(h.dataDir, APPID, hashFor(changed));
    expect(secondDataset?.status).toBe('complete');
    expect(report2.methodology.datasetFetchedAt).toBe(secondDataset!.meta.fetchedAt);
    expect(report2.methodology.servedAt).not.toBe(report1.methodology.servedAt);
  });

  it('ignores a malformed cached report and falls back to fresh AI analysis', async () => {
    const h = build();
    const baseRequest = request(h);
    const first = await runJob(h, baseRequest);
    expect(first.status).toBe('completed');
    const callsAfterFirst = h.ai.calls.length;
    const analysisHash = onlyReportFile(h.dataDir);

    const jsonPath = reportFilePaths(h.dataDir, APPID, analysisHash).json;
    fs.writeFileSync(jsonPath, JSON.stringify({ version: '1.0', conclusion: {} }), 'utf8');
    expect(await readReport(h.dataDir, APPID, analysisHash)).toBeNull();

    const second = await runJob(h, baseRequest);
    expect(second.status).toBe('completed');
    expect(h.ai.calls.length).toBeGreaterThan(callsAfterFirst);
    const report = h.manager.getReport(second.jobId);
    expect(report.methodology.analysisSource).toBe('fresh');
    expect(report.conclusion.headline.length).toBeGreaterThan(0);
    expect(await readReport(h.dataDir, APPID, analysisHash)).not.toBeNull();
  });

  it('treats corrupted dataset metadata as unusable instead of failing the job', async () => {
    const h = build();
    const baseRequest = request(h);
    const first = await runJob(h, baseRequest);
    expect(first.status).toBe('completed');
    const callsAfterFirst = h.ai.calls.length;

    const metaPath = metaFilePath(h.dataDir, APPID, hashFor(baseRequest));
    const meta = await readJsonFile<DatasetMeta>(metaPath);
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, rollingKpis: {} }), 'utf8');
    expect((await readDataset(h.dataDir, APPID, hashFor(baseRequest)))?.status).toBe('corrupted');

    const fetchCallsBefore = h.steam.fetchCalls;
    const second = await runJob(h, request(h, { forceAnalyze: true }));
    expect(second.status).toBe('completed');
    expect(h.steam.fetchCalls).toBeGreaterThan(fetchCallsBefore);
    expect(h.ai.calls.length).toBeGreaterThan(callsAfterFirst);
    const repaired = await readDataset(h.dataDir, APPID, hashFor(baseRequest));
    expect(repaired?.status).toBe('complete');
    expect(repaired?.meta.rollingKpis).toBeDefined();
    expect(repaired?.meta.rollingKpis).not.toEqual({});
  });
});
