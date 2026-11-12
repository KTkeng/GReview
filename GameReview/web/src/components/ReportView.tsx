import { useMemo, useState } from 'react';
import type { Report, ReportSource, TopReview } from '../types';
import { ReportHeader } from './ReportHeader';
import { ConclusionCard } from './ConclusionCard';
import { KPIRow } from './KPIRow';
import { ThemeTabs } from './ThemeTabs';
import { RecommendationSection } from './RecommendationSection';
import { TopReviewsTable } from './TopReviewsTable';
import { MethodologyCollapse } from './MethodologyCollapse';
import { TrendChart } from '../charts/TrendChart';
import { ThemeBar } from '../charts/ThemeBar';
import { PlaytimeHistogram } from '../charts/PlaytimeHistogram';
import { LanguageDonut } from '../charts/LanguageDonut';
import { trendSourceNote } from '../lib/chartData';

interface ReportViewProps {
  report: Report;
  onReanalyze: () => void;
  /** 历史报告的 analysisHash/数据目录；用于展开时重建完整 Top N。 */
  reportSource?: ReportSource;
  /** 重建 full Top N 后同步回 App 的 report（导出与分布图使用）。 */
  onReviewsLoaded?: (reviews: TopReview[]) => void;
}

export function ReportView({
  report,
  onReanalyze,
  reportSource,
  onReviewsLoaded,
}: ReportViewProps) {
  const [highlightedReviewId, setHighlightedReviewId] = useState<string | null>(null);

  const knownReviewIds = useMemo(
    () => new Set((report.topReviews ?? []).map((review) => String(review.reviewId))),
    [report.topReviews],
  );

  const handleJumpToReview = (reviewId: string) => {
    setHighlightedReviewId(null);
    window.requestAnimationFrame(() => setHighlightedReviewId(reviewId));
  };

  const ai = {
    appealPoints: report.ai?.appealPoints ?? [],
    frictionPoints: report.ai?.frictionPoints ?? [],
    expectationGaps: report.ai?.expectationGaps ?? [],
    updateImpact: report.ai?.updateImpact ?? [],
    recommendations: report.ai?.recommendations ?? [],
  };
  const distributionThemes = [...ai.appealPoints, ...ai.frictionPoints];

  return (
    <div className="report-view">
      <ReportHeader report={report} onReanalyze={onReanalyze} reportSource={reportSource} />

      <ConclusionCard conclusion={report.conclusion} />

      <KPIRow kpis={report.kpis} sample={report.sample} />

      <section className="report-section" aria-labelledby="report-trend-heading">
        <div className="report-section-head">
          <h2 id="report-trend-heading">口碑趋势</h2>
          <span className="section-note">{trendSourceNote(report.trend?.source)}</span>
        </div>
        <TrendChart trend={report.trend} />
      </section>

      <section className="report-section" aria-labelledby="report-ai-heading">
        <div className="report-section-head">
          <h2 id="report-ai-heading">AI 归纳</h2>
          <span className="section-note">
            共 {distributionThemes.length} 个主题 · 点击卡片展开证据引用
          </span>
        </div>
        <ThemeTabs
          ai={ai}
          knownReviewIds={knownReviewIds}
          onJumpToReview={handleJumpToReview}
        />
      </section>

      <section className="report-section" aria-labelledby="report-rec-heading">
        <div className="report-section-head">
          <h2 id="report-rec-heading">可行动建议</h2>
          <span className="section-note">按优先级排序</span>
        </div>
        <RecommendationSection recommendations={ai.recommendations} />
      </section>

      <section className="report-section" aria-labelledby="report-reviews-heading">
        <div className="report-section-head">
          <h2 id="report-reviews-heading">高赞评论</h2>
          <span className="section-note">
            默认显示 10 条，最多 50 条 · 证据引用可在此核对原文
          </span>
        </div>
        <TopReviewsTable
          reviews={report.topReviews ?? []}
          highlightedReviewId={highlightedReviewId}
          reportSource={reportSource}
          onReviewsLoaded={onReviewsLoaded}
          resetKey={report.generatedAt}
        />
      </section>

      <section className="report-section" aria-labelledby="report-dist-heading">
        <div className="report-section-head">
          <h2 id="report-dist-heading">样本分布</h2>
          <span className="section-note">基于本次高赞样本，仅供结构参考</span>
        </div>
        <div className="chart-grid-3">
          <ThemeBar themes={distributionThemes} title="主题分布" />
          <PlaytimeHistogram reviews={report.topReviews ?? []} />
          <LanguageDonut reviews={report.topReviews ?? []} />
        </div>
      </section>

      <section className="report-section" aria-labelledby="report-method-heading">
        <div className="report-section-head">
          <h2 id="report-method-heading">方法与局限</h2>
          <span className="section-note">抓取配置、样本量、模型、token 用量与采样偏差</span>
        </div>
        <MethodologyCollapse report={report} />
      </section>
    </div>
  );
}
