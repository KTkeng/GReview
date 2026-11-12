import path from 'node:path';
import { isAppError } from '../lib/errors';
import type { GameMeta, GamePresentation, Report, TitleSource } from '../types';
import { appDir, readGameMeta } from './game-meta';
import { readTitleOverride, type TitleReadState } from './game-title';
import { readContainedJson } from './paths';
import { isValidDatasetMeta } from './validation';

/** Placeholder used whenever no real Steam name or custom title is available. */
export function placeholderTitle(appid: number): string {
  return `AppID ${appid}`;
}

/**
 * Historical Steam metadata may contain a generated fallback such as "App 570",
 * "AppID 570" or just "570". Those are not real names and must fall through to
 * the custom title or the AppID placeholder instead of masquerading as one.
 */
function isFallbackSteamName(value: string | null | undefined, appid: number): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed === String(appid)) return true;
  const match = /^(?:appid|app)\s*(\d+)$/i.exec(trimmed);
  return match !== null && match[1] === String(appid);
}

function safeCoverUrl(meta: GameMeta | null): string | null {
  const value = meta?.headerImage;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Additional metadata sources used when the current game.json is missing or
 * corrupt. Order matters: the dataset that produced the report is preferred
 * over the report's own game block.
 */
export interface PresentationFallbacks {
  /** Original Steam metadata from the dataset the report was generated from. */
  dataset?: GameMeta | null;
  /**
   * The report's game block. A report that was already merged with presentation
   * fields carries its real automatic name in `steamName`; its `name` may be a
   * custom title and must never be reused as an automatic name.
   */
  report?: GameMeta | null;
}

function usableMeta(value: GameMeta | null | undefined, appid: number): GameMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // A mismatched appid can never describe this game; an absent appid (legacy
  // fixtures) is tolerated for the primary game.json source.
  if (typeof value.appid === 'number' && value.appid !== appid) return null;
  return value;
}

function firstValidSteamName(sources: GameMeta[], appid: number): string | null {
  for (const source of sources) {
    const name = source.name;
    if (typeof name === 'string' && !isFallbackSteamName(name, appid)) return name;
  }
  return null;
}

/**
 * Resolve the single presentation model used by every read path. The three-tier
 * fallback is customTitle -> valid steamName -> "AppID <appid>". `name` always
 * equals displayTitle so legacy consumers that only read game.name work.
 *
 * The automatic name is resolved from the first source with a valid Steam name:
 * the current game.json, then the dataset metadata, then the report's own
 * original metadata. Other metadata fields are merged in the same order so a
 * missing game.json does not drop the cover/description of an existing report.
 */
export function buildGamePresentation(
  meta: GameMeta | null,
  appid: number,
  titleState: TitleReadState,
  fallbacks: PresentationFallbacks = {},
): GamePresentation {
  const sources = [meta, fallbacks.dataset, fallbacks.report]
    .map((candidate) => usableMeta(candidate, appid))
    .filter((candidate): candidate is GameMeta => candidate !== null);

  const metadata: GameMeta = { appid, name: '' };
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    for (const [key, value] of Object.entries(sources[index])) {
      if (key === 'appid' || value === undefined) continue;
      (metadata as unknown as Record<string, unknown>)[key] = value;
    }
  }

  const steamName = firstValidSteamName(sources, appid);
  const customTitle = titleState.status === 'ok' ? titleState.title.customTitle : null;

  let displayTitle: string;
  let titleSource: TitleSource;
  if (customTitle) {
    displayTitle = customTitle;
    titleSource = '自定义';
  } else if (steamName) {
    displayTitle = steamName;
    titleSource = '自动读取';
  } else {
    displayTitle = placeholderTitle(appid);
    titleSource = '编号占位';
  }

  // Corrupt and temporarily unreadable title files degrade identically for
  // display: automatic name/placeholder plus a warning, never a broken list.
  const warnings =
    titleState.status === 'corrupt' || titleState.status === 'unavailable' ? [titleState.warning] : [];
  const titleRevision =
    titleState.status === 'corrupt' || titleState.status === 'unavailable'
      ? null
      : titleState.status === 'ok'
        ? titleState.title.revision
        : 0;
  const titleUpdatedAt = titleState.status === 'ok' ? titleState.title.updatedAt : null;

  return {
    ...metadata,
    appid,
    name: displayTitle,
    steamName,
    customTitle,
    displayTitle,
    titleSource,
    titleRevision,
    titleUpdatedAt,
    titleEditable: titleState.editable,
    coverUrl: safeCoverUrl(metadata),
    coverPlaceholder: placeholderTitle(appid),
    warnings,
  };
}

