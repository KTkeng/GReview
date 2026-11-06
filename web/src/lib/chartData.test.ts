import { describe, expect, it } from 'vitest';
import type { Theme, TopReview } from '../types';
import { languageCounts, playtimeHistogram, themeData, trendRate, trendSourceNote } from './chartData';
import { estimateFallback, gameGenres, getMatchingTotal, getReuseInfo } from './preview';
import type { PreviewResult } from '../types';

function review(playtimeHours: number, language: string): TopReview {
  return {
    reviewId: `${playtimeHours}-${language}`,
    text: 'text',
    votesUp: 1,
    votedUp: true,
    language,
    playtimeHours,
    createdAt: 0,
  };
}

describe('playtimeHistogram', () => {
  it('按边界分桶并忽略非法值', () => {
    const buckets = playtimeHistogram([
      review(0.5, 'english'),
      review(1, 'english'),
      review(4.9, 'english'),
      review(5, 'english'),
      review(29.9, 'english'),
      review(30, 'english'),
      review(100, 'english'),
      review(-3, 'english'),
      review(Number.NaN, 'english'),
    ]);
    const counts = Object.fromEntries(buckets.map((bucket) => [bucket.label, bucket.count]));
    expect(counts['<1h']).toBe(1);
    expect(counts['1–5h']).toBe(2);
    expect(counts['5–10h']).toBe(1);
    expect(counts['10–30h']).toBe(1);
    expect(counts['30–100h']).toBe(1);
    expect(counts['≥100h']).toBe(1);
  });
});

describe('languageCounts', () => {
  it('统计并按数量降序', () => {
    const slices = languageCounts([
      review(1, 'schinese'),
      review(1, 'schinese'),
      review(1, 'english'),
      review(1, ''),
    ]);
    expect(slices[0]).toMatchObject({ code: 'schinese', name: '简中', value: 2 });
    expect(slices.map((slice) => slice.code)).toContain('unknown');
    expect(slices.find((slice) => slice.code === 'unknown')?.value).toBe(1);
  });
});

describe('themeData', () => {
  const themes: Theme[] = [
    { id: 'a', name: 'A', mentions: 3, summary: '', evidenceIds: [], sentiment: 'positive' },
    { id: 'b', name: 'B', mentions: 9, summary: '', evidenceIds: [], sentiment: 'negative' },
    { id: 'c', name: 'C', mentions: 6, summary: '', evidenceIds: [], sentiment: 'neutral' },
  ];

  it('按提及次数排序并限制条数', () => {
    expect(themeData(themes, 2).map((item) => item.name)).toEqual(['B', 'C']);
    expect(themeData(themes).map((item) => item.sentiment)).toEqual([
      'negative',
      'neutral',
      'positive',
    ]);
  });
});

describe('preview helpers', () => {
  const preview: PreviewResult = {
    appid: 570,
    game: { appid: 570, name: 'Dota 2' },
    summary: {
      total: 100000,
      positive: 80000,
      negative: 20000,
      positiveRate: 80,
      reviewScoreDesc: '特别好评',
      matchingTotal: 5000,
    },
    steamMatchingTotal: 6000,
    reuse: {
      dataset: { reviewCount: 200, fetchedAt: '2025-01-01T00:00:00.000Z' },
      report: {
        generatedAt: '2025-01-02T00:00:00.000Z',
        match: 'exact',
        reusable: true,
      },
      canUseLocalReport: true,
    },
  };

  it('优先使用 steamMatchingTotal', () => {
    expect(getMatchingTotal(preview)).toBe(6000);
    expect(
      getMatchingTotal({ ...preview, steamMatchingTotal: undefined } as unknown as PreviewResult),
    ).toBe(5000);
    expect(getMatchingTotal(null)).toBe(0);
  });

  it('读取复用信息', () => {
    const reuse = getReuseInfo(preview);
    expect(reuse.dataset?.reviewCount).toBe(200);
    expect(reuse.report?.generatedAt).toBe('2025-01-02T00:00:00.000Z');
    expect(reuse.historicalReport).toBeNull();
    expect(getReuseInfo(null)).toEqual({ dataset: null, report: null, historicalReport: null });
  });

  it('历史报告不会被当作可复用报告（F1）', () => {
    const historical = {
      ...preview,
      reuse: {
        dataset: preview.reuse?.dataset,
        report: {
          generatedAt: '2025-01-02T00:00:00.000Z',
          match: 'historical' as const,
          reusable: false,
        },
        canUseLocalReport: false,
      },
    };
    const reuse = getReuseInfo(historical);
    expect(reuse.report).toBeNull();
    expect(reuse.historicalReport?.generatedAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('估算分页与请求数', () => {
    const estimate = estimateFallback(950, 500, 12);
    expect(estimate.pages).toBe(5);
    expect(estimate.trendRequests).toBe(12);
    expect(estimate.seconds).toBeGreaterThan(0);
  });

  it('解析 Steam 风格 genres', () => {
    expect(
      gameGenres({
        name: 'Dota 2',
        genres: ['Action', { id: '1', description: 'Strategy' }],
      }),
    ).toEqual(['Action', 'Strategy']);
  });
});

describe('trendRate', () => {
  it('统一转换为 0-100', () => {
    expect(trendRate(0.5)).toBe(50);
    expect(trendRate(75)).toBe(75);
    expect(trendRate(Number.NaN)).toBe(0);
  });
});

describe('trendSourceNote（F4）', () => {
  it('官方聚合与样本估算使用不同标题', () => {
    expect(trendSourceNote('official_aggregate')).toBe('官方月度聚合，不使用高赞样本');
    expect(trendSourceNote('sample_estimate')).toBe('样本估算，受高赞采样偏差影响');
  });

  it('未知来源不冒充官方聚合', () => {
    expect(trendSourceNote(undefined)).toBe('数据源标注见图表');
  });
});
