import type { TrendPoint } from '../types';

export const FORBIDDEN_CLAIM = /(销量|销售收入|收入|在线人数|商业成功|商业上的成功|商业成败|赚了多少钱)/;

/** Steam-like score bands used for windowed KPIs when only aggregates exist. */
export function scoreDescForRate(rate: number, total: number): string {
  if (total <= 0) return '暂无评论';
  if (rate >= 0.95) return '好评如潮';
  if (rate >= 0.85) return '特别好评';
  if (rate >= 0.8) return '好评';
  if (rate >= 0.7) return '多半好评';
  if (rate >= 0.4) return '褒贬不一';
  if (rate >= 0.2) return '多半差评';
  if (rate >= 0.1) return '差评';
  if (rate >= 0.05) return '特别差评';
  return '差评如潮';
}

export type TrendDirection = '近期回升' | '近期下滑' | '持平';

/** Trend direction: last-90d rate vs all-time, 5 percentage points threshold. */
export function trendDirection(allTimeRate: number, last90dRate: number): TrendDirection {
  const diff = last90dRate - allTimeRate;
  if (diff >= 0.05) return '近期回升';
  if (diff <= -0.05) return '近期下滑';
  return '持平';
}

export interface ConclusionLabelInput {
  reviewScoreDesc: string;
  allTimeRate: number;
  last90dRate: number;
}

/** Server-computed label; AI suggestions are ignored in favour of this rule. */
export function conclusionLabel(input: ConclusionLabelInput): string {
  const desc = input.reviewScoreDesc?.trim() || scoreDescForRate(input.allTimeRate, 1);
  const direction = trendDirection(input.allTimeRate, input.last90dRate);
  return direction === '持平' ? `${desc} · 持平` : `${desc} · ${direction}`;
}

export interface ConfidenceInput {
  sampleSize: number;
  trendMonths: number;
  nonZeroMonths: number;
}

/** Confidence rule from design §9.3. */
export function confidenceFor(input: ConfidenceInput): 'high' | 'medium' | 'low' {
  const { sampleSize, trendMonths, nonZeroMonths } = input;
  if (sampleSize >= 100 && trendMonths >= 3 && nonZeroMonths >= 2) return 'high';
  if ((sampleSize >= 30 && sampleSize < 100) || (trendMonths >= 1 && trendMonths <= 3)) return 'medium';
  return 'low';
}

export function containsForbiddenClaim(text: string): boolean {
  return FORBIDDEN_CLAIM.test(text);
}

/** Remove sentences that infer sales/revenue/online counts; keep the rest. */
export function scrubForbiddenClaims(text: string, fallback = '本报告仅评估口碑表现，不推断销量、收入或商业成败。'): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return fallback;
  if (!FORBIDDEN_CLAIM.test(trimmed)) return trimmed;
  const sentences = trimmed.split(/(?<=[。！？!?\n])/);
  const safe = sentences.filter((sentence) => !FORBIDDEN_CLAIM.test(sentence)).join('').trim();
  return safe || fallback;
}

/** Metric a quoted number refers to. Numbers are never valid on their own. */
export type NumericMetric = 'positive_rate' | 'negative_rate' | 'reviews' | 'positive' | 'negative';
export type NumericWindow = 'all_time' | 'last30d' | 'last90d' | 'sample' | 'matched' | 'month' | 'trend';
export type DeltaScope = 'month_over_month' | 'vs_all_time';
export type DeltaMetric = 'positive_rate' | 'negative_rate';

export interface NumericFact {
  metric: NumericMetric;
  window: NumericWindow;
  /** Percentage facts use a 0–100 scale; count facts use absolute counts. */
  value: number;
  /** `YYYY-MM` for month-window facts. */
  period?: string;
}

export interface NumericDeltaFact {
  /**
   * Signed delta in percentage points on a 0–100 scale. Positive means the
   * metric rose; negative means it fell. Never multiplied by 100 again.
   */
  value: number;
  scope: DeltaScope;
  metric: DeltaMetric;
  /** The rolling window compared against all-time (`vs_all_time` only). */
  window?: 'last30d' | 'last90d';
  /** `YYYY-MM` of the earlier month (`month_over_month` only). */
  fromPeriod?: string;
  /** `YYYY-MM` of the later month (`month_over_month` only). */
  toPeriod?: string;
}

