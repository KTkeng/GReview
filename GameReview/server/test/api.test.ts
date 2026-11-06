import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { JobManager, type AIFactory } from '../src/jobs/manager';
import { silentLogger } from '../src/lib/logger';
import type { JobSnapshot } from '../src/types';
import type { AIProvider } from '../src/ai/deepseek';
import { DeepSeekProvider } from '../src/ai/deepseek';
import { FakeAIProvider, FakeSteam, SAMPLE_ANALYSIS, SAMPLE_REVIEWS, SAMPLE_SUMMARY, makeConfig } from './helpers';
import { estimateCostUsd } from '../src/ai/pricing';

const SECRET = 'sk-test-secret-do-not-leak';
const ORIGIN = 'http://127.0.0.1:53821';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-api-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface TestContext {
  app: Express;
  config: ReturnType<typeof makeConfig>;
  steam: FakeSteam;
  ai: FakeAIProvider;
  manager: JobManager;
  factoryCalls: Array<{ apiKey: string; baseUrl?: string; model: string }>;
  dir: string;
}

function build(opts: {
  steam?: FakeSteam;
  ai?: FakeAIProvider;
  provider?: AIProvider;
  overrides?: Parameters<typeof makeConfig>[1];
} = {}): TestContext {
  const dir = tmpDir();
  const config = makeConfig(dir, opts.overrides ?? {});
  const steam = opts.steam ?? new FakeSteam();
  const ai = opts.ai ?? new FakeAIProvider(SAMPLE_ANALYSIS);
  const factoryCalls: TestContext['factoryCalls'] = [];
  const aiFactory: AIFactory = (factoryOpts): AIProvider => {
    factoryCalls.push(factoryOpts);
    return opts.provider ?? ai;
  };
  const manager = new JobManager({ config, steam, aiFactory, logger: silentLogger });
  const app = createApp({ config, steam, aiFactory, manager, logger: silentLogger });
  return { app, config, steam, ai, manager, factoryCalls, dir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(app: Express, jobId: string, timeoutMs = 8000): Promise<JobSnapshot> {
  const started = Date.now();
  for (;;) {
    const res = await request(app).get(`/api/jobs/${jobId}`);
    if (res.status !== 200) throw new Error(`job snapshot failed: ${res.status} ${JSON.stringify(res.body)}`);
    const snapshot = res.body as JobSnapshot;
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`job timeout: ${JSON.stringify(snapshot)}`);
    await sleep(10);
  }
}

async function startJob(app: Express, body: Record<string, unknown> = {}, key = SECRET) {
  const res = await request(app)
    .post('/api/jobs')
    .set('Origin', ORIGIN)
    .set('X-DeepSeek-Key', key)
    .send({ appid: 570, ...body });
  expect(res.status).toBe(202);
  expect(typeof res.body.jobId).toBe('string');
  return res.body.jobId as string;
}

function readAllText(dir: string): string {
  let out = '';
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out += `\n${fs.readFileSync(full, 'utf8')}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('API basics, validation and origin protection', () => {
  it('serves health and rejects missing keys and bad input with uniform errors', async () => {
    const { app, steam } = build();

    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true, version: '0.1.1' });

    const noKey = await request(app).post('/api/jobs').set('Origin', ORIGIN).send({ appid: 570 });
    expect(noKey.status).toBe(401);
    expect(noKey.body.error.code).toBe('INVALID_AI_KEY');
    expect(noKey.body.error.message).toBeTruthy();

    const missing = await request(app).post('/api/game/resolve').set('Origin', ORIGIN).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_REQUEST');

    const badJson = await request(app)
      .post('/api/game/resolve')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"url":');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('INVALID_REQUEST');

    const badUrl = await request(app).post('/api/game/resolve').set('Origin', ORIGIN).send({ url: 'https://example.com/app/570' });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error.code).toBe('INVALID_URL');
    expect(badUrl.body.error.message).not.toContain('http');

    const notFound = await request(app).get('/api/jobs/does-not-exist');
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe('JOB_NOT_FOUND');

    const unknown = await request(app).get('/api/unknown');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    const invalidDataDir = await request(app).post('/api/jobs').set('Origin', ORIGIN).set('X-DeepSeek-Key', SECRET).send({
      appid: 570,
      data: { dataDir: 'relative-data' },
    });
    expect(invalidDataDir.status).toBe(400);
    expect(invalidDataDir.body.error.code).toBe('DATA_DIR_NOT_ABSOLUTE');
    expect(steam.resolveCalls).toBe(0);
  });

  it('allows same-origin writes, blocks cross-origin writes and emits no CORS headers', async () => {
    const { app } = build();
    const cross = await request(app)
      .post('/api/game/resolve')
      .set('Origin', 'https://evil.example')
      .send({ url: 'https://store.steampowered.com/app/570/' });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
    expect(cross.headers['access-control-allow-origin']).toBeUndefined();

    const same = await request(app)
      .post('/api/game/resolve')
      .set('Origin', ORIGIN)
      .send({ url: 'https://store.steampowered.com/app/570/' });
    expect(same.status).toBe(200);
    expect(same.body.appid).toBe(570);
    expect(same.body.game.name).toBe('Test Game');
    expect(same.headers['access-control-allow-origin']).toBeUndefined();

    const health = await request(app).get('/api/health');
    expect(health.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects writes without Origin while reads may omit it', async () => {
    const { app } = build();
    // POST/PUT/PATCH/DELETE without Origin must be rejected with 403.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/game/resolve').send({ url: '570' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    const noOriginPreview = await request(app).post('/api/game/preview').send({ appid: 570 });
    expect(noOriginPreview.status).toBe(403);

    // A localhost origin on the configured port is accepted.
    const localhost = await request(app)
      .post('/api/game/resolve')
      .set('Origin', 'http://localhost:53821')
      .send({ url: '570' });
    expect(localhost.status).toBe(200);
    expect(localhost.body.appid).toBe(570);

    // Reads may omit Origin.
    const read = await request(app).get('/api/health');
    expect(read.status).toBe(200);

    const portMismatch = await request(app)
      .post('/api/game/resolve')
      .set('Origin', 'http://127.0.0.1:1234')
      .send({ url: '570' });
    expect(portMismatch.status).toBe(403);
  });

  it('accepts only the exact HTTP loopback origin for the configured port', async () => {
    const { app } = build();
    const rejected = [
      'https://127.0.0.1:53821',
      'https://localhost:53821',
      'http://[::1]:53821',
      'http://127.0.0.1:53821/',
      'http://127.0.0.1:53821/path',
      'http://127.0.0.1:53821?x=1',
      'http://user:pass@127.0.0.1:53821',
      'http://localhost:53821/extra',
      'http://127.0.0.1:53821.evil.example',
      'http://127.0.0.1',
    ];
    for (const origin of rejected) {
      const res = await request(app)
        .post('/api/game/resolve')
        .set('Origin', origin)
        .send({ url: '570' });
      expect(res.status, origin).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    for (const origin of ['http://127.0.0.1:53821', 'http://localhost:53821']) {
      const ok = await request(app)
        .post('/api/game/resolve')
        .set('Origin', origin)
        .send({ url: '570' });
      expect(ok.status, origin).toBe(200);
    }
  });

  it('resolves Steam URLs and maps app-not-found', async () => {
    const { app, steam } = build();
    const ok = await request(app).post('/api/game/resolve').set('Origin', ORIGIN).send({ url: '570' });
    expect(ok.body).toMatchObject({ appid: 570, game: { appid: 570, name: 'Test Game' } });
    expect(steam.resolveCalls).toBe(1);

    const notFoundSteam = build({ steam: new FakeSteam({ notFound: true }) });
    const res = await request(notFoundSteam.app).post('/api/game/resolve').set('Origin', ORIGIN).send({ url: '570' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  it('previews estimates and returns NO_REVIEWS for empty aggregates', async () => {
    const { app, steam } = build();
    const preview = await request(app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 });
    expect(preview.status).toBe(200);
    expect(preview.body.summary.matchingTotal).toBe(1000);
    expect(preview.body.estimate).toMatchObject({ pages: 2, trendRequests: 12, sampleSize: 200, chunks: 2 });
    expect(preview.body.estimate.outputTokens).toBe(2000);
    expect(typeof preview.body.estimate.costUsd).toBe('number');
    expect(preview.body.clientFilterNotice).toContain('客户端');
    expect(preview.body.reuse.dataset).toBeNull();
    expect(preview.body.reuse.report).toBeNull();
    expect(preview.body.reuse.canUseLocalReport).toBe(false);
    expect(preview.body.trend.months).toBe(12);
    expect(steam.aggregateCalls).toBe(1);

    // Preview accepts the same quantity/AI options as a real job and estimates
    // from those values instead of hard-coded defaults.
    const custom = await request(app)
      .post('/api/game/preview')
      .set('Origin', ORIGIN)
      .send({
        appid: 570,
        options: { maxReviews: 500, includeTranslations: true },
        ai: { model: 'deepseek-v4-pro', thinking: true },
      });
    expect(custom.status).toBe(200);
    expect(custom.body.estimate).toMatchObject({ pages: 5, sampleSize: 500, chunks: 3 });
    // 2000 base × 1.75 thinking + 800 translation output.
    expect(custom.body.estimate.outputTokens).toBe(4300);
    // The displayed outputTokens already includes the thinking multiplier;
    // cost is derived from exactly that token count, not multiplied twice.
    expect(custom.body.estimate.costUsd).toBe(
      estimateCostUsd('deepseek-v4-pro', custom.body.estimate.inputTokens, custom.body.estimate.outputTokens),
    );

    // A custom quantity changes the dataset hash: no local dataset hint.
    expect(custom.body.reuse.dataset).toBeNull();

    const badAppId = await request(app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 0 });
    expect(badAppId.status).toBe(400);
    expect(badAppId.body.error.code).toBe('INVALID_REQUEST');

    const badRange = await request(app)
      .post('/api/game/preview')
      .set('Origin', ORIGIN)
      .send({ appid: 570, filters: { dateRange: { start: 200, end: 100 } } });
    expect(badRange.status).toBe(400);
    expect(badRange.body.error.code).toBe('INVALID_REQUEST');

    // A single-sided range cannot be applied by Steam and must not be silently
    // ignored while the report still records it.
    for (const dateRange of [{ start: 100 }, { end: 200 }, { start: 0 }]) {
      const partial = await request(app)
        .post('/api/game/preview')
        .set('Origin', ORIGIN)
        .send({ appid: 570, filters: { dateRange } });
      expect(partial.status).toBe(400);
      expect(partial.body.error.code).toBe('INVALID_REQUEST');
      expect(String(partial.body.error.detail ?? '')).toContain('dateRange');
    }

    const partialJob = await request(app)
      .post('/api/jobs')
      .set('Origin', ORIGIN)
      .set('X-DeepSeek-Key', SECRET)
      .send({ appid: 570, filters: { dateRange: { start: 100 } } });
    expect(partialJob.status).toBe(400);
    expect(partialJob.body.error.code).toBe('INVALID_REQUEST');
    const partialEndJob = await request(app)
      .post('/api/jobs')
      .set('Origin', ORIGIN)
      .set('X-DeepSeek-Key', SECRET)
      .send({ appid: 570, filters: { dateRange: { end: 200 } } });
    expect(partialEndJob.status).toBe(400);
    expect(partialEndJob.body.error.code).toBe('INVALID_REQUEST');

    const empty = build({ steam: new FakeSteam({ empty: true }) });
    const res = await request(empty.app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_REVIEWS');
  });

  it('tests the AI connection only with a key and a safe base URL', async () => {
    const { app, factoryCalls } = build();
    const ok = await request(app)
      .post('/api/ai/test')
      .set('Origin', ORIGIN)
      .set('X-DeepSeek-Key', SECRET)
      .send({ model: 'deepseek-flash' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, latencyMs: 7 });
    expect(ok.body.models).toContain('deepseek-flash');
    expect(factoryCalls[0]).toMatchObject({ apiKey: SECRET, model: 'deepseek-flash' });
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);

    const missing = await request(app).post('/api/ai/test').set('Origin', ORIGIN).send({});
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('INVALID_AI_KEY');

    for (const baseUrl of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com']) {
      const bad = await request(app).post('/api/ai/test').set('Origin', ORIGIN).set('X-DeepSeek-Key', SECRET).send({ baseUrl });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_PARAMS');
    }

    const badJob = await request(app)
      .post('/api/jobs')
      .set('Origin', ORIGIN)
      .set('X-DeepSeek-Key', SECRET)
      .send({ appid: 570, ai: { baseUrl: 'file:///etc/passwd' } });
    expect(badJob.status).toBe(400);
    expect(badJob.body.error.code).toBe('INVALID_PARAMS');
  });
});

describe('full job lifecycle and local data APIs', () => {
  it('runs a job, serves its report, lists datasets and clears data without leaking keys', async () => {
    const { app, config, steam, ai, manager, dir } = build();
    const jobId = await startJob(app, { options: { maxReviews: 200, topReviews: 10 } });
    const done = await waitForJob(app, jobId);
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(100);
    expect(done.error).toBeUndefined();
    expect(done.logs.length).toBeGreaterThan(0);
    expect(done.report?.version).toBe('1.0');
    expect(done.report?.conclusion.label).toContain('特别好评');
    expect(done.report?.topReviews).toHaveLength(3);
    expect(done.report?.methodology.analysisSource).toBe('fresh');
    expect(steam.fetchCalls).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(manager.store.get(jobId)?.apiKey).toBeUndefined();

    const reportRes = await request(app).get(`/api/jobs/${jobId}/report`);
    expect(reportRes.status).toBe(200);
    expect(reportRes.body.report ?? reportRes.body).toBeTruthy();
    expect(reportRes.body.conclusion.label).toContain('特别好评');

    const stream = await request(app).get(`/api/jobs/${jobId}/stream`);
    expect(stream.status).toBe(200);
    expect(String(stream.headers['content-type'])).toContain('text/event-stream');
    expect(String(stream.text)).toContain('event: done');
    expect(String(stream.text)).not.toContain(SECRET);

    const list = await request(app).get('/api/datasets').query({ dataDir: config.dataDir });
    expect(list.status).toBe(200);
    expect(list.body.datasets).toHaveLength(1);
    const item = list.body.datasets[0];
    expect(item).toMatchObject({ appid: 570, reviewCount: 3, status: 'complete', reportCount: 1 });
    const reviewsHash = item.reviewsHash;
    expect(reviewsHash).toMatch(/^[a-f0-9]{16}$/);

    const detail = await request(app).get(`/api/datasets/570/${reviewsHash}`).query({ dataDir: config.dataDir });
    expect(detail.status).toBe(200);
    expect(detail.body.reviewCount).toBe(3);
    expect(detail.body.reports).toHaveLength(1);
    expect(detail.body.trends).toHaveLength(1);

    const reportsDir = path.join(config.dataDir, '570', 'reports');
    const analysisHash = fs
      .readdirSync(reportsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))[0];
    expect(analysisHash).toMatch(/^[a-f0-9]{16}$/);

    const served = await request(app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: config.dataDir, topReviews: 2 });
    expect(served.status).toBe(200);
    expect(served.body.topReviews).toHaveLength(2);
    expect(served.body.methodology.analysisSource).toBe('local_report');
    expect(served.body.methodology.servedAt).toBeTruthy();

    const badTopN = await request(app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: config.dataDir, topReviews: 0 });
    expect(badTopN.status).toBe(400);
    expect(badTopN.body.error.code).toBe('INVALID_PARAMS');

    const badHash = await request(app).get('/api/reports/570/not-a-hash').query({ dataDir: config.dataDir });
    expect(badHash.status).toBe(400);
    expect(badHash.body.error.code).toBe('INVALID_PARAMS');

    const missingReport = await request(app)
      .get(`/api/reports/570/${'f'.repeat(16)}`)
      .query({ dataDir: config.dataDir });
    expect(missingReport.status).toBe(404);
    expect(missingReport.body.error.code).toBe('NOT_FOUND');

    steam.resolveCalls = 0;
    steam.aggregateCalls = 0;
    steam.fetchCalls = 0;
    const reusePreview = await request(app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 });
    expect(reusePreview.status).toBe(200);
    expect(reusePreview.body.game.name).toBe('Test Game');
    expect(reusePreview.body.reuse.canUseLocalDataset).toBe(true);
    expect(reusePreview.body.reuse.canUseLocalReport).toBe(true);
    expect(reusePreview.body.reuse.dataset.reviewsHash).toBe(reviewsHash);
    expect(steam.resolveCalls).toBe(0);
    expect(steam.aggregateCalls).toBe(0);
    expect(steam.fetchCalls).toBe(0);

    // A different model changes the analysis hash: the stored report is only
    // historical and must not be advertised as reusable.
    const historical = await request(app)
      .post('/api/game/preview')
      .set('Origin', ORIGIN)
      .send({ appid: 570, ai: { model: 'deepseek-v4-pro' } });
    expect(historical.status).toBe(200);
    expect(historical.body.reuse.report).toMatchObject({ match: 'historical', reusable: false });
    expect(historical.body.reuse.canUseLocalReport).toBe(false);
    expect(historical.body.reuse.canUseLocalDataset).toBe(true);

    const validate = await request(app).post('/api/data/validate').set('Origin', ORIGIN).send({ dataDir: config.dataDir });
    expect(validate.status).toBe(200);
    expect(validate.body).toEqual({ dataDir: path.resolve(config.dataDir), writable: true });

    const noConfirm = await request(app).post('/api/data/clear').set('Origin', ORIGIN).send({ dataDir: config.dataDir });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('INVALID_REQUEST');

    const del = await request(app)
      .delete(`/api/datasets/570/${reviewsHash}`)
      .set('Origin', ORIGIN)
      .query({ dataDir: config.dataDir });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    const gone = await request(app).get(`/api/datasets/570/${reviewsHash}`).query({ dataDir: config.dataDir });
    expect(gone.status).toBe(404);
    const reportGone = await request(app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: config.dataDir });
    expect(reportGone.status).toBe(404);

    const cleared = await request(app)
      .post('/api/data/clear')
      .set('Origin', ORIGIN)
      .send({ dataDir: config.dataDir, confirm: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ cleared: true });
    expect(fs.readdirSync(config.dataDir)).toEqual(['.greview-data.json']);

    const cache = await request(app).post('/api/cache/clear').set('Origin', ORIGIN).send({});
    expect(cache.status).toBe(200);
    expect(cache.body).toEqual({ cleared: true });
    expect(steam.cacheCleared).toBe(1);

    expect(readAllText(dir)).not.toContain(SECRET);
  });

  it('redacts a non-sk upstream key from API errors, job snapshot, SSE, logs and disk', async () => {
    const key = 'local-relay-token-9f3a';
    const provider = new DeepSeekProvider({
      apiKey: key,
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ error: { message: `invalid api key ${key}`, key } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      timeoutMs: 2000,
      sleep: async () => undefined,
    });
    const h = build({ provider });

    // Synchronous AI test endpoint: the provider-boundary redaction must reach
    // the HTTP error response.
    const aiTest = await request(h.app)
      .post('/api/ai/test')
      .set('Origin', ORIGIN)
      .set('X-DeepSeek-Key', key)
      .send({ model: 'deepseek-flash' });
    expect(aiTest.status).not.toBe(200);
    expect(JSON.stringify(aiTest.body)).not.toContain(key);

    const jobId = await startJob(h.app, { options: { maxReviews: 50 } }, key);
    const failed = await waitForJob(h.app, jobId);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('AI_INVALID_RESPONSE');

    const snapshotJson = JSON.stringify(failed);
    expect(snapshotJson).toContain('[REDACTED]');
    expect(snapshotJson).not.toContain(key);
    expect(failed.logs.map((l) => l.message).join('\n')).not.toContain(key);

    const stream = await request(h.app).get(`/api/jobs/${jobId}/stream`);
    expect(stream.status).toBe(200);
    expect(String(stream.text)).toContain('event: error');
    expect(String(stream.text)).not.toContain(key);

    expect(readAllText(h.dir)).not.toContain(key);
  });

  it('reuses local dataset, trend, persisted aggregates and AI report with zero Steam requests', async () => {
    const { app, steam, ai, manager } = build();
    const first = await startJob(app, { options: { maxReviews: 200, topReviews: 10 } });
    const firstDone = await waitForJob(app, first);
    expect(firstDone.status).toBe('completed');
    expect(ai.calls).toHaveLength(1);
    expect(steam.fetchCalls).toBe(1);
    const firstReport = firstDone.report;
    expect(firstReport?.kpis.allTime.total).toBe(SAMPLE_SUMMARY.total);
    expect(firstReport?.methodology.aggregatesComputedAt).toBeTruthy();

    // Simulate Steam aggregates changing. A complete local reuse must serve the
    // persisted aggregates and make no Steam request at all (review R3 Major).
    steam.summary = {
      ...SAMPLE_SUMMARY,
      total: 2000,
      positive: 1600,
      negative: 400,
      positiveRate: 0.8,
      reviewScoreDesc: '好评',
    };
    steam.resetCounters();
    steam.resolveCalls = 0;
    steam.fetchCalls = 0;
    steam.aggregateCalls = 0;
    steam.trendSampleCalls = 0;
    ai.calls = [];

    const second = await startJob(app, { options: { maxReviews: 200, topReviews: 2 } }, 'sk-second-key');
    const done = await waitForJob(app, second);
    expect(done.status).toBe('completed');
    expect(done.report?.methodology.analysisSource).toBe('local_report');
    expect(done.report?.topReviews).toHaveLength(2);
    expect(ai.calls).toHaveLength(0);
    expect(steam.resolveCalls).toBe(0);
    expect(steam.fetchCalls).toBe(0);
    expect(steam.aggregateCalls).toBe(0);
    expect(steam.trendSampleCalls).toBe(0);
    expect(steam.steamRequests).toBe(0);
    expect(done.report?.methodology.steamRequests).toBe(0);
    // KPIs come from the locally persisted aggregates, not the changed Steam
    // responses (which were never requested).
    expect(done.report?.kpis.allTime.total).toBe(1000);
    expect(done.report?.kpis.allTime.positiveRate).toBe(0.9);
    expect(done.report?.kpis.last30d.total).toBe(1000);
    expect(done.report?.kpis.last90d.total).toBe(1000);
    expect(done.report?.kpis.allTimeSource).toBe('official_aggregate');
    expect(done.report?.kpis.sources).toEqual({
      last30d: 'official_aggregate',
      last90d: 'official_aggregate',
    });
    // The original generation time is preserved on the served copy.
    expect(done.report?.generatedAt).toBe(firstReport?.generatedAt);
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(JSON.stringify(done)).not.toContain('sk-second-key');
    expect(manager.store.get(first)?.apiKey).toBeUndefined();
    expect(manager.store.get(second)?.apiKey).toBeUndefined();

    // An explicit refresh (forceFetch) is the only path that re-requests the
    // aggregates; the cached AI report is still reused without tokens.
    steam.resolveCalls = 0;
    steam.fetchCalls = 0;
    steam.aggregateCalls = 0;
    ai.calls = [];
    const refreshedJob = await startJob(
      app,
      { options: { maxReviews: 200, topReviews: 2 }, data: { forceFetch: true } },
      'sk-refresh-key',
    );
    const refreshed = await waitForJob(app, refreshedJob);
    expect(refreshed.status).toBe('completed');
    expect(steam.fetchCalls).toBe(1);
    expect(steam.aggregateCalls).toBe(3);
    expect(ai.calls).toHaveLength(0);
    expect(refreshed.report?.kpis.allTime.total).toBe(2000);
    expect(refreshed.report?.kpis.allTime.positiveRate).toBe(0.8);
    expect(refreshed.report?.kpis.last30d.total).toBe(2000);
  });

  it('keeps rolling KPI windows official and independent of the user date range', async () => {
    const { app, steam } = build();
    const nowSec = Math.floor(Date.now() / 1000);
    const jobId = await startJob(app, {
      filters: {
        reviewType: 'negative',
        dateRange: { start: nowSec - 60 * 86400, end: nowSec - 86400 },
      },
    });
    const done = await waitForJob(app, jobId);
    expect(done.status).toBe('completed');
    const kpiCalls = steam.aggregateOptions.filter(
      (opts) => opts.dayRangeOverride === 30 || opts.dayRangeOverride === 90,
    );
    expect(kpiCalls).toHaveLength(2);
    // The custom date range only applies to the AI sample; the rolling KPI
    // queries explicitly clear it (review Major 2).
    expect(kpiCalls.every((opts) => opts.dateRangeOverride === null)).toBe(true);
    expect(kpiCalls.every((opts) => opts.reviewTypeOverride === 'all')).toBe(true);
    expect(done.report?.kpis.sources).toEqual({
      last30d: 'official_aggregate',
      last90d: 'official_aggregate',
    });
    expect(done.report?.kpis.last30d.total).toBe(SAMPLE_SUMMARY.total);
    expect(done.report?.kpis.last90d.total).toBe(SAMPLE_SUMMARY.total);
    expect(done.report?.kpis.allTimeSource).toBe('official_aggregate');
    expect(done.report?.kpis.allTime.total).toBe(SAMPLE_SUMMARY.total);
    // The sample itself still records the user's filters.
    expect(done.report?.sample.filters.reviewType).toBe('negative');
    expect(done.report?.sample.filters.dateRange).toEqual({ start: nowSec - 60 * 86400, end: nowSec - 86400 });
  });

  it('labels all-time KPI as a sample estimate when the official aggregate fails', async () => {
    const { app } = build({ steam: new FakeSteam({ allTimeFail: true }) });
    const jobId = await startJob(app);
    const done = await waitForJob(app, jobId);
    expect(done.status).toBe('completed');
    expect(done.report?.kpis.allTimeSource).toBe('sample_estimate');
    expect(done.report?.kpis.allTime.total).toBe(SAMPLE_REVIEWS.length);
    // Rolling windows still succeeded officially and are not mislabelled.
    expect(done.report?.kpis.sources).toEqual({
      last30d: 'official_aggregate',
      last90d: 'official_aggregate',
    });
    expect(done.report?.conclusion.caveats).toContain(
      '全部时间 KPI 缺少独立官方聚合，当前使用筛选样本估算，不代表 Steam 全站口径。',
    );
    expect(done.report?.methodology.note).toContain('筛选样本估算');
  });

  it('cancels a running job, then rejects a second cancel and report access', async () => {
    const { app, steam } = build({ steam: new FakeSteam({ fetchDelayMs: 300 }) });
    const jobId = await startJob(app);
    await sleep(30);
    const cancel = await request(app).post(`/api/jobs/${jobId}/cancel`).set('Origin', ORIGIN);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ status: 'cancelled' });

    const snapshot = await waitForJob(app, jobId);
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.report).toBeUndefined();

    const second = await request(app).post(`/api/jobs/${jobId}/cancel`).set('Origin', ORIGIN);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CANCELLED');

    const report = await request(app).get(`/api/jobs/${jobId}/report`);
    expect(report.status).toBe(409);
    expect(report.body.error.code).toBe('CONFLICT');
    expect(steam.fetchCalls).toBeLessThanOrEqual(1);
  });

  it('keeps review and trend reuse independent for forceFetch and forceTrend', async () => {
    const { app, steam, ai } = build();
    const first = await startJob(app, { options: { maxReviews: 200, topReviews: 5 } });
    expect((await waitForJob(app, first)).status).toBe('completed');
    expect(steam.fetchCalls).toBe(1);
    expect(ai.calls).toHaveLength(1);

    steam.resolveCalls = 0;
    steam.fetchCalls = 0;
    steam.aggregateCalls = 0;
    ai.calls = [];
    const forcedFetch = await startJob(
      app,
      { options: { maxReviews: 200, topReviews: 5 }, data: { forceFetch: true, forceAnalyze: true } },
      'sk-force-fetch',
    );
    const fetched = await waitForJob(app, forcedFetch);
    expect(fetched.status).toBe('completed');
    // Reviews were re-fetched...
    expect(steam.fetchCalls).toBe(1);
    expect(steam.resolveCalls).toBe(1);
    expect(ai.calls).toHaveLength(1);
    // ...but the still-valid trend cache was reused: only the all-time and two
    // rolling KPI aggregates were requested, no monthly trend requests.
    expect(fetched.report?.methodology.trendSource).toBe('local_cache');
    expect(steam.aggregateCalls).toBe(3);

    steam.resolveCalls = 0;
    steam.fetchCalls = 0;
    steam.aggregateCalls = 0;
    ai.calls = [];
    const forcedTrend = await startJob(
      app,
      { options: { maxReviews: 200, topReviews: 5 }, data: { forceTrend: true, forceAnalyze: true } },
      'sk-force-trend',
    );
    const trended = await waitForJob(app, forcedTrend);
    expect(trended.status).toBe('completed');
    // Reviews were reused, the trend was explicitly refreshed.
    expect(steam.fetchCalls).toBe(0);
    expect(steam.resolveCalls).toBe(0);
    expect(trended.report?.methodology.trendSource).toBe('official_aggregate');
    // 12 natural-month aggregates only: the persisted all-time and rolling KPI
    // aggregates are reused untouched (review R3 Major 3).
    expect(steam.aggregateCalls).toBe(12);
    expect(ai.calls).toHaveLength(1);
  });

  it('enforces the concurrent job limit', async () => {
    const ctx = build({ steam: new FakeSteam({ fetchDelayMs: 250 }), overrides: { maxConcurrentJobs: 2 } });
    const first = await startJob(ctx.app, { appid: 570 });
    const second = await startJob(ctx.app, { appid: 730 });
    const third = await request(ctx.app)
      .post('/api/jobs')
      .set('Origin', ORIGIN)
      .set('X-DeepSeek-Key', SECRET)
      .send({ appid: 101 });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('JOB_LIMIT');

    await request(ctx.app).post(`/api/jobs/${first}/cancel`).set('Origin', ORIGIN);
    await request(ctx.app).post(`/api/jobs/${second}/cancel`).set('Origin', ORIGIN);
    expect((await waitForJob(ctx.app, first)).status).toBe('cancelled');
    expect((await waitForJob(ctx.app, second)).status).toBe('cancelled');
    expect(ctx.ai.calls).toHaveLength(0);
  });
});
