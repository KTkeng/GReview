import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { JobManager, type AIFactory } from '../src/jobs/manager';
import { silentLogger } from '../src/lib/logger';
import type { JobSnapshot } from '../src/types';
import type { AIProvider } from '../src/ai/deepseek';
import type { ServerConfig } from '../src/lib/config';
import { resetTitleFsOpsForTests, setTitleFsOpsForTests, titleFilePath } from '../src/storage/game-title';
import { setContainedReadOpenErrorForTests, setDataDirProbeErrorForTests } from '../src/storage/paths';
import { FakeAIProvider, FakeSteam, SAMPLE_ANALYSIS, makeConfig } from './helpers';

const SECRET = 'sk-title-test-secret';
const ORIGIN = 'http://127.0.0.1:53821';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-title-api-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Remove a test temp tree without ever following a symbolic link or a Windows
 * directory junction. `fs.rmSync(dir, { recursive: true, force: true })` is
 * not reliable on Windows once the tree contains links: it can fail with
 * ENOTEMPTY after visiting the link target. Walking with lstat lets us delete
 * the link entry itself (unlink, or rmdir for Windows directory links) and
 * never the directory it points at.
 */
function removeTreeSync(target: string): void {
  let stat: ReturnType<typeof fs.lstatSync>;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Windows may reject lstat on a dangling file symlink. Try removing the
      // link entry itself so the parent directory can be removed; a genuinely
      // missing path simply fails both attempts with ENOENT.
      try {
        fs.unlinkSync(target);
        return;
      } catch {}
      try {
        fs.rmdirSync(target);
        return;
      } catch {}
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      // A Windows directory symlink/junction may reject unlink with
      // EPERM/EACCES/EISDIR; rmdir removes the link entry itself and never
      // traverses the target.
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EISDIR' && code !== 'ENOTDIR') throw err;
      fs.rmdirSync(target, { maxRetries: 10, retryDelay: 50 });
    }
    return;
  }

  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) removeTreeSync(path.join(target, entry));
    // Every child (including link entries) is gone before the parent is removed.
    try {
      fs.rmdirSync(target, { maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      try {
        console.error('[removeTreeSync] leftover in', target, fs.readdirSync(target));
      } catch {}
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
    return;
  }

  fs.rmSync(target, { force: true, maxRetries: 10, retryDelay: 50 });
}

afterEach(() => {
  resetTitleFsOpsForTests();
  setContainedReadOpenErrorForTests(null);
  setDataDirProbeErrorForTests(null);
  for (const dir of tmpDirs.splice(0)) removeTreeSync(dir);
});

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

interface TestContext {
  app: Express;
  config: ServerConfig;
  steam: FakeSteam;
  ai: FakeAIProvider;
  manager: JobManager;
  root: string;
}

function build(opts: { root?: string; steam?: FakeSteam; ai?: FakeAIProvider } = {}): TestContext {
  const root = opts.root ?? tmpDir();
  const config = makeConfig(root);
  const steam = opts.steam ?? new FakeSteam();
  const ai = opts.ai ?? new FakeAIProvider(SAMPLE_ANALYSIS);
  const aiFactory: AIFactory = (): AIProvider => ai;
  const manager = new JobManager({ config, steam, aiFactory, logger: silentLogger });
  const app = createApp({ config, steam, aiFactory, manager, logger: silentLogger });
  return { app, config, steam, ai, manager, root };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Stable hash of every file below a directory (relative path + bytes). */
function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(full));
        hash.update('\0');
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/** Parse SSE frames into their event name and JSON payload. */
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

async function waitForJob(app: Express, jobId: string, timeoutMs = 10000): Promise<JobSnapshot> {
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

async function startJob(app: Express, body: Record<string, unknown> = {}, key = SECRET): Promise<string> {
  const res = await request(app)
    .post('/api/jobs')
    .set('Origin', ORIGIN)
    .set('X-DeepSeek-Key', key)
    .send({ appid: 570, ...body });
  expect(res.status).toBe(202);
  return res.body.jobId as string;
}

interface PatchOptions {
  dataDir?: string;
  origin?: string | null;
  host?: string;
}

function patchTitle(ctx: TestContext, appid: number, body: unknown, opts: PatchOptions = {}) {
  let req = request(ctx.app).patch(`/api/datasets/${appid}/title`);
  if (opts.dataDir !== undefined) req = req.query({ dataDir: opts.dataDir });
  if (opts.origin !== null) req = req.set('Origin', opts.origin ?? ORIGIN);
  if (opts.host !== undefined) req = req.set('Host', opts.host);
  return req.send(body as object);
}

/** Create a directory symlink/junction; junctions are the Windows fallback. */
function tryCreateDirLink(target: string, link: string): boolean {
  const types: Array<'junction' | 'dir'> = process.platform === 'win32' ? ['junction', 'dir'] : ['dir'];
  for (const type of types) {
    try {
      fs.symlinkSync(target, link, type);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EINVAL') {
        throw err;
      }
    }
  }
  return false;
}

/** @returns false only when the platform/permissions forbid file symlinks. */
function tryCreateFileLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EINVAL') {
      throw err;
    }
    return false;
  }
}

/** Remove a link entry (file symlink, directory symlink or junction). */
function removeLinkSync(link: string): void {
  try {
    fs.unlinkSync(link);
    return;
  } catch {}
  try {
    fs.rmdirSync(link, { maxRetries: 10, retryDelay: 50 });
  } catch {}
}

