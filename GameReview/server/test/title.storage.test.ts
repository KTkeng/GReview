import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../src/lib/hash';
import {
  buildGamePresentation,
  presentReport,
  presentReportForApp,
  placeholderTitle,
} from '../src/storage/presentation';
import {
  normalizeCustomTitle,
  readTitleOverride,
  removeTitleOverride,
  resetTitleFsOpsForTests,
  setTitleFsOpsForTests,
  titleFilePath,
  updateGameTitle,
  type TitleUpdateOutcome,
} from '../src/storage/game-title';
import {
  buildReviewsHash,
  deleteDataset,
  gameFilePath,
  getDatasetDetail,
  listDatasets,
  metaFilePath,
  readGameMeta,
  writeDataset,
  type ReviewsHashInput,
} from '../src/storage/dataset';
import { buildAnalysisHash } from '../src/storage/report';
import {
  canonicalStorageRoot,
  captureStorageEpoch,
  storageRootKey,
  withStorageLock,
} from '../src/storage/lock';
import { setContainedReadOpenErrorForTests, setDataDirProbeErrorForTests } from '../src/storage/paths';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { DatasetMeta, GameMeta, Report } from '../src/types';
import { SAMPLE_REVIEWS, SAMPLE_SUMMARY } from './helpers';

const HASH_A = 'a'.repeat(16);
const HASH_B = 'b'.repeat(16);

const tmpDirs: string[] = [];
function tmpDir(prefix = 'greview-title-storage-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Errno values that genuinely mean "this platform cannot create links". */
function isLinkCapabilityError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EINVAL';
}

/**
 * Create a directory link/junction; returns false ONLY when the platform or
 * its permissions forbid link creation. A construction bug such as EEXIST must
 * fail the test instead of silently skipping this security coverage.
 */
function tryCreateDirLink(linkPath: string, target: string): boolean {
  const types: Array<'junction' | 'dir'> = process.platform === 'win32' ? ['junction', 'dir'] : ['dir'];
  for (const type of types) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (err) {
      if (!isLinkCapabilityError(err)) throw err;
    }
  }
  return false;
}

/** Create a file symlink; returns false only when the platform refuses. */
function tryCreateFileLink(linkPath: string, target: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch (err) {
    if (!isLinkCapabilityError(err)) throw err;
    return false;
  }
}

afterEach(() => {
  resetTitleFsOpsForTests();
  setContainedReadOpenErrorForTests(null);
  setDataDirProbeErrorForTests(null);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dataDirOf(root: string): string {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function optionsFor(root: string): { projectRoot: string; defaultDataDir: string } {
  return { projectRoot: root, defaultDataDir: path.join(root, 'data') };
}

/** Minimal local game: a reviews/<hash> directory is what proves existence. */
function makeGame(dataDir: string, appid = 570, reviewsHash = HASH_A): void {
  fs.mkdirSync(path.join(dataDir, String(appid), 'reviews', reviewsHash), { recursive: true });
}

function metaFor(appid: number, reviewsHash: string, maxReviews = 200): Omit<DatasetMeta, 'reviewsContentHash' | 'reviewCount' | 'status'> {
  return {
    appid,
    game: { appid, name: 'Test Game' },
    reviewsHash,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    maxReviews,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    sourceEndpoint: 'official',
    summary: SAMPLE_SUMMARY,
  };
}

function reviewsHashFor(maxReviews = 200): string {
  const input: ReviewsHashInput = {
    appid: 570,
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    maxReviews,
  };
  return buildReviewsHash(input);
}

function expectOk(outcome: TitleUpdateOutcome): Extract<TitleUpdateOutcome, { status: 'ok' }> {
  if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
  return outcome;
}

function readTitleFile(dataDir: string, appid = 570): { schemaVersion: number; appid: number; customTitle: string | null; revision: number; updatedAt: string } {
  return JSON.parse(fs.readFileSync(titleFilePath(dataDir, appid), 'utf8')) as {
    schemaVersion: number;
    appid: number;
    customTitle: string | null;
    revision: number;
    updatedAt: string;
  };
}

describe('custom title normalization', () => {
  it('applies NFC, trims, treats blank as null and preserves internal spaces and emoji', () => {
    expect(normalizeCustomTitle(null)).toBeNull();
    expect(normalizeCustomTitle('')).toBeNull();
    expect(normalizeCustomTitle('   ')).toBeNull();
    expect(normalizeCustomTitle('  Dota  2  ')).toBe('Dota  2');
    // e + combining acute -> single NFC code point.
    expect(normalizeCustomTitle('e\u0301')).toBe('\u00e9');
    // Emoji are counted by code point, not UTF-16 length.
    expect(normalizeCustomTitle('😀'.repeat(120))).toBe('😀'.repeat(120));
    expect([...('😀'.repeat(120))].length).toBe(120);
  });

  it('rejects 121 code points, control characters, line breaks and bidi controls', () => {
    expect(() => normalizeCustomTitle('😀'.repeat(121))).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\nb')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\rb')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\u0000b')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\u007fb')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\u2028b')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\u202eb')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('a\u2066b')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle(5 as unknown as string)).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle(['x'] as unknown as string)).toThrow('INVALID_PARAMS');
  });

  it('rejects control/bidi characters before trimming (leading/trailing/newline-only)', () => {
    // Trimming first used to launder these into valid titles.
    expect(() => normalizeCustomTitle('\nTitle')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('Title\n')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('\n\r\t')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('\tTitle\t')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle(' \n ')).toThrow('INVALID_PARAMS');
    // U+061C (Arabic Letter Mark) must be rejected like other bidi controls.
    expect(() => normalizeCustomTitle('a؜b')).toThrow('INVALID_PARAMS');
    expect(() => normalizeCustomTitle('؜Title')).toThrow('INVALID_PARAMS');
    // Format characters required by normal emoji sequences stay allowed.
    expect(normalizeCustomTitle('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(normalizeCustomTitle('❤️')).toBe('❤️');
  });
});

