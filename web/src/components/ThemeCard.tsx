import { useEffect, useId, useRef, useState } from 'react';
import type { Theme } from '../types';
import { formatNumber } from '../lib/format';
import { IconChevronDown } from './Icon';

interface ThemeCardProps {
  theme: Theme;
  knownReviewIds?: Set<string>;
  onJumpToReview?: (reviewId: string) => void;
}

const SENTIMENT_LABELS: Record<string, string> = {
  positive: '正向',
  negative: '负向',
  neutral: '中性',
};

export function ThemeCard({ theme, knownReviewIds, onJumpToReview }: ThemeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const previousExpanded = useRef(false);
  const contentId = useId();
  const quotes = theme.quotes ?? [];
  const evidenceIds = theme.evidenceIds ?? [];
  const sentiment = theme.sentiment ?? 'neutral';

  // 打印时展开所有证据，打印结束后恢复
  useEffect(() => {
    const beforePrint = () => {
      previousExpanded.current = expanded;
      setExpanded(true);
    };
    const afterPrint = () => setExpanded(previousExpanded.current);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, [expanded]);

  return (
    <article
      className={`theme-card${expanded ? ' expanded' : ''}`}
      data-sentiment={sentiment}
    >
      <button
        type="button"
        className="theme-main"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="theme-body">
          <div className="theme-name-row">
            <span className="theme-name">{theme.name}</span>
            <span
              className={`badge ${
                sentiment === 'positive'
                  ? 'badge-positive'
                  : sentiment === 'negative'
                    ? 'badge-negative'
                    : ''
              }`}
            >
              {SENTIMENT_LABELS[sentiment] ?? sentiment}
            </span>
            {theme.category ? <span className="badge">{theme.category}</span> : null}
          </div>
          <p className="theme-summary">{theme.summary}</p>
          <div className="theme-meta">
            <span className="theme-mentions">提及 {formatNumber(theme.mentions)} 次</span>
            <span className="dim" style={{ fontSize: 11 }}>
              证据 {formatNumber(evidenceIds.length)} 条
            </span>
          </div>
        </div>
        <span className="theme-chevron" aria-hidden="true">
          <IconChevronDown size={16} />
        </span>
      </button>

      {expanded ? (
        <div className="theme-evidence" id={contentId}>
          <div className="evidence-title">证据引用（原文为准）</div>
          {quotes.length > 0 ? (
            quotes.map((quote, index) => {
              const known = knownReviewIds?.has(quote.reviewId) ?? true;
              return (
                <blockquote className="quote" key={`${quote.reviewId}-${index}`}>
                  <div className="quote-head">
                    <span className="quote-id" title="评论 ID">
                      {quote.reviewId}
                    </span>
                    {typeof quote.votedUp === 'boolean' ? (
                      <span className={`badge ${quote.votedUp ? 'badge-positive' : 'badge-negative'}`}>
                        {quote.votedUp ? '好评' : '差评'}
                      </span>
                    ) : null}
                    {typeof quote.votesUp === 'number' ? (
                      <span className="mono-num">赞 {formatNumber(quote.votesUp)}</span>
                    ) : null}
                    {onJumpToReview ? (
                      <button
                        type="button"
                        className="btn-link"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => onJumpToReview(quote.reviewId)}
                        disabled={!known}
                        title={known ? '定位到高赞评论表格' : '该评论不在当前高赞评论列表中'}
                      >
                        {known ? '定位到高赞评论' : '不在 Top N 中'}
                      </button>
                    ) : null}
                  </div>
                  <div className="quote-original">{quote.original}</div>
                  {quote.zh ? (
                    <div className="quote-zh">
                      <span className="ai-tag">AI 翻译</span>
                      {quote.zh}
                    </div>
                  ) : null}
                </blockquote>
              );
            })
          ) : evidenceIds.length > 0 ? (
            <div className="filter-chips">
              {evidenceIds.map((id) => (
                <button
                  type="button"
                  key={id}
                  className="filter-chip"
                  onClick={() => onJumpToReview?.(id)}
                  disabled={knownReviewIds ? !knownReviewIds.has(id) : false}
                >
                  评论 <strong className="mono">{id}</strong>
                </button>
              ))}
            </div>
          ) : (
            <p className="field-hint">该主题没有通过校验的证据引用（AI 未提供可核对的原文）。</p>
          )}
          {quotes.length > 0 && evidenceIds.length > 0 ? (
            <div className="field-hint">
              证据 ID：{evidenceIds.map((id) => id).join('、')}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