export interface NumericFacts {
  /** Percentage facts bound to a metric and window. */
  percentages: NumericFact[];
  /** Absolute count facts bound to a metric and window. */
  counts: NumericFact[];
  /** Signed percentage-point deltas bound to a comparison and metric. */
  deltas: NumericDeltaFact[];
}

export interface ClaimedNumbers {
  percentages: number[];
  counts: number[];
}

interface NumericClaim {
  value: number;
  start: number;
  end: number;
  delta: boolean;
  /** The matched text (e.g. "3 条评论"), used to identify the counted object. */
  text: string;
}

const ASCII_PERCENT_CLAIM = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|％|个百分点|pp)/gi;
const CN_PERCENT_CLAIM = /百分之\s*([零〇一二两三四五六七八九十百点]+)/g;
// "九成"/"九成五" = 90%/95%. Require a following boundary so idioms such as
// "一成不变" are not mistaken for a percentage.
const CN_TENTH_CLAIM =
  /([零〇一二两三四五六七八九十百]+)\s*成(?:([一二三四五六七八九]))?(?=\s*(?:的|玩家|用户|好评|差评|评论|以上|左右|多|[，。；、,.]|$))/g;
const ASCII_COUNT_CLAIM = /(\d+(?:,\d{3})*)\s*(?:条|则|篇)\s*(?:评论|评价|用户评论)?/g;
const CN_COUNT_CLAIM = /([零〇一二两三四五六七八九十百千万]+)\s*(?:条|则|篇)\s*(?:评论|评价|用户评论)?/g;
// KPI totals frequently omit the 条/则/篇 classifier ("评论总数为 9999").
// Requiring the counted noun and, optionally, an explicit total/quantity word
// keeps ordinary prose from being mistaken for a count. A trailing classifier
// or percentage is excluded because the regexes above already cover it.
const ASCII_NOUN_COUNT_CLAIM =
  /(?:评论|评价|用户评论|好评|差评)\s*(?:总数|总数量|数量|条数)?\s*(?:为|是|达到|达|有|共|：|:)?\s*(\d+(?:,\d{3})*)(?!\s*(?:条|则|篇|个|%|％|个百分点|pp|成))/g;
const CN_NOUN_COUNT_CLAIM =
  /(?:评论|评价|用户评论|好评|差评)\s*(?:总数|总数量|数量|条数)?\s*(?:为|是|达到|达|有|共|：|:)?\s*([零〇一二两三四五六七八九十百千万]+)(?!\s*(?:条|则|篇|个|%|％|成))/g;

function parseClaim(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** Parse a Chinese integer/decimal such as 九十, 十五, 一百二十, 九点五. */
export function parseChineseNumber(raw: string): number | null {
  if (!raw) return null;
  const [integerPart, decimalPart] = raw.split('点');
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of integerPart) {
    if (char in CN_DIGITS) {
      digit = CN_DIGITS[char];
      continue;
    }
    const unit = char === '十' ? 10 : char === '百' ? 100 : char === '千' ? 1000 : char === '万' ? 10000 : 0;
    if (!unit) return null;
    if (unit === 10000) {
      section = (section + digit) * unit;
      total += section;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * unit;
      digit = 0;
    }
  }
  total += section + digit;
  if (decimalPart !== undefined) {
    let fraction = 0;
    let scale = 0.1;
    for (const char of decimalPart) {
      const d = CN_DIGITS[char];
      if (d === undefined) return null;
      fraction += d * scale;
      scale /= 10;
    }
    total += fraction;
  }
  return Number.isFinite(total) ? total : null;
}

