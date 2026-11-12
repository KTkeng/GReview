import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DatasetSummary, GamePresentation } from '../types';
import { ApiError, api } from '../lib/api';
import { DatasetCard } from './DatasetCard';

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

function renderCard(
  summary: DatasetSummary,
  props: Partial<Parameters<typeof DatasetCard>[0]> = {},
) {
  const onTitleSaved = vi.fn();
  const utils = render(
    <DatasetCard
      dataset={summary}
      dataDir="D:/data"
      onUse={vi.fn()}
      onDeleted={vi.fn()}
      onReportLoaded={vi.fn()}
      onTitleSaved={onTitleSaved}
      {...props}
    />,
  );
  return { ...utils, onTitleSaved };
}

function editButton() {
  return screen.getByRole('button', { name: '编辑游戏标题' }) as HTMLButtonElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DatasetCard 标题展示', () => {
  it('显示 displayTitle、自定义徽标与 Steam 原名', () => {
    renderCard(dataset({ customTitle: '我的 Dota', displayTitle: '我的 Dota', titleSource: '自定义' }));

    expect(screen.getByText('我的 Dota')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
    expect(screen.getByText('Steam 原名：Dota 2')).toBeTruthy();
    expect(editButton().disabled).toBe(false);
  });

  it('无自定义标题时不显示徽标与 Steam 原名提示', () => {
    renderCard(dataset());

    expect(screen.getByText('Dota 2')).toBeTruthy();
    expect(screen.queryByText('自定义')).toBeNull();
    expect(screen.queryByText(/Steam 原名/)).toBeNull();
  });

  it('titleEditable=false 时禁用编辑并展示 warning', () => {
    renderCard(
      dataset({
        titleEditable: false,
        warnings: ['标题文件损坏，已回退到自动标题'],
      }),
    );

    expect(editButton().disabled).toBe(true);
    expect(screen.getByText('标题文件损坏，已回退到自动标题')).toBeTruthy();
  });

  it('封面加载失败时使用后端 coverPlaceholder', () => {
    renderCard(dataset({ coverUrl: 'https://cdn.example.com/broken.jpg' }));

    const image = screen.getByRole('img', { name: 'Dota 2 封面' });
    expect(image.tagName).toBe('IMG');
    fireEvent.error(image);

    const placeholder = screen.getByRole('img', { name: 'AppID 570' });
    expect(placeholder.textContent).toBe('AppID 570');
    expect(screen.queryByRole('img', { name: 'Dota 2 封面' })).toBeNull();
  });
});

describe('DatasetCard 标题编辑（键盘可达）', () => {
  it('进入编辑后聚焦并全选，Enter 保存严格请求体并通知父级', async () => {
    const updated = presentation({
      customTitle: '新标题',
      displayTitle: '新标题',
      titleSource: '自定义',
      titleRevision: 4,
    });
    const updateSpy = vi
      .spyOn(api, 'updateDatasetTitle')
      .mockResolvedValue({ game: updated, changed: true });
    const { onTitleSaved } = renderCard(dataset());

    fireEvent.click(editButton());
    const input = screen.getByLabelText('游戏标题') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: '  新标题  ' } });
    // 计数字符串按 NFC + trim 展示
    expect(screen.getByText('3/120')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith(
      570,
      { customTitle: '新标题', expectedRevision: 3 },
      'D:/data',
    );
    expect(onTitleSaved).toHaveBeenCalledWith(updated);
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(screen.queryByLabelText('游戏标题')).toBeNull();
  });

  it('Escape 取消编辑且不发送请求', () => {
    const updateSpy = vi.spyOn(api, 'updateDatasetTitle');
    renderCard(dataset({ customTitle: '旧标题', displayTitle: '旧标题', titleSource: '自定义' }));

    fireEvent.click(editButton());
    const input = screen.getByLabelText('游戏标题') as HTMLInputElement;
    expect(input.value).toBe('旧标题');
    fireEvent.change(input, { target: { value: '改了但不保存' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByLabelText('游戏标题')).toBeNull();
    expect(screen.getByText('旧标题')).toBeTruthy();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('恢复默认发送 customTitle: null', async () => {
    const restored = presentation({ titleRevision: 4 });
    const updateSpy = vi
      .spyOn(api, 'updateDatasetTitle')
      .mockResolvedValue({ game: restored, changed: true });
    renderCard(dataset({ customTitle: '旧标题', displayTitle: '旧标题', titleSource: '自定义' }));

    fireEvent.click(editButton());
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith(
      570,
      { customTitle: null, expectedRevision: 3 },
      'D:/data',
    );
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('空白或超长输入按契约文案拦截，不发送请求', () => {
    const updateSpy = vi.spyOn(api, 'updateDatasetTitle');
    renderCard(dataset());

    fireEvent.click(editButton());
    const input = screen.getByLabelText('游戏标题');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByRole('alert').textContent).toBe('标题需为 1–120 个字符且不含换行');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('游戏标题')).toBeTruthy();
  });

  it('409 冲突保留草稿、刷新展示标题并通知父级', async () => {
    const currentGame = presentation({
      customTitle: '其他窗口标题',
      displayTitle: '其他窗口标题',
      titleSource: '自定义',
      titleRevision: 5,
    });
    vi.spyOn(api, 'updateDatasetTitle').mockRejectedValue(
      new ApiError('TITLE_CONFLICT', '标题已被修改', 409, undefined, undefined, currentGame),
    );
    const { onTitleSaved } = renderCard(dataset());

    fireEvent.click(editButton());
    const input = screen.getByLabelText('游戏标题') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('标题版本冲突');
    expect(alert.textContent).toContain('其他窗口标题');
    expect(alert.textContent).toContain('你的草稿未改动');
    // 草稿不被冲突响应覆盖
    expect((screen.getByLabelText('游戏标题') as HTMLInputElement).value).toBe('我的草稿');
    expect(onTitleSaved).toHaveBeenCalledWith(currentGame);
  });

  it('409 标题文件损坏时给出不可编辑提示', async () => {
    vi.spyOn(api, 'updateDatasetTitle').mockRejectedValue(
      new ApiError('TITLE_FILE_CORRUPTED', '标题文件损坏', 409),
    );
    renderCard(dataset());

    fireEvent.click(editButton());
    fireEvent.change(screen.getByLabelText('游戏标题'), { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('标题文件损坏，暂时无法修改');
    expect(alert.textContent).toContain('标题文件损坏');
  });
});
