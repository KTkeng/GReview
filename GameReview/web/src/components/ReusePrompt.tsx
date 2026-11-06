import type { ReusableDataset, ReusableReport } from '../types';
import { formatRelativeTime } from '../lib/format';
import { Switch } from './ui';

interface ReusePromptProps {
  reuseDataset: boolean;
  reuseReport: boolean;
  dataset: ReusableDataset | null;
  report: ReusableReport | null;
  historicalReport: ReusableReport | null;
  forceFetch: boolean;
  forceAnalyze: boolean;
  onToggleDataset: (next: boolean) => void;
  onToggleReport: (next: boolean) => void;
  onRefetch: () => void;
  onReanalyze: () => void;
}

export function ReusePrompt({
  reuseDataset,
  reuseReport,
  dataset,
  report,
  historicalReport,
  forceFetch,
  forceAnalyze,
  onToggleDataset,
  onToggleReport,
  onRefetch,
  onReanalyze,
}: ReusePromptProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="switch-row">
        <div className="switch-copy">
          <span className="switch-label">复用本地数据集</span>
          <span className="switch-desc">开启时若命中相同抓取条件，将跳过 Steam 抓取。</span>
        </div>
        <Switch checked={reuseDataset} onChange={onToggleDataset} label="复用本地数据集" />
      </div>

      {!reuseDataset || forceFetch ? (
        <p className="reuse-toggle-warning" role="status">
          将重新抓取 Steam 数据{forceFetch ? '（已点击「重新抓取」）' : ''}。
        </p>
      ) : dataset ? (
        <div className="reuse-prompt">
          <div className="reuse-prompt-title">
            <span aria-hidden="true">●</span>
            复用本地数据：{dataset.reviewCount} 条，抓取于 {formatRelativeTime(dataset.fetchedAt)}
          </div>
          {dataset.trendCoverage?.start && dataset.trendCoverage?.end ? (
            <div>
              趋势覆盖：{dataset.trendCoverage.start} 至 {dataset.trendCoverage.end}
            </div>
          ) : null}
          <div className="reuse-prompt-row">
            <span className="dim">使用本地评论可避免重复请求 Steam。</span>
            <button type="button" className="btn btn-sm" onClick={onRefetch} disabled={forceFetch}>
              重新抓取
            </button>
          </div>
        </div>
      ) : (
        <p className="field-hint">预览匹配数后，这里会显示可复用的本地数据。</p>
      )}

      <div className="switch-row">
        <div className="switch-copy">
          <span className="switch-label">复用本地分析报告</span>
          <span className="switch-desc">同数据、模型与提示词时直接返回上次报告，不再消耗 token。</span>
        </div>
        <Switch checked={reuseReport} onChange={onToggleReport} label="复用本地分析报告" />
      </div>

      {!reuseReport || forceAnalyze ? (
        <p className="reuse-toggle-warning" role="status">
          将重新调用 AI 分析并消耗 token{forceAnalyze ? '（已点击「重新分析」）' : ''}。
        </p>
      ) : report ? (
        <div className="reuse-prompt">
          <div className="reuse-prompt-title">
            <span aria-hidden="true">●</span>
            使用本地分析结果，本次未消耗 token
          </div>
          <div>报告生成于 {formatRelativeTime(report.generatedAt)}</div>
          <div className="reuse-prompt-row">
            <span className="dim">如需尝试新模型或提示词，可重新分析。</span>
            <button type="button" className="btn btn-sm" onClick={onReanalyze} disabled={forceAnalyze}>
              重新分析
            </button>
          </div>
        </div>
      ) : historicalReport ? (
        <div className="reuse-prompt historical">
          <div className="reuse-prompt-title">
            <span aria-hidden="true">●</span>
            历史报告（不可直接复用）
          </div>
          <div>
            报告生成于 {formatRelativeTime(historicalReport.generatedAt)}
            {historicalReport.model ? `，模型 ${historicalReport.model}` : ''}；当前数据集、模型、
            提示词、思考模式或翻译设置与它不一致，开始分析会重新调用 AI 并消耗 token。
          </div>
          <div className="reuse-prompt-row">
            <span className="dim">恢复生成该报告时的模型与选项后，预览会重新判定为可复用。</span>
          </div>
        </div>
      ) : (
        <p className="field-hint">预览匹配数后，这里会显示可复用的历史报告。</p>
      )}
    </div>
  );
}
