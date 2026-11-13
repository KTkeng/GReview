import { useId } from 'react';
import type { JobState } from '../../types';
import { useJobTimeline, type TimelineTerminal } from '../../hooks/useJobTimeline';
import { useLiveVizPref } from '../../hooks/useLiveVizPref';
import { StageTimeline } from './StageTimeline';
import { ChunkProgress } from './ChunkProgress';
import { CurrentStageBar } from './CurrentStageBar';
import { LogStream } from './LogStream';
import { LiveCounters } from './LiveCounters';

export interface LiveVizPanelProps {
  job: JobState;
  /** SSE 断线时显示「连接中断，正在恢复」；收起状态下同样可见。 */
  connection?: 'connected' | 'disconnected';
  /** 本任务曾断线并已恢复时显示「连接曾中断，部分过程可能未记录」。 */
  recovered?: boolean;
  /** 受控展开状态；未传入时使用 useLiveVizPref 的内部状态。 */
  expanded?: boolean;
  onToggle?: () => void;
}

interface LiveVizToggleProps {
  expanded: boolean;
  contentId: string;
  onToggle: () => void;
}

/** 标题栏中的展开/收起按钮（aria-expanded / aria-controls）。 */
export function LiveVizToggle({ expanded, contentId, onToggle }: LiveVizToggleProps) {
  return (
    <button
      type="button"
      className="btn-link live-viz-toggle"
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={onToggle}
    >
      <span>{expanded ? '收起' : '展开'}</span>
      <span className={`live-viz-chevron${expanded ? ' open' : ''}`} aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

function announcementFor(
  progress: number,
  label: string,
  terminal: TimelineTerminal,
): string {
  if (terminal === 'done') return '分析完成，进度 100%';
  if (terminal === 'cancelled') return '分析已取消';
  if (terminal === 'failed') return '分析失败';
  // 每 10% 一个里程碑，避免每个进度 tick 都触发朗读。
  const milestone = Math.floor(Math.max(0, Math.min(100, progress)) / 10) * 10;
  return `${label}，进度 ${milestone}%`;
}

/**
 * 分析进行中的实时可视化子区块。
 * - 默认展开；用户切换后经 useLiveVizPref 记忆；
 * - 收起时内容区 hidden（不参与 Tab 顺序），标题栏保留阶段名与百分比；
 * - 所有数据均来自现有 JobState（SSE + 快照），不新增接口。
 */
export function LiveVizPanel({
  job,
  connection = 'connected',
  recovered = false,
  expanded: expandedProp,
  onToggle,
}: LiveVizPanelProps) {
  const timeline = useJobTimeline(job);
  const pref = useLiveVizPref();
  const expanded = expandedProp ?? pref.expanded;
  const toggle = onToggle ?? pref.toggle;
  const contentId = useId();
  const disconnected = connection === 'disconnected' && timeline.terminal === null;
  const reportReused = timeline.reusedStages.includes('ai_map');
  const percent = Math.round(timeline.current.progress);
  const summary = `${timeline.current.label || '等待任务'} · ${percent}%`;

  return (
    <section className="live-viz" aria-label="AI 分析实时可视化" data-expanded={expanded}>
      <div className="live-viz-head">
        <div className="live-viz-title">
          <span className="live-viz-mark" aria-hidden="true" />
          <h3>实时可视化</h3>
          <span className="live-viz-summary mono-num" data-testid="live-viz-summary">
            {summary}
          </span>
          {disconnected ? (
            <span className="badge badge-warning live-viz-badge">连接中断，正在恢复</span>
          ) : null}
          {timeline.terminal === 'failed' ? (
            <span className="badge badge-negative live-viz-badge">失败</span>
          ) : null}
          {timeline.terminal === 'cancelled' ? (
            <span className="badge live-viz-badge">已取消</span>
          ) : null}
          {timeline.terminal === 'done' ? (
            <span className="badge badge-positive live-viz-badge">已完成</span>
          ) : null}
        </div>
        <LiveVizToggle expanded={expanded} contentId={contentId} onToggle={toggle} />
      </div>

      {recovered && !disconnected ? (
        <p className="live-viz-recovered" role="status">
          连接曾中断，部分过程可能未记录
        </p>
      ) : null}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcementFor(percent, timeline.current.label || '等待任务', timeline.terminal)}
      </p>

      <div id={contentId} className="live-viz-body" hidden={!expanded}>
        <StageTimeline stages={timeline.stages} />
        <ChunkProgress
          chunks={timeline.chunks}
          activeKey={timeline.current.key}
          reportReused={reportReused}
        />
        <CurrentStageBar current={timeline.current} errorCode={timeline.errorCode} />
        <LogStream logs={timeline.logs} omitted={timeline.omittedLogs} expanded={expanded} />
        <LiveCounters counts={job.counts} />
      </div>
    </section>
  );
}
