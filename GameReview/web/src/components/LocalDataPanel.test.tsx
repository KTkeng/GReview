import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DatasetSummary, GamePresentation } from '../types';
import { api } from '../lib/api';
import { LocalDataPanel } from './LocalDataPanel';

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

function dataset(overrides: Partial<GamePresentation> = {}): DatasetSummary {
  return {
    appid: 570,
    game: presentation(overrides),
    reviewsHash: 'reviews-abc',
    reviewCount: 180,
    fetchedAt: '2026-01-02T00:00:00.000Z',
    reportCount: 0,
    sizeBytes: 2048,
    status: '完整',
  };
}

function renderPanel(refreshKey = 1) {
  const onTitleUpdated = vi.fn();
  const props = {
    dataDir: '',
    refreshKey,
    onUseDataset: vi.fn(),
    onOpenReport: vi.fn(),
    onTitleUpdated,
  };
  const utils = render(<LocalDataPanel {...props} />);
  const rerenderPanel = (nextRefreshKey: number) =>
    utils.rerender(<LocalDataPanel {...props} refreshKey={nextRefreshKey} />);
  return { ...utils, rerenderPanel, onTitleUpdated };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalDataPanel 标题合并与过期响应保护', () => {
  it('较旧的列表响应不能覆盖已展示的较新标题（titleRevision）', async () => {
    const listSpy = vi
      .spyOn(api, 'listDatasets')
      .mockResolvedValueOnce({
        dataDir: 'D:/data',
        datasets: [
          dataset({
            customTitle: '新标题',
            displayTitle: '新标题',
            titleSource: '自定义',
            titleRevision: 5,
          }),
        ],
      })
      .mockResolvedValueOnce({
        dataDir: 'D:/data',
        datasets: [
          dataset({
            customTitle: '旧标题',
            displayTitle: '旧标题',
            titleSource: '自定义',
            titleRevision: 3,
          }),
        ],
      });

    const { rerenderPanel } = renderPanel(1);
    expect(await screen.findByText('新标题')).toBeTruthy();

    rerenderPanel(2);
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('旧标题')).toBeNull());
    expect(screen.getByText('新标题')).toBeTruthy();
  });

  it('保存成功后更新同 AppID 的全部数据集并通知 App', async () => {
    vi.spyOn(api, 'listDatasets').mockResolvedValue({
      dataDir: 'D:/data',
      datasets: [
        { ...dataset(), reviewsHash: 'a' },
        { ...dataset(), reviewsHash: 'b' },
      ],
    });
    const saved = presentation({
      customTitle: '统一新标题',
      displayTitle: '统一新标题',
      titleSource: '自定义',
      titleRevision: 4,
    });
    const updateSpy = vi
      .spyOn(api, 'updateDatasetTitle')
      .mockResolvedValue({ game: saved, changed: true });

    const { onTitleUpdated } = renderPanel();

    const editButtons = await screen.findAllByRole('button', { name: '编辑游戏标题' });
    fireEvent.click(editButtons[0]);
    fireEvent.change(screen.getByLabelText('游戏标题'), {
      target: { value: '统一新标题' },
    });
    fireEvent.keyDown(screen.getByLabelText('游戏标题'), { key: 'Enter' });

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onTitleUpdated).toHaveBeenCalledWith(saved));
    expect(screen.getAllByText('统一新标题')).toHaveLength(2);
  });

  it('迟到的旧保存响应被忽略，不覆盖较新标题也不通知 App', async () => {
    vi.spyOn(api, 'listDatasets').mockResolvedValue({
      dataDir: 'D:/data',
      datasets: [
        dataset({
          customTitle: '较新标题',
          displayTitle: '较新标题',
          titleSource: '自定义',
          titleRevision: 5,
        }),
      ],
    });
    vi.spyOn(api, 'updateDatasetTitle').mockResolvedValue({
      game: presentation({
        customTitle: '旧响应',
        displayTitle: '旧响应',
        titleSource: '自定义',
        titleRevision: 4,
      }),
      changed: true,
    });

    const { onTitleUpdated } = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '编辑游戏标题' }));
    fireEvent.change(screen.getByLabelText('游戏标题'), { target: { value: '旧响应' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByLabelText('游戏标题')).toBeNull());
    expect(onTitleUpdated).not.toHaveBeenCalled();
    expect(screen.getByText('较新标题')).toBeTruthy();
    expect(screen.queryByText('旧响应')).toBeNull();
  });

  it('切换数据目录后，不同目录中同 AppID 的标题缓存相互隔离', async () => {
    const listSpy = vi
      .spyOn(api, 'listDatasets')
      .mockResolvedValueOnce({
        dataDir: 'D:/data-a',
        datasets: [
          dataset({
            customTitle: 'A 目录标题',
            displayTitle: 'A 目录标题',
            titleSource: '自定义',
            titleRevision: 5,
          }),
        ],
      })
      .mockResolvedValueOnce({
        dataDir: 'D:/data-b',
        datasets: [dataset()],
      });

    const props = {
      refreshKey: 1,
      onUseDataset: vi.fn(),
      onOpenReport: vi.fn(),
      onTitleUpdated: vi.fn(),
    };
    const { rerender } = render(<LocalDataPanel {...props} dataDir="D:/data-a" />);
    expect(await screen.findByText('A 目录标题')).toBeTruthy();

    rerender(<LocalDataPanel {...props} dataDir="D:/data-b" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Dota 2')).toBeTruthy();
    expect(screen.queryByText('A 目录标题')).toBeNull();
  });
});
