import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectRoots, loadConfig } from '../src/lib/config';

describe('project root detection', () => {
  it('treats server/src/<subdir> and server/dist/<subdir> as two levels below the server root', () => {
    const project = path.join(os.tmpdir(), 'greview-root-probe');
    const server = path.join(project, 'server');
    const moduleDirs = [
      path.join(server, 'src', 'lib'),
      path.join(server, 'dist', 'lib'),
      path.join(server, 'src', 'storage'),
      path.join(server, 'dist', 'storage'),
    ];
    for (const moduleDir of moduleDirs) {
      expect(detectRoots(moduleDir)).toEqual({ serverRoot: server, projectRoot: project });
    }
  });

  it('resolves default data/cache/web paths from the repository root', () => {
    const config = loadConfig({});
    expect(config.projectRoot).toBe(path.resolve(__dirname, '..', '..'));
    expect(config.serverRoot).toBe(path.join(config.projectRoot, 'server'));
    expect(config.dataDir).toBe(path.join(config.projectRoot, 'data'));
    expect(config.cacheDir).toBe(path.join(config.projectRoot, 'server', '.cache'));
    expect(config.webDist).toBe(path.join(config.projectRoot, 'web', 'dist'));
  });
});
