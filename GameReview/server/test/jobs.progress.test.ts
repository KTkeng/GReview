import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { JobManager, type AIFactory } from '../src/jobs/manager';
import { JobStore, type JobEvent } from '../src/jobs/store';
import { analyzeReviews, type AnalyzeProgress } from '../src/analysis/pipeline';
import { AppError } from '../src/lib/errors';
import { silentLogger } from '../src/lib/logger';
import { DeepSeekProvider } from '../src/ai/deepseek';
import type { CreateJobRequest, Review, TrendDataset } from '../src/types';
import {
  FakeAIProvider,
  FakeSteam,
  SAMPLE_ANALYSIS,
  SAMPLE_REVIEWS,
  SAMPLE_SUMMARY,
  makeConfig,
  makeReview,
} from './helpers';

const ORIGIN = 'http://127.0.0.1:53821';
const SECRET = 'sk-test-secret-do-not-leak';

const TREND: TrendDataset = {
  granularity: 'month',
  source: 'official_aggregate',
  points: [
    { period: '2025-11', total: 100, positive: 80, negative: 20, positiveRate: 0.8 },
    { period: '2025-12', total: 100, positive: 85, negative: 15, positiveRate: 0.85 },
  ],
  coverage: { start: '2025-11', end: '2025-12', note: '' },
  timezone: 'Asia/Shanghai',
  sourceEndpoint: 'official',
  fetchedAt: '2026-01-05T00:00:00.000Z',
  trendHash: 'a'.repeat(16),
  trendContentHash: 'b'.repeat(16),
};

const FILTERS = {
  languages: ['english'],
  reviewType: 'all' as const,
  sort: 'helpful' as const,
  purchaseType: 'all' as const,
  dateRange: null,
  excludeOffTopic: true,
  useReviewQuality: true,
};

const AI_OPTIONS = { model: 'deepseek-flash', thinking: false };

/** Two ~33k-token reviews force the map/merge/final path with exactly 2 chunks. */
const BIG_ANALYSIS = {
  themes: [
    {
      name: '主题一',
      sentiment: 'positive',
      summary: 's',
      evidenceIds: ['big-1'],
      quotes: [{ reviewId: 'big-1', original: 'xxxxx' }],
    },
    {
      name: '主题二',
      sentiment: 'negative',
      summary: 's',
      evidenceIds: ['big-2'],
      quotes: [{ reviewId: 'big-2', original: 'xxxxx' }],
    },
  ],
  expectationGaps: [],
  updateImpact: [],
  recommendations: [],
  conclusion: { label: 'x', headline: 'h', summary: 's', confidence: 'high', caveats: [] },
};

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-progress-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface TestContext {
  app: Express;
  manager: JobManager;
  steam: FakeSteam;
  ai: FakeAIProvider;
}

function build(opts: { steam?: FakeSteam; ai?: FakeAIProvider } = {}): TestContext {
  const dir = tmpDir();
  const config = makeConfig(dir);
  const steam = opts.steam ?? new FakeSteam();
  const ai = opts.ai ?? new FakeAIProvider(SAMPLE_ANALYSIS);
  const aiFactory: AIFactory = () => ai;
  const manager = new JobManager({ config, steam, aiFactory, logger: silentLogger });
  const app = createApp({ config, steam, aiFactory, manager, logger: silentLogger });
  return { app, manager, steam, ai };
}

async function startJob(app: Express, body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/jobs')
    .set('Origin', ORIGIN)
    .set('X-DeepSeek-Key', SECRET)
    .send({ appid: 570, ...body });
  expect(res.status).toBe(202);
  expect(typeof res.body.jobId).toBe('string');
  return res.body.jobId as string;
}

