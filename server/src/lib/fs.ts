import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Atomic write: temp file in the destination directory then rename. */
export async function atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function fileSize(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += await fileSize(full);
    }
  } catch {
    return total;
  }
  return total;
}

/** Write a probe file to confirm a directory is writable, then remove it. */
export async function testWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.greview-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await fsp.writeFile(probe, 'ok');
    return true;
  } catch {
    return false;
  } finally {
    // Never leave a probe file behind, including when the write itself fails
    // partway through.
    await fsp.rm(probe, { force: true }).catch(() => undefined);
  }
}

export function removeDirSyncSafe(dir: string): void {
  // Used only for process-exit cleanup; never for user data.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
