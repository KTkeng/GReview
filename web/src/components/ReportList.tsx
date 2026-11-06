import type { DatasetReportRef } from '../types';
import { formatDateTime } from '../lib/format';

interface ReportListProps {
  reports: DatasetReportRef[];
  openingHash: string | null;
  error: string | null;
  onOpen: (analysisHash: string) => void;
}

export function ReportList({ reports, openingHash, error, onOpen }: ReportListProps) {
  if (reports.length === 0) {
    return <p className="field-hint">该数据集暂无已保存报告。</p>;
  }
  return (
    <div className="dataset-reports" aria-label="已保存报告">
      <div className="evidence-title">已保存报告</div>
      <ul style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {reports.map((report) => (
          <li key={report.analysisHash}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => onOpen(report.analysisHash)}
              disabled={openingHash === report.analysisHash}
            >
              {openingHash === report.analysisHash ? <span className="spinner" aria-hidden="true" /> : null}
              <span className="mono" style={{ fontSize: 11 }}>
                {report.analysisHash}
              </span>
              <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
                {report.generatedAt ? formatDateTime(report.generatedAt) : '时间未知'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
