import type { LiveStageKey } from '../../lib/stageMap';
import type { TimelineChunks } from '../../hooks/useJobTimeline';

const MAX_RENDERED_CHUNKS = 200;

interface ChunkProgressProps {
  chunks: TimelineChunks;
  /** 当前阶段为 AI map 时，未完成的第一格显示脉冲动效。 */
  activeKey: LiveStageKey | null;
  /** 命中“复用本地报告”时展示说明，不渲染分块格。 */
  reportReused: boolean;
}

/**
 * AI 分块进度：counts.chunks 个格子 + 「已完成 x / 共 y」。
 * 只展示后端明确提供的计数：不补全、不钳制；非法计数显示不可用。
 */
export function ChunkProgress({ chunks, activeKey, reportReused }: ChunkProgressProps) {
  if (reportReused) {
    return (
      <div className="live-viz-block">
        <h4 className="live-viz-block-title">AI 分块进度</h4>
        <p className="live-chunk-empty">本次复用报告，未调用 AI</p>
      </div>
    );
  }

  if (chunks.invalid) {
    return (
      <div className="live-viz-block">
        <h4 className="live-viz-block-title">AI 分块进度</h4>
        <p className="live-chunk-empty">分块进度暂不可用</p>
      </div>
    );
  }

  const total = chunks.total;
  if (total === null || total === 0) {
    return (
      <div className="live-viz-block">
        <h4 className="live-viz-block-title">AI 分块进度</h4>
        <p className="live-chunk-empty">暂无分块数据</p>
      </div>
    );
  }

  // 不钳制 completed：非法值已在状态中标记 invalid，正常值必在 0..total 内。
  const completed = chunks.completed ?? 0;

  const cellCount = Math.min(total, MAX_RENDERED_CHUNKS);
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const done = index < completed;
    const active = !done && index === completed && activeKey === 'ai_map';
    return (
      <span
        key={index}
        className={`live-chunk${done ? ' done' : ''}${active ? ' active' : ''}`}
        data-state={done ? 'done' : active ? 'active' : 'pending'}
      />
    );
  });

  return (
    <div className="live-viz-block">
      <h4 className="live-viz-block-title">AI 分块进度</h4>
      <div className="live-chunks">
        <div className="live-chunk-grid" aria-hidden="true">
          {cells}
        </div>
        <span className="live-chunk-summary mono-num">
          已完成 {completed} / 共 {total}
        </span>
        {total > MAX_RENDERED_CHUNKS ? (
          <span className="live-chunk-empty">仅展示前 {MAX_RENDERED_CHUNKS} 块</span>
        ) : null}
      </div>
    </div>
  );
}
