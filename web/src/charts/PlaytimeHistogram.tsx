import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import type { TopReview } from '../types';
import { playtimeHistogram } from '../lib/chartData';
import { escapeHtml } from '../lib/html';
import { CHART_COLORS, EChart, TOOLTIP_STYLE } from './EChart';

interface PlaytimeHistogramProps {
  reviews: TopReview[];
}

export function PlaytimeHistogram({ reviews }: PlaytimeHistogramProps) {
  const buckets = useMemo(() => playtimeHistogram(reviews), [reviews]);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  const option = useMemo<EChartsOption>(() => ({
    backgroundColor: 'transparent',
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown): string => {
        const list = Array.isArray(params) ? params : [params];
        const item = list[0] as { name?: string; value?: number } | undefined;
        return `${escapeHtml(item?.name)}<br/>评论：${escapeHtml(item?.value ?? 0)} 条`;
      },
    },
    grid: { top: 16, left: 8, right: 12, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: buckets.map((bucket) => bucket.label),
      axisLine: { lineStyle: { color: CHART_COLORS.line } },
      axisTick: { show: false },
      axisLabel: { color: CHART_COLORS.text, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: CHART_COLORS.text, fontSize: 11 },
      splitLine: { lineStyle: { color: CHART_COLORS.split } },
    },
    series: [
      {
        type: 'bar',
        data: buckets.map((bucket) => bucket.count),
        barMaxWidth: 28,
        itemStyle: {
          color: 'rgba(56,189,248,0.6)',
          borderColor: CHART_COLORS.accent,
          borderWidth: 1,
          borderRadius: [3, 3, 0, 0],
        },
      },
    ],
  }), [buckets]);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">游玩时长分布</span>
        <span className="chart-subtitle">基于报告 Top 评论样本</span>
      </div>
      {total > 0 ? (
        <EChart option={option} height={220} ariaLabel="游玩时长分布直方图" />
      ) : (
        <div className="chart-empty" style={{ height: 220 }}>
          暂无游玩时长数据
        </div>
      )}
    </div>
  );
}
