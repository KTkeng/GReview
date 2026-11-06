import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewPanel } from './PreviewPanel';
import type { PreviewResult, PreviewState } from '../types';

const noop = () => undefined;

function previewProps(preview: PreviewState) {
  return {
    preview,
    game: null,
    appid: 570,
    maxReviews: 200,
    trendMonths: 12,
    canStart: preview.status === 'success',
    startDisabledReason: null,
    onRetry: noop,
    onStart: vi.fn(),
    onAdjustFilters: noop,
  };
}

function successResult(report: NonNullable<PreviewResult['reuse']>['report']): PreviewResult {
  return {
    appid: 570,
    game: { name: 'Dota 2' },
    summary: {
      total: 1000,
      positive: 900,
      negative: 100,
      positiveRate: 0.9,
      reviewScoreDesc: '特别好评',
      matchingTotal: 500,
    },
    steamMatchingTotal: 500,
    estimate: {
      pages: 3,
      seconds: 5.6,
      trendRequests: 12,
      inputTokens: 5000,
      outputTokens: 2000,
      chunks: 1,
      costUsd: 0.01,
    },
    reuse: {
      dataset: null,
      report,
      canUseLocalReport: report?.reusable === true,
    },
  };
}

describe('PreviewPanel 的无匹配与复用状态', () => {
  it('后端 422 NO_REVIEWS 时显示无匹配提示并禁用开始（F3）', () => {
    render(
      <PreviewPanel
        {...previewProps({
          status: 'no_match',
          error: { code: 'NO_REVIEWS', message: '筛选后没有匹配的评论' },
        })}
      />,
    );

    expect(screen.getByText('筛选后没有匹配的评论')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /开始分析/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: '放宽筛选条件' })).toBeTruthy();
  });

  it('历史报告不会被展示为“使用后不消耗 token”（F1）', () => {
    render(
      <PreviewPanel
        {...previewProps({
          status: 'success',
          result: successResult({
            generatedAt: '2025-01-02T00:00:00.000Z',
            match: 'historical',
            reusable: false,
            model: 'deepseek-flash',
          }),
        })}
      />,
    );

    expect(screen.getByText(/历史报告：生成于/)).toBeTruthy();
    expect(screen.queryByText(/使用后本次不消耗 token/)).toBeNull();
  });

  it('exact 命中时展示本地报告可复用', () => {
    render(
      <PreviewPanel
        {...previewProps({
          status: 'success',
          result: successResult({
            generatedAt: '2025-01-02T00:00:00.000Z',
            match: 'exact',
            reusable: true,
          }),
        })}
      />,
    );

    expect(screen.getByText(/使用后本次不消耗 token/)).toBeTruthy();
  });
});
