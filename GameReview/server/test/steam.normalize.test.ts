import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSteamUrl, isValidAppId } from '../src/steam/url';
import { normalizeSteamPage, mergeReviews, cleanText } from '../src/steam/normalize';
import { resolveGame } from '../src/steam/appdetails';
import {
  applyClientFilters,
  toOfficialInput,
  toStorefrontQuery,
  withClientFilterDefaults,
  withFilterDefaults,
} from '../src/steam/filters';
import type { Review } from '../src/types';

const fixtures = path.join(__dirname, 'fixtures');
const official = JSON.parse(fs.readFileSync(path.join(fixtures, 'official-page.json'), 'utf8')) as unknown;
const storefront = JSON.parse(fs.readFileSync(path.join(fixtures, 'storefront-page.json'), 'utf8')) as unknown;

describe('Steam URL parsing', () => {
  it.each([
    ['https://store.steampowered.com/app/570/Dota_2/', 570],
    ['https://store.steampowered.com/app/570', 570],
    ['https://store.steampowered.com/app/570/?l=schinese', 570],
    ['https://store.steampowered.com/agecheck/app/570/', 570],
    ['https://steamcommunity.com/app/570', 570],
    ['https://steamcommunity.com/app/570/discussions/', 570],
    ['https://www.store.steampowered.com/app/730/', 730],
    ['570', 570],
    [' 570 ', 570],
  ])('accepts %s', (input, expected) => {
    expect(parseSteamUrl(input)).toBe(expected);
  });

  it.each([
    'https://example.com/app/570',
    'https://evil.example/steamcommunity.com/app/570',
    'https://store.steampowered.com.evil.example/app/570',
    '0',
    '-570',
    '+570',
    '2147483648',
    '999999999999999999999999999999999',
    'https://store.steampowered.com/app/0',
    'https://store.steampowered.com/app/notanumber',
    'not a url',
    '',
    'ftp://store.steampowered.com/app/570',
  ])('rejects %s with INVALID_URL without fetching', (input) => {
    expect(() => parseSteamUrl(input)).toThrow('INVALID_URL');
  });

  it('validates numeric app ids', () => {
    expect(isValidAppId(570)).toBe(true);
    expect(isValidAppId(0)).toBe(false);
    expect(isValidAppId(-1)).toBe(false);
    expect(isValidAppId(2147483648)).toBe(false);
  });
});

describe('Steam filter mapping', () => {
  const filters = withFilterDefaults({
    languages: ['schinese', 'english'],
    reviewType: 'negative',
    sort: 'helpful',
    purchaseType: 'all',
    dateRange: { start: 100, end: 200 },
    minPlaytimeHours: 10,
    maxPlaytimeHours: 100,
    excludeOffTopic: true,
    useReviewQuality: true,
  });

  it('maps to official input_json numeric enums', () => {
    const input = toOfficialInput(570, filters);
    expect(input).toMatchObject({
      appid: 570,
      filter: 0,
      languages: ['schinese', 'english'],
      review_type: 2,
      purchase_type: 1,
      day_range: 0,
      date_range_start: 100,
      date_range_end: 200,
      playtime_min_hours: 10,
      playtime_max_hours: 100,
      filter_offtopic_activity: true,
      use_review_quality: true,
      num_per_page: 100,
    });
  });

  it('uses the same off-topic semantics for both endpoints', () => {
    // true/1 = filter off-topic reviews out (design §7.1); the §7.4 table row is
    // internally inconsistent and superseded by the field definition.
    const excluding = withFilterDefaults({ excludeOffTopic: true });
    const including = withFilterDefaults({ excludeOffTopic: false });
    expect(toOfficialInput(570, excluding).filter_offtopic_activity).toBe(true);
    expect(toStorefrontQuery(excluding).filter_offtopic_activity).toBe('1');
    expect(toOfficialInput(570, including).filter_offtopic_activity).toBe(false);
    expect(toStorefrontQuery(including).filter_offtopic_activity).toBe('0');
  });

  it('supports explicit day_range overrides for rolling KPI / trend fallbacks', () => {
    const input = toOfficialInput(570, withFilterDefaults(), { dayRangeOverride: 30 });
    expect(input.day_range).toBe(30);
    expect(toOfficialInput(570, withFilterDefaults(), { dayRangeOverride: 0 }).day_range).toBe(0);
    expect(toOfficialInput(570, withFilterDefaults(), { dayRangeOverride: 999 }).day_range).toBe(365);
    expect(toOfficialInput(570, withFilterDefaults(), { dayRangeOverride: null }).day_range).toBeUndefined();
    const query = toStorefrontQuery(withFilterDefaults(), { dayRangeOverride: 90 });
    expect(query.day_range).toBe('90');
    expect(toStorefrontQuery(withFilterDefaults(), { dayRangeOverride: null }).day_range).toBeUndefined();
  });

  it('maps purchase types and sort modes', () => {
    expect(toOfficialInput(1, withFilterDefaults({ purchaseType: 'steam' })).purchase_type).toBe(0);
    expect(toOfficialInput(1, withFilterDefaults({ purchaseType: 'non_steam' })).purchase_type).toBe(2);
    const recent = toOfficialInput(1, withFilterDefaults({ sort: 'recent' }));
    expect(recent.filter).toBe(1);
    expect(recent.day_range).toBeUndefined();
    expect(toOfficialInput(1, withFilterDefaults({ reviewType: 'positive' })).review_type).toBe(1);
  });

  it('maps to storefront string enums', () => {
    const query = toStorefrontQuery(filters);
    expect(query).toMatchObject({
      filter: 'all',
      language: 'schinese,english',
      review_type: 'negative',
      purchase_type: 'all',
      day_range: '0',
      start_date: '100',
      end_date: '200',
      date_range_type: 'include',
      playtime_filter_min: '10',
      playtime_filter_max: '100',
      filter_offtopic_activity: '1',
      use_review_quality: '1',
      num_per_page: '100',
    });
    expect(toStorefrontQuery(withFilterDefaults({ purchaseType: 'non_steam' })).purchase_type).toBe(
      'non_steam_purchase',
    );
    expect(toStorefrontQuery(withFilterDefaults({ purchaseType: 'steam' })).purchase_type).toBe('steam');
  });

  it('applies client filters', () => {
    const reviews: Review[] = [
      { id: 'a', language: 'en', votedUp: true, votesUp: 5, weightedVoteScore: 0, playtimeAtReviewMinutes: 0, createdAt: 0, text: 'Great combat system', writtenDuringEarlyAccess: false, receivedForFree: false },
      { id: 'b', language: 'en', votedUp: false, votesUp: 50, weightedVoteScore: 0, playtimeAtReviewMinutes: 0, createdAt: 0, text: 'Buggy and crashing', writtenDuringEarlyAccess: true, receivedForFree: true },
    ];
    const filters = withClientFilterDefaults({ minVotes: 10, minLength: 5, includeKeywords: [], excludeKeywords: ['crash'], excludeEarlyAccess: true, excludeFree: true });
    expect(applyClientFilters(reviews, filters).map((r) => r.id)).toEqual([]);
    expect(applyClientFilters(reviews, withClientFilterDefaults({}))).toHaveLength(2);
  });
});

