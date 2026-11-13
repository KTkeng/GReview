import type { JobCounts } from '../../types';
import { formatNumber } from '../../lib/format';

const COUNTERS: Array<{ key: 'themes' | 'evidence' | 'tokens'; label: string }> = [
  { key: 'themes', label: '主题' },
  { key: 'evidence', label: '证据' },
  { key: 'tokens', label: 'Tokens' },
];

interface LiveCountersProps {
  counts?: JobCounts;
}

/**
 * 可选实时计数：仅当后端 counts 提供 themes / evidence / tokens 时渲染；
 * 字段缺失时整块返回 null，不产生占位空块。
 */
export function LiveCounters({ counts }: LiveCountersProps) {
  const items = COUNTERS.flatMap((counter) => {
    const value = counts?.[counter.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return [];
    return [{ ...counter, value }];
  });

  if (items.length === 0) return null;

  return (
    <div className="live-viz-counters" aria-label="实时计数">
      {items.map((item) => (
        <span key={item.key} className="live-counter">
          <span className="live-counter-label">{item.label}</span>
          <span className="live-counter-value mono-num">{formatNumber(item.value)}</span>
        </span>
      ))}
    </div>
  );
}
