import type { Theme, TopReview } from '../types';
import { languageName, normalizeRate } from '../lib/format';

export interface HistogramBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

const BUCKET_DEFINITIONS: Array<{ label: string; min: number; max: number }> = [
  { label: '<1h', min: 0, max: 1 },
  { label: '1–5h', min: 1, max: 5 },
  { label: '5–10h', min: 5, max: 10 },
  { label: '10–30h', min: 10, max: 30 },
  { label: '30–100h', min: 30, max: 100 },
  { label: '≥100h', min: 100, max: Number.POSITIVE_INFINITY },
];

export function playtimeHistogram(reviews: TopReview[]): HistogramBucket[] {
  return BUCKET_DEFINITIONS.map((bucket) => ({
    ...bucket,
    count: reviews.filter((review) => {
      const hours = Number(review.playtimeHours);
      if (!Number.isFinite(hours) || hours < 0) return false;
      if (bucket.max === Number.POSITIVE_INFINITY) return hours >= bucket.min;
      return hours >= bucket.min && hours < bucket.max;
    }).length,
  }));
}

export interface LanguageSlice {
  name: string;
  code: string;
  value: number;
}

export function languageCounts(reviews: TopReview[]): LanguageSlice[] {
  const counts = new Map<string, number>();
  for (const review of reviews) {
    const code = review.language || 'unknown';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([code, value]) => ({
      code,
      name: languageName(code),
      value,
    }))
    .sort((a, b) => b.value - a.value);
}

export interface ThemeDatum {
  name: string;
  mentions: number;
  sentiment: 'positive' | 'negative' | 'neutral';
}

export function themeData(themes: Theme[], limit = 10): ThemeDatum[] {
  const seen = new Set<string>();
  return [...themes]
    .filter((theme) => {
      const key = theme.id || theme.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((theme) => ({
      name: theme.name,
      mentions: Number.isFinite(theme.mentions) ? theme.mentions : 0,
      sentiment:
        theme.sentiment === 'negative'
          ? ('negative' as const)
          : theme.sentiment === 'positive'
            ? ('positive' as const)
            : ('neutral' as const),
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);
}

export function trendRate(value: number): number {
  return normalizeRate(value) ?? 0;
}

/** 报告趋势区标题必须与趋势实际来源一致，不能硬编码“官方聚合”（F4）。 */
export function trendSourceNote(source: string | undefined): string {
  if (source === 'sample_estimate') return '样本估算，受高赞采样偏差影响';
  if (source === 'official_aggregate') return '官方月度聚合，不使用高赞样本';
  return '数据源标注见图表';
}

export function hasTrendData(points: Array<{ total?: number; positiveRate?: number }>): boolean {
  return Array.isArray(points) && points.length > 0;
}
