import { useState } from 'react';
import type { Report } from '../types';
import { downloadMarkdown } from '../lib/exportMarkdown';
import { IconDownload, IconPrinter } from './Icon';

interface ExportButtonsProps {
  report: Report;
}

export function ExportButtons({ report }: ExportButtonsProps) {
  const [exported, setExported] = useState<string | null>(null);

  const handleExport = () => {
    try {
      const filename = downloadMarkdown(report);
      setExported(filename);
      window.setTimeout(() => setExported(null), 4000);
    } catch {
      setExported('导出失败');
    }
  };

  return (
    <div className="inline-flex" style={{ flexWrap: 'wrap', gap: 6 }}>
      <button type="button" className="btn btn-sm" onClick={handleExport}>
        <IconDownload size={14} />
        导出 Markdown
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
