import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { JobState } from '../../types';
import { LIVEVIZ_STORAGE_KEY } from '../../hooks/useLiveVizPref';
import { LiveVizPanel } from './LiveVizPanel';

function runningJob(overrides: Partial<JobState> = {}): JobState {
  return {
    jobId: 'job-live-1',
    status: 'running',
    stage: 'analyzing',
    progress: 55,
    message: 'AI 分块分析 2/5',
    counts: { chunks: 5, completed: 2 },
    logs: [
      { level: 'info', message: '抓取完成：200 条' },
      { level: 'warn', message: '分块 2 重试后成功' },
      { level: 'error', message: '分块 1 解析失败，已重试' },
    ],
    ...overrides,
  };
}

function bodyOf(container: HTMLElement): HTMLElement {
  const body = container.querySelector<HTMLElement>('.live-viz-body');
  if (!body) throw new Error('未找到 .live-viz-body');
  return body;
}

describe('LiveVizPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('首次默认展开，渲染三块内容与 7 阶段时间线', () => {
    const { container } = render(<LiveVizPanel job={runningJob()} />);
    const toggle = screen.getByRole('button', { name: '收起' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = bodyOf(container);
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect(body.hidden).toBe(false);

    expect(container.querySelectorAll('.live-stage')).toHaveLength(7);
    expect(screen.getByText('分析阶段')).toBeTruthy();
    expect(screen.getByText('AI 分块进度')).toBeTruthy();
    expect(screen.getByText('已完成 2 / 共 5')).toBeTruthy();
    expect(screen.getByText('AI 分块分析 2/5')).toBeTruthy();
    const stageBar = screen.getByRole('progressbar', { name: '任务总进度（AI 分块 map）' });
    expect(stageBar.getAttribute('aria-valuenow')).toBe('55');
    // progress 是任务总进度，读屏文案不得写成“当前阶段进度”。
    expect(screen.getByLabelText('任务总进度 55%')).toBeTruthy();
    expect(container.querySelectorAll('.live-chunk')).toHaveLength(5);
    expect(container.querySelectorAll('.live-chunk.done')).toHaveLength(2);
    expect(container.querySelectorAll('.live-chunk.active')).toHaveLength(1);

    // 收起时标题栏仍显示当前阶段与百分比。
    const summary = screen.getByTestId('live-viz-summary');
    expect(summary.textContent).toContain('AI 分块 map');
    expect(summary.textContent).toContain('55%');
  });

  it('点击折叠后内容 hidden、aria-expanded=false 并写入 localStorage；再次点击恢复', () => {
    const { container } = render(<LiveVizPanel job={runningJob()} />);
    const toggle = screen.getByRole('button', { name: '收起' });
    fireEvent.click(toggle);

    const collapsed = screen.getByRole('button', { name: '展开' });
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(bodyOf(container).hidden).toBe(true);
    expect(window.localStorage.getItem(LIVEVIZ_STORAGE_KEY)).toBe('0');
    expect(screen.getByTestId('live-viz-summary').textContent).toContain('55%');

    fireEvent.click(collapsed);
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
    expect(bodyOf(container).hidden).toBe(false);
    expect(window.localStorage.getItem(LIVEVIZ_STORAGE_KEY)).toBe('1');
  });

  it('按 localStorage 记忆值初始化：值为 0 时初始收起', () => {
    window.localStorage.setItem(LIVEVIZ_STORAGE_KEY, '0');
    const { container } = render(<LiveVizPanel job={runningJob()} />);
    expect(screen.getByRole('button', { name: '展开' }).getAttribute('aria-expanded')).toBe('false');
    expect(bodyOf(container).hidden).toBe(true);
  });

  it('中途进入时未观察阶段显示「未观察」而非已完成', () => {
    const { container } = render(<LiveVizPanel job={runningJob()} />);
    // stage=analyzing，从未收到 fetch/trend/preprocess 事件。
    expect(screen.getAllByText('未观察')).toHaveLength(3);
    expect(container.querySelectorAll('.live-stage.unobserved')).toHaveLength(3);
    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('未知 stage 显示「其他阶段（原始标识）」而不崩溃', () => {
    render(
      <LiveVizPanel
        job={runningJob({ stage: 'mystery_stage', message: '后端新增阶段' })}
      />,
    );
    expect(screen.getByTestId('live-viz-summary').textContent).toContain('mystery_stage');
    expect(screen.getByText('其他阶段（mystery_stage）')).toBeTruthy();
  });

  it('SSE 断线时标题栏显示恢复徽标', () => {
    render(<LiveVizPanel job={runningJob()} connection="disconnected" />);
    expect(screen.getByText('连接中断，正在恢复')).toBeTruthy();
  });

  it('断线恢复后显示「连接曾中断，部分过程可能未记录」', () => {
    const { rerender } = render(<LiveVizPanel job={runningJob()} recovered />);
    expect(screen.getByText('连接曾中断，部分过程可能未记录')).toBeTruthy();

    // 仍处于断线恢复中时只显示断线徽标，不显示“曾中断”完成态提示。
    rerender(<LiveVizPanel job={runningJob()} connection="disconnected" recovered />);
    expect(screen.queryByText('连接曾中断，部分过程可能未记录')).toBeNull();
    expect(screen.getByText('连接中断，正在恢复')).toBeTruthy();
  });

  it('aria-valuenow 跟随事件值，不回退为单调递增', () => {
    const { rerender } = render(<LiveVizPanel job={runningJob({ progress: 55 })} />);
    const bar = () => screen.getByRole('progressbar', { name: '任务总进度（AI 分块 map）' });
    expect(bar().getAttribute('aria-valuenow')).toBe('55');
    expect(screen.getByTestId('live-viz-summary').textContent).toContain('55%');

    rerender(<LiveVizPanel job={runningJob({ progress: 20 })} />);
    expect(bar().getAttribute('aria-valuenow')).toBe('20');
    expect(screen.getByTestId('live-viz-summary').textContent).toContain('20%');

    // 0.5 按 0–100 契约保留为 1%，不再乘 100。
    rerender(<LiveVizPanel job={runningJob({ progress: 0.5 })} />);
    expect(bar().getAttribute('aria-valuenow')).toBe('1');
  });

  it('复用本地报告时分块区显示未调用 AI 说明', () => {
    render(
      <LiveVizPanel
        job={runningJob({
          stage: 'saving',
          progress: 98,
          message: '复用本地分析结果',
          counts: {},
          logs: [{ level: 'info', message: '使用本地分析结果，本次未消耗 token' }],
        })}
      />,
    );
    expect(screen.getByText('本次复用报告，未调用 AI')).toBeTruthy();
    expect(screen.queryAllByText('已完成 0 / 共 0')).toHaveLength(0);
    // 三个 AI 阶段用文字说明“已跳过”，不只靠颜色区分。
    expect(screen.getAllByText('已跳过（复用本地）')).toHaveLength(3);
  });

  it('日志容器 aria-live=off，且按级别着色', () => {
    const { container } = render(<LiveVizPanel job={runningJob()} />);
    const logBody = container.querySelector('.live-log-body');
    expect(logBody?.getAttribute('aria-live')).toBe('off');
    expect(container.querySelectorAll('.live-log-line').length).toBe(3);
    expect(container.querySelectorAll('.live-log-line.warn')).toHaveLength(1);
    expect(container.querySelectorAll('.live-log-line.error')).toHaveLength(1);
  });

  it('后端未提供 themes/evidence/tokens 时不渲染计数块', () => {
    const { container } = render(<LiveVizPanel job={runningJob()} />);
    expect(container.querySelector('.live-viz-counters')).toBeNull();

    const { container: withCounts } = render(
      <LiveVizPanel
        job={runningJob({ counts: { chunks: 5, completed: 2, themes: 4, evidence: 12, tokens: 3456 } })}
      />,
    );
    expect(withCounts.querySelectorAll('.live-counter')).toHaveLength(3);
    expect(screen.getByText('3,456')).toBeTruthy();
  });
});
