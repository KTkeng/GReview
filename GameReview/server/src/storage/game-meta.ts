import path from 'node:path';
import { atomicWriteJson } from '../lib/fs';
import { isAppError } from '../lib/errors';
import type { GameMeta } from '../types';
import { assertSafeWritePath, readContainedJson } from './paths';
import { runStorageMutationHook, withStorageLock } from './lock';

/** Directory of one game inside the data root (path only ever uses the AppID). */
export function appDir(dataDir: string, appid: number): string {
  return path.join(dataDir, String(appid));
}

export function gameFilePath(dataDir: string, appid: number): string {
  return path.join(appDir(dataDir, appid), 'game.json');
}

/** Persist metadata while already holding the unified storage lock. */
export async function writeGameMetaLocked(dataDir: string, game: GameMeta): Promise<void> {
  const target = gameFilePath(dataDir, game.appid);
  await assertSafeWritePath(dataDir, target);
  await atomicWriteJson(target, game);
}

/** Persist automatically fetched Steam metadata; never contains the custom title. */
export async function writeGameMeta(dataDir: string, game: GameMeta): Promise<void> {
  await withStorageLock(dataDir, async () => {
    await runStorageMutationHook({ operation: 'writeGameMeta', dataDir, appid: game.appid });
    await writeGameMetaLocked(dataDir, game);
  });
}

export async function readGameMeta(dataDir: string, appid: number): Promise<GameMeta | null> {
  try {
    const meta = await readContainedJson<GameMeta>(dataDir, gameFilePath(dataDir, appid));
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  } catch (err) {
    // Malformed JSON degrades to "no metadata"; path/link security failures
    // must propagate so callers cannot serve data from outside the root.
    if (isAppError(err)) throw err;
    return null;
  }
}
