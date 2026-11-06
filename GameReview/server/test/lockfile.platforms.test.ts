import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootLock = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'package-lock.json'), 'utf8')
) as {
  packages: Record<string, { version?: string; optionalDependencies?: Record<string, string> }>;
};

const WORKSPACES = ['server', 'web'] as const;

describe('root lockfile platform coverage', () => {
  it('includes Linux esbuild and rollup packages for every workspace', () => {
    for (const workspace of WORKSPACES) {
      expect(rootLock.packages[`${workspace}/node_modules/@esbuild/linux-x64`]).toBeDefined();
      expect(rootLock.packages[`${workspace}/node_modules/@rollup/rollup-linux-x64-gnu`]).toBeDefined();
    }
    // The server workspace has a nested Vite/esbuild copy.
    expect(
      rootLock.packages['server/node_modules/vite/node_modules/@esbuild/linux-x64']
    ).toBeDefined();
  });

  it('pins Linux native package versions to their parent optional dependency ranges', () => {
    const pairs: Array<[string, string, string]> = [
      ['server/node_modules/esbuild', 'server/node_modules/@esbuild/linux-x64', '@esbuild/linux-x64'],
      [
        'server/node_modules/vite/node_modules/esbuild',
        'server/node_modules/vite/node_modules/@esbuild/linux-x64',
        '@esbuild/linux-x64',
      ],
      ['web/node_modules/esbuild', 'web/node_modules/@esbuild/linux-x64', '@esbuild/linux-x64'],
      [
        'server/node_modules/rollup',
        'server/node_modules/@rollup/rollup-linux-x64-gnu',
        '@rollup/rollup-linux-x64-gnu',
      ],
      [
        'web/node_modules/rollup',
        'web/node_modules/@rollup/rollup-linux-x64-gnu',
        '@rollup/rollup-linux-x64-gnu',
      ],
    ];

    for (const [parentPath, childPath, packageName] of pairs) {
      const parent = rootLock.packages[parentPath];
      const child = rootLock.packages[childPath];
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(parent.optionalDependencies?.[packageName]).toBe(child.version);
    }
  });
});
