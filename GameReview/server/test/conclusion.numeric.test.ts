import { describe, expect, it } from 'vitest';
import {
  allowedTrendDeltas,
  buildNumericFacts,
  checkNumericConsistency,
  parseChineseNumber,
  sanitizeNarrative,
  type NumericFactsInput,
} from '../src/analysis/conclusion';
import type { TrendPoint } from '../src/types';

const TREND_POINTS: TrendPoint[] = [
  { period: '2025-11', total: 100, positive: 80, negative: 20, positiveRate: 0.8 },
  { period: '2025-12', total: 100, positive: 85, negative: 15, positiveRate: 0.85 },
];

const FACTS_INPUT: NumericFactsInput = {
  allTime: { total: 1000, positive: 900, negative: 100, positiveRate: 0.9 },
  last30d: { total: 300, positive: 240, negative: 60, positiveRate: 0.8 },
  last90d: { total: 600, positive: 420, negative: 180, positiveRate: 0.7 },
  sampleCount: 3,
  samplePositive: 2,
  samplePositiveRate: 2 / 3,
  usedForAI: 3,
  matchedTotal: 1000,
  trendPoints: TREND_POINTS,
};

const facts = buildNumericFacts(FACTS_INPUT);

function accepts(text: string): boolean {
  return checkNumericConsistency(text, facts).ok;
}

