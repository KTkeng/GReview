import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import type { TrendInfo } from '../types';
import { TREND_SOURCE_LABELS, formatNumber, formatPercent } from '../lib/format';
import { escapeHtml } from '../lib/html';
import { trendRate } from '../lib/chartData';
import { CHART_COLORS, EChart, TOOLTIP_STYLE } from './EChart';

interface TrendChartProps {
  trend: TrendInfo | null | undefined;
}

export function TrendChart({ trend }: TrendChartProps) {
  const points = trend?.points ?? [];

  const option = useMemo<EChartsOption>(() => {
    const periods = points.map((point) => point.period);
    const totals = points.map((point) => point.total);
    const rates = points.map((point) => trendRate(point.positiveRate));

    return {
      backgroundColor: 'transparent',
      tooltip: {
        ...TOOLTIP_STYLE,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,0.06)' } },
        formatter: (params: unknown): string => {
          const list = Array.isArray(params) ? params : [params];
          const first = list[0] as { dataIndex?: number } | undefined;
          const index = typeof first?.dataIndex === 'number' ? first.dataIndex : -1;
          const point = points[index];
          if (!point) return '';
          return [
            `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(point.period)}</div>`,
            `评论数：${formatNumber(point.total)}`,
            `好评率：${formatPercent(point.positiveRate)}`,
            `好评：${formatNumber(point.positive)} · 差评：${formatNumber(point.negative)}`,
          ].join('<br/>');
        },
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: CHART_COLORS.text, fontSize: 11 },
        data: ['评论量', '好评率'],
      },
      grid: {
        top: 36,
        left: 8,
        right: 8,
        bottom: periods.length > 12 ? 46 : 26,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: periods,
        axisLine: { lineStyle: { color: CHART_COLORS.line } },
        axisTick: { show: false },
        axisLabel: {
          color: CHART_COLORS.text,
          fontSize: 11,
          rotate: periods.length > 12 ? 40 : 0,
          hideOverlap: true,
        },
      },
      yAxis: [
        {
          type: 'value',
          name: '评论数',
          nameTextStyle: { color: CHART_COLORS.text, fontSize: 11 },
          axisLabel: { color: CHART_COLORS.text, fontSize: 11 },
          splitLine: { lineStyle: { color: CHART_COLORS.split } },
        },
        {
          type: 'value',
          name: '好评率',
          min: 0,
          max: 100,
          nameTextStyle: { color: CHART_COLORS.text, fontSize: 11 },
          axisLabel: {
            color: CHART_COLORS.text,
            fontSize: 11,
            formatter: '{value}%',
          },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '评论量',
          type: 'bar',
          yAxisIndex: 0,
          data: totals,
          barMaxWidth: 26,
          itemStyle: {
            color: 'rgba(56,189,248,0.55)',
            borderColor: CHART_COLORS.accent,
            borderWidth: 1,
            borderRadius: [3, 3, 0, 0],
          },
          emphasis: { itemStyle: { color: 'rgba(56,189,248,0.8)' } },
        },
        {
          name: '好评率',
          type: 'line',
          yAxisIndex: 1,
          data: rates,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { width: 2, color: CHART_COLORS.warning },
          itemStyle: { color: CHART_COLORS.warning },
          emphasis: { scale: 1.5 },
          z: 5,
        },
      ],
    };
  }, [points]);

  const hasData = points.length > 0;
  const sourceLabel = TREND_SOURCE_LABELS[trend?.source ?? ''] ?? trend?.source ?? '—';

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">口碑趋势</span>
        <span className="chart-subtitle">月度评论量（柱）+ 好评率（折线），双轴</span>
      </div>
      {hasData ? (
        <EChart
          option={option}
          height={320}
          ariaLabel={`口碑趋势图，${points.length} 个月，数据源 ${sourceLabel}`}
        />
      ) : (
        <div className="chart-empty">暂无趋势数据</div>
      )}
      <div className="chart-caption">
        <span>
          数据源：<strong>{sourceLabel}</strong>
        </span>
        <span>
          覆盖区间：
          <strong>
            {trend?.coverage?.start ?? '—'} 至 {trend?.coverage?.end ?? '—'}
          </strong>
        </span>
        <span>
          {trend?.source === 'sample_estimate'
            ? '样本估算，受高赞采样偏差影响'
            : '官方聚合，不使用高赞样本'}
        </span>
        {trend?.coverage?.note ? <span>说明：{trend.coverage.note}</span> : null}
      </div>
    </div>
  );
}
