import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopReviewsTable } from './TopReviewsTable';
import type { TopReview } from '../types';

function makeReviews(count: number): TopReview[] {
  return Array.from({ length: count }, (_, index) => ({
    reviewId: `r${index + 1}`,
    text: `评论 ${index + 1}`,
    votesUp: 1000 - index,
    votedUp: index % 2 === 0,
    language: 'schinese',
    playtimeHours: 10 + index,
    createdAt: 1_700_000_000 + index,
  }));
}

describe('TopReviewsTable 的展开与重建（R2）', () => {
  it('本地只有 10 条时，展开调用 onLoadMore 并从数据集重建 50 条', async () => {
    const onLoadMore = vi.fn().mockResolvedValue(makeReviews(50));
    render(<TopReviewsTable reviews={makeReviews(10)} onLoadMore={onLoadMore} resetKey="r1" />);

    expect(screen.getByText(/已显示 10 \/ 共 10 条/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /展开更多/ }));

    await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/已显示 50 \/ 共 50 条/)).toBeTruthy());
    expect(screen.getByText('评论 50')).toBeTruthy();
  });

  it('任务报告已含 50 条时无需请求接口，直接展开', () => {
    render(<TopReviewsTable reviews={makeReviews(50)} resetKey="r2" />);

    fireEvent.click(screen.getByRole('button', { name: '展开更多（50 条）' }));
    expect(screen.getByText(/已显示 50 \/ 共 50 条/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起至 10 条' })).toBeTruthy();
  });

  it('重建失败时保留本地条目并显示可读错误', async () => {
    const onLoadMore = vi.fn().mockRejectedValue(new Error('REPORT_NOT_FOUND: 报告不存在'));
    render(<TopReviewsTable reviews={makeReviews(10)} onLoadMore={onLoadMore} resetKey="r3" />);

    fireEvent.click(screen.getByRole('button', { name: /展开更多/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('REPORT_NOT_FOUND'),
    );
    expect(screen.getByText(/仍展示本地 10 条/)).toBeTruthy();
    expect(screen.getByText('评论 10')).toBeTruthy();
  });
});
