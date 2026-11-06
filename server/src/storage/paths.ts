import path from 'node:path';
import fsp from 'node:fs/promises';
import { AppError } from '../lib/errors';
import { detectRoots } from '../lib/config';
import { atomicWriteJson, isDirectory, readJsonFile, testWritable } from '../lib/fs';

export interface DataDirOptions {
  projectRoot?: string;
  defaultDataDir?: string;
}

/** Marker proving a directory was created/adopted by GReview (design §6.9, §12). */
export const DATA_DIR_MARKER = '.greview-data.json';

export interface DataDirMarker {
  app: 'greview';
  version: 1;
  createdAt: string;
}

function roots(opts: DataDirOptions): { projectRoot: string; defaultDataDir: string } {
  const detected = detectRoots();
  const projectRoot = opts.projectRoot ?? detected.projectRoot;
  return {
    projectRoot,
    defaultDataDir: opts.defaultDataDir ?? path.join(projectRoot, 'data'),
  };
}

const FORBIDDEN_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.greview',
  '.claude',
  'docs',
  'tools',
  'server',
  'web',
]);

function normalizeForCompare(p: string): string {
  return path.resolve(p).replace(/[\\/]+/g, '/').toLowerCase();
}

function isAncestorOrSame(parent: string, child: string): boolean {
  const p = normalizeForCompare(parent);
  const c = normalizeForCompare(child);
  return c === p || c.startsWith(`${p}/`);
}

function isStrictlyInside(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  return c !== p && c.startsWith(`${p.replace(/\/$/, '')}/`);
}

/**
 * String-level safety checks shared by the synchronous resolver and the
 * realpath-based check. Rejects roots, protected segments, the project root,
 * its ancestors, source trees and ancestors of source trees.
 */
function assertSafeResolvedPath(resolved: string, projectRoot: string): void {
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) throw new AppError('DATA_DIR_FORBIDDEN', '不能使用磁盘根目录');

  const segments = normalizeForCompare(resolved).split('/').filter(Boolean);
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new AppError('DATA_DIR_FORBIDDEN', `路径包含受保护目录 ${segment}`);
    }
  }

  const projectNorm = normalizeForCompare(projectRoot);
  const resolvedNorm = normalizeForCompare(resolved);
  if (resolvedNorm === projectNorm || isAncestorOrSame(resolved, projectRoot)) {
    // Data dir must not be the project root or one of its ancestors, otherwise
    // "clear all" could delete source code.
    throw new AppError('DATA_DIR_FORBIDDEN', '数据目录不能是工程根目录或其上级目录');
  }

  const protectedRoots = [
    path.join(projectRoot, 'server', 'src'),
    path.join(projectRoot, 'server', 'test'),
    path.join(projectRoot, 'server', 'dist'),
    path.join(projectRoot, 'web', 'src'),
    path.join(projectRoot, 'web', 'public'),
    path.join(projectRoot, 'web', 'dist'),
  ];
  for (const protectedRoot of protectedRoots) {
    if (
      resolvedNorm === normalizeForCompare(protectedRoot) ||
      isAncestorOrSame(protectedRoot, resolved) ||
      isAncestorOrSame(resolved, protectedRoot)
    ) {
      throw new AppError('DATA_DIR_FORBIDDEN', '数据目录不能位于源码目录或其上级');
    }
  }
}

/**
 * Resolve and validate a data directory (design §6.9 / §12).
 * Defaults are relative to the project root, never the process cwd. Custom
 * directories must be absolute and must not overlap source or protected paths.
 *
 * This is the synchronous, string-level check. Callers touching the filesystem
 * must additionally use `ensureDataDir`/`assertSafeExistingDataDir`, which
 * resolve symlinks and Windows junctions before writing or deleting.
 */
export function resolveDataDir(input?: string, opts: DataDirOptions = {}): string {
  const { projectRoot, defaultDataDir } = roots(opts);
  if (input === undefined || input === null || String(input).trim() === '') {
    return path.resolve(defaultDataDir);
  }
  const raw = String(input).trim();
  if (!raw || raw.includes('\0')) throw new AppError('DATA_DIR_INVALID');
  if (!path.isAbsolute(raw)) throw new AppError('DATA_DIR_NOT_ABSOLUTE');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) throw new AppError('DATA_DIR_INVALID', '路径不能包含 ..');

  const resolved = path.resolve(raw);
  assertSafeResolvedPath(resolved, projectRoot);
  return resolved;
}

/**
 * Resolve an existing data directory to its real path and re-run every protected
 * path check there. This closes the symlink/junction alias hole: a path that
 * looks harmless can point at `server/src` or the project root.
 */
export async function assertSafeExistingDataDir(
  input: string,
  opts: DataDirOptions = {},
): Promise<string> {
  const { projectRoot } = roots(opts);
  const resolved = path.resolve(input);
  let realPath: string;
  try {
    realPath = await fsp.realpath(resolved);
  } catch {
    throw new AppError('DATA_DIR_INVALID', '数据目录不存在或无法解析');
  }
  let realProjectRoot = projectRoot;
  try {
    realProjectRoot = await fsp.realpath(projectRoot);
  } catch {
    // A missing project root cannot be an alias target; keep the literal path.
  }
  assertSafeResolvedPath(realPath, realProjectRoot);
  return realPath;
}

