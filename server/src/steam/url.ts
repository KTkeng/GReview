import { AppError } from '../lib/errors';

const MAX_APPID = 2147483647; // 32-bit signed positive integer
const STEAM_HOSTS = new Set([
  'store.steampowered.com',
  'www.store.steampowered.com',
  'steamcommunity.com',
  'www.steamcommunity.com',
  'help.steampowered.com',
]);

function toAppId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new AppError('INVALID_URL');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_APPID) throw new AppError('INVALID_URL');
  return n;
}

/**
 * Extract a Steam AppID from a store link, community link, or bare positive
 * integer. Deliberately never fetches the user-provided URL (SSRF protection).
 */
export function parseSteamUrl(input: string): number {
  if (typeof input !== 'string') throw new AppError('INVALID_URL');
  const value = input.trim();
  if (!value) throw new AppError('INVALID_URL');

  if (/^\d+$/.test(value)) return toAppId(value);
  if (/^[-+]?\d+$/.test(value)) throw new AppError('INVALID_URL'); // negative / signed
  if (!/^https?:\/\//i.test(value)) throw new AppError('INVALID_URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('INVALID_URL');
  if (!STEAM_HOSTS.has(url.hostname.toLowerCase())) throw new AppError('INVALID_URL');

  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].toLowerCase() === 'app' && /^\d+$/.test(segments[i + 1])) {
      return toAppId(segments[i + 1]);
    }
  }
  throw new AppError('INVALID_URL');
}

export function isValidAppId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_APPID;
}

export function assertAppId(value: unknown): number {
  if (!isValidAppId(value)) throw new AppError('INVALID_URL');
  return value;
}