function collectClaims(text: string): { percentages: NumericClaim[]; counts: NumericClaim[] } {
  const percentages: NumericClaim[] = [];
  const counts: NumericClaim[] = [];
  for (const match of text.matchAll(ASCII_PERCENT_CLAIM)) {
    const value = parseClaim(match[1]);
    if (!Number.isFinite(value)) continue;
    percentages.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: match[2] === '个百分点' || match[2].toLowerCase() === 'pp',
      text: match[0],
    });
  }
  for (const match of text.matchAll(CN_PERCENT_CLAIM)) {
    const value = parseChineseNumber(match[1]);
    if (value === null) continue;
    percentages.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: false,
      text: match[0],
    });
  }
  for (const match of text.matchAll(CN_TENTH_CLAIM)) {
    const base = parseChineseNumber(match[1]);
    if (base === null) continue;
    const tenth = match[2] ? (CN_DIGITS[match[2]] ?? 0) : 0;
    percentages.push({
      value: base * 10 + tenth,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: false,
      text: match[0],
    });
  }
  for (const match of text.matchAll(ASCII_COUNT_CLAIM)) {
    const value = parseClaim(match[1]);
    if (!Number.isFinite(value)) continue;
    counts.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: false,
      text: match[0],
    });
  }
  for (const match of text.matchAll(CN_COUNT_CLAIM)) {
    const value = parseChineseNumber(match[1]);
    if (value === null) continue;
    counts.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: false,
      text: match[0],
    });
  }
  for (const match of text.matchAll(ASCII_NOUN_COUNT_CLAIM)) {
    const value = parseClaim(match[1]);
    if (!Number.isFinite(value)) continue;
    counts.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: false,
      text: match[0],
    });
  }
  for (const match of text.matchAll(CN_NOUN_COUNT_CLAIM)) {
    const value = parseChineseNumber(match[1]);
    if (value === null) continue;
    counts.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      delta: false,
      text: match[0],
    });
  }
  return { percentages, counts };
}

/** Extract explicit percentages and review counts claimed by AI prose. */
export function extractClaimedNumbers(text: string): ClaimedNumbers {
  const claims = collectClaims(text);
  return {
    percentages: claims.percentages.map((c) => c.value),
    counts: claims.counts.map((c) => c.value),
  };
}

export interface WindowBinding {
  window: NumericWindow;
  period?: string;
  month?: number;
}

function padMonth(month: number): string {
  return String(month).padStart(2, '0');
}

function contextAround(text: string, start: number, end: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, start - 28), start),
    after: text.slice(end, Math.min(text.length, end + 18)),
  };
}

/** Detect the time window a number is attached to. Unbound windows are rejected. */
export function detectNumericWindow(before: string, after: string): WindowBinding | null {
  interface Candidate {
    index: number;
    binding: WindowBinding;
  }
  const collect = (text: string): Candidate[] => {
    const candidates: Candidate[] = [];
    const yearRanges: Array<{ start: number; end: number }> = [];
    for (const match of text.matchAll(/(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*月?/g)) {
      const month = Number(match[2]);
      if (month >= 1 && month <= 12) {
        const index = match.index ?? 0;
        yearRanges.push({ start: index, end: index + match[0].length });
        candidates.push({
          index,
          binding: { window: 'month', period: `${match[1]}-${padMonth(month)}` },
        });
      }
    }
    for (const match of text.matchAll(/(\d{1,2})\s*月/g)) {
      const index = match.index ?? 0;
      if (yearRanges.some((range) => index >= range.start && index < range.end)) continue;
      const month = Number(match[1]);
      if (month >= 1 && month <= 12) {
        candidates.push({ index, binding: { window: 'month', month } });
      }
    }
    const simple: Array<{ re: RegExp; window: NumericWindow }> = [
      { re: /(?:最近|近|过去)\s*30\s*天|30\s*天(?:内|窗口)/g, window: 'last30d' },
      { re: /(?:最近|近|过去)\s*90\s*天|90\s*天(?:内|窗口)/g, window: 'last90d' },
      { re: /全部时间|历史|开服以来|总体|整体|全站/g, window: 'all_time' },
      { re: /样本|本次分析|送入\s*AI|用于分析/g, window: 'sample' },
      { re: /匹配|符合筛选|命中/g, window: 'matched' },
      { re: /趋势/g, window: 'trend' },
    ];
    for (const { re, window } of simple) {
      for (const match of text.matchAll(re)) {
        candidates.push({ index: match.index ?? 0, binding: { window } });
      }
    }
    return candidates;
  };

  // The window closest to the number wins. In the prefix that is the last
  // occurrence; in the suffix (e.g. "3 条评论样本，全部时间...") it is the
  // first occurrence. Otherwise a later unrelated "全部时间" could hijack a
  // count that is explicitly attached to the sample.
  const beforeCandidates = collect(before);
  if (beforeCandidates.length > 0) {
    return beforeCandidates.reduce((a, b) => (b.index >= a.index ? b : a)).binding;
  }
  const afterCandidates = collect(after);
  if (afterCandidates.length > 0) {
    return afterCandidates.reduce((a, b) => (b.index < a.index ? b : a)).binding;
  }
  return null;
}

function detectRateMetric(text: string): 'positive_rate' | 'negative_rate' | null {
  if (/差评率|差评占比|差评比例|负面率|负面比例/.test(text)) return 'negative_rate';
  if (/好评率|好评占比|好评比例|正面率|正面比例|好评度/.test(text)) return 'positive_rate';
  return null;
}

function detectCountMetric(text: string): 'reviews' | 'positive' | 'negative' {
  if (/差评/.test(text)) return 'negative';
  if (/好评/.test(text)) return 'positive';
  return 'reviews';
}

type DeltaDirection = 1 | -1 | 0;

/** Signed direction explicitly stated by a delta sentence (0 = unspecified). */
function detectDeltaDirection(text: string): DeltaDirection {
  const up = /(?:回升|上升|提高|提升|上涨|增加|增长|扩大)/.test(text);
  const down = /(?:下降|下滑|回落|降低|减少|下跌|缩小)/.test(text);
  if (up && !down) return 1;
  if (down && !up) return -1;
  return 0;
}

interface MonthToken {
  year?: number;
  month: number;
  index: number;
}

interface MonthPair {
  from?: MonthToken;
  to?: MonthToken;
}

function extractMonthTokens(text: string): MonthToken[] {
  const tokens: MonthToken[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*月?/g)) {
    const month = Number(match[2]);
    const start = match.index ?? 0;
    if (month < 1 || month > 12) continue;
    tokens.push({ year: Number(match[1]), month, index: start });
    ranges.push({ start, end: start + match[0].length });
  }
  for (const match of text.matchAll(/(\d{1,2})\s*月/g)) {
    const start = match.index ?? 0;
    if (ranges.some((range) => start >= range.start && start < range.end)) continue;
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) tokens.push({ month, index: start });
  }
  return tokens.sort((a, b) => a.index - b.index);
}

