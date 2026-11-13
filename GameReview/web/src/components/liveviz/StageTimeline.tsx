import type { TimelineStage, LiveStageStatus } from '../../hooks/useJobTimeline';

const STATUS_TEXT: Record<LiveStageStatus, string> = {
  unobserved: '未观察',
  pending: '待开始',
  active: '进行中',
  done: '已完成',
  skipped: '已跳过（复用本地）',
  failed: '失败',
  cancelled: '已取消',
};

const DOT_TEXT: Partial<Record<LiveStageStatus, string>> = {
  unobserved: '·',
  done: '✓',
  failed: '!',
  cancelled: '×',
};

interface StageTimelineProps {
  stages: TimelineStage[];
}

/**
 * 7 阶段时间线：桌面横向、窄屏（<720px）纵向。
 * 每个节点同时给出状态文字，不只依赖颜色区分。
 */
export function StageTimeline({ stages }: StageTimelineProps) {
  return (
    <div className="live-viz-block">
      <h4 className="live-viz-block-title">分析阶段</h4>
      <ol className="live-timeline" aria-label="分析阶段时间线">
        {stages.map((stage) => {
          const stateText = stage.detail ?? STATUS_TEXT[stage.status];
          const dot = DOT_TEXT[stage.status] ?? '';
          return (
            <li
              key={stage.key}
              className={`live-stage ${stage.status}`}
              data-status={stage.status}
              aria-current={stage.status === 'active' ? 'step' : undefined}
            >
              <span className="live-stage-dot" aria-hidden="true">
                {dot}
              </span>
              <span className="live-stage-label">{stage.label}</span>
              <span className="live-stage-state">{stateText}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
