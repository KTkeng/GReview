import { TREND_MONTH_OPTIONS } from '../lib/defaults';

interface TrendConfigFormProps {
  months: number;
  onChange: (months: number) => void;
}

export function TrendConfigForm({ months, onChange }: TrendConfigFormProps) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor="trend-months">趋势范围（月）</label>
      <select
        id="trend-months"
        className="select"
        value={months}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {TREND_MONTH_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option === 36 ? '全部（最多 36 个月）' : `最近 ${option} 个月`}
          </option>
        ))}
      </select>
      <p className="field-hint">
        趋势使用 Steam 官方月度聚合，与上方「样本时间范围」相互独立；「全部」按最多 36
        个月统计（API 仍传 months=36）。趋势的好评率始终基于全部评论类型。
      </p>
    </div>
  );
}
