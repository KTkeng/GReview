import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { JobState } from '../types';
import { ProgressPanel } from './ProgressPanel';
import { LIVEVIZ_STORAGE_KEY } from '../hooks/useLiveVizPref';

const callbacks = {
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onAdjustFilters: vi.fn(),
};

function job(overrides: Partial<JobState> = {}): JobState {
  return {
    jobId: 'job-progress-1',
    status: 'running',
    stage: 'analyzing',
    progress: 55,
    message: 'AI 分块分析 2/5',
    counts: { chunks: 5, completed: 2 },
    logs: [{ level: 'info', message: '抓取完成' }],
    ...overrides,
  };
}

describe('ProgressPanel 集成实时可视化', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('分析进行中在进度面板内挂载 LiveVizPanel', () => {
    render(<ProgressPanel job={job()} {...callbacks} />);
    expect(screen.getByRole('heading', { name: '实时可视化' })).toBeTruthy();
    expect(screen.getByText('已完成 2 / 共 5')).toBeTruthy();
  });

  it('失败状态保留面板并显示错误码', () => {
    render(
      <ProgressPanel
        job={job({
          status: 'failed',
          error: { code: 'AI_TIMEOUT', message: 'AI 请求超时' },
        })}
        {...callbacks}
      />,
    );
    expect(screen.getByRole('heading', { name: '实时可视化' })).toBeTruthy();
    expect(screen.getAllByText(/AI_TIMEOUT/).length).toBeGreaterThan(0);
  });

  it('取消状态保留面板并标记已取消', () => {
    render(
      <ProgressPanel
        job={job({ status: 'cancelled', cancelled: true })}
        {...callbacks}
      />,
    );
    expect(screen.getByRole('heading', { name: '实时可视化' })).toBeTruthy();
    expect(screen.getAllByText('已取消').length).toBeGreaterThan(0);
  });

  it('SSE 断线时标题栏显示恢复徽标', () => {
    render(<ProgressPanel job={job()} connection="disconnected" {...callbacks} />);
    expect(screen.getByText('连接中断，正在恢复')).toBeTruthy();
  });

  it('恢复后显示过程可能缺失提示', () => {
    render(<ProgressPanel job={job()} recovered {...callbacks} />);
    expect(screen.getByText('连接曾中断，部分过程可能未记录')).toBeTruthy();
  });

  it('展开实时可视化时隐藏旧日志区与旧阶段列表，收起时回退显示', () => {
    const { container, unmount } = render(<ProgressPanel job={job()} {...callbacks} />);
    // 默认展开：旧日志区与旧阶段列表都不重复渲染，避免与新时间线同屏矛盾。
    expect(container.querySelector('.log-viewer')).toBeNull();
    expect(container.querySelector('.stage-list')).toBeNull();
    expect(container.querySelector('.progress-panel')?.hasAttribute('aria-live')).toBe(false);
    unmount();

    window.localStorage.setItem(LIVEVIZ_STORAGE_KEY, '0');
    const { container: collapsed } = render(<ProgressPanel job={job()} {...callbacks} />);
    expect(collapsed.querySelector('.log-viewer')).not.toBeNull();
    expect(collapsed.querySelector('.live-viz-body')?.hasAttribute('hidden')).toBe(true);
    const stageList = collapsed.querySelector('.stage-list');
    expect(stageList).not.toBeNull();
    // 收起时的旧列表复用 stageMap 的统一阶段文案（7 个节点）。
    expect(stageList?.textContent).toContain('读取/抓取');
    expect(stageList?.textContent).toContain('AI 分块 map');
    expect(stageList?.querySelectorAll('.stage-item')).toHaveLength(7);
  });

  it('里程碑播报区的祖先元素没有 aria-busy=true', () => {
    const { container } = render(<ProgressPanel job={job()} {...callbacks} />);
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    let ancestor: Element | null = liveRegion?.parentElement ?? null;
    while (ancestor) {
      expect(ancestor.getAttribute('aria-busy')).not.toBe('true');
      ancestor = ancestor.parentElement;
    }
    // 进行中分支的外层 section 不再携带 aria-busy。
    expect(container.querySelector('.progress-panel')?.getAttribute('aria-busy')).toBeNull();
  });
});
