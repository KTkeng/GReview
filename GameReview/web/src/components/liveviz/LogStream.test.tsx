import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogStream } from './LogStream';
import { MAX_TIMELINE_LOGS } from '../../hooks/useJobTimeline';
import type { JobLogEntry } from '../../types';

function makeLogs(count: number): JobLogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    level: index % 2 === 0 ? 'info' : 'warn',
    message: `日志 ${index}`,
  }));
}

describe('LogStream', () => {
  it(`DOM 最多渲染最近 ${MAX_TIMELINE_LOGS} 条并提示省略数量`, () => {
    const { container } = render(
      <LogStream logs={makeLogs(205)} omitted={0} expanded />,
    );
    expect(container.querySelectorAll('.live-log-line')).toHaveLength(MAX_TIMELINE_LOGS);
    expect(screen.getByText('已省略较早 5 条')).toBeTruthy();
    expect(screen.queryByText('日志 0')).toBeNull();
    expect(screen.getByText('日志 204')).toBeTruthy();
  });

  it('叠加缓存层累计的省略数量', () => {
    const { container } = render(
      <LogStream logs={makeLogs(500)} omitted={10} expanded />,
    );
    expect(container.querySelectorAll('.live-log-line')).toHaveLength(MAX_TIMELINE_LOGS);
    // 缓存 500 条中渲染最近 200 条，省略 300；再加缓存层丢弃的 10 条。
    expect(screen.getByText('已省略较早 310 条')).toBeTruthy();
    expect(screen.getByText('200 / 510 条')).toBeTruthy();
  });

  it('日志容器 aria-live=off，避免逐条朗读，并可通过键盘聚焦滚动', () => {
    const { container } = render(<LogStream logs={makeLogs(1)} omitted={0} expanded />);
    const body = container.querySelector('.live-log-body');
    expect(body?.getAttribute('aria-live')).toBe('off');
    expect(body?.getAttribute('tabindex')).toBe('0');
  });

  it('缓存已满 500 条后追加日志仍自动滚到底部', () => {
    const { container, rerender } = render(
      <LogStream logs={makeLogs(500)} omitted={0} expanded />,
    );
    const body = container.querySelector<HTMLElement>('.live-log-body');
    if (!body) throw new Error('未找到 .live-log-body');
    // jsdom 不计算布局，手动给出滚动高度后断言 effect 把 scrollTop 拉到底。
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 2400 });
    body.scrollTop = 0;

    // 缓存已满：logs.length 保持 500，每来一条新日志只增加缓存层累计的 omitted。
    rerender(<LogStream logs={makeLogs(500)} omitted={1} expanded />);
    expect(body.scrollTop).toBe(2400);
  });

  it('无日志时显示等待提示', () => {
    render(<LogStream logs={[]} omitted={0} expanded />);
    expect(screen.getByText('等待任务输出…')).toBeTruthy();
  });
});
