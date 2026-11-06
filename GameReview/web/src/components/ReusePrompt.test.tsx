import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReusePrompt } from './ReusePrompt';

const noop = () => undefined;

function renderPrompt(overrides: Partial<Parameters<typeof ReusePrompt>[0]> = {}) {
  return render(
    <ReusePrompt
      reuseDataset={false}
      reuseReport
      dataset={null}
      report={null}
      historicalReport={null}
      forceFetch={false}
      forceAnalyze={false}
      onToggleDataset={noop}
      onToggleReport={noop}
      onRefetch={noop}
      onReanalyze={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ReusePrompt 的报告复用提示（F1）', () => {
  it('exact 命中时显示“本次未消耗 token”', () => {
    renderPrompt({
      report: {
        generatedAt: '2025-01-02T00:00:00.000Z',
        match: 'exact',
        reusable: true,
      },
    });
    expect(screen.getByText('使用本地分析结果，本次未消耗 token')).toBeTruthy();
  });

  it('历史报告不会承诺“本次未消耗 token”', () => {
    renderPrompt({
      historicalReport: {
        generatedAt: '2025-01-02T00:00:00.000Z',
        match: 'historical',
        reusable: false,
        model: 'deepseek-flash',
      },
    });
    expect(screen.getByText('历史报告（不可直接复用）')).toBeTruthy();
    expect(screen.queryByText('使用本地分析结果，本次未消耗 token')).toBeNull();
    expect(screen.getByText(/开始分析会重新调用 AI 并消耗 token/)).toBeTruthy();
  });
});
