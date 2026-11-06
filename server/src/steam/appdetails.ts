import { AppError } from '../lib/errors';
import type { GameMeta } from '../types';
import { USER_AGENT } from './client';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => (typeof v === 'string' ? v : asRecord(v)?.name ?? asRecord(v)?.description))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return out.length ? out : undefined;
}

/** Parse a store appdetails payload; throws APP_NOT_FOUND when Steam says so. */
export function parseAppDetails(raw: unknown, appid: number): GameMeta {
  const root = asRecord(raw);
  if (!root) throw new AppError('STEAM_UNAVAILABLE', 'appdetails 响应格式异常');
  const entry = asRecord(root[String(appid)] ?? root[appid]);
  if (!entry || entry.success === false) throw new AppError('APP_NOT_FOUND');
  const data = asRecord(entry.data);
  if (!data) throw new AppError('STEAM_UNAVAILABLE', 'appdetails 缺少 data');

  const priceOverview = asRecord(data.price_overview);
  const releaseDate = asRecord(data.release_date);
  return {
    appid,
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : `App ${appid}`,
    ...(typeof data.header_image === 'string' ? { headerImage: data.header_image } : {}),
    ...(typeof data.short_description === 'string' ? { shortDescription: data.short_description } : {}),
    ...(strings(data.developers) ? { developers: strings(data.developers) } : {}),
    ...(strings(data.publishers) ? { publishers: strings(data.publishers) } : {}),
    ...(strings(data.genres) ? { genres: strings(data.genres) } : {}),
    ...(typeof releaseDate?.date === 'string' ? { releaseDate: releaseDate.date } : {}),
    ...(typeof priceOverview?.final_formatted === 'string' ? { price: priceOverview.final_formatted } : {}),
  };
}

export function fallbackGame(appid: number): GameMeta {
  return { appid, name: `App ${appid}` };
}

async function defaultFetchAppDetails(appid: number): Promise<unknown> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=cn`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new AppError('STEAM_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  }
  if (response.status === 404) throw new AppError('APP_NOT_FOUND');
  if (!response.ok) throw new AppError('STEAM_UNAVAILABLE', `Steam HTTP ${response.status}`);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AppError('STEAM_UNAVAILABLE', 'appdetails 响应不是合法 JSON');
  }
}

/**
 * Resolve game metadata. Metadata failure never blocks the main flow; only a
 * definitive `success:false` surfaces APP_NOT_FOUND.
 */
export async function resolveGame(
  appid: number,
  deps: { fetchAppDetails?: (appid: number) => Promise<unknown> } = {},
): Promise<GameMeta> {
  try {
    const raw = deps.fetchAppDetails ? await deps.fetchAppDetails(appid) : await defaultFetchAppDetails(appid);
    return parseAppDetails(raw, appid);
  } catch (err) {
    if (err instanceof AppError && err.code === 'APP_NOT_FOUND') throw err;
    return fallbackGame(appid);
  }
}
