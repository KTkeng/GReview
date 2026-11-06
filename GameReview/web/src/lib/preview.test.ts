import { describe, expect, it } from 'vitest';
import { buildPreviewRequest, getReuseInfo, previewConfigSlice, type PreviewConfigSlice } from './preview';
import type { ClientFilters, PreviewResult, ReusableReport, ScrapeFilters } from '../types';
import { DEFAULT_CONFIG } from './defaults';

const filters: ScrapeFilters = {
  languages: ['schinese', 'english'],
  reviewType: 'all',
  sort: 'helpful',
  purchaseType: 'all',
  dateRange: null,
  excludeOffTopic: true,
  useReviewQuality: true,
};

const clientFilters: ClientFilters = {
  minVotes: 10,
  minLength: 0,
  includeKeywords: [],
  excludeKeywords: [],
  excludeEarlyAccess: false,
  excludeFree: false,
};

const baseConfig: PreviewConfigSlice = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: false,
  maxReviews: 200,
  includeTranslations: true,
  topReviews: 50,
  trendMonths: 12,
  dataDir: '',
};

function config(overrides: Partial<PreviewConfigSlice> = {}): PreviewConfigSlice {
  return { ...baseConfig, ...overrides };
}

describe('buildPreviewRequest（F2）', () => {
  it('把与任务一致的 ai/options 传给预览接口', () => {
    const request = buildPreviewRequest({
      appid: 570,
      filters,
      clientFilters,
      config: config({
        baseUrl: 'https://proxy.example.com',
        model: 'deepseek-v4-pro',
        thinking: true,
        maxReviews: 1000,
        includeTranslations: false,
        topReviews: 10,
        trendMonths: 24,
        dataDir: 'D:/GReview/data',
      }),
    });

    expect(request.ai).toEqual({
      baseUrl: 'https://proxy.example.com',
      model: 'deepseek-v4-pro',
      thinking: true,
    });
    expect(request.options).toEqual({
      maxReviews: 1000,
      includeTranslations: false,
      topReviews: 10,
    });
    expect(request.trend).toEqual({ months: 24 });
    expect(request.dataDir).toBe('D:/GReview/data');
  });

  it('默认值与任务请求一致，并限制 topReviews 范围', () => {
    const request = buildPreviewRequest({
      appid: 570,
      filters,
      clientFilters,
      config: config({ model: '  ', baseUrl: '  ', topReviews: 999 }),
    });

    expect(request.ai.model).toBe('deepseek-flash');
    expect(request.ai.baseUrl).toBeUndefined();
    expect(request.options.maxReviews).toBe(200);
    expect(request.options.topReviews).toBe(50);
    expect(request.dataDir).toBeUndefined();
  });

  it('topReviews 非有限值时回退到 50，避免发送 null', () => {
    const request = buildPreviewRequest({
      appid: 570,
      filters,
      clientFilters,
      config: config({ topReviews: Number.NaN }),
    });
    expect(request.options.topReviews).toBe(50);
  });
});

function previewWithReport(report: ReusableReport | null): PreviewResult {
  return {
    appid: 570,
    game: { name: 'Dota 2' },
    summary: {
      total: 100,
      positive: 90,
      negative: 10,
      positiveRate: 0.9,
      reviewScoreDesc: '特别好评',
    },
    steamMatchingTotal: 100,
    reuse: {
      dataset: null,
      report,
      canUseLocalReport: report?.reusable === true,
    },
  } as PreviewResult;
}

describe('getReuseInfo 的复用判定（F1）', () => {
  it('只有 exact/reusable 的报告才显示为可复用', () => {
    const exact = getReuseInfo(
      previewWithReport({ generatedAt: '2025-01-01T00:00:00.000Z', match: 'exact', reusable: true }),
    );
    expect(exact.report).not.toBeNull();
    expect(exact.historicalReport).toBeNull();
  });

  it('历史报告（reusable=false）只进入 historicalReport', () => {
    const historical = getReuseInfo(
      previewWithReport({
        generatedAt: '2025-01-01T00:00:00.000Z',
        match: 'historical',
        reusable: false,
      }),
    );
    expect(historical.report).toBeNull();
    expect(historical.historicalReport).not.toBeNull();
  });

  it('旧后端没有 reusable/match 时不承诺未消耗 token', () => {
    const legacy = getReuseInfo(previewWithReport({ generatedAt: '2025-01-01T00:00:00.000Z' }));
    expect(legacy.report).toBeNull();
    expect(legacy.historicalReport).not.toBeNull();
  });

  it('canUseLocalReport=true 且 report 未显式标记时仍可复用', () => {
    const result = previewWithReport({ generatedAt: '2025-01-01T00:00:00.000Z' });
    result.reuse!.canUseLocalReport = true;
    expect(getReuseInfo(result).report).not.toBeNull();
  });
});

describe('previewConfigSlice', () => {
  it('从 AnalysisConfig 提取预览所需字段', () => {
    const slice = previewConfigSlice({
      ...DEFAULT_CONFIG,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      thinking: true,
      maxReviews: 500,
      includeTranslations: false,
      topReviews: 25,
      trendMonths: 6,
      dataDir: 'D:/data',
    });
    expect(slice).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      thinking: true,
      maxReviews: 500,
      includeTranslations: false,
      topReviews: 25,
      trendMonths: 6,
      dataDir: 'D:/data',
    });
  });
});
