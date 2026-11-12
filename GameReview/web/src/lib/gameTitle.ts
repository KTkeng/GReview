/**
 * 游戏标题展示与校验工具。
 *
 * 展示解析以后端 GamePresentation 为唯一来源：`displayTitle` / `titleSource`
 * 已经由后端按「自定义标题 → 有效 Steam 名称 → AppID 占位」解析完成。
 * 这里只做薄封装，并为旧后端或本地缓存中的 GameMeta 提供同样的回退链，
 * 避免前端各处重复拼接标题。
 */

import type { GameMeta, GamePresentation, TitleSource } from '../types';

export const TITLE_MAX_CODE_POINTS = 120;
export const TITLE_VALIDATION_MESSAGE = '标题需为 1–120 个字符且不含换行';

/**
 * 与后端一致的禁止字符：C0/C1 控制字符（含换行、制表符）、
 * 双向文本控制字符（可能造成显示欺骗）以及 Unicode 行/段分隔符。
 */
const FORBIDDEN_TITLE_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;

export function normalizeTitle(value: string): string {
  return value.normalize('NFC').trim();
}

/** 按 Unicode 码点计数（表情等代理对记 1 个字符）。 */
export function titleCodePointLength(value: string): number {
  return Array.from(value).length;
}

export type TitleValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * 本地校验与后端对齐：NFC + trim、1–120 码点、禁换行/控制字符。
 * 纯空白视为无效编辑输入；需要清除自定义标题时应使用「恢复默认」。
 */
export function validateCustomTitle(raw: string): TitleValidationResult {
  const normalized = normalizeTitle(raw);
  if (
    normalized.length === 0 ||
    FORBIDDEN_TITLE_PATTERN.test(normalized) ||
    titleCodePointLength(normalized) > TITLE_MAX_CODE_POINTS
  ) {
    return { ok: false, error: TITLE_VALIDATION_MESSAGE };
  }
  return { ok: true, value: normalized };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toAppid(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' &&
    Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= 4294967295
    ? parsed
    : null;
}

const TITLE_SOURCES: readonly TitleSource[] = [
  '自定义',
  '自动读取',
  '编号占位',
  'custom',
  'steam',
  'placeholder',
];

function toTitleSource(value: unknown): TitleSource | null {
  return typeof value === 'string' && (TITLE_SOURCES as readonly string[]).includes(value)
    ? (value as TitleSource)
    : null;
}

/**
 * 后端把恰好等于 AppID 或「AppID <数字>」的名称视为缺失。
 * 前端在旧数据上沿用同一规则，避免把占位名称当成 Steam 原名。
 */
export function isPlaceholderTitle(
  value: string | null | undefined,
  appid?: number | null,
): boolean {
  const text = nonEmpty(value);
  if (!text) return true;
  if (/^AppID\s+\d+$/i.test(text)) return true;
  if (appid != null && (text === String(appid) || text === `AppID ${appid}`)) return true;
  return false;
}

export interface GameTitleInfo {
  appid: number | null;
  /** 与 displayTitle 相同，兼容 GameMeta.name。 */
  name: string;
  displayTitle: string;
  steamName: string | null;
  customTitle: string | null;
  titleSource: TitleSource | null;
  isCustom: boolean;
  titleRevision: number;
  titleUpdatedAt: string | null;
  titleEditable: boolean;
  coverUrl: string | null;
  coverPlaceholder: string;
  warnings: string[];
}

/** 将 GamePresentation / GameMeta / 字符串归一为展示所需字段。 */
export function gameTitleInfo(
  game: GameMeta | GamePresentation | string | null | undefined,
  fallbackAppid?: number | null,
): GameTitleInfo {
  const record: Record<string, unknown> =
    game && typeof game === 'object' ? (game as Record<string, unknown>) : {};
  const appid = toAppid(record.appid) ?? toAppid(fallbackAppid);
  const placeholder = appid ? `AppID ${appid}` : '未知游戏';

  const customTitle = nonEmpty(record.customTitle);
  const steamRaw = nonEmpty(record.steamName);
  const steamName = steamRaw && !isPlaceholderTitle(steamRaw, appid) ? steamRaw : null;

  const legacyName = typeof game === 'string' ? nonEmpty(game) : nonEmpty(record.name);
  const displayCandidate =
    nonEmpty(record.displayTitle) ??
    (legacyName && !isPlaceholderTitle(legacyName, appid) ? legacyName : null);

  const displayTitle =
    (displayCandidate && !isPlaceholderTitle(displayCandidate, appid) ? displayCandidate : null) ??
    customTitle ??
    steamName ??
    placeholder;

  const titleSource = toTitleSource(record.titleSource);
  const isCustom = titleSource
    ? titleSource === '自定义' || titleSource === 'custom'
    : Boolean(customTitle && customTitle === displayTitle);

  const revisionValue = record.titleRevision;
  const titleRevision =
    typeof revisionValue === 'number' &&
    Number.isSafeInteger(revisionValue) &&
    revisionValue >= 0
      ? revisionValue
      : 0;

  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter(
        (item): item is string => typeof item === 'string' && item.trim() !== '',
      )
    : [];

  const coverUrl =
    nonEmpty(record.coverUrl) ??
    nonEmpty(record.headerImage) ??
    nonEmpty(record.header_image);

  const titleUpdatedAt =
    typeof record.titleUpdatedAt === 'string' ? record.titleUpdatedAt : null;

  return {
    appid,
    name: displayTitle,
    displayTitle,
    steamName,
    customTitle,
    titleSource,
    isCustom,
    titleRevision,
    titleUpdatedAt,
    titleEditable: record.titleEditable !== false,
    coverUrl,
    coverPlaceholder: nonEmpty(record.coverPlaceholder) ?? placeholder,
    warnings,
  };
}

/** 薄封装：直接消费 displayTitle/titleSource 的回退链。 */
export function resolveGameTitle(
  game: GameMeta | GamePresentation | string | null | undefined,
  fallbackAppid?: number | null,
): string {
  return gameTitleInfo(game, fallbackAppid).displayTitle;
}

/** 把任意来源的 game 归一为可合并的 GamePresentation。 */
export function toGamePresentation(
  game: GameMeta | GamePresentation | string | null | undefined,
  fallbackAppid?: number | null,
): GamePresentation {
  const info = gameTitleInfo(game, fallbackAppid);
  const base = game && typeof game === 'object' ? game : {};
  return {
    ...base,
    appid: info.appid ?? 0,
    name: info.displayTitle,
    displayTitle: info.displayTitle,
    steamName: info.steamName,
    customTitle: info.customTitle,
    titleSource:
      info.titleSource ??
      (info.isCustom
        ? '自定义'
        : isPlaceholderTitle(info.displayTitle, info.appid)
          ? '编号占位'
          : '自动读取'),
    titleRevision: info.titleRevision,
    titleUpdatedAt: info.titleUpdatedAt,
    titleEditable: info.titleEditable,
    coverUrl: info.coverUrl,
    coverPlaceholder: info.coverPlaceholder,
    warnings: info.warnings,
  };
}