async function waitForJob(app: Express, jobId: string, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const res = await request(app).get(`/api/jobs/${jobId}`);
    if (res.status !== 200) throw new Error(`job snapshot failed: ${res.status} ${JSON.stringify(res.body)}`);
    if (['completed', 'failed', 'cancelled'].includes(res.body.status)) return res.body;
    if (Date.now() - started > timeoutMs) throw new Error(`job timeout: ${JSON.stringify(res.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function analyzeInput(reviews: Review[]) {
  return {
    game: { appid: 570, name: 'Test Game' },
    reviews,
    trend: TREND,
    summary: SAMPLE_SUMMARY,
    filters: FILTERS,
    aiOptions: AI_OPTIONS,
    includeTranslations: false,
  };
}

function bigReview(id: string): Review {
  return makeReview({ id, text: 'x'.repeat(120000) });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 10000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** One OpenAI-compatible chat completion carrying an optional reasoning body. */
function chatResponse(content: string, reasoning = ''): Response {
  return jsonResponse({
    choices: [
      {
        message: { role: 'assistant', content, reasoning_content: reasoning },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

/** Parse wire-format SSE frames into their event name and JSON payload. */
function sseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
    const dataLine = lines.find((line) => line.startsWith('data:'))?.slice('data:'.length).trim();
    if (!eventName || !dataLine) continue;
    events.push({ event: eventName, data: JSON.parse(dataLine) as Record<string, unknown> });
  }
  return events;
}

function completedValues(progress: AnalyzeProgress[]): number[] {
  return progress
    .map((info) => info.counts?.completed)
    .filter((value): value is number => typeof value === 'number');
}

describe('AI chunk progress counts', () => {
  it('reports the task-level chunk total and counts every successful chunk once', async () => {
    const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
    const progress: AnalyzeProgress[] = [];
    await analyzeReviews({
      ...analyzeInput(SAMPLE_REVIEWS),
      ai,
      // One review per chunk -> 3 map calls, then merge and final.
      maxTokensPerChunk: 1,
      maxChunks: 10,
      onProgress: (info) => progress.push(info),
    });

    const chunkEvents = progress.filter((info) => info.counts?.chunks !== undefined);
    expect(chunkEvents.length).toBeGreaterThan(0);
    expect(chunkEvents.every((info) => info.counts?.chunks === 3)).toBe(true);

    const completed = completedValues(progress);
    // Before/after each map call: 0,1,1,2,2,3; merge/final repeat 3.
    expect(completed[0]).toBe(0);
    expect(completed.at(-1)).toBe(3);
    expect(completed.every((value, index) => index === 0 || value >= completed[index - 1])).toBe(true);
    expect(completed.every((value) => value <= 3)).toBe(true);
    const increments = completed.filter(
      (value, index) => index > 0 && value === completed[index - 1] + 1,
    );
    expect(increments).toHaveLength(3);
    // 3 map + merge + final: merge/final never increment the chunk counter.
    expect(ai.calls).toHaveLength(5);
  });

  it('retries a 429 inside the real provider and counts that chunk only once', async () => {
    // Exercise the production DeepSeekProvider retry loop with a mocked
    // transport: the first HTTP attempt is rate limited, the retry succeeds.
    // No real network or real backoff sleep is used.
    const requests: Array<{ authorization: string; body: Record<string, unknown> }> = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const ai = new DeepSeekProvider({
      apiKey: SECRET,
      baseUrl: 'https://api.deepseek.com',
      timeoutMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        attempts += 1;
        requests.push({
          authorization: String((init.headers as Record<string, string>).Authorization),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        // Only the very first raw attempt fails; the provider's own retry then
        // serves the first chunk successfully.
        if (attempts === 1) return jsonResponse({ error: { message: 'rate limited' } }, 429);
        return chatResponse(JSON.stringify(SAMPLE_ANALYSIS));
      }) as unknown as typeof fetch,
    });

    const progress: AnalyzeProgress[] = [];
    await analyzeReviews({
      ...analyzeInput(SAMPLE_REVIEWS),
      ai,
      maxTokensPerChunk: 1,
      maxChunks: 10,
      onProgress: (info) => progress.push(info),
    });

    // 3 map + merge + final logical calls; one transparent retry of the first
    // map call -> 6 actual HTTP requests.
    expect(attempts).toBe(6);
    expect(requests).toHaveLength(6);
    expect(sleeps).toEqual([1000]);
    expect(requests.every((request) => request.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(requests.every((request) => typeof request.body.model === 'string')).toBe(true);
    // The first two raw attempts sent the same chunk-1 request body: a real
    // provider retry, not a second chunk.
    expect(requests[0].body).toEqual(requests[1].body);
    expect(requests[2].body).not.toEqual(requests[0].body);

    const completed = completedValues(progress);
    expect(completed.at(-1)).toBe(3);
    expect(completed.every((value, index) => index === 0 || value >= completed[index - 1])).toBe(true);
    expect(completed.every((value) => value <= 3)).toBe(true);
    const increments = completed.filter(
      (value, index) => index > 0 && value === completed[index - 1] + 1,
    );
    // One increment per chunk, even though the first chunk consumed two HTTP
    // attempts inside the provider.
    expect(increments).toHaveLength(3);
    const firstChunkDone = progress.filter((info) => info.message === 'AI 分块分析 1/3 完成');
    expect(firstChunkDone).toHaveLength(1);
    expect(firstChunkDone[0].counts).toEqual({ chunks: 3, completed: 1 });
  });

  it('does not count a chunk whose model call failed', async () => {
    let call = 0;
    const ai = new FakeAIProvider(() => {
      call += 1;
      if (call === 2) throw new AppError('AI_TIMEOUT');
      return SAMPLE_ANALYSIS;
    });
    const progress: AnalyzeProgress[] = [];
    await expect(
      analyzeReviews({
        ...analyzeInput(SAMPLE_REVIEWS),
        ai,
        maxTokensPerChunk: 1,
        maxChunks: 10,
        onProgress: (info) => progress.push(info),
      }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });

    const completed = completedValues(progress);
    expect(Math.max(...completed)).toBe(1);
    expect(completed).not.toContain(2);
  });

  it('does not count a chunk whose response fails schema validation', async () => {
    // The transport succeeds but the model's JSON has the wrong structure.
    // parseAnalysis rejects it, so the failed chunk must never be counted.
    let attempts = 0;
    const ai = new DeepSeekProvider({
      apiKey: SECRET,
      baseUrl: 'https://api.deepseek.com',
      timeoutMs: 5000,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 2) return chatResponse(JSON.stringify({ themes: 'not-an-array' }));
        return chatResponse(JSON.stringify(SAMPLE_ANALYSIS));
      }) as unknown as typeof fetch,
    });

    const progress: AnalyzeProgress[] = [];
    let failure: unknown;
    try {
      await analyzeReviews({
        ...analyzeInput(SAMPLE_REVIEWS),
        ai,
        maxTokensPerChunk: 1,
        maxChunks: 10,
        onProgress: (info) => progress.push(info),
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('AI_INVALID_RESPONSE');
    expect(String((failure as AppError).detail)).toContain('分块分析 2/3');
    // A schema failure is not a transport failure: no repair retry happens.
    expect(attempts).toBe(2);

    const completed = completedValues(progress);
    expect(Math.max(...completed)).toBe(1);
    expect(progress.some((info) => info.counts?.completed === 2)).toBe(false);
    expect(progress.some((info) => info.message === 'AI 分块分析 2/3 完成')).toBe(false);
  });

  it('counts the single holistic call only after it succeeds', async () => {
    const progress: AnalyzeProgress[] = [];
    await analyzeReviews({
      ...analyzeInput(SAMPLE_REVIEWS),
      ai: new FakeAIProvider(SAMPLE_ANALYSIS),
      onProgress: (info) => progress.push(info),
    });

    const withCompleted = progress.filter((info) => typeof info.counts?.completed === 'number');
    expect(withCompleted[0].counts).toMatchObject({ chunks: 1, completed: 0 });
    expect(withCompleted.at(-1)?.counts).toMatchObject({ chunks: 1, completed: 1 });
  });

  it('merges counts field-wise so a stage change keeps known chunk totals', () => {
    const jobRequest = { appid: 570 } as CreateJobRequest;
    const store = new JobStore();
    const record = store.create({ request: jobRequest, dataDir: '/tmp/data' });

    store.update(record, {
      status: 'running',
      stage: 'analyzing',
      progress: 50,
      message: 'AI 分块分析 1/4 完成',
      counts: { chunks: 4, completed: 1 },
    });
    store.update(record, { stage: 'validating', progress: 96, message: '校验证据并计算 KPI' });

    const snapshot = store.snapshot(record);
    expect(snapshot.counts).toMatchObject({ chunks: 4, completed: 1 });
    expect(snapshot.message).toBe('校验证据并计算 KPI');

    // A new job starts from an empty count object; nothing leaks across jobs.
    const next = store.create({ request: jobRequest, dataDir: '/tmp/data' });
    expect(store.snapshot(next).counts).toEqual({});
  });
});

describe('job snapshot and SSE chunk progress', () => {
  it('serves identical stage, progress, message and counts over HTTP SSE and the snapshot', async () => {
    const THINKING_MARKER = 'MODEL-REASONING-MUST-NOT-LEAK-4c1e';
    const entered = deferred();
    const release = deferred();
    const requests: Array<{ authorization: string; body: string }> = [];
    // Real provider, mocked transport. It pauses after the first chunk has
    // completed and before the second chunk's response, leaving the job in a
    // deterministic mid-chunk state for both the SSE replay and the snapshot.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requests.push({
        authorization: String((init.headers as Record<string, string>).Authorization),
        body: String(init.body),
      });
      if (requests.length === 2) {
        entered.resolve();
        await withTimeout(release.promise, 'test never released the paused AI call');
      }
      return chatResponse(
        JSON.stringify(BIG_ANALYSIS),
        // The model's private reasoning must never reach a client surface.
        `${THINKING_MARKER} ${SECRET}`,
      );
    }) as unknown as typeof fetch;

    const dir = tmpDir();
    const config = makeConfig(dir);
    const steam = new FakeSteam({ reviews: [bigReview('big-1'), bigReview('big-2')] });
    const aiFactory: AIFactory = (opts) =>
      new DeepSeekProvider({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        fetchImpl,
        sleep: async () => undefined,
        timeoutMs: 30000,
      });
    const manager = new JobManager({ config, steam, aiFactory, logger: silentLogger });
    const app = createApp({ config, steam, aiFactory, manager, logger: silentLogger });

    // The SSE route subscribes through the manager; signal once the route has
    // replayed the paused state so snapshot and stream describe the same state.
    const subscribed = deferred();
    const originalSubscribe = manager.subscribe.bind(manager);
    manager.subscribe = ((id: string, listener: (event: JobEvent) => void) => {
      const unsubscribe = originalSubscribe(id, listener);
      subscribed.resolve();
      return unsubscribe;
    }) as JobManager['subscribe'];

    const jobId = await startJob(app);
    await withTimeout(entered.promise, 'job never paused before the second chunk');

    // Actual HTTP SSE request. Calling .then starts the request immediately.
    const streamPromise = request(app).get(`/api/jobs/${jobId}/stream`).then((res) => res);
    await withTimeout(subscribed.promise, 'SSE route never subscribed');

    // Same paused state, read through the public snapshot endpoint.
    const snapshotRes = await request(app).get(`/api/jobs/${jobId}`);
    expect(snapshotRes.status).toBe(200);
    const snapshot = snapshotRes.body as {
      status: string;
      stage: string;
      progress: number;
      message?: string;
      counts: Record<string, number>;
    };
    expect(snapshot.status).toBe('running');
    expect(snapshot.stage).toBe('analyzing');
    expect(snapshot.progress).toBe(53);
    expect(snapshot.message).toBe('AI 分块分析 2/2');
    expect(snapshot.counts).toMatchObject({ chunks: 2, completed: 1 });

    release.resolve();
    const stream = await streamPromise;
    expect(stream.status).toBe(200);
    expect(String(stream.headers['content-type'])).toContain('text/event-stream');

    const events = sseEvents(String(stream.text));
    const statuses = events
      .filter((event) => event.event === 'status')
      .map((event) => event.data as {
        status?: string;
        stage?: string;
        progress?: number;
        message?: string;
        counts?: Record<string, number>;
      });
    expect(statuses.length).toBeGreaterThan(0);
    // The first wire event is the replay of the exact state the snapshot read.
    const paused = statuses[0];
    expect(paused.status).toBe(snapshot.status);
    expect(paused.stage).toBe(snapshot.stage);
    expect(paused.progress).toBe(snapshot.progress);
    expect(paused.message).toBe(snapshot.message);
    expect(paused.counts).toEqual(snapshot.counts);
    expect(events.filter((event) => event.event === 'done')).toHaveLength(1);

    const finalSnapshot = (await request(app).get(`/api/jobs/${jobId}`)).body as {
      status: string;
      counts: Record<string, number>;
    };
    expect(finalSnapshot.status).toBe('completed');
    expect(finalSnapshot.counts).toMatchObject({ chunks: 2, completed: 2 });

    const liveCompleted = statuses
      .map((status) => status.counts?.completed)
      .filter((value): value is number => typeof value === 'number');
    expect(liveCompleted.length).toBeGreaterThan(0);
    expect(liveCompleted.every((value) => value >= 0 && value <= 2)).toBe(true);
    expect(liveCompleted.at(-1)).toBe(2);
    expect(statuses.some((status) => status.stage === 'analyzing')).toBe(true);
    // Completion status and recovery snapshot agree as well.
    expect(statuses.at(-1)?.counts).toEqual(finalSnapshot.counts);

    // The key and the reasoning marker really were on the wire...
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.authorization === `Bearer ${SECRET}`)).toBe(true);
    // ...but neither the paused snapshot, the final snapshot nor any SSE frame
    // may expose the API key or the model's thinking content.
    for (const payload of [snapshot, finalSnapshot]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(THINKING_MARKER);
    }
    expect(String(stream.text)).not.toContain(SECRET);
    expect(String(stream.text)).not.toContain(THINKING_MARKER);
  });

  it('does not fabricate chunk counts when an existing report is reused', async () => {
    const { app, ai } = build();
    const first = await startJob(app);
    expect((await waitForJob(app, first)).status).toBe('completed');

    const callsAfterFirst = ai.calls.length;
    const second = await startJob(app);
    const reused = await waitForJob(app, second);

    expect(reused.status).toBe('completed');
    expect(ai.calls.length).toBe(callsAfterFirst);
    expect(reused.counts?.chunks).toBeUndefined();
    expect(reused.counts?.completed).toBeUndefined();
  });
});

describe('job recovery error contract', () => {
  it('returns the contract error bodies for missing jobs and snapshot failures', async () => {
    const { app, manager } = build();

    const missing = await request(app).get('/api/jobs/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: 'JOB_NOT_FOUND',
      message: '任务不存在或已清理',
    });

    // The stream route must answer with a JSON error before opening SSE.
    const missingStream = await request(app).get('/api/jobs/does-not-exist/stream');
    expect(missingStream.status).toBe(404);
    expect(String(missingStream.headers['content-type'])).toContain('application/json');
    expect(missingStream.body.error.code).toBe('JOB_NOT_FOUND');

    manager.getSnapshot = async (): Promise<never> => {
      throw new Error('ENOENT: no such file /private/path');
    };
    const failed = await request(app).get('/api/jobs/any-id');
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatchObject({ code: 'INTERNAL', message: '读取任务状态失败' });
    expect(JSON.stringify(failed.body)).not.toContain('ENOENT');
    expect(JSON.stringify(failed.body)).not.toContain('/private/path');
  });
});
