import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Report, TopReview } from '../types';

const { getSavedReport } = vi.hoisted(() => ({ getSavedReport: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: { getSavedReport },
  toApiError: (error: unknown) => ({
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  }),
}));

import { TopReviewsTable } from './TopReviewsTable';

function makeReviews(count: number): TopReview[] {
  return Array.from({ length: count }, (_, index) => ({
    reviewId: `s${index + 1}`,
    text: `接口评论 ${index + 1}`,
    votesUp: 500 - index,
    votedUp: true,
    language: 'english',
    playtimeHours: 5,
    createdAt: 1_700_000_000 + index,
  }));
}

describe('TopReviewsTable 按 analysisHash 重建（R2）', () => {
  it('展开时调用 GET /api/reports/:appid/:analysisHash?topReviews=50', async () => {
    getSavedReport.mockResolvedValue({
      topReviews: makeReviews(50),
    } as unknown as Report);

    render(
      <TopReviewsTable
        reviews={makeReviews(10)}
        reportSource={{ appid: 570, analysisHash: 'abcdef1234567890', dataDir: 'D:/data' }}
        resetKey="report-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /展开更多/ }));

    await waitFor(() =>
      expect(getSavedReport).toHaveBeenCalledWith(570, 'abcdef1234567890', 'D:/data', 50),
    );
    await waitFor(() => expect(screen.getByText('接口评论 50')).toBeTruthy());
    expect(screen.getByText(/已显示 50 \/ 共 50 条/)).toBeTruthy();
  });
});
