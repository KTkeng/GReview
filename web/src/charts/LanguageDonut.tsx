import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import type { TopReview } from '../types';
import { languageCounts } from '../lib/chartData';
import { escapeHtml } from '../lib/html';
import { EChart, TOOLTIP_STYLE } from './EChart';

interface LanguageDonutProps {
  reviews: TopReview[];
}

const PALETTE = ['#38BDF8', '#4ADE80', '#FBBF24', '#F87171', '#A78BFA', '#9CA3AF', '#34D399', '#F472B6'];

export function LanguageDonut({ reviews }: LanguageDonutProps) {
  const slices = useMemo(() => languageCounts(reviews), [reviews]);

  const option = useMemo<EChartsOption>(() => ({
    backgroundColor: 'transparent',
    color: PALETTE,
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: 'item',
      formatter: (params: unknown): string => {
        const item = params as { name?: string; value?: number; percent?: number };
        return `${escapeHtml(item.name)}：${escapeHtml(item.value ?? 0)} 条（${escapeHtml(item.percent ?? 0)}%）`;
      },
    },
    legend: {
      bottom: 0,
      textStyle: { color: '#94A3B8', fontSize: 11 },
      itemWidth: 8,
      itemHeight: 8,
    },
    series: [
      {
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#1A2332', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, color: '#E5E7EB', fontSize: 12 } },
        data: slices.map((slice) => ({ name: slice.name, value: slice.value })),
      },
    ],
  }), [slices]);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">语言分布</span>
        <span className="chart-subtitle">基于报告 Top 评论样本</span>
      </div>
      {slices.length > 0 ? (
        <EChart option={option} height={220} ariaLabel="语言分布环图" />
      ) : (
        <div className="chart-empty" style={{ height: 220 }}>
          暂无语言数据
        </div>
      )}
    </div>
  );
}