/** True only when `child` resolves to a path strictly below `parent`. */
export async function assertPathWithinDataDir(dataDir: string, target: string): Promise<void> {
  let realDataDir: string;
  let realTarget: string;
  try {
    realDataDir = await fsp.realpath(dataDir);
    realTarget = await fsp.realpath(target);
  } catch {
    // The caller decides whether a missing target is an error.
    return;
  }
  if (!isStrictlyInside(realTarget, realDataDir)) {
    throw new AppError('DATA_DIR_FORBIDDEN', '目标路径不在数据目录内（可能通过符号链接指向外部）');
  }
}

/**
 * Validate every existing component between the data directory and a target
 * path. A symlink or Windows junction at *any* level (`570/reviews`,
 * `570/trends`, `570/reports`, ...) could otherwise redirect a write or a
 * deletion outside the data directory. The deepest existing ancestor is also
 * realpath-checked, catching reparse points `lstat` does not flag. Missing
 * trailing components are allowed (callers decide whether that is an error).
 */
async function assertSafeContainedPath(
  dataDir: string,
  target: string,
  action: '写入' | '删除',
): Promise<void> {
  const root = path.resolve(dataDir);
  const resolved = path.resolve(target);
  if (!isStrictlyInside(resolved, root)) {
    throw new AppError('DATA_DIR_FORBIDDEN', `${action}目标不在数据目录内`);
  }
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new AppError('DATA_DIR_INVALID', '数据目录不存在或无法解析');
  }
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new AppError('DATA_DIR_INVALID', `无法检查${action}路径 ${segments[i]}`);
    }
    if (stat.isSymbolicLink()) {
      throw new AppError('DATA_DIR_FORBIDDEN', `${action}路径包含符号链接/联接点 ${segments[i]}，拒绝${action}`);
    }
    if (i < segments.length - 1 && !stat.isDirectory()) {
      throw new AppError('DATA_DIR_INVALID', `${action}路径层级 ${segments[i]} 不是目录`);
    }
    let real: string;
    try {
      real = await fsp.realpath(current);
    } catch {
      throw new AppError('DATA_DIR_INVALID', `${action}路径层级 ${segments[i]} 无法解析`);
    }
    if (!isAncestorOrSame(realRoot, real)) {
      throw new AppError('DATA_DIR_FORBIDDEN', `${action}路径通过链接指向数据目录之外：${segments[i]}`);
    }
  }
}

/** Reject a write target reached through any symlink/junction level. */
export async function assertSafeWritePath(dataDir: string, target: string): Promise<void> {
  await assertSafeContainedPath(dataDir, target, '写入');
}

/**
 * Reject a delete target reached through any symlink/junction level. Deletion
 * needs its own check, not just a pre-flight check of the dataset directory:
 * `570/reports` may itself be a junction while `570/reviews/<hash>` is a plain
 * directory, and following it would delete JSON files outside the data dir.
 */
export async function assertSafeDeletePath(dataDir: string, target: string): Promise<void> {
  await assertSafeContainedPath(dataDir, target, '删除');
}