describe('Steam response normalization', () => {
  it('normalizes the official wrapped response and cleans text', () => {
    const page = normalizeSteamPage(official, 'official');
    expect(page.source).toBe('official');
    expect(page.cursor).toBe('cursor-2');
    expect(page.reviews).toHaveLength(2);
    expect(page.reviews[0].id).toBe('official-r1');
    expect(page.reviews[0].text).toContain('Combat');
    expect(page.reviews[0].text).not.toContain('[b]');
    expect(page.reviews[0].text).not.toContain('&amp;');
    expect(page.reviews[0].votesUp).toBe(42);
    expect(page.reviews[0].weightedVoteScore).toBeCloseTo(0.8123);
    expect(page.reviews[0].playtimeAtReviewMinutes).toBe(420);
    expect(page.summary?.positive).toBe(9);
    expect(page.summary?.totalPositive).toBe(9);
    expect(page.summary?.totalNegative).toBe(1);
    expect(page.summary?.matchingTotal).toBe(10);
    expect(page.matchingTotal).toBe(10);
    const raw = JSON.stringify(page.reviews);
    expect(raw).not.toContain('steamid');
    expect(raw).not.toContain('76561190000000000');
  });

  it('normalizes the storefront root response', () => {
    const page = normalizeSteamPage(storefront, 'storefront');
    expect(page.source).toBe('storefront');
    expect(page.reviews[0].id).toBe('store-r1');
    expect(page.reviews[0].text).toContain('Solid gameplay');
    expect(page.summary?.reviewScoreDesc).toBe('好评');
    expect(page.matchingTotal).toBe(100);
  });

  it('throws STEAM_ENDPOINT_CHANGED for unexpected structures', () => {
    expect(() => normalizeSteamPage({ unexpected: true }, 'official')).toThrow('STEAM_ENDPOINT_CHANGED');
    expect(() => normalizeSteamPage({ response: { weird: 1 } }, 'official')).toThrow('STEAM_ENDPOINT_CHANGED');
    expect(() => normalizeSteamPage(null, 'storefront')).toThrow('STEAM_ENDPOINT_CHANGED');
  });

  it('cleans BBCode, entities and whitespace', () => {
    expect(cleanText('[b]Hello[/b]&nbsp;[i]world[/i]&amp; &lt;tag&gt;\n\n\nnext')).toBe('Hello world& <tag>\n\nnext');
  });

  it('deduplicates reviews by id preferring fuller text', () => {
    const merged = mergeReviews([
      [{ id: 'x', language: 'en', votedUp: true, votesUp: 1, weightedVoteScore: 0, playtimeAtReviewMinutes: 0, createdAt: 0, text: 'short', writtenDuringEarlyAccess: false, receivedForFree: false }],
      [{ id: 'x', language: 'en', votedUp: true, votesUp: 1, weightedVoteScore: 0, playtimeAtReviewMinutes: 0, createdAt: 0, text: 'longer text', writtenDuringEarlyAccess: false, receivedForFree: false }],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('longer text');
  });
});

describe('Game metadata', () => {
  it('falls back to AppID when metadata fails', async () => {
    const game = await resolveGame(570, { fetchAppDetails: () => Promise.reject(new Error('offline')) });
    expect(game.appid).toBe(570);
    expect(game.name).toBe('App 570');
  });

  it('parses appdetails and rejects definitive not-found', async () => {
    const game = await resolveGame(570, {
      fetchAppDetails: async () => ({
        '570': {
          success: true,
          data: { name: 'Dota 2', header_image: 'https://x/h.jpg', release_date: { date: '9 Jul, 2013' } },
        },
      }),
    });
    expect(game.name).toBe('Dota 2');
    expect(game.releaseDate).toBe('9 Jul, 2013');
    await expect(resolveGame(999, { fetchAppDetails: async () => ({ '999': { success: false } }) })).rejects.toThrow(
      'APP_NOT_FOUND',
    );
  });
});
