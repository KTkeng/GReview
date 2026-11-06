import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import type { Theme } from '../types';
import { themeData } from '../lib/chartData';
import { escapeHtml } from '../lib/html';
import { CHART_COLORS, EChart, TOOLTIP_STYLE } from './EChart';

interface ThemeBarProps {
  themes: Theme[];
  title?: string;
}

const SENTIMENT_COLORS = {
  positive: CHART_COLORS.positive,
  negative: CHART_COLORS.negative,
  neutral: CHART_COLORS.neutral,
};

export function ThemeBar({ themes, title = '主题分布' }: ThemeBarProps) {
  const data = useMemo(() => themeData(themes, 10), [themes]);
  const option = useMemo<EChartsOption>(() => {
    const ordered = [...data].reverse();
    return {
      backgroundColor: 'transparent',
      tooltip: {
        ...TOOLTIP_STYLE,
        trigger: 'item',
        formatter: (params: unknown): string => {
          const item = params as { name?: string; value?: number };
          return `${escapeHtml(item.name)}<br/>提及 ${escapeHtml(item.value ?? 0)} 次`;
        },
      },
      grid: { top: 8, left: 8, right: 40, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        axisLabel: { color: CHART_COLORS.text, fontSize: 11 },
        splitLine: { lineStyle: { color: CHART_COLORS.split } },
      },
      yAxis: {
        type: 'category',
        data: ordered.map((item) => item.name),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: CHART_COLORS.text,
          fontSize: 11,
          width: 150,
          overflow: 'truncate',
        },
      },
      series: [
        {
          type: 'bar',
          data: ordered.map((item) => ({
            value: item.mentions,
            itemStyle: {
              color: SENTIMENT_COLORS[item.sentiment],
              borderRadius: [0, 3, 3, 0],
            },
          })),
          barMaxWidth: 16,
          label: {
            show: true,
            position: 'right',
            color: CHART_COLORS.text,
            fontSize: 11,
          },
        },
      ],
    };
  }, [data]);

  const height = Math.max(200, data.length * 30 + 50);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-subtitle">按提及数排序（绿=吸引点，红=劝退点）</span>
      </div>
      {data.length > 0 ? (
        <EChart option={option} height={height} ariaLabel={`${title}横向条形图`} />
      ) : (
        <div className="chart-empty">暂无主题数据</div>
      )}
    </div>
  );
}
