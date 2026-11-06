import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SteamCache, sanitizeForCache } from '../src/cache/file';
import { normalizeSteamPage } from '../src/steam/normalize';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greview-cache-privacy-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RAW_PAGE = {
  response: {
    reviews: [
      {
        recommendationid: 'privacy-1',
        author: {
          steamid: '76561190000000000',
          personaname: 'PlayerNickname',
          avatar: 'https://avatars.steamstatic.com/abc.jpg',
          profile_url: 'https://steamcommunity.com/id/player',
          playtime_at_review: 420,
          playtime_forever: 900,
        },
        language: 'english',
        review: 'public review text',
        timestamp_created: 1700000000,
        voted_up: true,
        votes_up: 3,
        weighted_vote_score: '0.5',
      },
    ],
    query_summary: { total_reviews: 1, total_positive: 1, total_negative: 0 },
    total_matching: 1,
  },
};

describe('Steam cache privacy', () => {
  it('never writes personal Steam author fields to disk', async () => {
    const dir = tmpDir();
    const cache = new SteamCache(dir);
    await cache.set('reviews-official', 570, { appid: 570 }, RAW_PAGE);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(text).not.toContain('steamid');
    expect(text).not.toContain('76561190000000000');
    expect(text).not.toContain('personaname');
    expect(text).not.toContain('PlayerNickname');
    expect(text).not.toContain('avatar');
    expect(text).not.toContain('profile_url');
    expect(text).not.toContain('nickname');

    // Public review fields remain so normalization still works from cache.
    expect(text).toContain('public review text');
    const cached = (await cache.get('reviews-official', 570, { appid: 570 }, 60_000)) as typeof RAW_PAGE;
    const author = cached.response.reviews[0].author as Record<string, unknown>;
    expect(author).toEqual({ playtime_at_review: 420, playtime_forever: 900 });
    const page = normalizeSteamPage(cached, 'official');
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0].text).toBe('public review text');
  });

  it('recursively strips personal keys at any depth but keeps public data', () => {
    const sanitized = sanitizeForCache({
      ok: 1,
      nested: { account_id: 42, keep: 'yes', list: [{ steamid: 'x', value: 2 }] },
      author: { personaname: 'x', playtime_at_review: 1 },
      nickname: 'drop',
      profile_url: 'https://example',
    });
    expect(sanitized).toEqual({
      ok: 1,
      nested: { keep: 'yes', list: [{ value: 2 }] },
      author: { playtime_at_review: 1 },
    });
  });

  it('drops a non-object author rather than leaking it', () => {
    expect(sanitizeForCache({ author: '76561190000000000', review: 'x' })).toEqual({ review: 'x' });
  });
});
