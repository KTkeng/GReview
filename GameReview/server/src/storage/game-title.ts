import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, isAppError, isSecurityError } from '../lib/errors';
import {
  assertSafeDeletePath,
  assertSafeExistingDataDir,
  assertSafeWritePath,
  openContainedRead,
  readContainedDir,
  type DataDirOptions,
} from './paths';
import { appDir } from './game-meta';
import { runStorageMutationHook, withStorageLock } from './lock';
import type { GameTitleOverride } from '../types';

export const TITLE_FILE_NAME = 'title.json';
export const TITLE_SCHEMA_VERSION = 1;
export const TITLE_MAX_CODE_POINTS = 120;
export const TITLE_MIN_CODE_POINTS = 1;
/** Bounded read limit: a corrupt giant title file must only degrade one game. */
export const TITLE_MAX_FILE_BYTES = 64 * 1024;

/** C0/C1 controls, DEL and the Unicode line/paragraph separators. */
function hasForbiddenControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Unicode bidirectional control characters that can visually reorder text:
 * ALM (U+061C), LRM/RLM, the embedding/override block and the isolate block.
 */
function hasForbiddenBidi(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x061c) return true;
    if (code === 0x200e || code === 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

export function titleFilePath(dataDir: string, appid: number): string {
  return path.join(appDir(dataDir, appid), TITLE_FILE_NAME);
}

function titleError(detail: string): AppError {
  return new AppError('INVALID_PARAMS', detail, '参数无效', {
    field: 'customTitle',
    publicDetail: detail,
  });
}

/**
 * Normalise and validate a submitted title. Forbidden newline/control and
 * bidirectional characters are checked on the *raw* input, before NFC and
 * trimming, so a leading/trailing newline or a newline-only value cannot be
 * laundered into a valid title. Then NFC, trim, empty -> null, and 1–120 code
 * points. Format characters needed by normal emoji (ZWJ, variation selectors,
 * skin-tone modifiers) remain allowed.
 */
export function normalizeCustomTitle(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw titleError('customTitle 必须是字符串或 null');
  if (hasForbiddenControl(value)) throw titleError('标题不能包含换行或控制字符');
  if (hasForbiddenBidi(value)) throw titleError('标题不能包含双向文本控制字符');
  const normalized = value.normalize('NFC').trim();
  if (normalized.length === 0) return null;
  const codePoints = [...normalized].length;
  if (codePoints < TITLE_MIN_CODE_POINTS || codePoints > TITLE_MAX_CODE_POINTS) {
    throw titleError(`标题需为 1–${TITLE_MAX_CODE_POINTS} 个字符`);
  }
  return normalized;
}

/** Non-throwing variant used when validating an on-disk file. */
function normalizedOrUndefined(value: unknown): string | null | undefined {
  try {
    return normalizeCustomTitle(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Strict canonical ISO-8601 timestamp with millisecond precision and `Z`. */
export function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * Validate a persisted title document. Returns null for any structural,
 * version, timestamp, appid, field or normalisation mismatch; the caller must
 * treat that as a corrupt file and never overwrite it silently.
 */
export function parseStoredTitle(raw: unknown, appid: number): GameTitleOverride | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== TITLE_SCHEMA_VERSION) return null;
  if (raw.appid !== appid) return null;
  if (!isNonNegativeSafeInt(raw.revision)) return null;
  if (!isStrictIsoTimestamp(raw.updatedAt)) return null;
  if (raw.customTitle !== null && typeof raw.customTitle !== 'string') return null;
  const normalized = normalizedOrUndefined(raw.customTitle);
  // The file must already contain the canonical form written by this server.
  if (normalized !== raw.customTitle) return null;
  return {
    schemaVersion: TITLE_SCHEMA_VERSION,
    appid,
    customTitle: normalized,
    revision: raw.revision,
    updatedAt: raw.updatedAt,
  };
}

export type TitleReadState =
  | { status: 'missing'; appid: number; revision: 0; customTitle: null; updatedAt: null; editable: true }
  | { status: 'ok'; appid: number; title: GameTitleOverride; editable: true }
  | { status: 'corrupt'; appid: number; reason: string; warning: string; editable: false }
  /**
   * An ordinary filesystem failure (permission or I/O) while opening/reading
   * title.json. The file may be perfectly valid; we simply cannot inspect it.
   * It degrades the same way as corruption for display, but a PATCH must not be
   * reported as "corrupt" (409): permission problems are 503 and other I/O
   * failures are 500.
   */
  | {
      status: 'unavailable';
      appid: number;
      reason: string;
      warning: string;
      editable: false;
      permission: boolean;
    };

function corruptState(appid: number, reason: string): TitleReadState {
  return {
    status: 'corrupt',
    appid,
    reason,
    editable: false,
    warning: `游戏标题文件损坏或版本不受支持（AppID ${appid}），已回退显示自动名称或编号；请修复或删除 title.json 后重试。`,
  };
}

function unavailableState(appid: number, reason: string, permission: boolean): TitleReadState {
  return {
    status: 'unavailable',
    appid,
    reason,
    editable: false,
    permission,
    warning: permission
      ? `游戏标题文件不可访问（AppID ${appid}），已回退显示自动名称或编号；请检查文件权限后重试。`
      : `游戏标题文件暂时无法读取（AppID ${appid}），已回退显示自动名称或编号；请稍后重试。`,
  };
}

function isPermissionErrno(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function readFailureIsPermission(err: unknown): boolean {
  if (isAppError(err) && err.causeCode) {
    return err.causeCode === 'EACCES' || err.causeCode === 'EPERM' || err.causeCode === 'EROFS';
  }
  return isPermissionErrno(err);
}

/**
 * Read <dataDir>/<appid>/title.json through a validated, bounded, read-only
 * handle. A missing file is NOT created. Link/junction escapes throw instead of
 * degrading to a local warning; ordinary open/read failures (permission, I/O)
 * degrade only this game with an explicit warning so a single unreadable title
 * file never breaks listing, preview or report reads.
 */
export async function readTitleOverride(dataDir: string, appid: number): Promise<TitleReadState> {
  let handle: Awaited<ReturnType<typeof openContainedRead>>;
  try {
    handle = await openContainedRead(dataDir, titleFilePath(dataDir, appid));
  } catch (err) {
    // Security violations (link/junction escape, protected path) propagate.
    if (isSecurityError(err)) throw err;
    return unavailableState(appid, '打开标题文件失败', readFailureIsPermission(err));
  }
  if (!handle) {
    return { status: 'missing', appid, revision: 0, customTitle: null, updatedAt: null, editable: true };
  }
  try {
    const stat = await handle.stat();
    if (stat.size > TITLE_MAX_FILE_BYTES) {
      return corruptState(appid, '标题文件过大');
    }
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text, 'utf8') > TITLE_MAX_FILE_BYTES) {
      return corruptState(appid, '标题文件过大');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return corruptState(appid, 'JSON 无法解析');
    }
    const title = parseStoredTitle(raw, appid);
    if (!title) return corruptState(appid, '内容不符合标题模型');
    return { status: 'ok', appid, title, editable: true };
  } catch (err) {
    if (isSecurityError(err)) throw err;
    return unavailableState(appid, '读取标题文件失败', readFailureIsPermission(err));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hasHexEntry(
  dataDir: string,
  dir: string,
  pattern: RegExp,
  wantDirectory: boolean,
): Promise<boolean> {
  const entries = await readContainedDir(dataDir, dir);
  if (!entries) return false;
  return entries.some(
    (entry) => pattern.test(entry.name) && (wantDirectory ? entry.isDirectory() : entry.isFile()),
  );
}

/**
 * A local game exists only when it has at least one dataset directory or one
 * report file. game.json/title.json alone do not count, so a PATCH cannot
 * create an arbitrary game directory. Every probe validates link containment.
 */
export async function localGameExists(dataDir: string, appid: number): Promise<boolean> {
  const dir = appDir(dataDir, appid);
  const entries = await readContainedDir(dataDir, dir);
  if (!entries) return false;
  const hasReviews = entries.some((entry) => entry.name === 'reviews' && entry.isDirectory());
  const hasReports = entries.some((entry) => entry.name === 'reports' && entry.isDirectory());
  if (hasReviews && (await hasHexEntry(dataDir, path.join(dir, 'reviews'), /^[a-f0-9]{16}$/, true))) {
    return true;
  }
  if (hasReports && (await hasHexEntry(dataDir, path.join(dir, 'reports'), /^[a-f0-9]{16}\.json$/, false))) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Atomic persistence
//
// File operations go through an injectable layer so tests can fail a *real*
// open/write/sync/rename after partial progress, not a synthetic pre-flight
// check. Production always uses the node:fs/promises operations.
// ---------------------------------------------------------------------------

const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WritePhase = 'prepare' | 'rename';

function mapWriteError(err: unknown, phase: WritePhase): AppError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC') return new AppError('TITLE_NO_SPACE', '磁盘空间不足，原标题已保留');
  if (code === 'ENOENT') return new AppError('GAME_NOT_FOUND', '本地游戏目录已被删除');
  if (phase === 'rename') {
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      return new AppError('TITLE_BUSY', '标题文件暂被占用，请稍后重试');
    }
  } else if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AppError('TITLE_NOT_WRITABLE', '数据目录不可写');
  }
  return new AppError('INTERNAL', '标题保存失败，请稍后重试');
}

export interface TitleFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface TitleFsOps {
  open(target: string, flags: string): Promise<TitleFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(target: string, options: { force: boolean }): Promise<void>;
}

const defaultTitleFsOps: TitleFsOps = {
  open: (target, flags) => fsp.open(target, flags),
  rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
  rm: (target, options) => fsp.rm(target, options),
};

let titleFsOps: TitleFsOps = defaultTitleFsOps;

/** @internal Test hook: override individual filesystem operations. */
export function setTitleFsOpsForTests(ops: Partial<TitleFsOps> | null): void {
  titleFsOps = ops ? { ...defaultTitleFsOps, ...ops } : defaultTitleFsOps;
}

/** @internal Restore real filesystem operations after a fault-injection test. */
export function resetTitleFsOpsForTests(): void {
  titleFsOps = defaultTitleFsOps;
}

async function atomicWriteTitleFile(target: string, value: GameTitleOverride): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let handle: TitleFileHandle | undefined;
  try {
    try {
      handle = await titleFsOps.open(tmp, 'wx');
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (err) {
      throw mapWriteError(err, 'prepare');
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
      try {
        await titleFsOps.rename(tmp, target);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break;
        if (attempt < RENAME_ATTEMPTS - 1) await sleep(RENAME_RETRY_MS);
      }
    }
    throw mapWriteError(lastErr, 'rename');
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await titleFsOps.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export type TitleUpdateOutcome =
  | { status: 'ok'; state: TitleReadState; changed: boolean; revision: number }
  | { status: 'conflict'; state: TitleReadState; currentRevision: number }
  | { status: 'corrupt'; state: TitleReadState };

export interface UpdateGameTitleOptions extends DataDirOptions {
  /** Override existence probing (tests); default checks datasets/reports. */
  gameExists?: (dataDir: string, appid: number) => Promise<boolean>;
  /** Inject a clock for deterministic updatedAt in tests. */
  now?: () => Date;
}

/**
 * Optimistic, storage-locked title update. Order inside the root lock:
 *   1. re-validate the data root and re-check the game still exists;
 *   2. safely read the current title file (corrupt -> 409, never overwritten);
 *   3. compare expectedRevision (mismatch -> conflict, even if the value is equal);
 *   4. compare normalised value (equal -> changed=false, no write);
 *   5. atomically write temp file + rename, revision+1 (safe-integer bounded).
 */
export async function updateGameTitle(
  dataDir: string,
  appid: number,
  customTitle: string | null,
  expectedRevision: number,
  options: UpdateGameTitleOptions = {},
): Promise<TitleUpdateOutcome> {
  // Normalising here as well as at the HTTP boundary keeps direct callers
  // (jobs/tests/future routes) unable to persist an uncanonical value.
  const normalizedTitle = normalizeCustomTitle(customTitle);
  return withStorageLock(dataDir, async () => {
    await runStorageMutationHook({ operation: 'updateGameTitle', dataDir, appid });
    let realDir: string;
    try {
      realDir = await assertSafeExistingDataDir(dataDir, options);
    } catch (err) {
      // Only a genuinely missing/unresolvable root means "local game not
      // found"; permission (503) and I/O (500) failures pass through.
      if (isAppError(err) && err.code === 'DATA_DIR_INVALID') throw new AppError('GAME_NOT_FOUND');
      throw err;
    }
    const exists = options.gameExists ?? localGameExists;
    if (!(await exists(realDir, appid))) throw new AppError('GAME_NOT_FOUND');
    const state = await readTitleOverride(realDir, appid);
    if (state.status === 'corrupt') return { status: 'corrupt', state };
    if (state.status === 'unavailable') {
      // We cannot verify the current revision safely. Permission problems are
      // 503 存储不可写; other I/O failures are 500 — never a false 409.
      throw state.permission
        ? new AppError('TITLE_NOT_WRITABLE', '标题文件不可访问')
        : new AppError('INTERNAL', '标题文件暂时无法读取');
    }

    const currentRevision = state.status === 'ok' ? state.title.revision : 0;
    if (expectedRevision !== currentRevision) {
      return { status: 'conflict', state, currentRevision };
    }

    const currentTitle = state.status === 'ok' ? state.title.customTitle : null;
    if (normalizedTitle === currentTitle) {
      return { status: 'ok', state, changed: false, revision: currentRevision };
    }

    // Nothing to persist: clearing an absent title keeps the logical revision 0
    // and must not create a file (contract: initial clear returns revision 0).
    if (state.status === 'missing' && normalizedTitle === null) {
      return { status: 'ok', state, changed: false, revision: 0 };
    }

    // Never mint an unsafe integer; refuse the write and keep the old file.
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      return { status: 'corrupt', state: corruptState(appid, '标题版本号已达安全整数上限') };
    }

    const next: GameTitleOverride = {
      schemaVersion: TITLE_SCHEMA_VERSION,
      appid,
      customTitle: normalizedTitle,
      revision: currentRevision + 1,
      updatedAt: (options.now ? options.now() : new Date()).toISOString(),
    };
    const target = titleFilePath(realDir, appid);
    await assertSafeWritePath(realDir, target);
    await atomicWriteTitleFile(target, next);
    const written: TitleReadState = { status: 'ok', appid, title: next, editable: true };
    return { status: 'ok', state: written, changed: true, revision: next.revision };
  });
}

/**
 * Remove title.json when the last dataset/report for a game is gone. The
 * delete path is validated first; a failed validation aborts the deletion and
 * propagates the security error. Only "already gone" is ignored as cleanup.
 */
export async function removeTitleOverride(dataDir: string, appid: number): Promise<void> {
  const target = titleFilePath(dataDir, appid);
  await assertSafeDeletePath(dataDir, target);
  try {
    await titleFsOps.rm(target, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
