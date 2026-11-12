import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GamePresentation, Report } from '../types';
import { MethodologyCollapse } from './MethodologyCollapse';
import { ReportHeader } from './ReportHeader';

function presentation(overrides: Partial<GamePresentation> = {}): GamePresentation {
  return {
    appid: 570,
    name: 'Dota 2',
    steamName: 'Dota 2',
    customTitle: null,
    displayTitle: 'Dota 2',
    titleSource: '自动读取',
    titleRevision: 3,
    titleUpdatedAt: null,
    titleEditable: true,
    coverUrl: null,
    coverPlaceholder: 'AppID 570',
    warnings: [],
    ...overrides,
  };
}

function makeReport(game: GamePresentation): Report {
  return {
    version: '1.0',
    generatedAt: '2026-01-02T03:04:05.000Z',
    game,
    sample: {
      filters: {
        languages: ['schinese'],
        reviewType: 'all',
        sort: 'helpful',
        purchaseType: 'all',
        dateRange: null,
        excludeOffTopic: true,
        useReviewQuality: true,
      },
      fetched: 10,
      matchedTotal: 10,
      usedForAI: 10,
      languages: ['schinese'],
      sourceEndpoint: 'official',
    },
    kpis: {
      allTime: { total: 100, positiveRate: 80, reviewScoreDesc: '特别好评' },
      last30d: { total: 10, positiveRate: 80, reviewScoreDesc: '特别好评' },
      last90d: { total: 30, positiveRate: 80, reviewScoreDesc: '特别好评' },
      samplePositiveRate: 80,
    },
    trend: {
      granularity: 'month',
      source: 'official_aggregate',
      points: [],
      coverage: { start: '2025-01', end: '2026-01', note: '' },
    },
    conclusion: {
      label: '特别好评',
      headline: '口碑稳健',
      summary: '总结',
      confidence: 'high',
      caveats: [],
    },
    ai: {
      appealPoints: [],
      frictionPoints: [],
      expectationGaps: [],
      updateImpact: [],
      recommendations: [],
    },
    topReviews: [],
    methodology: {
      note: '方法论说明',
      steamRequests: 1,
      cacheHits: 0,
      dataSource: 'fresh',
      trendSource: 'official_aggregate',
      analysisSource: 'fresh',
      dataDir: 'D:/data',
      aiModel: 'deepseek-flash',
      thinkingEnabled: false,
      promptVersion: 'prompt-1',
      generatedBy: 'GReview',
    },
  };
}

describe('ReportHeader 使用合并后的 displayTitle', () => {
  it('自定义标题显示徽标、打印文字与 Steam 原名提示', () => {
    const report = makeReport(
      presentation({
        customTitle: '我的 Dota',
        displayTitle: '我的 Dota',
        titleSource: '自定义',
      }),
    );
    render(<ReportHeader report={report} onReanalyze={vi.fn()} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('我的 Dota');
    expect(heading.textContent).toContain('自定义');
    expect(heading.textContent).toContain('[自定义名称]');
    expect(heading.getAttribute('title')).toBe('Steam 原名：Dota 2');
    expect(screen.getByText('自定义')).toBeTruthy();
    expect(screen.getByText('[自定义名称]')).toBeTruthy();
  });

  it('非自定义标题不显示徽标，标题为 Steam 名称', () => {
    render(<ReportHeader report={makeReport(presentation())} onReanalyze={vi.fn()} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Dota 2');
    expect(screen.queryByText('自定义')).toBeNull();
    expect(screen.queryByText('[自定义名称]')).toBeNull();
  });

  it('缺少封面时使用后端 coverPlaceholder', () => {
    render(<ReportHeader report={makeReport(presentation())} onReanalyze={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'AppID 570' }).textContent).toBe('AppID 570');
  });
});

describe('MethodologyCollapse 标题信息', () => {
  it('自定义标题时同时展示自定义名与 Steam 原名', () => {
    const report = makeReport(
      presentation({
        customTitle: '我的 Dota',
        displayTitle: '我的 Dota',
        titleSource: '自定义',
      }),
    );
    render(<MethodologyCollapse report={report} />);
    expect(screen.getByText('游戏标题')).toBeTruthy();
    expect(screen.getByText('我的 Dota（Steam 原名：Dota 2）')).toBeTruthy();
  });

  it('非自定义标题不额外占用方法论字段', () => {
    render(<MethodologyCollapse report={makeReport(presentation())} />);
    expect(screen.queryByText('游戏标题')).toBeNull();
  });
});
