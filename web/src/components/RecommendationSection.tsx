import type { Recommendation } from '../types';
import { PRIORITY_LABELS, formatNumber } from '../lib/format';

interface RecommendationSectionProps {
  recommendations: Recommendation[];
}

export function RecommendationSection({ recommendations }: RecommendationSectionProps) {
  if (!recommendations || recommendations.length === 0) {
    return <div className="empty-inline">本次没有生成可行动建议。</div>;
  }

  return (
    <div className="recommendation-list">
      {recommendations.map((recommendation, index) => (
        <article className="recommendation" key={`${recommendation.title}-${index}`}>
          <span className={`priority ${recommendation.priority}`}>
            {PRIORITY_LABELS[recommendation.priority] ?? recommendation.priority}
          </span>
          <div className="recommendation-body">
            <h3 className="recommendation-title">{recommendation.title}</h3>
            <p className="recommendation-detail">{recommendation.detail}</p>
            {recommendation.evidenceIds && recommendation.evidenceIds.length > 0 ? (
              <p className="field-hint" style={{ marginTop: 4 }}>
                依据评论 ID：{recommendation.evidenceIds.join('、')}
                <span className="dim">（共 {formatNumber(recommendation.evidenceIds.length)} 条）</span>
              </p>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
