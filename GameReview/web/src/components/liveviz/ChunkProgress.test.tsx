import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChunkProgress } from './ChunkProgress';
import type { TimelineChunks } from '../../hooks/useJobTimeline';

function chunks(overrides: Partial<TimelineChunks> = {}): TimelineChunks {
  return { total: null, completed: null, invalid: false, ...overrides };
}

describe('ChunkProgress', () => {
  it('渲染 N 格分块与「已完成 x / 共 y」', () => {
    const { container } = render(
      <ChunkProgress
        chunks={chunks({ total: 5, completed: 2 })}
        activeKey="ai_map"
        reportReused={false}
      />,
    );
    expect(container.querySelectorAll('.live-chunk')).toHaveLength(5);
    expect(container.querySelectorAll('.live-chunk.done')).toHaveLength(2);
    expect(container.querySelectorAll('.live-chunk.active')).toHaveLength(1);
    expect(screen.getByText('已完成 2 / 共 5')).toBeTruthy();
  });

  it('chunks 缺失时显示「暂无分块数据」且不渲染格子', () => {
    const { container } = render(
      <ChunkProgress chunks={chunks()} activeKey={null} reportReused={false} />,
    );
    expect(screen.getByText('暂无分块数据')).toBeTruthy();
    expect(container.querySelectorAll('.live-chunk')).toHaveLength(0);
  });

  it('chunks 为 0 时显示「暂无分块数据」', () => {
    const { container } = render(
      <ChunkProgress
        chunks={chunks({ total: 0, completed: 0 })}
        activeKey={null}
        reportReused={false}
      />,
    );
    expect(screen.getByText('暂无分块数据')).toBeTruthy();
    expect(container.querySelectorAll('.live-chunk')).toHaveLength(0);
  });

  it('completed > chunks 时显示「分块进度暂不可用」且不渲染格子', () => {
    const { container } = render(
      <ChunkProgress
        chunks={chunks({ total: 5, completed: 9, invalid: true })}
        activeKey="ai_map"
        reportReused={false}
      />,
    );
    expect(screen.getByText('分块进度暂不可用')).toBeTruthy();
    expect(container.querySelectorAll('.live-chunk')).toHaveLength(0);
    expect(screen.queryByText(/已完成 9/)).toBeNull();
  });

  it('负数或非整数计数显示「分块进度暂不可用」', () => {
    const { container } = render(
      <ChunkProgress
        chunks={chunks({ total: 5, completed: -1, invalid: true })}
        activeKey={null}
        reportReused={false}
      />,
    );
    expect(screen.getByText('分块进度暂不可用')).toBeTruthy();
    expect(container.querySelectorAll('.live-chunk')).toHaveLength(0);
  });

  it('复用报告时显示未调用 AI 说明', () => {
    render(
      <ChunkProgress chunks={chunks()} activeKey={null} reportReused />,
    );
    expect(screen.getByText('本次复用报告，未调用 AI')).toBeTruthy();
  });
});