describe('storage root identity', () => {
  it('keeps case-distinct real data roots isolated on case-sensitive filesystems', async (ctx) => {
    const root = tmpDir();
    const lower = path.join(root, 'data');
    const upper = path.join(root, 'DATA');
    fs.mkdirSync(lower, { recursive: true });
    fs.mkdirSync(upper, { recursive: true });
    // Runtime capability probe: on case-insensitive filesystems the two
    // spellings are the same directory. That is a platform limit (skip), not
    // a reason to stop exercising the POSIX isolation contract.
    const probe = path.join(lower, `.case-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x', 'utf8');
    const caseInsensitive = fs.existsSync(path.join(upper, path.basename(probe)));
    fs.rmSync(probe, { force: true });
    if (caseInsensitive) ctx.skip();

    expect(await canonicalStorageRoot(lower)).not.toBe(await canonicalStorageRoot(upper));
    expect(storageRootKey(lower)).not.toBe(storageRootKey(upper));

    const epochLower = await captureStorageEpoch(lower);
    const epochUpper = await captureStorageEpoch(upper);
    expect(epochLower).toBe(0);
    expect(epochUpper).toBe(0);

    // Clearing one root bumps only its own epoch and invalidates only writes
    // that captured that epoch. The other root keeps its epoch and writes.
    await withStorageLock(lower, async () => undefined, { bumpEpoch: true });
    expect(await captureStorageEpoch(lower)).toBe(epochLower + 1);
    expect(await captureStorageEpoch(upper)).toBe(epochUpper);
    await expect(withStorageLock(lower, async () => 'stale', { epoch: epochLower })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await expect(withStorageLock(upper, async () => 'still-valid', { epoch: epochUpper })).resolves.toBe(
      'still-valid',
    );
  });
});

describe('GamePresentation three-tier fallback', () => {
  const missing = { status: 'missing' as const, appid: 570, revision: 0 as const, customTitle: null, updatedAt: null, editable: true as const };

  it('prefers custom title, then a valid Steam name, then the AppID placeholder', () => {
    const custom = buildGamePresentation({ appid: 570, name: 'Steam Name' }, 570, {
      status: 'ok',
      appid: 570,
      editable: true,
      title: {
        schemaVersion: 1,
        appid: 570,
        customTitle: '自定义名称',
        revision: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });
    expect(custom).toMatchObject({
      name: '自定义名称',
      displayTitle: '自定义名称',
      steamName: 'Steam Name',
      customTitle: '自定义名称',
      titleSource: '自定义',
      titleRevision: 3,
      titleUpdatedAt: '2026-01-02T00:00:00.000Z',
      titleEditable: true,
      coverPlaceholder: 'AppID 570',
      warnings: [],
    });

    const automatic = buildGamePresentation({ appid: 570, name: 'Steam Name' }, 570, missing);
    expect(automatic).toMatchObject({
      name: 'Steam Name',
      displayTitle: 'Steam Name',
      steamName: 'Steam Name',
      customTitle: null,
      titleSource: '自动读取',
      titleRevision: 0,
      titleUpdatedAt: null,
    });

    const placeholder = buildGamePresentation({ appid: 570, name: 'App 570' }, 570, missing);
    expect(placeholder).toMatchObject({
      name: placeholderTitle(570),
      displayTitle: 'AppID 570',
      steamName: null,
      titleSource: '编号占位',
    });
    // Legacy automatic fallbacks are never treated as a real Steam name.
    for (const legacy of ['AppID 570', 'App 570', '570', '  ', '']) {
      expect(buildGamePresentation({ appid: 570, name: legacy }, 570, missing).steamName).toBeNull();
    }
    const nullMeta = buildGamePresentation(null, 570, missing);
    expect(nullMeta.displayTitle).toBe('AppID 570');
    expect(nullMeta.name).toBe('AppID 570');
    expect(nullMeta.appid).toBe(570);
  });

  it('exposes only http(s) cover URLs and reports corrupt title state as warnings', () => {
    const missing = { status: 'missing' as const, appid: 570, revision: 0 as const, customTitle: null, updatedAt: null, editable: true as const };
    expect(buildGamePresentation({ appid: 570, name: 'X', headerImage: 'https://cdn.example/a.jpg' }, 570, missing).coverUrl).toBe(
      'https://cdn.example/a.jpg',
    );
    expect(buildGamePresentation({ appid: 570, name: 'X', headerImage: 'http://cdn.example/a.jpg' }, 570, missing).coverUrl).toBe(
      'http://cdn.example/a.jpg',
    );
    expect(buildGamePresentation({ appid: 570, name: 'X', headerImage: 'javascript:alert(1)' }, 570, missing).coverUrl).toBeNull();
    expect(buildGamePresentation({ appid: 570, name: 'X', headerImage: 'not a url' }, 570, missing).coverUrl).toBeNull();

    const corrupt = buildGamePresentation({ appid: 570, name: 'Steam Name' }, 570, {
      status: 'corrupt',
      appid: 570,
      reason: 'JSON 无法解析',
      warning: '标题文件损坏',
      editable: false,
    });
    expect(corrupt.titleEditable).toBe(false);
    expect(corrupt.titleRevision).toBeNull();
    expect(corrupt.customTitle).toBeNull();
    expect(corrupt.displayTitle).toBe('Steam Name');
    expect(corrupt.warnings).toContain('标题文件损坏');
  });
});

describe('title.json persistence', () => {
  it('treats a missing file as revision 0 and never creates it on read/clear', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);

    const missing = await readTitleOverride(dataDir, 570);
    expect(missing).toMatchObject({ status: 'missing', revision: 0, customTitle: null, editable: true });
    expect(fs.existsSync(titleFilePath(dataDir, 570))).toBe(false);

    const cleared = expectOk(await updateGameTitle(dataDir, 570, null, 0, opts));
    expect(cleared.changed).toBe(false);
    expect(cleared.revision).toBe(0);
    expect(fs.existsSync(titleFilePath(dataDir, 570))).toBe(false);
  });

  it('writes atomically with revision/updatedAt and keeps the revision record when cleared', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);

    const first = expectOk(
      await updateGameTitle(dataDir, 570, '  My Game  ', 0, {
        ...opts,
        now: () => new Date('2026-02-03T04:05:06.000Z'),
      }),
    );
    expect(first.changed).toBe(true);
    expect(first.revision).toBe(1);
    expect(readTitleFile(dataDir)).toEqual({
      schemaVersion: 1,
      appid: 570,
      customTitle: 'My Game',
      revision: 1,
      updatedAt: '2026-02-03T04:05:06.000Z',
    });

    // Same normalised value: no write, no revision bump.
    const same = expectOk(await updateGameTitle(dataDir, 570, 'My Game', 1, opts));
    expect(same.changed).toBe(false);
    expect(same.revision).toBe(1);
    expect(readTitleFile(dataDir).revision).toBe(1);

    // Clearing keeps title.json (revision + updatedAt) as required.
    const cleared = expectOk(await updateGameTitle(dataDir, 570, '   ', 1, opts));
    expect(cleared.changed).toBe(true);
    expect(cleared.revision).toBe(2);
    expect(readTitleFile(dataDir)).toMatchObject({ customTitle: null, revision: 2 });

    const again = expectOk(await updateGameTitle(dataDir, 570, null, 2, opts));
    expect(again.changed).toBe(false);
    expect(again.revision).toBe(2);
  });

  it('rejects stale revisions even when the submitted title is unchanged', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);

    expectOk(await updateGameTitle(dataDir, 570, 'A', 0, opts));
    const stale = await updateGameTitle(dataDir, 570, 'A', 0, opts);
    expect(stale.status).toBe('conflict');
    if (stale.status !== 'conflict') throw new Error('expected conflict');
    expect(stale.currentRevision).toBe(1);
    expect(stale.state.status).toBe('ok');
    expect(readTitleFile(dataDir).customTitle).toBe('A');
  });

  it('degrades unsupported/corrupt files without overwriting them and refuses updates', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);
    const file = titleFilePath(dataDir, 570);

    fs.writeFileSync(file, '{not json', 'utf8');
    const corrupt = await readTitleOverride(dataDir, 570);
    expect(corrupt).toMatchObject({ status: 'corrupt', editable: false });
    if (corrupt.status !== 'corrupt') throw new Error('expected corrupt');
    expect(corrupt.warning).toContain('title.json');
    expect((await updateGameTitle(dataDir, 570, 'New', 0, opts)).status).toBe('corrupt');
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');

    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 2, appid: 570, customTitle: 'X', revision: 1, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    expect((await readTitleOverride(dataDir, 570)).status).toBe('corrupt');

    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, appid: 999, customTitle: 'X', revision: 1, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    expect((await readTitleOverride(dataDir, 570)).status).toBe('corrupt');

    // Not canonical (leading space) -> corrupt rather than silently usable.
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, appid: 570, customTitle: ' X ', revision: 1, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    expect((await readTitleOverride(dataDir, 570)).status).toBe('corrupt');
  });

  it('injects failures at the real open/write/sync/rename boundaries and preserves the old file', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);
    expectOk(await updateGameTitle(dataDir, 570, 'Old', 0, opts));
    const file = titleFilePath(dataDir, 570);
    const before = fs.readFileSync(file, 'utf8');

    // Real open fails: no temp file is created, old file untouched.
    setTitleFsOpsForTests({
      open: async () => {
        throw errno('EACCES', 'denied');
      },
    });
    await expect(updateGameTitle(dataDir, 570, 'New', 1, opts)).rejects.toMatchObject({
      code: 'TITLE_NOT_WRITABLE',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(dataDir, '570')).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Real partial write followed by ENOSPC: the temp file is genuinely
    // written to disk before the failure, then cleaned up.
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
    await expect(updateGameTitle(dataDir, 570, 'New', 1, opts)).rejects.toMatchObject({
      code: 'TITLE_NO_SPACE',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(dataDir, '570')).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Real write succeeded, real fsync fails: previous file stays byte-identical.
    setTitleFsOpsForTests({
      open: async (target, flags) => {
        const real = await fsp.open(target, flags);
        return {
          writeFile: (data, encoding) => real.writeFile(data, encoding),
          sync: async () => {
            throw errno('EIO', 'sync failed');
          },
          close: () => real.close(),
        };
      },
    });
    await expect(updateGameTitle(dataDir, 570, 'New', 1, opts)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(dataDir, '570')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('retries rename five times on transient busy and succeeds when it clears', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);
    expectOk(await updateGameTitle(dataDir, 570, 'Old', 0, opts));

    let attempts = 0;
    setTitleFsOpsForTests({
      rename: async (from, to) => {
        attempts += 1;
        if (attempts <= 2) throw errno('EBUSY', 'busy');
        await fsp.rename(from, to);
      },
    });
    const outcome = expectOk(await updateGameTitle(dataDir, 570, 'New', 1, opts));
    expect(outcome.changed).toBe(true);
    expect(outcome.revision).toBe(2);
    expect(attempts).toBe(3);
    expect(readTitleFile(dataDir).customTitle).toBe('New');
  });

  it('gives up after five persistent rename failures, keeps the old file and cleans the temp file', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);
    expectOk(await updateGameTitle(dataDir, 570, 'Old', 0, opts));
    const file = titleFilePath(dataDir, 570);
    const before = fs.readFileSync(file, 'utf8');

    let attempts = 0;
    setTitleFsOpsForTests({
      rename: async () => {
        attempts += 1;
        throw errno('EBUSY', 'busy');
      },
    });
    await expect(updateGameTitle(dataDir, 570, 'New', 1, opts)).rejects.toMatchObject({ code: 'TITLE_BUSY' });
    expect(attempts).toBe(5);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(dataDir, '570')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects non-ISO persisted timestamps instead of accepting Date.parse leniency', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const file = titleFilePath(dataDir, 570);
    const write = (updatedAt: string): void => {
      fs.writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, appid: 570, customTitle: 'X', revision: 1, updatedAt }),
        'utf8',
      );
    };

    for (const bad of [
      '2026-01-01',
      'January 1, 2026',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000+00:00',
      '2026-02-30T00:00:00.000Z',
    ]) {
      write(bad);
      expect((await readTitleOverride(dataDir, 570)).status, bad).toBe('corrupt');
    }
    write('2026-01-01T00:00:00.000Z');
    expect((await readTitleOverride(dataDir, 570)).status).toBe('ok');
  });

  it('refuses to increment beyond the safe-integer revision bound and keeps the file', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const file = titleFilePath(dataDir, 570);
    const raw = {
      schemaVersion: 1,
      appid: 570,
      customTitle: 'Max',
      revision: Number.MAX_SAFE_INTEGER,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    const before = fs.readFileSync(file, 'utf8');

    const outcome = await updateGameTitle(dataDir, 570, 'New', Number.MAX_SAFE_INTEGER, optionsFor(root));
    expect(outcome.status).toBe('corrupt');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('bounds title reads so an oversized corrupt file only degrades that game', async () => {
    const dataDir = dataDirOf(tmpDir());
    const hashA = reviewsHashFor(200);
    const hashB = reviewsHashFor(201);
    await writeDataset(dataDir, metaFor(570, hashA, 200), SAMPLE_REVIEWS);
    await writeDataset(dataDir, metaFor(730, hashB, 201), SAMPLE_REVIEWS);
    fs.writeFileSync(
      titleFilePath(dataDir, 570),
      `{"schemaVersion":1,"appid":570,"customTitle":"${'a'.repeat(70 * 1024)}","revision":1,"updatedAt":"2026-01-01T00:00:00.000Z"}`,
      'utf8',
    );

    const state = await readTitleOverride(dataDir, 570);
    expect(state.status).toBe('corrupt');
    if (state.status !== 'corrupt') throw new Error('expected corrupt');
    expect(state.reason).toContain('过大');

    const listed = await listDatasets(dataDir);
    const game570 = listed.find((item) => item.appid === 570);
    const game730 = listed.find((item) => item.appid === 730);
    expect(game570?.game.titleEditable).toBe(false);
    expect(game570?.game.warnings.length).toBeGreaterThan(0);
    expect(game730?.game.displayTitle).toBe('Test Game');
  });

  it('degrades ordinary title open/read failures locally and maps updates to 503/500', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);
    expectOk(await updateGameTitle(dataDir, 570, '原标题', 0, opts));
    const file = titleFilePath(dataDir, 570);
    const before = fs.readFileSync(file, 'utf8');

    // Permission-class open failure: listing stays available with a warning.
    setContainedReadOpenErrorForTests((target) =>
      target.endsWith('title.json') ? errno('EACCES', 'denied') : null,
    );
    const state = await readTitleOverride(dataDir, 570);
    expect(state).toMatchObject({ status: 'unavailable', editable: false, permission: true });
    if (state.status !== 'unavailable') throw new Error('expected unavailable');
    expect(state.warning).toContain('不可访问');

    const listed = await listDatasets(dataDir);
    expect(listed).toHaveLength(1);
    expect(listed[0].game.titleEditable).toBe(false);
    expect(listed[0].game.titleRevision).toBeNull();
    expect(listed[0].game.warnings).toContain(state.warning);
    // This fixture has no game.json, so the automatic name falls back to the
    // AppID placeholder while the title file is unreadable.
    expect(listed[0].game.displayTitle).toBe('AppID 570');

    // A PATCH cannot verify the revision safely: permission -> 503.
    await expect(updateGameTitle(dataDir, 570, '新标题', 1, opts)).rejects.toMatchObject({
      code: 'TITLE_NOT_WRITABLE',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // Non-permission I/O failure: other persistence failure -> 500.
    setContainedReadOpenErrorForTests((target) =>
      target.endsWith('title.json') ? errno('EIO', 'io failure') : null,
    );
    await expect(updateGameTitle(dataDir, 570, '新标题', 1, opts)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // The injected failures are gone; the real file is intact and editable.
    setContainedReadOpenErrorForTests(null);
    const healthy = await readTitleOverride(dataDir, 570);
    expect(healthy.status).toBe('ok');
    expect(fs.readdirSync(path.join(dataDir, '570')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('classifies root permission probes as 503 for updates and 500 for listings', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);
    expectOk(await updateGameTitle(dataDir, 570, '原标题', 0, opts));

    setDataDirProbeErrorForTests(errno('EACCES', 'denied'));
    await expect(updateGameTitle(dataDir, 570, '新标题', 1, opts)).rejects.toMatchObject({
      code: 'STORAGE_NOT_WRITABLE',
    });
    await expect(listDatasets(dataDir)).rejects.toMatchObject({ code: 'INTERNAL' });

    // A genuinely missing root remains "game not found" for updates.
    setDataDirProbeErrorForTests(errno('ENOENT', 'missing'));
    await expect(updateGameTitle(dataDir, 570, '新标题', 1, opts)).rejects.toMatchObject({
      code: 'GAME_NOT_FOUND',
    });

    setDataDirProbeErrorForTests(null);
    expect((await readTitleOverride(dataDir, 570)).status).toBe('ok');
  });

  it('removeTitleOverride aborts on link validation and leaves the external file intact', async (ctx) => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    const external = path.join(root, 'external');
    fs.mkdirSync(external, { recursive: true });
    const externalTitle = path.join(external, 'title.json');
    fs.writeFileSync(externalTitle, '{"keep":true}', 'utf8');
    // Link the *missing* game directory to an external directory. Creating the
    // real 570 directory first would make symlinkSync fail with EEXIST, which
    // used to be swallowed as a skip and left this security case unexecuted.
    if (!tryCreateDirLink(path.join(dataDir, '570'), external)) ctx.skip();

    let rmCalls = 0;
    setTitleFsOpsForTests({
      rm: async () => {
        rmCalls += 1;
      },
    });
    await expect(removeTitleOverride(dataDir, 570)).rejects.toMatchObject({ code: 'DATA_DIR_FORBIDDEN' });
    expect(rmCalls).toBe(0);
    expect(fs.existsSync(externalTitle)).toBe(true);
    expect(fs.readFileSync(externalTitle, 'utf8')).toBe('{"keep":true}');
  });

  it('removeTitleOverride rejects a symlinked title file without deleting its target', async (ctx) => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const external = path.join(root, 'outside-title.json');
    fs.writeFileSync(external, '{"keep":"outside"}', 'utf8');
    if (!tryCreateFileLink(titleFilePath(dataDir, 570), external)) ctx.skip();

    let rmCalls = 0;
    setTitleFsOpsForTests({
      rm: async () => {
        rmCalls += 1;
      },
    });
    await expect(removeTitleOverride(dataDir, 570)).rejects.toMatchObject({ code: 'DATA_DIR_FORBIDDEN' });
    expect(rmCalls).toBe(0);
    expect(fs.readFileSync(external, 'utf8')).toBe('{"keep":"outside"}');
  });

  it('readTitleOverride rejects a linked title file instead of reading external content', async (ctx) => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const external = path.join(root, 'outside-title.json');
    fs.writeFileSync(
      external,
      JSON.stringify({ schemaVersion: 1, appid: 570, customTitle: '外部标题', revision: 9, updatedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );
    if (!tryCreateFileLink(titleFilePath(dataDir, 570), external)) ctx.skip();

    await expect(readTitleOverride(dataDir, 570)).rejects.toMatchObject({ code: 'DATA_DIR_FORBIDDEN' });
  });

  it('serializes concurrent updates so exactly one wins the revision race', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    makeGame(dataDir);
    const opts = optionsFor(root);

    const outcomes = await Promise.all([
      updateGameTitle(dataDir, 570, 'First', 0, opts),
      updateGameTitle(dataDir, 570, 'Second', 0, opts),
    ]);
    const winners = outcomes.filter((o) => o.status === 'ok');
    const conflicts = outcomes.filter((o) => o.status === 'conflict');
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    if (winners[0].status !== 'ok') throw new Error('expected ok');
    expect(winners[0].changed).toBe(true);
    if (conflicts[0].status !== 'conflict') throw new Error('expected conflict');
    expect(conflicts[0].currentRevision).toBe(1);
    const stored = await readTitleOverride(dataDir, 570);
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') throw new Error('expected ok');
    expect(['First', 'Second']).toContain(stored.title.customTitle);
  });

  it('does not let a title update create an arbitrary game directory', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    fs.mkdirSync(path.join(dataDir, '730'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, '730', 'game.json'), JSON.stringify({ appid: 730, name: 'Only meta' }), 'utf8');
    await expect(updateGameTitle(dataDir, 730, 'Nope', 0, optionsFor(root))).rejects.toMatchObject({
      code: 'GAME_NOT_FOUND',
    });
    expect(fs.existsSync(titleFilePath(dataDir, 730))).toBe(false);
  });
});

describe('presentation integration with datasets and reports', () => {
  it('shares one custom title across datasets of the same app/directory and isolates other directories', async () => {
    const rootA = tmpDir();
    const dataDirA = dataDirOf(rootA);
    const hashA = reviewsHashFor(200);
    const hashB = reviewsHashFor(201);
    await writeDataset(dataDirA, metaFor(570, hashA, 200), SAMPLE_REVIEWS);
    await writeDataset(dataDirA, metaFor(570, hashB, 201), SAMPLE_REVIEWS);
    expect(fs.existsSync(titleFilePath(dataDirA, 570))).toBe(false);

    expectOk(await updateGameTitle(dataDirA, 570, '共享标题', 0, optionsFor(rootA)));
    const listed = await listDatasets(dataDirA);
    expect(listed).toHaveLength(2);
    for (const item of listed) {
      expect(item.game).toMatchObject({
        displayTitle: '共享标题',
        name: '共享标题',
        steamName: 'Test Game',
        customTitle: '共享标题',
        titleSource: '自定义',
        titleRevision: 1,
      });
      expect(item.sizeBytes).toBeGreaterThan(0);
      expect(item.bytes).toBe(item.sizeBytes);
    }
    const detail = await getDatasetDetail(dataDirA, 570, hashA);
    expect(detail?.game.displayTitle).toBe('共享标题');
    expect(detail?.dataset.game.displayTitle).toBe('共享标题');
    // Persisted fetch metadata is untouched by the rename.
    expect(detail?.meta.game.name).toBe('Test Game');
    expect((await readGameMeta(dataDirA, 570))?.name).toBe('Test Game');

    const rootB = tmpDir();
    const dataDirB = dataDirOf(rootB);
    await writeDataset(dataDirB, metaFor(570, hashA, 200), SAMPLE_REVIEWS);
    const other = await listDatasets(dataDirB);
    expect(other[0].game.displayTitle).toBe('Test Game');
    expect(other[0].game.customTitle).toBeNull();
  });

  it('degrades to warnings in list/detail when a title file is corrupt', async () => {
    const dataDir = dataDirOf(tmpDir());
    const hash = reviewsHashFor();
    await writeDataset(dataDir, metaFor(570, hash), SAMPLE_REVIEWS);
    fs.writeFileSync(titleFilePath(dataDir, 570), '{bad', 'utf8');

    const listed = await listDatasets(dataDir);
    expect(listed[0].game.titleEditable).toBe(false);
    expect(listed[0].game.titleRevision).toBeNull();
    expect(listed[0].game.displayTitle).toBe('Test Game');
    expect(listed[0].game.warnings.length).toBeGreaterThan(0);

    const detail = await getDatasetDetail(dataDir, 570, hash);
    expect(detail?.game.warnings.length).toBeGreaterThan(0);
  });

  it('removes the custom title only when the last dataset/report for the game is gone', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    const hashA = reviewsHashFor(200);
    const hashB = reviewsHashFor(201);
    await writeDataset(dataDir, metaFor(570, hashA, 200), SAMPLE_REVIEWS);
    await writeDataset(dataDir, metaFor(570, hashB, 201), SAMPLE_REVIEWS);
    expectOk(await updateGameTitle(dataDir, 570, 'Keep me', 0, optionsFor(root)));
    const file = titleFilePath(dataDir, 570);

    await deleteDataset(dataDir, 570, hashA, optionsFor(root));
    expect(fs.existsSync(file)).toBe(true);

    await deleteDataset(dataDir, 570, hashB, optionsFor(root));
    expect(fs.existsSync(file)).toBe(false);

    // A surviving report file also keeps the title alive.
    const reportRoot = tmpDir();
    const reportDir = dataDirOf(reportRoot);
    const reportHash = reviewsHashFor(300);
    await writeDataset(reportDir, metaFor(570, reportHash, 300), SAMPLE_REVIEWS);
    expectOk(await updateGameTitle(reportDir, 570, 'Report keeps me', 0, optionsFor(reportRoot)));
    fs.mkdirSync(path.join(reportDir, '570', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(reportDir, '570', 'reports', `${HASH_B}.json`), '{}', 'utf8');
    await deleteDataset(reportDir, 570, reportHash, optionsFor(reportRoot));
    expect(fs.existsSync(titleFilePath(reportDir, 570))).toBe(true);
  });

  it('removes the whole game directory after the last dataset is deleted, and keeps it otherwise', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    const hashA = reviewsHashFor(200);
    const hashB = reviewsHashFor(201);
    await writeDataset(dataDir, metaFor(570, hashA, 200), SAMPLE_REVIEWS);
    await writeDataset(dataDir, metaFor(570, hashB, 201), SAMPLE_REVIEWS);
    expectOk(await updateGameTitle(dataDir, 570, '目录清理', 0, optionsFor(root)));
    const appPath = path.join(dataDir, '570');
    fs.mkdirSync(path.join(appPath, 'trends'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'trends', `${'c'.repeat(16)}.json`), '{"cache":true}', 'utf8');

    await deleteDataset(dataDir, 570, hashA, optionsFor(root));
    // Another dataset remains: keep the game directory, metadata, title and
    // trend cache; only the deleted dataset directory is gone.
    for (const rel of ['game.json', 'title.json', 'trends', path.join('reviews', hashB)]) {
      expect(fs.existsSync(path.join(appPath, rel)), rel).toBe(true);
    }
    expect(fs.existsSync(path.join(appPath, 'reviews', hashA))).toBe(false);

    await deleteDataset(dataDir, 570, hashB, optionsFor(root));
    // Last dataset gone and no reports: the entire game directory, including
    // game.json, title.json, trends and the now-empty reviews/ parent, is gone.
    expect(fs.existsSync(appPath)).toBe(false);
  });

  it('keeps game metadata, title and trends while a report from another dataset remains', async () => {
    const root = tmpDir();
    const dataDir = dataDirOf(root);
    const hash = reviewsHashFor(300);
    await writeDataset(dataDir, metaFor(570, hash, 300), SAMPLE_REVIEWS);
    expectOk(await updateGameTitle(dataDir, 570, '报告保留', 0, optionsFor(root)));
    const appPath = path.join(dataDir, '570');
    fs.mkdirSync(path.join(appPath, 'trends'), { recursive: true });
    fs.mkdirSync(path.join(appPath, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'reports', `${HASH_B}.json`), '{}', 'utf8');

    await deleteDataset(dataDir, 570, hash, optionsFor(root));
    for (const rel of ['game.json', 'title.json', 'trends', 'reports']) {
      expect(fs.existsSync(path.join(appPath, rel)), rel).toBe(true);
    }
    expect(fs.existsSync(path.join(appPath, 'reviews', hash))).toBe(false);
  });

  it('does not let the custom title affect reviews/trend/analysis hashes', async () => {
    const dataDir = dataDirOf(tmpDir());
    const hash = reviewsHashFor();
    await writeDataset(dataDir, metaFor(570, hash), SAMPLE_REVIEWS);
    const reviewsInput: ReviewsHashInput = {
      appid: 570,
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      maxReviews: 200,
    };
    const reviewsBefore = buildReviewsHash(reviewsInput);
    const analysisInput = {
      reviewsContentHash: contentHash(SAMPLE_REVIEWS),
      trendContentHash: 't'.repeat(16),
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrlHost: 'api.deepseek.com',
      promptVersion: 'greview-prompt-v1',
      thinking: false,
      includeTranslations: false,
    };
    const analysisBefore = buildAnalysisHash(analysisInput);

    expectOk(await updateGameTitle(dataDir, 570, 'Hash invariant', 0, optionsFor(path.dirname(dataDir))));
    expect(buildReviewsHash(reviewsInput)).toBe(reviewsBefore);
    expect(buildAnalysisHash(analysisInput)).toBe(analysisBefore);
    const dataset = await listDatasets(dataDir);
    expect(dataset[0].reviewsHash).toBe(hash);
  });

  it('overlays presentation on a report copy without mutating the input', () => {
    const report = {
      version: '1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      game: { appid: 570, name: 'Old Name' },
    } as unknown as Report;
    const presentation = buildGamePresentation({ appid: 570, name: 'Steam Name' } as GameMeta, 570, {
      status: 'ok',
      appid: 570,
      editable: true,
      title: {
        schemaVersion: 1,
        appid: 570,
        customTitle: '新名字',
        revision: 2,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });
    const presented = presentReport(report, presentation);
    expect(report.game.name).toBe('Old Name');
    expect(presented.game.name).toBe('新名字');
    expect((presented.game as unknown as Record<string, unknown>).displayTitle).toBe('新名字');
    expect((presented.game as unknown as Record<string, unknown>).titleSource).toBe('自定义');
    expect(presented.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  function reportStub(reviewsHash: string, game: Record<string, unknown>): Report {
    return {
      version: '1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      game,
      methodology: { reviewsHash },
    } as unknown as Report;
  }

  it('falls back to dataset meta.game when game.json is gone and the report name is a placeholder', async () => {
    const dataDir = dataDirOf(tmpDir());
    const hash = reviewsHashFor();
    await writeDataset(dataDir, metaFor(570, hash), SAMPLE_REVIEWS);
    fs.rmSync(gameFilePath(dataDir, 570), { force: true });

    const presented = await presentReportForApp(
      dataDir,
      570,
      reportStub(hash, { appid: 570, name: 'App 570' }),
    );
    expect(presented.game).toMatchObject({
      name: 'Test Game',
      displayTitle: 'Test Game',
      steamName: 'Test Game',
      customTitle: null,
      titleSource: '自动读取',
    });
  });

  it('uses a merged report steamName, never its stale custom name, when re-presenting', async () => {
    const dataDir = dataDirOf(tmpDir());
    const hash = reviewsHashFor();
    await writeDataset(dataDir, metaFor(570, hash), SAMPLE_REVIEWS);
    fs.rmSync(gameFilePath(dataDir, 570), { force: true });

    // This is the shape of a report already presented under a custom title:
    // `name` is the old custom title, `steamName` keeps the real automatic name.
    const presented = await presentReportForApp(
      dataDir,
      570,
      reportStub(hash, {
        appid: 570,
        name: '旧自定义名称',
        steamName: 'Test Game',
        displayTitle: '旧自定义名称',
        customTitle: '旧自定义名称',
        titleSource: '自定义',
      }),
    );
    const game = presented.game as unknown as Record<string, unknown>;
    expect(game.name).toBe('Test Game');
    expect(game.displayTitle).toBe('Test Game');
    expect(game.steamName).toBe('Test Game');
    expect(game.customTitle).toBeNull();
    expect(game.titleSource).toBe('自动读取');
  });

  it('propagates link security failures from the dataset metadata fallback', async () => {
    const dataDir = dataDirOf(tmpDir());
    const hash = reviewsHashFor();
    await writeDataset(dataDir, metaFor(570, hash), SAMPLE_REVIEWS);
    fs.rmSync(gameFilePath(dataDir, 570), { force: true });

    // A link loop is a security-class failure: the metadata fallback must not
    // swallow it and silently serve the placeholder name instead.
    setContainedReadOpenErrorForTests((target) =>
      target.endsWith('meta.json') ? errno('ELOOP', 'link loop') : null,
    );
    try {
      await expect(
        presentReportForApp(dataDir, 570, reportStub(hash, { appid: 570, name: 'App 570' })),
      ).rejects.toMatchObject({ code: 'DATA_DIR_FORBIDDEN' });
    } finally {
      setContainedReadOpenErrorForTests(null);
    }
    expect(fs.existsSync(metaFilePath(dataDir, 570, hash))).toBe(true);
  });
});