/**
 * Detect the two months being compared. "2025-12 较 2025-11" means `to=12`,
 * `from=11`; a single named month is treated as the later month. This makes a
 * swapped-month claim fail instead of merely checking that some month-over-
 * month delta has the quoted magnitude.
 */
function detectMonthPair(text: string): MonthPair | null {
  const tokens = extractMonthTokens(text);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return { to: tokens[0] };
  const compareAt = text.search(/(?:较|相比|对比|与)/);
  if (compareAt >= 0) {
    const before = tokens.filter((token) => token.index < compareAt);
    const after = tokens.filter((token) => token.index > compareAt);
    if (before.length > 0 && after.length > 0) {
      return { to: before[before.length - 1], from: after[0] };
    }
  }
  return { from: tokens[0], to: tokens[1] };
}

function monthTokenMatches(period: string | undefined, token: MonthToken | undefined): boolean {
  if (!token) return true;
  if (!period) return false;
  const factYear = Number(period.slice(0, 4));
  const factMonth = Number(period.slice(5, 7));
  if (factMonth !== token.month) return false;
  return token.year === undefined || token.year === factYear;
}

/** The 30/90-day window explicitly named next to a vs-all-time delta. */
function detectComparedWindow(text: string): 'last30d' | 'last90d' | null {
  const has30 = /30\s*天/.test(text);
  const has90 = /90\s*天/.test(text);
  if (has30 && !has90) return 'last30d';
  if (has90 && !has30) return 'last90d';
  return null;
}

/**
 * A delta is only accepted when its comparison scope, metric and signed
 * direction match a server-computed fact. When months or a 30/90-day window
 * are named explicitly they must identify the same comparison; without them,
 * the magnitude+direction must still identify a single comparison window.
 */
function deltaClaimOk(claim: NumericClaim, text: string, facts: NumericFacts): boolean {
  const { before, after } = contextAround(text, claim.start, claim.end);
  const near = `${before}${after}`;
  const scope: DeltaScope | null = /较上月|环比|月度|上月/.test(near)
    ? 'month_over_month'
    : /较全部时间|相比全部时间|与全部时间|较历史|相比历史/.test(near)
      ? 'vs_all_time'
      : null;
  if (!scope) return false;

  // An unspecified rate noun defaults to the primary positive-rate KPI; an
  // explicit 差评率/负面率 binds the delta to the negative rate instead.
  const metric: DeltaMetric = detectRateMetric(near) ?? 'positive_rate';
  const direction = detectDeltaDirection(near);
  const monthPair = scope === 'month_over_month' ? detectMonthPair(near) : null;
  const comparedWindow = scope === 'vs_all_time' ? detectComparedWindow(near) : null;
  const tolerance = 0.55;

  const candidates = facts.deltas.filter((delta) => {
    if (delta.scope !== scope) return false;
    if (delta.metric !== metric) return false;
    if (direction !== 0 && Math.sign(delta.value) !== direction) return false;
    return Math.abs(Math.abs(delta.value) - claim.value) <= tolerance;
  });
  if (candidates.length === 0) return false;

  if (scope === 'month_over_month') {
    if (!monthPair) return true;
    return candidates.some(
      (delta) =>
        monthTokenMatches(delta.fromPeriod, monthPair.from) &&
        monthTokenMatches(delta.toPeriod, monthPair.to),
    );
  }
  if (comparedWindow) return candidates.some((delta) => delta.window === comparedWindow);
  return new Set(candidates.map((delta) => delta.window)).size === 1;
}