/**
 * Read the stored Steam metadata (unless the caller already has it) plus the
 * current title file and build the presentation. A corrupt title file degrades
 * to the automatic name with warnings; it never breaks the read path.
 */
export async function resolveGamePresentation(
  dataDir: string,
  appid: number,
  meta?: GameMeta | null,
  fallbacks: PresentationFallbacks = {},
): Promise<GamePresentation> {
  const [gameMeta, titleState] = await Promise.all([
    meta === undefined ? readGameMeta(dataDir, appid) : Promise.resolve(meta),
    readTitleOverride(dataDir, appid),
  ]);
  return buildGamePresentation(gameMeta, appid, titleState, fallbacks);
}

const PRESENTATION_FIELD_MARKERS = ['steamName', 'displayTitle', 'titleSource'] as const;

/**
 * Extract the original Steam metadata carried by a report. A persisted report
 * that was never presented has a plain GameMeta game block. A report that was
 * already merged with presentation fields carries the real automatic name in
 * `steamName` (possibly null); its `name` may be an old custom title or an
 * AppID placeholder and must never be treated as the automatic name.
 */
export function reportGameFallback(report: Report): GameMeta | null {
  const game = report?.game;
  if (!game || typeof game !== 'object' || Array.isArray(game)) return null;
  const record = game as unknown as Record<string, unknown>;
  const presented = PRESENTATION_FIELD_MARKERS.some((key) => key in record);
  if (!presented) return game;
  return {
    ...game,
    name: typeof record.steamName === 'string' ? record.steamName : '',
  };
}

/**
 * Read the Steam metadata stored with the dataset a report was generated from.
 * This is only a fallback source for presentation: missing or malformed
 * metadata is ignored, but path/link security failures and ordinary read
 * failures still propagate so a compromised data root is never masked.
 */
async function readDatasetGameMeta(
  dataDir: string,
  appid: number,
  reviewsHash: string | undefined,
): Promise<GameMeta | null> {
  if (!reviewsHash || !/^[a-f0-9]{16}$/.test(reviewsHash)) return null;
  const target = path.join(appDir(dataDir, appid), 'reviews', reviewsHash, 'meta.json');
  try {
    const raw = await readContainedJson<unknown>(dataDir, target);
    if (!isValidDatasetMeta(raw, { appid, reviewsHash })) return null;
    return raw.game;
  } catch (err) {
    if (isAppError(err)) throw err;
    return null;
  }
}

/**
 * Resolve the presentation for a report with the full metadata fallback
 * order: valid current game.json, then the dataset that produced the report,
 * then the report's own original Steam metadata, and finally the AppID
 * placeholder. Presented reports contribute only their `steamName`, never a
 * possibly-custom `name`.
 */
export async function resolveReportPresentation(
  dataDir: string,
  appid: number,
  report: Report,
  meta?: GameMeta | null,
): Promise<GamePresentation> {
  const datasetMeta = await readDatasetGameMeta(dataDir, appid, report.methodology?.reviewsHash);
  return resolveGamePresentation(dataDir, appid, meta, {
    dataset: datasetMeta,
    report: reportGameFallback(report),
  });
}

/**
 * Copy a report and overlay the current presentation on its game block. Only
 * the returned copy changes: the persisted analysis, generatedAt and markdown
 * snapshot on disk stay untouched (contract: rename never rewrites reports).
 */
export function presentReport(report: Report, presentation: GamePresentation): Report {
  const clone = JSON.parse(JSON.stringify(report)) as Report;
  clone.game = { ...clone.game, ...presentation, name: presentation.displayTitle };
  return clone;
}

/** Convenience wrapper for the report read paths. */
export async function presentReportForApp(
  dataDir: string,
  appid: number,
  report: Report,
  meta?: GameMeta | null,
): Promise<Report> {
  const presentation = await resolveReportPresentation(dataDir, appid, report, meta);
  return presentReport(report, presentation);
}
