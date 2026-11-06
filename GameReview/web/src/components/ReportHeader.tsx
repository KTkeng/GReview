import type { Report } from '../types';
import { CONFIDENCE_LABELS, formatDateTime, gameName } from '../lib/format';
import { ExportButtons } from './ExportButtons';
import { ReuseIndicator } from './ReuseIndicator';
import { IconRefresh } from './Icon';

interface ReportHeaderProps {
  report: Report;
  onReanalyze: () => void;
}

export function ReportHeader({ report, onReanalyze }: ReportHeaderProps) {
  const confidence = report.conclusion?.confidence;

  return (
    <div className="report-section">
      <div className="report-toolbar">
        <div className="report-toolbar-title">
          <span>报告</span>
          <strong>{gameName(report.game)}</strong>
          <span className="dim">生成于 {formatDateTime(report.generatedAt)}</span>
          {confidence ? (
            <span className="badge">{CONFIDENCE_LABELS[confidence] ?? confidence}</span>
          ) : null}
        </div>
        <div className="report-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onReanalyze}>
            <IconRefresh size={14} />
            重新分析
          </button>
          <ExportButtons report={report} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <ReuseIndicator report={report} />
      </div>
    </div>
  );
}
