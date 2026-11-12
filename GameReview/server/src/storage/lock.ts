import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../lib/errors';

/**
 * Unified per-data-root storage lock (contract: one process may write to one
 * data directory at a time). Every mutation of datasets, metadata, trends,
 * titles and reports must run inside `withStorageLock`, keyed by the canonical
 * real data root so symlink/junction aliases of the same directory cannot run
 * concurrently.
 *
 * Lock order is always root lock -> existing per-dataset lock. Nothing takes a
 * root lock while already holding one, so the protocol cannot deadlock.
 *
 * An epoch is bumped when the data directory is cleared. Jobs capture the
 * epoch when they are created and pass it to later writes; a write carrying a
 * stale epoch is cancelled instead of resurrecting data after "clear all".
 */

export type StorageOperation =
  | 'writeDataset'
  | 'updateDatasetMeta'
  | 'saveTrend'
  | 'saveReport'
  | 'writeGameMeta'
  | 'updateGameTitle'
  | 'deleteDataset'
  | 'clearDataDir';

export interface StorageMutationInfo {
  operation: StorageOperation;
  dataDir: string;
  appid?: number;
}

interface RootState {
  tail: Promise<void>;
  epoch: number;
}

const roots = new Map<string, RootState>();

function stateFor(key: string): RootState {
  let state = roots.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), epoch: 0 };
    roots.set(key, state);
  }
  return state;
}

/**
 * Platforms whose default filesystems are case-insensitive. Two spellings that
 * differ only by case name the same directory there, so the lock identity must
 * lowercase. On case-sensitive filesystems (Linux), two real directories that
 * differ only by case are genuinely independent roots and must NOT share lock
 * state or storage epochs.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * In-process identity key for a data root. Separators are normalised on every
 * platform; case is folded only where the filesystem itself folds it.
 */
export function storageRootKey(dataDir: string): string {
  const normalized = path.resolve(dataDir).replace(/[\\/]+/g, '/');
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

/** Canonical identity of a data root: realpath when it exists, normalised literal otherwise. */
export async function canonicalStorageRoot(dataDir: string): Promise<string> {
  const literal = path.resolve(dataDir);
  let real = literal;
  try {
    real = await fsp.realpath(literal);
  } catch {
    // A missing root cannot be aliased yet; use the normalised literal path.
  }
  return storageRootKey(real);
}

export interface StorageLockOptions {
  /** Epoch captured by a job at creation time; stale epoch cancels the write. */
  epoch?: number;
  /** Bump the root epoch while holding the lock (used by clear-all). */
  bumpEpoch?: boolean;
}

export async function withStorageLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
  options: StorageLockOptions = {},
): Promise<T> {
  const key = await canonicalStorageRoot(dataDir);
  const state = stateFor(key);
  const previous = state.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => gate);
  await previous;
  try {
    if (options.bumpEpoch) state.epoch += 1;
    if (options.epoch !== undefined && options.epoch !== state.epoch) {
      throw new AppError('CANCELLED', '数据目录已被清空，任务无法继续写入');
    }
    return await fn();
  } finally {
    release();
  }
}

/** Read the current epoch of a data root (0 for a root never cleared this run). */
export async function captureStorageEpoch(dataDir: string): Promise<number> {
  const key = await canonicalStorageRoot(dataDir);
  return stateFor(key).epoch;
}

// ---------------------------------------------------------------------------
// Test hook: runs *inside* the root lock, after the epoch check, so tests can
// build deterministic barriers between real storage operations.
// ---------------------------------------------------------------------------

let mutationHook: ((info: StorageMutationInfo) => Promise<void> | void) | null = null;

/** @internal Test hook: pause/observe storage mutations while the lock is held. */
export function setStorageMutationHookForTests(
  hook: ((info: StorageMutationInfo) => Promise<void> | void) | null,
): void {
  mutationHook = hook;
}

export async function runStorageMutationHook(info: StorageMutationInfo): Promise<void> {
  if (mutationHook) await mutationHook(info);
}
