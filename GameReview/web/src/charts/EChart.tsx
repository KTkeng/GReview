import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { EChartsType } from 'echarts/core';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export const CHART_COLORS = {
  text: '#94A3B8',
  textStrong: '#E5E7EB',
  line: '#374151',
  split: '#1F2937',
  accent: '#38BDF8',
  positive: '#22C55E',
  negative: '#F87171',
  warning: '#F59E0B',
  neutral: '#6B7280',
};

/**
 * ECharts 默认使用 HTML tooltip；formatter 返回的字符串不会被 React 转义。
 * 任何进入 formatter 的动态文本（AI 主题名、趋势 period、语言名等）都必须
 * 先经过 `lib/html.escapeHtml`，否则会形成同源 XSS 面（F5）。
 */
export const TOOLTIP_STYLE = {
  backgroundColor: '#121821',
  borderColor: '#374151',
  borderWidth: 1,
  textStyle: { color: '#E5E7EB', fontSize: 12 },
  extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,.45); border-radius:8px;',
};

interface EChartProps {
  option: EChartsOption;
  height?: number;
  className?: string;
  ariaLabel: string;
}

export function EChart({ option, height = 300, className, ariaLabel }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const chart = echarts.init(element, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    const resize = () => {
      if (!chart.isDisposed()) chart.resize();
    };
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(element);
    window.addEventListener('beforeprint', resize);
    window.addEventListener('afterprint', resize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('beforeprint', resize);
      window.removeEventListener('afterprint', resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (chartRef.current && !chartRef.current.isDisposed()) {
      chartRef.current.setOption(option, true);
    }
  }, [option]);

  return (
    <div
      ref={containerRef}
      className={`chart-canvas${className ? ` ${className}` : ''}`}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}