function periodMatches(fact: NumericFact, binding: WindowBinding): boolean {
  if (binding.window !== 'month') return true;
  if (binding.period && fact.period !== binding.period) return false;
  if (binding.month !== undefined) {
    const factMonth = Number((fact.period ?? '').slice(5, 7));
    if (factMonth !== binding.month) return false;
  }
  return true;
}

function matchesFact(
  fact: NumericFact,
  binding: WindowBinding,
  metric: NumericMetric,
  value: number,
  tolerance: number,
): boolean {
  return (
    fact.window === binding.window &&
    fact.metric === metric &&
    periodMatches(fact, binding) &&
    Math.abs(fact.value - value) <= tolerance
  );
}

function percentClaimOk(claim: NumericClaim, text: string, facts: NumericFacts): boolean {
  const { before, after } = contextAround(text, claim.start, claim.end);

  if (claim.delta) {
    // Deltas are percentage points. They only mean something when the sentence
    // says which comparison is being made ("较上月" vs "较全部时间"), which
    // metric it concerns and in which direction.
    return deltaClaimOk(claim, text, facts);
  }

  // "90% 的玩家/评论者/主题..." is a proportion of a subject, not a KPI.
  // Never let it pass merely because some unrelated KPI happens to equal 90%.
  if (/(?:%|％)\s*的?\s*(?:玩家|用户|人|受访者|评论者|主题|反馈)/.test(after)) return false;
  if (/^\s*的?\s*(?:玩家|用户|人|受访者|评论者|主题|反馈)/.test(text.slice(claim.end, claim.end + 16))) {
    return false;
  }

  const binding = detectNumericWindow(before, after);
  if (!binding) return false;
  // Look before the number first, so a later unrelated noun in the same
  // sentence cannot be used to legitimise the wrong metric.
  const metric = detectRateMetric(before) ?? detectRateMetric(after.slice(0, 12));
  // A bare percentage with no explicit rate noun has no verifiable object.
  if (!metric) return false;
  return facts.percentages.some((fact) => matchesFact(fact, binding, metric, claim.value, 0.55));
}

function countClaimOk(claim: NumericClaim, text: string, facts: NumericFacts): boolean {
  const { before, after } = contextAround(text, claim.start, claim.end);
  const binding = detectNumericWindow(before, after);
  if (!binding) return false;
  // The counted object is immediately adjacent to the number ("3 条评论",
  // "好评 900 条", "900 条好评"). Only a short suffix is inspected so a later
  // clause cannot change which object was counted.
  const metric = detectCountMetric(`${before.slice(-12)}${claim.text}${after.slice(0, 6)}`);
  return facts.counts.some((fact) =>
    matchesFact(fact, binding, metric, claim.value, Math.max(1, Math.abs(claim.value) * 0.01)),
  );
}

/**
 * Numeric consistency check (design §8.5 rule 8). Every quoted number must be
 * bound to the metric, time window and object it describes; a value that merely
 * appears in some other KPI is not accepted. Percentages allow rounding slack
 * (0.55pp); counts allow 1% (or one review) rounding. Chinese numerals and
 * "百分点" claims are handled explicitly.
 */
