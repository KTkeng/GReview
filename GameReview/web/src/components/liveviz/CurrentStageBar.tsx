import type { TimelineCurrent } from '../../hooks/useJobTimeline';

interface CurrentStageBarProps {
  current: TimelineCurrent;
  errorCode?: string | null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 当前阶段条：阶段中文名（未知 stage 原样显示）+ 百分比 + message。 */
export function CurrentStageBar({ current, errorCode }: CurrentStageBarProps) {
  const progress = clampPercent(current.progress);
  const label = current.label || '等待任务';
  return (
    <div className="live-viz-block live-current">
      <div className="live-current-head">
        <span className="live-current-stage">{label}</span>
        <span className="live-current-percent mono-num" aria-label={`任务总进度 ${progress}%`}>
          {progress}%
        </span>
      </div>
      <div
        className="live-current-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-label={`任务总进度（${label}）`}
      >
        <div className="live-current-fill" style={{ width: `${progress}%` }} />
      </div>
      <p className="live-current-message">{current.message || '等待任务输出…'}</p>
      {errorCode ? <p className="live-current-error">错误码：{errorCode}</p> : null}
    </div>
  );
}
