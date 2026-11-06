import type { Report } from '../types';
import { formatCostUsd, formatNumber } from '../lib/format';

interface ReuseIndicatorProps {
  report: Report;
}

export function ReuseIndicator({ report }: ReuseIndicatorProps) {
  const methodology = report.methodology;
  const items: Array<{ icon: string; text: string; note?: string }> = [];

  if (methodology?.analysisSource === 'local_report') {
    items.push({
      icon: '↺',
      text: '使用本地分析结果，本次未消耗 token',
      note: methodology.reportGeneratedAt
        ? `原始报告生成于 ${new Date(methodology.reportGeneratedAt).toLocaleString('zh-CN')}`
        : undefined,
    });
  }
  if (methodology?.dataSource === 'local_dataset') {
    items.push({
      icon: '▣',
      text: '复用本地评论数据集，未请求 Steam',
      note: methodology.datasetFetchedAt
        ? `数据抓取于 ${new Date(methodology.datasetFetchedAt).toLocaleString('zh-CN')}`
        : undefined,
    });
  } else if (methodology?.analysisSource === 'fresh') {
    items.push({ icon: '↓', text: '本次抓取 Steam 数据' });
  }
  // 复用数据集但重新分析时，仍然产生了 token 消耗，必须显示（F13）。
  if (methodology?.analysisSource === 'fresh') {
    const usage = report.sample?.tokenUsage;
    if (usage) {
      items.push({
        icon: '∑',
        text: `本次消耗 token：输入 ${formatNumber(usage.input)} / 输出 ${formatNumber(usage.output)}`,
        note:
          typeof usage.estimatedCostUsd === 'number'
            ? `估算 ${formatCostUsd(usage.estimatedCostUsd)}`
            : undefined,
      });
    }
  }
  if (methodology?.trendSource === 'local_cache') {
    items.push({ icon: '▤', text: '复用本地趋势缓存，未重新聚合' });
  }

  if (items.length === 0) return null;

  return (
    <div className="reuse-indicator" role="status">
      <span className="reuse-icon" aria-hidden="true">
        {items[0].icon}
      </span>
      <div>
        {items.map((item) => (
          <div key={item.text}>
            <span style={{ color: 'var(--positive-light)', fontWeight: 500 }}>{item.text}</span>
            {item.note ? <span className="reuse-note"> · {item.note}</span> : null}
          </div>
        ))}
        {report.methodology?.servedAt ? (
          <div className="reuse-note" style={{ fontSize: 11, marginTop: 2 }}>
            本次读取时间：{new Date(report.methodology.servedAt).toLocaleString('zh-CN')}
          </div>
        ) : null}
      </div>
    </div>
  );
}