export function checkNumericConsistency(
  text: string,
  facts: NumericFacts,
): { ok: boolean; mismatches: string[] } {
  const claims = collectClaims(text);
  const mismatches: string[] = [];
  for (const claim of claims.percentages) {
    if (!percentClaimOk(claim, text, facts)) mismatches.push(`${claim.value}%`);
  }
  for (const claim of claims.counts) {
    if (!countClaimOk(claim, text, facts)) mismatches.push(`${claim.value} 条`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

export interface WindowedKpi {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
  reviewScoreDesc: string;
}

/**
 * Convert server-computed rolling KPI windows to report windows. The windows
 * themselves always come from true rolling 30/90-day aggregates (official, or
 * sample timestamps as a labelled fallback) — never from natural-month trends.
 */
export function windowedKpiFromWindow(
  window: { total: number; positive: number; negative: number; positiveRate: number },
): WindowedKpi {
  return {
    ...window,
    reviewScoreDesc: window.total > 0 ? scoreDescForRate(window.positiveRate, window.total) : '暂无评论',
  };
}

/** Extra percentage facts worth accepting when the AI mentions the 90d delta. */
export function allowedTrendDeltas(points: TrendPoint[]): number[] {
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    deltas.push(Math.abs((points[i].positiveRate - points[i - 1].positiveRate) * 100));
  }
  return deltas;
}

export interface NumericWindowFacts {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
}

export interface NumericFactsInput {
  allTime: NumericWindowFacts;
  last30d: NumericWindowFacts;
  last90d: NumericWindowFacts;
  /** Number of reviews in the analysed sample. */
  sampleCount: number;
  samplePositive: number;
  samplePositiveRate: number;
  usedForAI: number;
  matchedTotal: number;
  trendPoints: TrendPoint[];
}

/**
 * Build the structured fact table used to verify AI prose. Every fact carries
 * its metric and time window so a number cannot be legitimised by an unrelated
 * KPI that happens to have the same value (review Major 2). Trend deltas are
 * percentage points on a 0–100 scale and are never multiplied by 100 again.
 */
export function buildNumericFacts(input: NumericFactsInput): NumericFacts {
  const percentages: NumericFact[] = [];
  const counts: NumericFact[] = [];

  const addRate = (
    metric: 'positive_rate' | 'negative_rate',
    window: NumericWindow,
    rate: number,
    period?: string,
  ): void => {
    const value = rate * 100;
    if (!Number.isFinite(value)) return;
    percentages.push(period ? { metric, window, value, period } : { metric, window, value });
  };
  const addCount = (metric: NumericMetric, window: NumericWindow, value: number, period?: string): void => {
    if (!Number.isFinite(value)) return;
    counts.push(period ? { metric, window, value, period } : { metric, window, value });
  };
  const addWindow = (window: 'last30d' | 'last90d', kpi: NumericWindowFacts): void => {
    addRate('positive_rate', window, kpi.positiveRate);
    if (kpi.total > 0) addRate('negative_rate', window, kpi.negative / kpi.total);
    addCount('reviews', window, kpi.total);
    addCount('positive', window, kpi.positive);
    addCount('negative', window, kpi.negative);
  };

  addRate('positive_rate', 'all_time', input.allTime.positiveRate);
  if (input.allTime.total > 0) {
    addRate('negative_rate', 'all_time', input.allTime.negative / input.allTime.total);
  }
  addCount('reviews', 'all_time', input.allTime.total);
  addCount('positive', 'all_time', input.allTime.positive);
  addCount('negative', 'all_time', input.allTime.negative);

  addWindow('last30d', input.last30d);
  addWindow('last90d', input.last90d);

  if (input.sampleCount > 0) {
    addRate('positive_rate', 'sample', input.samplePositiveRate);
    addRate('negative_rate', 'sample', 1 - input.samplePositiveRate);
  }
  addCount('reviews', 'sample', input.sampleCount);
  addCount('reviews', 'sample', input.usedForAI);
  addCount('positive', 'sample', input.samplePositive);
  addCount('negative', 'sample', input.sampleCount - input.samplePositive);
  addCount('reviews', 'matched', input.matchedTotal);

  for (const point of input.trendPoints) {
    const period = typeof point.period === 'string' && point.period ? point.period : undefined;
    addRate('positive_rate', 'month', point.positiveRate, period);
    if (point.total > 0) addRate('negative_rate', 'month', point.negative / point.total, period);
    addCount('reviews', 'month', point.total, period);
    addCount('positive', 'month', point.positive, period);
    addCount('negative', 'month', point.negative, period);
  }

  const deltas: NumericFacts['deltas'] = [];
  for (let i = 1; i < input.trendPoints.length; i += 1) {
    const previous = input.trendPoints[i - 1];
    const current = input.trendPoints[i];
    const positiveDelta = (current.positiveRate - previous.positiveRate) * 100;
    if (!Number.isFinite(positiveDelta)) continue;
    deltas.push({
      value: positiveDelta,
      scope: 'month_over_month',
      metric: 'positive_rate',
      ...(previous.period ? { fromPeriod: previous.period } : {}),
      ...(current.period ? { toPeriod: current.period } : {}),
    });
    // A positive-rate increase is exactly a negative-rate decrease.
    deltas.push({
      value: -positiveDelta,
      scope: 'month_over_month',
      metric: 'negative_rate',
      ...(previous.period ? { fromPeriod: previous.period } : {}),
      ...(current.period ? { toPeriod: current.period } : {}),
    });
  }
  const windows: Array<['last30d' | 'last90d', NumericWindowFacts]> = [
    ['last30d', input.last30d],
    ['last90d', input.last90d],
  ];
  for (const [window, kpi] of windows) {
    const positiveDelta = (kpi.positiveRate - input.allTime.positiveRate) * 100;
    if (!Number.isFinite(positiveDelta)) continue;
    deltas.push({ value: positiveDelta, scope: 'vs_all_time', metric: 'positive_rate', window });
    deltas.push({ value: -positiveDelta, scope: 'vs_all_time', metric: 'negative_rate', window });
  }

  return { percentages, counts, deltas };
}

export interface NarrativeSanitization {
  text: string;
  /** True when at least one sentence was dropped or the fallback was used. */
  changed: boolean;
  /** True when a sentence was dropped because its numbers could not be verified. */
  numericMismatch: boolean;
  /** True when a sentence was dropped because it inferred sales/revenue/etc. */
  forbiddenRemoved: boolean;
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Server-side scrub of AI narrative (design §8.5 rules 8–9, §9.3). Every
 * sentence that infers sales/revenue/online counts or quotes a percentage /
 * review count that does not match server-computed facts is removed. When
 * nothing remains, the caller-provided fallback is used instead.
 */
export function sanitizeNarrative(
  text: string,
  facts: NumericFacts,
  fallback = '',
): NarrativeSanitization {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { text: fallback, changed: false, numericMismatch: false, forbiddenRemoved: false };
  const kept: string[] = [];
  let numericMismatch = false;
  let forbiddenRemoved = false;
  for (const sentence of splitSentences(trimmed)) {
    if (containsForbiddenClaim(sentence)) {
      forbiddenRemoved = true;
      continue;
    }
    if (!checkNumericConsistency(sentence, facts).ok) {
      numericMismatch = true;
      continue;
    }
    kept.push(sentence);
  }
  const out = kept.join('').trim();
  if (!out) {
    return { text: fallback, changed: true, numericMismatch, forbiddenRemoved };
  }
  return { text: out, changed: numericMismatch || forbiddenRemoved, numericMismatch, forbiddenRemoved };
}

/** Baseline caveats that every report must carry (design §9.3). */
export const BASE_CAVEATS = [
  '样本以高赞评论为主，可能低估长尾玩家与沉默玩家。',
  '语言筛选（默认简中 + 英文）会遗漏其他语言玩家。',
  '已按配置过滤离题/差评轰炸活动，数字与 Steam 全站口径可能不同。',
  '评论样本不代表全部玩家，结论仅反映可获取的公开评论。',
  '无法依据评论推断销量、收入、在线人数或商业成败。',
];

function cleanCaveat(value: string): string {
  return scrubForbiddenClaims(value, '').trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = (value ?? '').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function uniqueAiCaveats(values: string[]): string[] {
  return uniqueStrings(values.map(cleanCaveat));
}

/**
 * Merge caveats with required-first priority (review R3 Major): the mandatory
 * baseline caveats and server-generated dynamic warnings are always retained,
 * even when the AI returns many optional caveats. Only the optional AI list is
 * capped, so the total stays at most 10.
 *
 * Server caveats are deliberately not scrubbed: the baseline disclaimer must
 * be allowed to mention "销量/收入/商业成败" while disclaiming them.
 */
export function buildCaveats(aiCaveats: string[], extra: string[] = []): string[] {
  const required = uniqueStrings([...extra, ...BASE_CAVEATS]);
  const requiredSet = new Set(required);
  const optional = uniqueAiCaveats(aiCaveats).filter((c) => !requiredSet.has(c));
  const slots = Math.max(0, 10 - required.length);
  return [...required, ...optional.slice(0, slots)];
}
