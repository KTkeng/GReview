import { IconPlay, IconSearch, IconStop } from './Icon';

interface ActionButtonsProps {
  onPreview: () => void;
  onStart: () => void;
  onCancel: () => void;
  previewLoading: boolean;
  analyzing: boolean;
  canStart: boolean;
  startDisabledReason: string | null;
  startLabel?: string;
  previewLabel?: string;
}

export function ActionButtons({
  onPreview,
  onStart,
  onCancel,
  previewLoading,
  analyzing,
  canStart,
  startDisabledReason,
  startLabel = '开始分析',
  previewLabel = '预览匹配数',
}: ActionButtonsProps) {
  if (analyzing) {
    return (
      <div className="config-actions">
        <button type="button" className="btn btn-danger btn-block" onClick={onCancel}>
          <IconStop size={14} />
          取消分析
        </button>
        <p className="action-hint">取消后任务停止，已抓取的数据仍会保留在本地。</p>
      </div>
    );
  }

  return (
    <div className="config-actions">
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={onStart}
        disabled={!canStart}
      >
        <IconPlay size={14} />
        {startLabel}
      </button>
      <button type="button" className="btn btn-block" onClick={onPreview} disabled={previewLoading}>
        {previewLoading ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <IconSearch size={14} />
        )}
        {previewLoading ? '预览中…' : previewLabel}
      </button>
      {!canStart && startDisabledReason ? (
        <p className="action-hint" role="status">
          {startDisabledReason}
        </p>
      ) : (
        <p className="action-hint">预计成本以预览结果为准；复用本地数据/报告时不请求 Steam、不消耗 token。</p>
      )}
    </div>
  );
}
