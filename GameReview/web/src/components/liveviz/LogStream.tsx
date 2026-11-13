import { useEffect, useRef, useState } from 'react';
import type { JobLogEntry } from '../../types';
import { MAX_TIMELINE_LOGS } from '../../hooks/useJobTimeline';

interface LogStreamProps {
  logs: JobLogEntry[];
  /** 缓存层已丢弃的较早日志条数（渲染层还会省略最近 200 条之外的缓存）。 */
  omitted: number;
  /** 收起时内容区 hidden，跳过自动滚动。 */
  expanded: boolean;
}

const LEVEL_LABEL: Record<JobLogEntry['level'], string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

/**
 * 等宽日志流：
 * - 位于底部时新日志自动滚到底；
 * - 用户上滑后暂停自动滚动并显示「回到最新」，点击恢复；
 * - 最多渲染最近 200 条，并在顶部提示省略条数；
 * - aria-live="off"，避免屏幕阅读器逐条朗读日志。
 */
export function LogStream({ logs, omitted, expanded }: LogStreamProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  // 缓存最多 500 条，DOM 只渲染最近 200 条。
  const visibleLogs =
    logs.length > MAX_TIMELINE_LOGS ? logs.slice(logs.length - MAX_TIMELINE_LOGS) : logs;
  const omittedTotal = omitted + (logs.length - visibleLogs.length);
  // 缓存满 500 条后每来一条新日志都会丢弃一条旧日志，logs.length 不再变化；
  // 用总条数（缓存条数 + 已丢弃累计）作为依赖，保证后续新日志仍能触发自动滚动。
  const totalCount = logs.length + omitted;

  useEffect(() => {
    if (!expanded || paused) return;
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [totalCount, expanded, paused]);

  const handleScroll = () => {
    const element = bodyRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance > 24) {
      setPaused(true);
    } else if (paused) {
      setPaused(false);
    }
  };

  const jumpToLatest = () => {
    setPaused(false);
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  return (
    <div className="live-viz-block live-log">
      <div className="live-log-head">
        <h4 className="live-viz-block-title">日志流</h4>
        <span className="live-log-count mono-num">
          {visibleLogs.length}
          {omittedTotal > 0 ? ` / ${totalCount}` : ''} 条
        </span>
        <span className="spacer" />
        {paused ? (
          <button type="button" className="btn-link live-log-latest" onClick={jumpToLatest}>
            回到最新
          </button>
        ) : null}
      </div>
      <div
        ref={bodyRef}
        className="live-log-body"
        role="group"
        aria-label="任务日志流"
        aria-live="off"
        tabIndex={0}
        onScroll={handleScroll}
      >
        {omittedTotal > 0 ? (
          <p className="live-log-omitted">已省略较早 {omittedTotal} 条</p>
        ) : null}
        {visibleLogs.length === 0 ? (
          <p className="live-log-empty">等待任务输出…</p>
        ) : (
          visibleLogs.map((entry, index) => (
            <div
              // 有服务端 id 时用 id 作为稳定 key；截断窗口滑动时避免整列表重建。
              key={entry.id ?? `${index}-${entry.at ?? ''}-${entry.message}`}
              className={`live-log-line ${entry.level}`}
            >
              <span className="live-log-level">{LEVEL_LABEL[entry.level] ?? 'INFO'}</span>
              <span className="live-log-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