export async function readDataDirMarker(dir: string): Promise<DataDirMarker | null> {
  try {
    const raw = await readJsonFile<Partial<DataDirMarker>>(path.join(dir, DATA_DIR_MARKER));
    if (raw && raw.app === 'greview' && raw.version === 1) {
      return { app: 'greview', version: 1, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '' };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeDataDirMarker(dir: string): Promise<void> {
  const marker: DataDirMarker = { app: 'greview', version: 1, createdAt: new Date().toISOString() };
  const target = path.join(dir, DATA_DIR_MARKER);
  await assertSafeWritePath(dir, target);
  await atomicWriteJson(target, marker);
}

const APP_DIR_ENTRIES = new Set(['reviews', 'trends', 'reports', 'game.json']);

/** Recognize an app directory created by this tool; used when adopting old data. */
async function looksLikeGreviewAppDir(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false;
    if (entry.isDirectory()) {
      if (!APP_DIR_ENTRIES.has(entry.name)) return false;
    } else if (entry.isFile()) {
      if (!APP_DIR_ENTRIES.has(entry.name)) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function realProjectRootOf(projectRoot: string): Promise<string> {
  try {
    return await fsp.realpath(projectRoot);
  } catch {
    return projectRoot;
  }
}

interface AncestorProbe {
  /** Real path of the deepest existing ancestor (symlinks/junctions resolved). */
  realPath: string;
  /** Missing path components below that ancestor, outermost first. */
  missing: string[];
  /** Literal absolute paths of the missing components, outermost first. */
  createdCandidates: string[];
  /** True when the probe target itself exists. */
  exists: boolean;
}

/**
 * Walk up from `target` to the deepest existing ancestor, resolving that
 * ancestor's real path. Nothing is created. A non-directory ancestor that
 * would have to become a directory is rejected before any filesystem write.
 */
async function probeDeepestExisting(target: string): Promise<AncestorProbe> {
  const missing: string[] = [];
  const createdCandidates: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new AppError('DATA_DIR_INVALID', `无法检查数据目录路径：${code ?? 'unknown'}`);
      }
      const parent = path.dirname(current);
      if (parent === current) throw new AppError('DATA_DIR_INVALID', '无法解析数据目录路径');
      missing.unshift(path.basename(current));
      createdCandidates.unshift(current);
      current = parent;
      continue;
    }
    // A symlink/junction to a directory is a valid ancestor even though
    // lstat().isDirectory() is false for the link itself. Resolve it before
    // deciding whether the missing trailing components can be created.
    if (stat.isSymbolicLink()) {
      let realLink: string;
      try {
        realLink = await fsp.realpath(current);
      } catch {
        throw new AppError('DATA_DIR_INVALID', '数据目录路径中的链接无法解析');
      }
      if (missing.length > 0) {
        let targetStat;
        try {
          targetStat = await fsp.stat(realLink);
        } catch {
          throw new AppError('DATA_DIR_INVALID', '数据目录路径中的链接目标无法检查');
        }
        if (!targetStat.isDirectory()) {
          throw new AppError('DATA_DIR_INVALID', '数据目录的上级路径不是目录');
        }
      }
      return { realPath: realLink, missing, createdCandidates, exists: missing.length === 0 };
    }
    if (missing.length > 0 && !stat.isDirectory()) {
      throw new AppError('DATA_DIR_INVALID', '数据目录的上级路径不是目录');
    }
    let realPath: string;
    try {
      realPath = await fsp.realpath(current);
    } catch {
      throw new AppError('DATA_DIR_INVALID', '数据目录路径无法解析');
    }
    return { realPath, missing, createdCandidates, exists: missing.length === 0 };
  }
}

async function removeCreatedDirs(paths: string[]): Promise<void> {
  // Only empty directories created by this call are removed; if another
  // process wrote data concurrently, rmdir fails with ENOTEMPTY and is ignored.
  for (let i = paths.length - 1; i >= 0; i -= 1) {
    await fsp.rmdir(paths[i]).catch(() => undefined);
  }
}

/**
 * Create the directory if necessary, verify it is writable, resolve symlinks
 * and establish the GReview marker. Unmarked directories carrying unrelated
 * files are rejected instead of silently adopted.
 *
 * Safety checks run before mkdir (deepest existing ancestor + link target) and
 * again on the actual path after creation, so a harmless-looking path that is
 * actually a junction into `server/src` cannot create a probe file or a
 * directory in protected source. Any failure removes only the empty
 * directories this call created.
 */
export async function ensureDataDir(input?: string, opts: DataDirOptions = {}): Promise<string> {
  const dir = resolveDataDir(input, opts);
  const { projectRoot } = roots(opts);
  const probe = await probeDeepestExisting(dir);
  const realProjectRoot = await realProjectRootOf(projectRoot);
  const resolvedCandidate = probe.missing.length
    ? path.join(probe.realPath, ...probe.missing)
    : probe.realPath;
  // Pre-flight validation happens before mkdir/testWritable can create anything.
  assertSafeResolvedPath(resolvedCandidate, realProjectRoot);

  try {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new AppError('DATA_DIR_INVALID', err instanceof Error ? err.message : String(err));
    }
    if (!(await isDirectory(dir))) throw new AppError('DATA_DIR_INVALID', '路径不是目录');
    // Re-check the actual path after creation (an existing component could have
    // been a junction all along, or swapped between the probe and mkdir).
    await assertSafeExistingDataDir(dir, opts);
    // Only probe writability after the real path is known to be safe.
    if (!(await testWritable(dir))) throw new AppError('DATA_DIR_INVALID', '目录不可写');

    const entries = await fsp.readdir(dir);
    if (entries.length === 0) {
      await writeDataDirMarker(dir);
      return dir;
    }
    if (await readDataDirMarker(dir)) return dir;

    // Legacy GReview data directories (created before the marker existed) may
    // be adopted only when every top-level entry is a numeric app directory of
    // this tool. Anything else is an ordinary directory and must not be used.
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) {
        throw new AppError('DATA_DIR_FORBIDDEN', `目录包含非 GReview 条目 ${entry}，拒绝作为数据目录`);
      }
      const full = path.join(dir, entry);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AppError('DATA_DIR_FORBIDDEN', `数据目录条目 ${entry} 不是普通目录`);
      }
      if (!(await looksLikeGreviewAppDir(full))) {
        throw new AppError('DATA_DIR_FORBIDDEN', `数据目录条目 ${entry} 不属于 GReview`);
      }
    }
    await writeDataDirMarker(dir);
    return dir;
  } catch (err) {
    if (probe.createdCandidates.length > 0) await removeCreatedDirs(probe.createdCandidates);
    throw err;
  }
}

export function assertAppIdSegment(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new AppError('INVALID_URL');
  return n;
}

export function assertHashSegment(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) throw new AppError('INVALID_PARAMS');
  return value;
}
