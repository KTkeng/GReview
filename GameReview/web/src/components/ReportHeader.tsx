import type { Report, ReportSource } from '../types';
import { CONFIDENCE_LABELS, formatDateTime } from '../lib/format';
import { gameTitleInfo } from '../lib/gameTitle';
import { ExportButtons } from './ExportButtons';
import { ReuseIndicator } from './ReuseIndicator';
import { CustomTitleBadge, ReportCover } from './GameTitle';
import { IconRefresh } from './Icon';

interface ReportHeaderProps {
  report: Report;
  onReanalyze: () => void;
  /** 历史报告的 analysisHash；Markdown 导出通过服务端按当前标题生成。 */
  reportSource?: ReportSource;
}

export function ReportHeader({ report, onReanalyze, reportSource }: ReportHeaderProps) {
  const confidence = report.conclusion?.confidence;
  const title = gameTitleInfo(report.game, report.game?.appid);

  return (
    <div className="report-section">
      <div className="report-toolbar">
        <ReportCover game={report.game} appid={report.game?.appid} />
        <div className="report-toolbar-title">
          <span>报告</span>
          <h1
            className="report-title"
            title={
              title.isCustom && title.steamName
                ? `Steam 原名：${title.steamName}`
                : title.displayTitle
            }
          >
            {title.displayTitle}
            {title.isCustom ? <CustomTitleBadge /> : null}
            {title.isCustom ? (
              <span className="custom-title-print" aria-hidden="true">
                [自定义名称]
              </span>
            ) : null}
          </h1>
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
          <ExportButtons report={report} reportSource={reportSource} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <ReuseIndicator report={report} />
      </div>
    </div>
  );
}
