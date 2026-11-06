import type { Kpis, Report } from '../types';
import { formatNumber, formatPercent } from '../lib/format';

interface KPIRowProps {
  kpis: Kpis;
  sample: Report['sample'];
}

export function KPIRow({ kpis, sample }: KPIRowProps) {
  const cards = [
    {
      key: 'all-time',
      label: '全部时间好评率',
      value: formatPercent(kpis.allTime?.positiveRate),
      sub: kpis.allTime?.reviewScoreDesc || 'Steam 口碑标签',
      tone: 'positive',
    },
    {
      key: 'total',
      label: '总评论数',
      value: formatNumber(kpis.allTime?.total),
      sub: 'Steam 官方聚合',
      tone: '',
    },
    {
      key: 'last-30',
      label: '近 30 天好评率',
      value: formatPercent(kpis.last30d?.positiveRate),
      sub: `近 30 天 ${formatNumber(kpis.last30d?.total)} 条`,
      tone: 'accent',
    },
    {
      key: 'sample',
      label: '本次样本量',
      value: formatNumber(sample?.usedForAI),
      sub: `样本好评率 ${formatPercent(kpis.samplePositiveRate)}`,
      tone: '',
    },
  ];

  return (
    <div className="kpi-row">
      {cards.map((card) => (
        <div className="kpi-card" key={card.key}>
          <div className={`kpi-value ${card.tone}`}>{card.value}</div>
          <div className="kpi-label">{card.label}</div>
          <div className="kpi-sub">{card.sub}</div>
        </div>
      ))}
    </div>
  );
}