function reportsOf(config: ServerConfig, appid = 570): string[] {
  const dir = path.join(config.dataDir, String(appid), 'reports');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^[a-f0-9]{16}\.json$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

async function datasetInfo(app: Express, config: ServerConfig) {
  const list = await request(app).get('/api/datasets').query({ dataDir: config.dataDir });
  expect(list.status).toBe(200);
  expect(list.body.datasets).toHaveLength(1);
  return list.body.datasets[0] as { reviewsHash: string; game: Record<string, unknown> };
}

function readStoredTitle(config: ServerConfig, appid = 570): {
  schemaVersion: number;
  appid: number;
  customTitle: string | null;
  revision: number;
  updatedAt: string;
} {
  return JSON.parse(fs.readFileSync(titleFilePath(config.dataDir, appid), 'utf8')) as {
    schemaVersion: number;
    appid: number;
    customTitle: string | null;
    revision: number;
    updatedAt: string;
  };
}

describe('PATCH /api/datasets/:appid/title', () => {
  it('persists a title, exposes it on every read path and survives an app restart', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 200, topReviews: 10 } });
    const done = await waitForJob(h.app, jobId);
    expect(done.status).toBe('completed');
    const { reviewsHash } = await datasetInfo(h.app, h.config);
    const reportsBefore = reportsOf(h.config);
    expect(reportsBefore).toHaveLength(1);
    const analysisHash = reportsBefore[0].replace(/\.json$/, '');
    const reportPath = path.join(h.config.dataDir, '570', 'reports', `${analysisHash}.json`);
    const diskReportBefore = fs.readFileSync(reportPath, 'utf8');

    const initial = await request(h.app).get('/api/datasets').query({ dataDir: h.config.dataDir });
    expect(initial.body.datasets[0].game).toMatchObject({
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      customTitle: null,
      titleSource: '自动读取',
      titleRevision: 0,
      titleEditable: true,
      coverPlaceholder: 'AppID 570',
      warnings: [],
    });
    expect(String(initial.headers['cache-control'])).toContain('no-store');

    h.steam.resolveCalls = 0;
    h.steam.fetchCalls = 0;
    h.steam.aggregateCalls = 0;
    h.steam.steamRequests = 0;
    const aiCallsBefore = h.ai.calls.length;

    const patched = await patchTitle(h, 570, { customTitle: '自定义名称', expectedRevision: 0 });
    expect(patched.status).toBe(200);
    expect(patched.body.changed).toBe(true);
    expect(patched.body.game).toMatchObject({
      appid: 570,
      name: '自定义名称',
      displayTitle: '自定义名称',
      steamName: 'Test Game',
      customTitle: '自定义名称',
      titleSource: '自定义',
      titleRevision: 1,
      titleEditable: true,
      coverPlaceholder: 'AppID 570',
    });
    expect(patched.body.game.titleUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(patched.headers['cache-control'])).toContain('no-store');
    // A rename must never fetch Steam or call the AI provider.
    expect(h.steam.steamRequests).toBe(0);
    expect(h.ai.calls.length).toBe(aiCallsBefore);

    const stored = readStoredTitle(h.config);
    expect(stored).toMatchObject({ schemaVersion: 1, appid: 570, customTitle: '自定义名称', revision: 1 });
    expect(stored.updatedAt).toBe(patched.body.game.titleUpdatedAt);
    // game.json still holds the automatic Steam metadata only.
    const gameJson = JSON.parse(fs.readFileSync(path.join(h.config.dataDir, '570', 'game.json'), 'utf8'));
    expect(gameJson.name).toBe('Test Game');
    expect(JSON.stringify(gameJson)).not.toContain('自定义名称');

    const list = await request(h.app).get('/api/datasets').query({ dataDir: h.config.dataDir });
    expect(list.body.datasets[0].game.displayTitle).toBe('自定义名称');
    expect(list.body.datasets[0].game.titleSource).toBe('自定义');

    const detail = await request(h.app)
      .get(`/api/datasets/570/${reviewsHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(detail.status).toBe(200);
    expect(detail.body.game.displayTitle).toBe('自定义名称');
    expect(detail.body.dataset.game.displayTitle).toBe('自定义名称');
    expect(detail.body.meta.game.name).toBe('Test Game');

    const served = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(served.status).toBe(200);
    expect(served.body.game.name).toBe('自定义名称');
    expect(served.body.game.displayTitle).toBe('自定义名称');
    expect(served.body.game.titleSource).toBe('自定义');
    expect(served.body.generatedAt).toBe(done.report?.generatedAt);
    expect(String(served.headers['cache-control'])).toContain('no-store');
    // The persisted report JSON is byte-for-byte unchanged.
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(diskReportBefore);

    const markdown = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir, format: 'markdown' });
    expect(markdown.status).toBe(200);
    expect(String(markdown.headers['content-type'])).toContain('text/markdown');
    expect(String(markdown.headers['content-type'])).toContain('charset=utf-8');
    expect(String(markdown.headers['content-disposition'])).toBe(
      `attachment; filename="greview-570-${analysisHash}.md"`,
    );
    expect(String(markdown.text)).toContain('自定义名称');
    expect(String(markdown.text)).not.toContain('Test Game');
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(diskReportBefore);

    // Reused preview resolves the local custom title without any Steam call.
    h.steam.resolveCalls = 0;
    h.steam.fetchCalls = 0;
    h.steam.aggregateCalls = 0;
    h.steam.steamRequests = 0;
    const preview = await request(h.app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 });
    expect(preview.status).toBe(200);
    expect(preview.body.game.displayTitle).toBe('自定义名称');
    expect(preview.body.game.titleSource).toBe('自定义');
    expect(preview.body.reuse.dataset.game).toBe('自定义名称');
    expect(h.steam.resolveCalls).toBe(0);
    expect(h.steam.fetchCalls).toBe(0);
    expect(h.steam.aggregateCalls).toBe(0);
    expect(h.steam.steamRequests).toBe(0);

    // A fresh app instance over the same data directory (backend restart).
    const restarted = build({ root: h.root });
    const afterRestart = await request(restarted.app).get('/api/datasets').query({ dataDir: restarted.config.dataDir });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.datasets[0].game.displayTitle).toBe('自定义名称');
    expect(afterRestart.body.datasets[0].game.titleRevision).toBe(1);

    // Restore the automatic name; the revision record stays on disk.
    const cleared = await patchTitle(restarted, 570, { customTitle: null, expectedRevision: 1 });
    expect(cleared.status).toBe(200);
    expect(cleared.body.changed).toBe(true);
    expect(cleared.body.game).toMatchObject({
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      customTitle: null,
      titleSource: '自动读取',
      titleRevision: 2,
    });
    expect(readStoredTitle(restarted.config)).toMatchObject({ customTitle: null, revision: 2 });
    const noop = await patchTitle(restarted, 570, { customTitle: '   ', expectedRevision: 2 });
    expect(noop.status).toBe(200);
    expect(noop.body.changed).toBe(false);
    expect(noop.body.game.titleRevision).toBe(2);
  });

  it('returns 409 with currentGame on revision conflict and refuses to overwrite a corrupt file', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');

    const first = await patchTitle(h, 570, { customTitle: '客户端 A', expectedRevision: 0 });
    expect(first.status).toBe(200);
    expect(first.body.game.titleRevision).toBe(1);

    const stale = await patchTitle(h, 570, { customTitle: '客户端 B', expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('标题版本冲突');
    expect(stale.body.error.message).toBeTruthy();
    expect(stale.body.error.currentGame).toMatchObject({
      displayTitle: '客户端 A',
      customTitle: '客户端 A',
      titleRevision: 1,
      titleSource: '自定义',
    });
    // The losing client's value must not be written.
    expect(readStoredTitle(h.config).customTitle).toBe('客户端 A');

    const file = titleFilePath(h.config.dataDir, 570);
    fs.writeFileSync(file, '{broken title', 'utf8');
    const listed = await request(h.app).get('/api/datasets').query({ dataDir: h.config.dataDir });
    expect(listed.status).toBe(200);
    expect(listed.body.datasets[0].game).toMatchObject({
      displayTitle: 'Test Game',
      titleRevision: null,
      titleEditable: false,
      titleSource: '自动读取',
    });
    expect(listed.body.datasets[0].game.warnings.length).toBeGreaterThan(0);

    const blocked = await patchTitle(h, 570, { customTitle: '不能覆盖', expectedRevision: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('标题文件损坏');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken title');
  });

  it('validates title text, the strict request schema, body size, content type and local existence', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');

    const cases: Array<{ body: unknown; field?: string }> = [
      { body: { expectedRevision: 0 }, field: 'customTitle' },
      { body: { customTitle: 5, expectedRevision: 0 }, field: 'customTitle' },
      { body: { customTitle: ['x'], expectedRevision: 0 }, field: 'customTitle' },
      { body: { customTitle: 'ok', expectedRevision: '1' }, field: 'expectedRevision' },
      { body: { customTitle: 'ok', expectedRevision: -1 }, field: 'expectedRevision' },
      { body: { customTitle: 'ok', expectedRevision: 1.5 }, field: 'expectedRevision' },
      { body: { customTitle: 'ok', expectedRevision: 0, revision: 9 } },
      { body: { customTitle: 'ok', expectedRevision: 0, appid: 730 } },
    ];
    for (const item of cases) {
      const res = await patchTitle(h, 570, item.body);
      expect(res.status, JSON.stringify(item.body)).toBe(400);
      expect(res.body.error.code).toBe('参数无效');
      if (item.field) expect(res.body.error.field).toBe(item.field);
    }

    // Zod details are translated to Chinese; the raw English issue text never
    // reaches the client.
    const unknownField = await patchTitle(h, 570, { customTitle: 'ok', expectedRevision: 0, extra: true });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe('参数无效');
    expect(String(unknownField.body.error.detail)).toContain('未知字段');
    expect(String(unknownField.body.error.detail)).not.toMatch(/Unrecognized|unknown/i);

    for (const badTitle of [
      'x'.repeat(121),
      'line' + String.fromCharCode(10) + 'break',
      String.fromCharCode(10) + 'leading newline',
      'trailing newline' + String.fromCharCode(10),
      'null' + String.fromCharCode(0) + 'byte',
      'bidi' + String.fromCodePoint(0x202e) + 'text',
      // U+061C (Arabic letter mark) is a bidirectional control too.
      'alm' + String.fromCodePoint(0x061c) + 'text',
    ]) {
      const res = await patchTitle(h, 570, { customTitle: badTitle, expectedRevision: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('参数无效');
      expect(res.body.error.field).toBe('customTitle');
    }

    const max = await patchTitle(h, 570, { customTitle: '字'.repeat(120), expectedRevision: 0 });
    expect(max.status).toBe(200);
    expect(max.body.game.titleRevision).toBe(1);
    const whitespace = await patchTitle(h, 570, { customTitle: '    ', expectedRevision: 1 });
    expect(whitespace.status).toBe(200);
    expect(whitespace.body.game.customTitle).toBeNull();
    expect(whitespace.body.game.titleRevision).toBe(2);

    const tooLarge = await patchTitle(h, 570, { customTitle: 'x'.repeat(5000), expectedRevision: 2 });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe('参数无效');

    const wrongType = await request(h.app)
      .patch('/api/datasets/570/title')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'text/plain')
      .send('hello');
    expect(wrongType.status).toBe(415);
    expect(wrongType.body.error.code).toBe('参数无效');

    const missingOrigin = await request(h.app)
      .patch('/api/datasets/570/title')
      .send({ customTitle: 'x', expectedRevision: 2 });
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.body.error.code).toBe('来源不允许');

    const crossOrigin = await patchTitle(h, 570, { customTitle: 'x', expectedRevision: 2 }, { origin: 'https://evil.example' });
    expect(crossOrigin.status).toBe(403);

    const badHost = await patchTitle(h, 570, { customTitle: 'x', expectedRevision: 2 }, { host: 'evil.example' });
    expect(badHost.status).toBe(403);

    for (const pathAppid of ['abc', '0', '4294967296', '1e3', '-1']) {
      const res = await request(h.app)
        .patch(`/api/datasets/${pathAppid}/title`)
        .set('Origin', ORIGIN)
        .send({ customTitle: 'x', expectedRevision: 0 });
      expect(res.status, pathAppid).toBe(400);
      expect(res.body.error.code).toBe('参数无效');
    }

    const missingGame = await patchTitle(h, 730, { customTitle: 'x', expectedRevision: 0 });
    expect(missingGame.status).toBe(404);
    expect(missingGame.body.error.code).toBe('本地游戏不存在');

    const missingDir = await patchTitle(h, 570, { customTitle: 'x', expectedRevision: 2 }, {
      dataDir: path.join(h.config.dataDir, 'does-not-exist'),
    });
    expect(missingDir.status).toBe(404);
    expect(missingDir.body.error.code).toBe('本地游戏不存在');

    // game.json alone is not a local game: the endpoint must not create dirs.
    fs.mkdirSync(path.join(h.config.dataDir, '730'), { recursive: true });
    fs.writeFileSync(path.join(h.config.dataDir, '730', 'game.json'), JSON.stringify({ appid: 730, name: 'Only meta' }));
    const metaOnly = await patchTitle(h, 730, { customTitle: 'x', expectedRevision: 0 });
    expect(metaOnly.status).toBe(404);
    expect(fs.existsSync(titleFilePath(h.config.dataDir, 730))).toBe(false);
  });

  it('maps real title write failures to 503 storage errors and keeps the old file intact', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const saved = await patchTitle(h, 570, { customTitle: '原标题', expectedRevision: 0 });
    expect(saved.status).toBe(200);
    const file = titleFilePath(h.config.dataDir, 570);
    const before = fs.readFileSync(file, 'utf8');
    const tmpFiles = () => fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));

    setTitleFsOpsForTests({
      open: async () => {
        throw errno('EACCES', 'denied');
      },
    });
    const unwritable = await patchTitle(h, 570, { customTitle: '新标题', expectedRevision: 1 });
    expect(unwritable.status).toBe(503);
    expect(unwritable.body.error.code).toBe('存储不可写');
    expect(unwritable.body.error.message).toBe('存储不可写');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(tmpFiles()).toEqual([]);

    setTitleFsOpsForTests({
      open: async (target, flags) => {
        const real = await fsp.open(target, flags);
        return {
          writeFile: async (data, encoding) => {
            await real.writeFile(data.slice(0, Math.max(1, Math.floor(data.length / 2))), encoding);
            throw errno('ENOSPC', 'full');
          },
          sync: () => real.sync(),
          close: () => real.close(),
        };
      },
    });
    const noSpace = await patchTitle(h, 570, { customTitle: '新标题', expectedRevision: 1 });
    expect(noSpace.status).toBe(503);
    expect(noSpace.body.error.code).toBe('存储空间不足');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(tmpFiles()).toEqual([]);

    let attempts = 0;
    setTitleFsOpsForTests({
      rename: async () => {
        attempts += 1;
        throw errno('EBUSY', 'busy');
      },
    });
    const busy = await patchTitle(h, 570, { customTitle: '新标题', expectedRevision: 1 });
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe('存储忙');
    expect(attempts).toBe(5);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(tmpFiles()).toEqual([]);
  });

  it('applies the 4 KiB body cap to case variants, trailing slashes and whitespace padding', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');

    const paths = [
      '/api/datasets/570/title',
      '/api/datasets/570/TITLE',
      '/api/Datasets/570/Title',
      '/api/datasets/570/title/',
    ];
    let revision = 0;
    for (const route of paths) {
      const res = await request(h.app)
        .patch(route)
        .set('Origin', ORIGIN)
        .send({ customTitle: `大小写 ${route}`, expectedRevision: revision });
      expect(res.status, route).toBe(200);
      revision += 1;
      expect(res.body.game.titleRevision, route).toBe(revision);
    }

    // Valid fields followed by >4 KiB of JSON whitespace exceed the title
    // endpoint cap. If the path-scoped parser missed a case variant, the 2 MB
    // parser would accept the body and the request would succeed instead.
    const padded = `{"customTitle":"空白填充","expectedRevision":${revision}}${' '.repeat(5000)}`;
    for (const route of paths) {
      const res = await request(h.app)
        .patch(route)
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/json')
        .send(padded);
      expect(res.status, route).toBe(413);
      expect(res.body.error.code, route).toBe('参数无效');
      expect(String(res.body.error.detail), route).toContain('大小上限');
    }
    expect(readStoredTitle(h.config).revision).toBe(4);
  });

  it('reuses local data and reports after a rename with zero Steam/AI calls', async () => {
    const h = build();
    const first = await startJob(h.app, { options: { maxReviews: 200, topReviews: 10 } });
    const firstDone = await waitForJob(h.app, first);
    expect(firstDone.status).toBe('completed');
    expect(h.steam.fetchCalls).toBe(1);
    expect(h.ai.calls.length).toBe(1);
    const reportsBefore = reportsOf(h.config);
    expect(reportsBefore).toHaveLength(1);
    const { reviewsHash } = await datasetInfo(h.app, h.config);
    const reviewsTreeBefore = treeHash(path.join(h.config.dataDir, '570', 'reviews'));
    const trendsTreeBefore = treeHash(path.join(h.config.dataDir, '570', 'trends'));
    const reportJsonPath = path.join(h.config.dataDir, '570', 'reports', reportsBefore[0]);
    const reportMdPath = path.join(h.config.dataDir, '570', 'reports', `${reportsBefore[0].replace(/\.json$/, '')}.md`);
    const reportJsonBefore = fs.readFileSync(reportJsonPath, 'utf8');
    const reportMdBefore = fs.readFileSync(reportMdPath, 'utf8');

    const name = await patchTitle(h, 570, { customTitle: '改名后的游戏', expectedRevision: 0 });
    expect(name.status).toBe(200);

    h.steam.resolveCalls = 0;
    h.steam.fetchCalls = 0;
    h.steam.aggregateCalls = 0;
    h.steam.trendSampleCalls = 0;
    h.steam.resetCounters();
    h.ai.calls = [];
    const second = await startJob(h.app, { options: { maxReviews: 200, topReviews: 5 } }, 'sk-second');
    const secondDone = await waitForJob(h.app, second);
    expect(secondDone.status).toBe('completed');
    expect(secondDone.report?.game.name).toBe('改名后的游戏');
    expect((secondDone.report?.game as unknown as Record<string, unknown>).displayTitle).toBe('改名后的游戏');
    expect(secondDone.report?.methodology.dataSource).toBe('local_dataset');
    expect(secondDone.report?.methodology.analysisSource).toBe('local_report');
    expect(h.steam.steamRequests).toBe(0);
    expect(h.steam.resolveCalls).toBe(0);
    expect(h.steam.fetchCalls).toBe(0);
    expect(h.steam.aggregateCalls).toBe(0);
    expect(h.steam.trendSampleCalls).toBe(0);
    expect(h.ai.calls).toHaveLength(0);
    expect(reportsOf(h.config)).toEqual(reportsBefore);
    // The full reuse path after a rename leaves every persisted artifact
    // byte-identical: reviews, trends, report JSON and historical Markdown.
    expect((await datasetInfo(h.app, h.config)).reviewsHash).toBe(reviewsHash);
    expect(treeHash(path.join(h.config.dataDir, '570', 'reviews'))).toBe(reviewsTreeBefore);
    expect(treeHash(path.join(h.config.dataDir, '570', 'trends'))).toBe(trendsTreeBefore);
    expect(fs.readFileSync(reportJsonPath, 'utf8')).toBe(reportJsonBefore);
    expect(fs.readFileSync(reportMdPath, 'utf8')).toBe(reportMdBefore);
    // Persisted dataset metadata still carries the Steam name.
    const datasetMeta = JSON.parse(
      fs.readFileSync(
        path.join(h.config.dataDir, '570', 'reviews', (await datasetInfo(h.app, h.config)).reviewsHash, 'meta.json'),
        'utf8',
      ),
    );
    expect(datasetMeta.game.name).toBe('Test Game');
  });

  it('presents the latest committed title on completion snapshots, SSE replay and the report endpoint', async () => {
    const h = build();
    const first = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, first)).status).toBe('completed');
    const callsAfterFirst = h.ai.calls.length;
    const { reviewsHash } = await datasetInfo(h.app, h.config);

    // Historical output from the first analysis must survive the second job and
    // every rename byte-for-byte; only presentation copies may change.
    const historicalReports = reportsOf(h.config);
    expect(historicalReports).toHaveLength(1);
    const historicalHash = historicalReports[0].replace(/\.json$/, '');
    const historicalJson = path.join(h.config.dataDir, '570', 'reports', historicalReports[0]);
    const historicalMd = path.join(h.config.dataDir, '570', 'reports', `${historicalHash}.md`);
    const historicalJsonBefore = fs.readFileSync(historicalJson, 'utf8');
    const historicalMdBefore = fs.readFileSync(historicalMd, 'utf8');
    const reviewsTreeBefore = treeHash(path.join(h.config.dataDir, '570', 'reviews'));
    const trendsTreeBefore = treeHash(path.join(h.config.dataDir, '570', 'trends'));

    const a = await patchTitle(h, 570, { customTitle: '任务开始时的标题', expectedRevision: 0 });
    expect(a.status).toBe(200);
    expect(a.body.game.titleRevision).toBe(1);

    // Explicit barrier: block *the second job's* AI call (the first job already
    // left a call in the fake provider), rename while it is in flight, then let
    // the job finish. A calls.length === 0 poll would end immediately here.
    const entered = deferred();
    const release = deferred();
    h.ai.beforeCall = async (callIndex) => {
      if (callIndex === callsAfterFirst + 1) {
        entered.resolve();
        await release.promise;
      }
    };
    const slow = await startJob(h.app, {
      options: { maxReviews: 50 },
      // A different model produces a new analysisHash: the historical report is
      // not overwritten, so its bytes can be compared before/after.
      ai: { model: 'deepseek-v4-pro' },
      data: { forceAnalyze: true },
    }, 'sk-slow');
    await Promise.race([
      entered.promise,
      sleep(5000).then(() => {
        throw new Error('second AI call did not start');
      }),
    ]);
    expect(h.ai.calls.length).toBe(callsAfterFirst + 1);
    const b = await patchTitle(h, 570, { customTitle: '任务完成前的标题', expectedRevision: 1 });
    expect(b.status).toBe(200);
    expect(b.body.game.titleRevision).toBe(2);
    release.resolve();

    const done = await waitForJob(h.app, slow);
    expect(done.status).toBe('completed');
    expect(done.report?.game.name).toBe('任务完成前的标题');
    const doneGame = done.report?.game as unknown as Record<string, unknown>;
    expect(doneGame.displayTitle).toBe('任务完成前的标题');
    expect(doneGame.titleRevision).toBe(2);
    expect(doneGame.titleSource).toBe('自定义');
    expect(h.ai.calls.length).toBe(callsAfterFirst + 1);

    // Rename/reuse never rewrites reviews, trends or historical outputs.
    expect((await datasetInfo(h.app, h.config)).reviewsHash).toBe(reviewsHash);
    expect(treeHash(path.join(h.config.dataDir, '570', 'reviews'))).toBe(reviewsTreeBefore);
    expect(treeHash(path.join(h.config.dataDir, '570', 'trends'))).toBe(trendsTreeBefore);
    expect(fs.readFileSync(historicalJson, 'utf8')).toBe(historicalJsonBefore);
    expect(fs.readFileSync(historicalMd, 'utf8')).toBe(historicalMdBefore);

    const secondHash = reportsOf(h.config)
      .map((file) => file.replace(/\.json$/, ''))
      .find((hash) => hash !== historicalHash);
    expect(secondHash).toBeTruthy();
    expect(secondHash).toMatch(/^[a-f0-9]{16}$/);

    // Rename after completion: report endpoint, task snapshot and a late SSE
    // subscriber must all re-resolve the current title and revision.
    const callsBeforeRename = h.ai.calls.length;
    const c = await patchTitle(h, 570, { customTitle: '完成后的标题', expectedRevision: 2 });
    expect(c.status).toBe(200);
    expect(c.body.game.titleRevision).toBe(3);
    expect(h.ai.calls.length).toBe(callsBeforeRename);

    const served = await request(h.app).get(`/api/jobs/${slow}/report`);
    expect(served.status).toBe(200);
    expect(served.body.game).toMatchObject({
      name: '完成后的标题',
      displayTitle: '完成后的标题',
      titleRevision: 3,
      titleSource: '自定义',
    });
    expect(String(served.headers['cache-control'])).toContain('no-store');

    const snapshot = await request(h.app).get(`/api/jobs/${slow}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.report.game).toMatchObject({
      name: '完成后的标题',
      displayTitle: '完成后的标题',
      titleRevision: 3,
      titleSource: '自定义',
    });

    const stream = await request(h.app).get(`/api/jobs/${slow}/stream`);
    expect(stream.status).toBe(200);
    const doneEvents = sseEvents(String(stream.text)).filter((event) => event.event === 'done');
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0].data.report as { game: Record<string, unknown> }).game).toMatchObject({
      name: '完成后的标题',
      displayTitle: '完成后的标题',
      titleRevision: 3,
      titleSource: '自定义',
    });
    expect(String(stream.text)).not.toContain('任务开始时的标题');

    // Disk reports (written at completion) never contain any custom title.
    for (const hash of [historicalHash, secondHash!]) {
      const diskReport = JSON.parse(
        fs.readFileSync(path.join(h.config.dataDir, '570', 'reports', `${hash}.json`), 'utf8'),
      );
      expect(diskReport.game.name).toBe('Test Game');
    }
  });

  it('never exposes a title through an app-directory junction (HTTP)', async (ctx) => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    const saved = await patchTitle(h, 570, { customTitle: '联接外部标题', expectedRevision: 0 });
    expect(saved.status).toBe(200);

    const dataDir = h.config.dataDir;
    const appPath = path.join(dataDir, '570');
    const external = path.join(h.root, 'external-app');
    fs.renameSync(appPath, external);
    if (!tryCreateDirLink(external, appPath)) ctx.skip();
    const externalTitle = fs.readFileSync(path.join(external, 'title.json'), 'utf8');

    const list = await request(h.app).get('/api/datasets').query({ dataDir });
    expect(list.status).toBe(400);
    expect(list.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(list.body)).not.toContain('联接外部标题');

    const preview = await request(h.app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 });
    expect(preview.status).toBe(400);
    expect(preview.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(preview.body)).not.toContain('联接外部标题');

    const patch = await patchTitle(h, 570, { customTitle: '不能写入外部', expectedRevision: 1 });
    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(patch.body)).not.toContain('联接外部标题');

    const report = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir });
    expect(report.status).toBe(400);
    expect(report.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(report.body)).not.toContain('联接外部标题');

    // The external title file was neither read into a response nor modified.
    expect(fs.readFileSync(path.join(external, 'title.json'), 'utf8')).toBe(externalTitle);
  });

  it('never lists or reads through a linked reviews subdirectory (HTTP)', async (ctx) => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    expect((await patchTitle(h, 570, { customTitle: '子目录标题', expectedRevision: 0 })).status).toBe(200);

    const dataDir = h.config.dataDir;
    const reviewsPath = path.join(dataDir, '570', 'reviews');
    const external = path.join(h.root, 'external-reviews');
    fs.renameSync(reviewsPath, external);
    if (!tryCreateDirLink(external, reviewsPath)) ctx.skip();
    const externalTreeBefore = treeHash(external);

    const list = await request(h.app).get('/api/datasets').query({ dataDir });
    expect(list.status).toBe(400);
    expect(list.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(list.body)).not.toContain('Review r1 text');

    const preview = await request(h.app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 });
    expect(preview.status).toBe(400);
    expect(preview.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(preview.body)).not.toContain('Review r1 text');

    // PATCH may still succeed because it only touches title.json; what matters
    // is that it never follows the linked reviews directory or leaks its data.
    const patch = await patchTitle(h, 570, { customTitle: '不能经由子目录', expectedRevision: 1 });
    expect(JSON.stringify(patch.body)).not.toContain('Review r1 text');

    const report = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir });
    expect(report.status).toBe(400);
    expect(report.body.error.code).toBe('数据目录无效');
    expect(JSON.stringify(report.body)).not.toContain('Review r1 text');

    // Nothing below the linked directory was touched.
    expect(treeHash(external)).toBe(externalTreeBefore);
  });

  it('never reads a symlinked title file through any HTTP surface', async (ctx) => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    const dataDir = h.config.dataDir;

    // Keep the target in a separate temp dir so it is still present when the
    // data tree's symlink is cleaned up (a dangling link can break lstat on
    // Windows).
    const external = path.join(tmpDir(), 'outside-title.json');
    const externalBody = JSON.stringify({
      schemaVersion: 1,
      appid: 570,
      customTitle: '文件链接外部标题',
      revision: 9,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(external, externalBody, 'utf8');
    if (!tryCreateFileLink(external, titleFilePath(dataDir, 570))) ctx.skip();

    try {
      const responses = [
        await request(h.app).get('/api/datasets').query({ dataDir }),
        await request(h.app).post('/api/game/preview').set('Origin', ORIGIN).send({ appid: 570 }),
        await patchTitle(h, 570, { customTitle: '不能写入', expectedRevision: 0 }),
        await request(h.app).get(`/api/reports/570/${analysisHash}`).query({ dataDir }),
      ];
      for (const res of responses) {
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('数据目录无效');
        expect(JSON.stringify(res.body)).not.toContain('文件链接外部标题');
      }
      expect(fs.readFileSync(external, 'utf8')).toBe(externalBody);
    } finally {
      // Remove the link explicitly while its target still exists; Windows can
      // otherwise leave a dangling reparse point that the generic walk cannot
      // lstat.
      removeLinkSync(titleFilePath(dataDir, 570));
      fs.rmSync(external, { force: true, maxRetries: 10, retryDelay: 50 });
      // The test body has already passed. Windows CI can keep a handle on
      // game.json after the read-only symlink probes, so do not fail teardown
      // on a platform temp-dir quirk; the runner's temp dir is ephemeral.
      const rootIndex = tmpDirs.indexOf(h.root);
      if (rootIndex >= 0) tmpDirs.splice(rootIndex, 1);
      try {
        removeTreeSync(h.root);
      } catch (err) {
        console.warn('[title.api.test] best-effort temp cleanup failed', err);
      }
    }
  });

  it('escapes Markdown titles and keeps the fixed download filename', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    const title = '<script>alert(1)</script> # [link](https://evil.example)';
    const saved = await patchTitle(h, 570, { customTitle: title, expectedRevision: 0 });
    expect(saved.status).toBe(200);

    const markdown = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir, format: 'markdown' });
    expect(markdown.status).toBe(200);
    expect(String(markdown.headers['content-disposition'])).toBe(
      `attachment; filename="greview-570-${analysisHash}.md"`,
    );
    const text = String(markdown.text);
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(String(markdown.headers['content-disposition'])).not.toContain('script');
    expect(String(markdown.headers['content-disposition'])).not.toContain(encodeURIComponent('script'));
    // The JSON representation keeps the title as plain text data.
    const json = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(json.body.game.name).toBe(title);
  });
});

