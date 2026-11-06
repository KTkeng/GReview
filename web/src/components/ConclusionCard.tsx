import type { Conclusion } from '../types';
import { CONFIDENCE_LABELS } from '../lib/format';

interface ConclusionCardProps {
  conclusion: Conclusion;
}

export function ConclusionCard({ conclusion }: ConclusionCardProps) {
  const paragraphs = String(conclusion.summary ?? '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  const summaryParagraphs = paragraphs.length > 0 ? paragraphs : [String(conclusion.summary ?? '')];
  const confidence = conclusion.confidence ?? 'low';

  return (
    <article className="conclusion-card" aria-labelledby="conclusion-heading">
      <div className="conclusion-top">
        <span className="conclusion-label" id="conclusion-heading">
          {conclusion.label || '暂无口碑标签'}
        </span>
        <span className={`badge ${confidence === 'high' ? 'badge-positive' : confidence === 'medium' ? 'badge-warning' : 'badge-negative'}`}>
          <span className={`confidence-dot ${confidence}`} aria-hidden="true" />
          {CONFIDENCE_LABELS[confidence] ?? confidence}
        </span>
      </div>
      <p className="conclusion-headline">{conclusion.headline}</p>
      <div className="conclusion-summary">
        {summaryParagraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      <div className="conclusion-footer">
        <div>
          <span className="strong" style={{ color: 'var(--text-secondary)' }}>
            局限
          </span>
          {conclusion.caveats && conclusion.caveats.length > 0 ? (
            <ul className="caveat-list" style={{ marginTop: 2 }}>
              {conclusion.caveats.map((caveat, index) => (
                <li key={index}>{caveat}</li>
              ))}
            </ul>
          ) : (
            <span className="dim"> · 报告未列出额外局限，请参考「方法与局限」。</span>
          )}
        </div>
      </div>
    </article>
  );
}
