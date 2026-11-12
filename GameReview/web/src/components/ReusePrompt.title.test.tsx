import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GamePresentation } from '../types';
import { ReusePrompt } from './ReusePrompt';

const noop = () => undefined;

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

describe('ReusePrompt 游戏标题展示', () => {
  it('数据集复用卡片显示 displayTitle、自定义徽标与 Steam 原名', () => {
    const game = presentation({
      customTitle: '我的 Dota',
      displayTitle: '我的 Dota',
      titleSource: '自定义',
    });
    renderPrompt({
      reuseDataset: true,
      dataset: {
        reviewCount: 180,
        fetchedAt: '2026-01-02T00:00:00.000Z',
      },
      game,
      appid: 570,
    });

    expect(screen.getByText(/复用本地数据：180 条，抓取于/)).toBeTruthy();
    expect(screen.getByText('我的 Dota')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
    expect(screen.getByText('Steam 名称：Dota 2')).toBeTruthy();
  });

  it('报告复用卡片同样使用合并后的标题', () => {
    const game = presentation({
      customTitle: '我的 Dota',
      displayTitle: '我的 Dota',
      titleSource: '自定义',
    });
    renderPrompt({
      report: {
        generatedAt: '2026-01-02T00:00:00.000Z',
        match: 'exact',
        reusable: true,
      },
      game,
      appid: 570,
    });

    expect(screen.getByText('使用本地分析结果，本次未消耗 token')).toBeTruthy();
    expect(screen.getByText('我的 Dota')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
  });

  it('非自定义标题不显示徽标与 Steam 提示', () => {
    renderPrompt({
      reuseDataset: true,
      dataset: {
        reviewCount: 180,
        fetchedAt: '2026-01-02T00:00:00.000Z',
      },
      game: presentation(),
      appid: 570,
    });

    expect(screen.getByText('Dota 2')).toBeTruthy();
    expect(screen.queryByText('自定义')).toBeNull();
    expect(screen.queryByText(/Steam 名称/)).toBeNull();
  });

  it('只有 AppID 时回退为「AppID 570」占位标题', () => {
    renderPrompt({
      reuseDataset: true,
      dataset: {
        reviewCount: 180,
        fetchedAt: '2026-01-02T00:00:00.000Z',
      },
      appid: 570,
    });

    expect(screen.getByText('AppID 570')).toBeTruthy();
    expect(screen.queryByText('自定义')).toBeNull();
  });
});