describe('report and SSE failure semantics', () => {
  it('returns 404 only for a missing report and 500 for corrupt or unreadable reports', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    const file = path.join(h.config.dataDir, '570', 'reports', `${analysisHash}.json`);
    const original = fs.readFileSync(file, 'utf8');

    const missing = await request(h.app)
      .get(`/api/reports/570/${'f'.repeat(16)}`)
      .query({ dataDir: h.config.dataDir });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('报告不存在');

    // Corrupt JSON: the report exists, so this is a 500, never a 404.
    fs.writeFileSync(file, '{not json', 'utf8');
    const corrupt = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(corrupt.status).toBe(500);
    expect(corrupt.body.error.code).toBe('INTERNAL');

    // Structurally valid JSON that fails the report model is also corruption.
    fs.writeFileSync(file, JSON.stringify({ version: '1.0', conclusion: {} }), 'utf8');
    const invalidModel = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(invalidModel.status).toBe(500);
    expect(invalidModel.body.error.code).toBe('INTERNAL');

    // Literal `null` content is a present-but-corrupt file, never "missing".
    fs.writeFileSync(file, 'null', 'utf8');
    const nullBody = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(nullBody.status).toBe(500);
    expect(nullBody.body.error.code).toBe('INTERNAL');

    // Ordinary read failure (permission): 500, not 400 数据目录无效 or 404.
    setContainedReadOpenErrorForTests((target) =>
      target.replace(/\\/g, '/').includes('/reports/') && target.endsWith('.json')
        ? errno('EACCES', 'denied')
        : null,
    );
    const unreadable = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(unreadable.status).toBe(500);
    expect(unreadable.body.error.code).toBe('INTERNAL');
    setContainedReadOpenErrorForTests(null);

    // The untouched report still serves normally.
    fs.writeFileSync(file, original, 'utf8');
    const good = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir });
    expect(good.status).toBe(200);
    expect(good.body.game.displayTitle).toBe('Test Game');
  });

  it('maps title-file access failures to 503 and keeps listings degraded with warnings', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const saved = await patchTitle(h, 570, { customTitle: '原标题', expectedRevision: 0 });
    expect(saved.status).toBe(200);
    const file = titleFilePath(h.config.dataDir, 570);
    const before = fs.readFileSync(file, 'utf8');

    setContainedReadOpenErrorForTests((target) =>
      target.endsWith('title.json') ? errno('EACCES', 'denied') : null,
    );
    const unreadable = await patchTitle(h, 570, { customTitle: '新标题', expectedRevision: 1 });
    expect(unreadable.status).toBe(503);
    expect(unreadable.body.error.code).toBe('存储不可写');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // Listing still succeeds and exposes the degradation through warnings.
    const list = await request(h.app).get('/api/datasets').query({ dataDir: h.config.dataDir });
    expect(list.status).toBe(200);
    expect(list.body.datasets[0].game).toMatchObject({
      displayTitle: 'Test Game',
      titleEditable: false,
      titleRevision: null,
    });
    expect(list.body.datasets[0].game.warnings.length).toBeGreaterThan(0);

    // Non-permission I/O failure is a 500 INTERNAL, not a false 409 conflict.
    setContainedReadOpenErrorForTests((target) =>
      target.endsWith('title.json') ? errno('EIO', 'io failure') : null,
    );
    const ioFailure = await patchTitle(h, 570, { customTitle: '新标题', expectedRevision: 1 });
    expect(ioFailure.status).toBe(500);
    expect(ioFailure.body.error.code).toBe('INTERNAL');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    setContainedReadOpenErrorForTests(null);
  });

  it('maps root permission probes to 503 for PATCH, 500 for listing, and keeps 404 for a missing root', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');

    setDataDirProbeErrorForTests(errno('EACCES', 'denied'));
    const denied = await patchTitle(h, 570, { customTitle: '新标题', expectedRevision: 0 });
    expect(denied.status).toBe(503);
    expect(denied.body.error.code).toBe('存储不可写');

    const listed = await request(h.app).get('/api/datasets').query({ dataDir: h.config.dataDir });
    expect(listed.status).toBe(500);
    expect(listed.body.error.code).toBe('INTERNAL');
    setDataDirProbeErrorForTests(null);

    const missingDir = await patchTitle(h, 570, { customTitle: 'x', expectedRevision: 0 }, {
      dataDir: path.join(h.config.dataDir, 'does-not-exist'),
    });
    expect(missingDir.status).toBe(404);
    expect(missingDir.body.error.code).toBe('本地游戏不存在');
  });

  it('sends an explicit SSE error instead of a cached done when presentation fails after subscription', async () => {
    const h = build();
    const first = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, first)).status).toBe('completed');
    const callsAfterFirst = h.ai.calls.length;
    const named = await patchTitle(h, 570, { customTitle: '完成前标题', expectedRevision: 0 });
    expect(named.status).toBe(200);

    // Block the second job's AI call so a live SSE subscription can be
    // established before completion.
    const entered = deferred();
    const release = deferred();
    h.ai.beforeCall = async (callIndex) => {
      if (callIndex === callsAfterFirst + 1) {
        entered.resolve();
        await release.promise;
      }
    };
    const jobId = await startJob(
      h.app,
      {
        options: { maxReviews: 50 },
        ai: { model: 'deepseek-v4-pro' },
        data: { forceAnalyze: true },
      },
      'sk-sse',
    );
    await Promise.race([
      entered.promise,
      sleep(5000).then(() => {
        throw new Error('second AI call did not start');
      }),
    ]);

    // Start the stream immediately (calling .then initiates the request).
    const streamPromise = request(h.app).get(`/api/jobs/${jobId}/stream`).then((res) => res);
    await sleep(150);

    // First title read (job completion) succeeds; the SSE subscriber's
    // re-presentation hits a link-level security failure.
    let titleOpens = 0;
    setContainedReadOpenErrorForTests((target) => {
      if (!target.endsWith('title.json')) return null;
      titleOpens += 1;
      return titleOpens === 2 ? errno('ELOOP', 'link loop') : null;
    });
    release.resolve();

    const stream = await streamPromise;
    expect(stream.status).toBe(200);
    const events = sseEvents(String(stream.text));
    expect(events.filter((event) => event.event === 'done')).toHaveLength(0);
    const errors = events.filter((event) => event.event === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data.code).toBe('数据目录无效');
    // The cached completion report (which carried the custom title) must not
    // be replayed as a success event.
    expect(String(stream.text)).not.toContain('完成前标题');

    // The underlying analysis itself completed; only that client's live view
    // was failed because the presentation could not be produced safely.
    setContainedReadOpenErrorForTests(null);
    const snapshot = await request(h.app).get(`/api/jobs/${jobId}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.status).toBe('completed');
    expect(snapshot.body.report.game.displayTitle).toBe('完成前标题');
  });

  it('replays done with a warnings presentation when only the title file degraded', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    expect((await patchTitle(h, 570, { customTitle: '旧标题', expectedRevision: 0 })).status).toBe(200);

    // Corrupt the title file after completion: a late SSE subscriber must get
    // the current fallback presentation with warnings, not the cached title.
    fs.writeFileSync(titleFilePath(h.config.dataDir, 570), '{broken', 'utf8');
    const stream = await request(h.app).get(`/api/jobs/${jobId}/stream`);
    expect(stream.status).toBe(200);
    const events = sseEvents(String(stream.text));
    const done = events.filter((event) => event.event === 'done');
    expect(done).toHaveLength(1);
    const game = (done[0].data.report as { game: Record<string, unknown> }).game;
    expect(game.displayTitle).toBe('Test Game');
    expect(game.titleEditable).toBe(false);
    expect(game.titleRevision).toBeNull();
    expect((game.warnings as string[]).length).toBeGreaterThan(0);
    expect(String(stream.text)).not.toContain('旧标题');
  });
});

describe('report metadata fallback when game.json is missing or corrupt', () => {
  function gameJsonPath(config: ServerConfig): string {
    return path.join(config.dataDir, '570', 'game.json');
  }

  async function reportGame(app: Express, config: ServerConfig, analysisHash: string) {
    const res = await request(app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: config.dataDir });
    expect(res.status).toBe(200);
    return res.body.game as Record<string, unknown>;
  }

  it('restores the real automatic name on every report surface after clearing a title with corrupt game.json', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    const done = await waitForJob(h.app, jobId);
    expect(done.status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    const reportPath = path.join(h.config.dataDir, '570', 'reports', `${analysisHash}.json`);
    const diskReportBefore = fs.readFileSync(reportPath, 'utf8');

    // A custom title was presented on the job report before game.json broke.
    const named = await patchTitle(h, 570, { customTitle: '旧自定义名称', expectedRevision: 0 });
    expect(named.status).toBe(200);
    fs.writeFileSync(gameJsonPath(h.config), '{broken game.json', 'utf8');

    // The report's own valid Steam metadata is the fallback: the automatic name
    // survives even though game.json no longer parses.
    const namedReport = await reportGame(h.app, h.config, analysisHash);
    expect(namedReport).toMatchObject({
      name: '旧自定义名称',
      displayTitle: '旧自定义名称',
      steamName: 'Test Game',
      customTitle: '旧自定义名称',
      titleSource: '自定义',
    });

    const cleared = await patchTitle(h, 570, { customTitle: null, expectedRevision: 1 });
    expect(cleared.status).toBe(200);

    // Report JSON: back to the real automatic name, not the AppID placeholder
    // and not the old custom title.
    const json = await reportGame(h.app, h.config, analysisHash);
    expect(json).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      customTitle: null,
      titleSource: '自动读取',
    });
    expect(JSON.stringify(json)).not.toContain('旧自定义名称');
    expect(json.name).not.toBe('AppID 570');
    // The persisted report itself is never rewritten by presentation.
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(diskReportBefore);

    // Markdown uses the same presented report.
    const markdown = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir, format: 'markdown' });
    expect(markdown.status).toBe(200);
    expect(String(markdown.text)).toContain('# GReview 口碑报告：Test Game');
    expect(String(markdown.text)).not.toContain('旧自定义名称');
    expect(String(markdown.text)).not.toContain('AppID 570');

    // Task report endpoint re-resolves the cleared title from the cached
    // presented report and must use its steamName, never its old custom name.
    const jobReport = await request(h.app).get(`/api/jobs/${jobId}/report`);
    expect(jobReport.status).toBe(200);
    expect(jobReport.body.game).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      customTitle: null,
      titleSource: '自动读取',
    });
    expect(JSON.stringify(jobReport.body.game)).not.toContain('旧自定义名称');

    // Task snapshot and a late SSE subscriber use the same presentation rule.
    const snapshot = await request(h.app).get(`/api/jobs/${jobId}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.report.game).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      titleSource: '自动读取',
    });

    const stream = await request(h.app).get(`/api/jobs/${jobId}/stream`);
    expect(stream.status).toBe(200);
    const doneEvents = sseEvents(String(stream.text)).filter((event) => event.event === 'done');
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0].data.report as { game: Record<string, unknown> }).game).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      titleSource: '自动读取',
    });
    expect(String(stream.text)).not.toContain('旧自定义名称');
    // Only the cover placeholder may mention the AppID; the title must not.
    expect(String(stream.text)).not.toContain('"name":"AppID 570"');
  });

  it('uses dataset meta.game when game.json is missing and the report name is a fallback', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');
    const reportPath = path.join(h.config.dataDir, '570', 'reports', `${analysisHash}.json`);

    // The stored report carries only a generated fallback name; the dataset
    // metadata written next to it still has the real Steam name.
    const stored = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { game: Record<string, unknown> };
    stored.game.name = 'App 570';
    fs.writeFileSync(reportPath, JSON.stringify(stored), 'utf8');
    fs.rmSync(gameJsonPath(h.config), { force: true });

    const game = await reportGame(h.app, h.config, analysisHash);
    expect(game).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      titleSource: '自动读取',
    });

    const markdown = await request(h.app)
      .get(`/api/reports/570/${analysisHash}`)
      .query({ dataDir: h.config.dataDir, format: 'markdown' });
    expect(markdown.status).toBe(200);
    expect(String(markdown.text)).toContain('# GReview 口碑报告：Test Game');
    expect(String(markdown.text)).not.toContain('AppID 570');
  });

  it('falls back to the report original game.name when game.json and dataset metadata are both missing', async () => {
    const h = build();
    const jobId = await startJob(h.app, { options: { maxReviews: 50 } });
    expect((await waitForJob(h.app, jobId)).status).toBe('completed');
    const { reviewsHash } = await datasetInfo(h.app, h.config);
    const analysisHash = reportsOf(h.config)[0].replace(/\.json$/, '');

    fs.rmSync(gameJsonPath(h.config), { force: true });
    fs.rmSync(path.join(h.config.dataDir, '570', 'reviews', reviewsHash, 'meta.json'), { force: true });

    const game = await reportGame(h.app, h.config, analysisHash);
    expect(game).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      titleSource: '自动读取',
    });
    expect(game.name).not.toBe('AppID 570');
  });
});
