import { useEffect, useState } from 'react';
import type { ReportSource, TopReview } from '../types';
import { api, toApiError } from '../lib/api';
import {
  formatDate,
  formatNumber,
  formatPlaytimeHours,
  languageName,
} from '../lib/format';

interface TopReviewsTableProps {
  reviews: TopReview[];
  highlightedReviewId?: string | null;
  /**
   * 历史报告的定位信息。展开时调用
   * GET /api/reports/:appid/:analysisHash?topReviews=50 从数据集重建，
   * 不改写磁盘（integrationNotes 第 5 条）。任务报告默认已请求 50 条，可不传。
   */
  reportSource?: ReportSource;
  /** 重建完成后回传完整列表，供报告导出与样本分布图使用。 */
  onReviewsLoaded?: (reviews: TopReview[]) => void;
  /** 测试或自定义场景的加载器；提供了就不再直接请求接口。 */
  onLoadMore?: () => Promise<TopReview[]>;
  /** 报告切换标识（generatedAt）；变化时才重置展开状态。 */
  resetKey?: string;
}

const INITIAL_VISIBLE = 10;
const MAX_VISIBLE = 50;

/** 按 analysisHash 从数据集重建最多 50 条；Top N 不进入 analysisHash。 */
async function loadFullTopReviews(source: ReportSource): Promise<TopReview[]> {
  const full = await api.getSavedReport(
    source.appid,
    source.analysisHash,
    source.dataDir,
    MAX_VISIBLE,
  );
  return Array.isArray(full.topReviews) ? full.topReviews : [];
}

function errorMessage(error: unknown): string {
  const apiError = toApiError(error);
  return `${apiError.code}: ${apiError.message}`;
}

export function TopReviewsTable({
  reviews,
  highlightedReviewId,
  reportSource,
  onReviewsLoaded,
  onLoadMore,
  resetKey,
}: TopReviewsTableProps) {
  const [rows, setRows] = useState<TopReview[]>(reviews);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedMore, setLoadedMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 仅在切换到另一份报告时重置；重建 50 条后同一报告内的 reviews 更新
  // 只同步数据，不把用户刚展开的表格收回 10 条。
  useEffect(() => {
    setRows(reviews);
    setVisible(INITIAL_VISIBLE);
    setLoadedMore(false);
    setLoadError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    setRows(reviews);
  }, [reviews]);

  useEffect(() => {
    if (!highlightedReviewId) return;
    const index = rows.findIndex((review) => review.reviewId === highlightedReviewId);
    if (index >= 0) {
      setVisible((current) => Math.max(current, Math.min(index + 1, MAX_VISIBLE)));
    }
  }, [highlightedReviewId, rows]);

  useEffect(() => {
    if (!highlightedReviewId) return;
    const element = document.getElementById(`review-row-${highlightedReviewId}`);
    if (!element) return;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'center',
    });
  }, [highlightedReviewId, visible]);

  const capped = rows.slice(0, MAX_VISIBLE);
  const visibleRows = capped.slice(0, visible);
  const expanded = visible >= capped.length && visible > INITIAL_VISIBLE;
  const loader = onLoadMore ?? (reportSource ? () => loadFullTopReviews(reportSource) : undefined);
  // 即使本地报告只带了 10 条，只要知道 analysisHash 也应提供“展开”入口，
  // 由 GET /api/reports/:appid/:analysisHash?topReviews=50 从数据集重建。
  const canExpand = capped.length > INITIAL_VISIBLE || (Boolean(loader) && !loadedMore);
  const handleToggle = async () => {
    if (expanded) {
      setVisible(INITIAL_VISIBLE);
      return;
    }
    if (loader && !loadedMore) {
      setLoadingMore(true);
      setLoadError(null);
      try {
        const full = await loader();
        if (Array.isArray(full) && full.length > 0) {
          setRows(full);
          setLoadedMore(true);
          setVisible(Math.min(full.length, MAX_VISIBLE));
          onReviewsLoaded?.(full);
        } else {
          setLoadedMore(true);
          setVisible(Math.min(rows.length, MAX_VISIBLE));
        }
      } catch (error) {
        // 重建失败时仍展开本地已加载的条目，并提示原因。
        setLoadError(errorMessage(error));
        setVisible(Math.min(rows.length, MAX_VISIBLE));
      } finally {
        setLoadingMore(false);
      }
      return;
    }
    setVisible(Math.min(rows.length, MAX_VISIBLE));
  };

  if (!rows || rows.length === 0) {
    return <div className="empty-inline">本次没有可展示的高赞评论。</div>;
  }

  return (
    <div className="table-wrap">
      <div className="table-scroll">
        <table className="reviews-table">
          <caption className="sr-only">高赞评论列表</caption>
          <thead>
            <tr>
              <th scope="col"># / ID</th>
              <th scope="col">评论正文</th>
              <th scope="col">赞数</th>
              <th scope="col">游玩时长</th>
              <th scope="col">评价</th>
              <th scope="col">语言</th>
              <th scope="col">发布时间</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((review, index) => (
              <tr
                key={review.reviewId}
                id={`review-row-${review.reviewId}`}
                className={highlightedReviewId === review.reviewId ? 'evidence-highlight' : undefined}
              >
                <td className="num">
                  {index + 1}
                  <div>
                    <span className="quote-id" title={`评论 ID ${review.reviewId}`}>
                      {review.reviewId}
                    </span>
                  </div>
                </td>
                <td className="review-text">{review.text || '（空评论）'}</td>
                <td className="num">{formatNumber(review.votesUp)}</td>
                <td className="num nowrap">{formatPlaytimeHours(review.playtimeHours)}</td>
                <td className="nowrap">
                  <span className={`badge ${review.votedUp ? 'badge-positive' : 'badge-negative'}`}>
                    {review.votedUp ? '好评' : '差评'}
                  </span>
                </td>
                <td className="nowrap">{languageName(review.language)}</td>
                <td className="nowrap">{formatDate(review.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        <span>
          已显示 {visibleRows.length} / 共 {formatNumber(rows.length)} 条
          {rows.length > MAX_VISIBLE ? '（最多展示 50 条）' : ''}
        </span>
        {highlightedReviewId ? (
          <span className="badge badge-accent">已定位证据评论 {highlightedReviewId}</span>
        ) : null}
        {loadError ? (
          <span className="field-error" role="alert">
            重建完整高赞评论失败：{loadError}（仍展示本地 {capped.length} 条）
          </span>
        ) : null}
        {canExpand ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleToggle()}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore
              ? '加载完整 50 条…'
              : expanded
                ? '收起至 10 条'
                : capped.length > INITIAL_VISIBLE
                  ? `展开更多（${capped.length} 条）`
                  : '展开更多（最多 50 条）'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
