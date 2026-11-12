import { useState } from 'react';
import type { Report, ReportSource } from '../types';
import { downloadReportMarkdown } from '../lib/exportMarkdown';
import { IconDownload, IconPrinter } from './Icon';

interface ExportButtonsProps {
  report: Report;
  /** 历史报告有 analysisHash 时优先让后端按当前展示标题生成 Markdown。 */
  reportSource?: ReportSource;
}

export function ExportButtons({ report, reportSource }: ExportButtonsProps) {
  const [exported, setExported] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const filename = await downloadReportMarkdown(report, reportSource);
      setExported(filename);
      window.setTimeout(() => setExported(null), 4000);
    } catch {
      setExported('导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="inline-flex" style={{ flexWrap: 'wrap', gap: 6 }}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void handleExport()}
        disabled={exporting}
      >
        <IconDownload size={14} />
        {exporting ? '导出中…' : '导出 Markdown'}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => window.print()}>
        <IconPrinter size={14} />
        打印 / PDF
      </button>
      {exported ? (
        <span className="field-hint" role="status" style={{ alignSelf: 'center' }}>
          {exported === '导出失败' ? '导出失败，请重试' : `已下载 ${exported}`}
        </span>
      ) : null}
    </div>
  );
}