describe('numeric claims are bound to metric, window and object', () => {
  it('accepts a percentage only for its own window and metric', () => {
    expect(accepts('全部时间好评率 90.0%')).toBe(true);
    expect(accepts('全部时间差评率 10%')).toBe(true);
    expect(accepts('最近 30 天好评率 80%')).toBe(true);
    expect(accepts('最近 90 天好评率 70%')).toBe(true);

    // Metric interchange: a real value cannot legitimise another window.
    expect(accepts('最近 30 天好评率 90%')).toBe(false);
    expect(accepts('最近 90 天好评率 90%')).toBe(false);
    expect(accepts('全部时间好评率 80%')).toBe(false);
    // Rate interchange within the same window.
    expect(accepts('全部时间差评率 90%')).toBe(false);
  });

  it('rejects theme/player proportions that merely reuse a KPI value', () => {
    expect(accepts('90%的玩家反馈战斗手感很好')).toBe(false);
    expect(accepts('90% 的受访者提到了价格')).toBe(false);
    expect(accepts('80% 的主题与战斗有关')).toBe(false);
    expect(accepts('有 90% 的用户推荐本作')).toBe(false);
  });

  it('binds review counts to the counted object and window', () => {
    expect(accepts('全部时间共 1000 条评论')).toBe(true);
    expect(accepts('全部时间共 900 条好评')).toBe(true);
    expect(accepts('全部时间共 100 条差评')).toBe(true);
    expect(accepts('基于 3 条评论样本')).toBe(true);

    expect(accepts('最近 30 天共 1000 条评论')).toBe(false);
    expect(accepts('全部时间共 900 条评论')).toBe(false);
    expect(accepts('全部时间共 1000 条好评')).toBe(false);
    expect(accepts('最近 30 天共 900 条好评')).toBe(false);
  });

  it('accepts percentage-point deltas once, never multiplied twice', () => {
    // Build facts must expose 5 percentage points, not 500.
    expect(allowedTrendDeltas(TREND_POINTS)[0]).toBeCloseTo(5, 9);
    expect(facts.deltas.some((d) => d.scope === 'month_over_month' && Math.abs(d.value - 5) < 1e-9)).toBe(true);
    expect(facts.deltas.some((d) => d.value === 500)).toBe(false);

    expect(accepts('较上月回升 5 个百分点')).toBe(true);
    expect(accepts('环比变化 5pp')).toBe(true);
    expect(accepts('较全部时间下降 20 个百分点')).toBe(true);

    expect(accepts('较上月回升 500 个百分点')).toBe(false);
    expect(accepts('较上月回升 5%')).toBe(false);
    expect(accepts('回升 5 个百分点')).toBe(false);
  });

  it('parses and binds Chinese numerals', () => {
    expect(parseChineseNumber('九十')).toBe(90);
    expect(parseChineseNumber('九点五')).toBe(9.5);
    expect(parseChineseNumber('一百二十')).toBe(120);
    expect(parseChineseNumber('一千')).toBe(1000);
    expect(parseChineseNumber('一万')).toBe(10000);

    expect(accepts('全部时间好评率百分之九十')).toBe(true);
    expect(accepts('全部时间好评率九成')).toBe(true);
    expect(accepts('全部时间共一千条评论')).toBe(true);
    expect(accepts('样本共三条评论')).toBe(true);

    expect(accepts('好评率百分之九十')).toBe(false);
    expect(accepts('最近 30 天好评率九成')).toBe(false);
    expect(accepts('最近 30 天共一千条评论')).toBe(false);
    expect(accepts('全部时间好评率百分之九十九')).toBe(false);
  });

  it('binds a delta to its signed direction and metric', () => {
    // The server fact is +5pp for the positive rate: a decline is a different
    // claim and must not be accepted by absolute magnitude alone.
    expect(accepts('环比回升 5 个百分点')).toBe(true);
    expect(accepts('环比下降 5 个百分点')).toBe(false);
    expect(accepts('环比差评率下降 5 个百分点')).toBe(true);
    expect(accepts('环比差评率上升 5 个百分点')).toBe(false);
    // Direction without a comparison scope is unverifiable.
    expect(accepts('回升 5 个百分点')).toBe(false);
  });

  it('binds month-over-month deltas to the exact month pair', () => {
    expect(accepts('环比：2025-12 较 2025-11 回升 5 个百分点')).toBe(true);
    expect(accepts('环比：2025-11 较 2025-12 回升 5 个百分点')).toBe(false);
    expect(accepts('环比 12 月较 11 月回升 5 个百分点')).toBe(true);
    expect(accepts('环比 11 月较 12 月回升 5 个百分点')).toBe(false);
    // The right pair with the wrong direction still fails.
    expect(accepts('环比：2025-12 较 2025-11 下降 5 个百分点')).toBe(false);
  });

  it('binds vs-all-time deltas to the named 30/90-day window', () => {
    // Facts: last30d is -10pp and last90d is -20pp against all-time.
    expect(accepts('最近 30 天较全部时间下降 10 个百分点')).toBe(true);
    expect(accepts('最近 90 天较全部时间下降 20 个百分点')).toBe(true);

    // Swapping the window and the magnitude must not pass on the aggregate
    // magnitude alone.
    expect(accepts('最近 30 天较全部时间下降 20 个百分点')).toBe(false);
    expect(accepts('最近 90 天较全部时间下降 10 个百分点')).toBe(false);
    // Wrong direction in the right window.
    expect(accepts('最近 90 天较全部时间回升 20 个百分点')).toBe(false);
  });

  it('accepts unit-less KPI review counts bound to their window', () => {
    expect(accepts('全部时间评论总数为 1000')).toBe(true);
    expect(accepts('最近 30 天评论总数为 300')).toBe(true);
    expect(accepts('最近 90 天评论总数为 600')).toBe(true);
    expect(accepts('全部时间好评总数为 900')).toBe(true);
    expect(accepts('全部时间差评总数为 100')).toBe(true);
    expect(accepts('全部时间评论总数为一千')).toBe(true);

    // A count without a classifier is still bound to the metric and window.
    expect(accepts('最近 30 天评论总数为 9999')).toBe(false);
    expect(accepts('全部时间评论总数为 300')).toBe(false);
    expect(accepts('全部时间好评总数为 100')).toBe(false);
    expect(accepts('全部时间差评总数为 900')).toBe(false);
    expect(accepts('评论总数为 1000')).toBe(false);

    // The classifier form must not be rejected by the new noun-count rule.
    expect(accepts('全部时间共 1000 条评论')).toBe(true);
    expect(accepts('最近 30 天共 1000 条评论')).toBe(false);
  });

  it('removes only the sentences whose claims cannot be verified', () => {
    const result = sanitizeNarrative('全部时间好评率 90%。最近 30 天好评率 90%。战斗手感很好。', facts);
    expect(result.text).toBe('全部时间好评率 90%。战斗手感很好。');
    expect(result.changed).toBe(true);
    expect(result.numericMismatch).toBe(true);

    const unbound = sanitizeNarrative('好评率高达 90%。', facts, '无可用结论。');
    expect(unbound.text).toBe('无可用结论。');
    expect(unbound.numericMismatch).toBe(true);
  });
});
