import { useEffect, useRef, useState } from 'react';
import type { JobState } from '../types';
import { canonicalStage, STAGE_LABELS, STAGE_SEQUENCE } from '../lib/defaults';
import { formatNumber } from '../lib/format';
import { ErrorBanner, InlineNotice } from './ui';
import { IconStop } from './Icon';

interface ProgressPanelProps {
  job: JobState;
  onCancel: () => void;
  onRetry: () => void;
  onAdjustFilters: () => void;
  /** 可选：提供“清除 Steam 短期缓存”操作（STEAM_* 错误时显示）。 */
  onClearCache?: () => void;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value > 0 && value < 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

function stageIndex(stage: string | undefined): number {
  const canonical = canonicalStage(stage);
  if (!canonical) return -1;
  if (canonical === 'done' || canonical === 'completed') return STAGE_SEQUENCE.length;
  return STAGE_SEQUENCE.findIndex((item) => item.key === canonical);
}

function stageDetail(stage: string | undefined, job: JobState): string | null {
  const canonical = canonicalStage(stage);
  const counts = job.counts ?? {};
  if (canonical === 'fetching_reviews') {
    const fetched = typeof counts.fetched === 'number' ? counts.fetched : undefined;
    const target = typeof counts.target === 'number' ? counts.target : undefined;
    if (fetched !== undefined || target !== undefined) {
      return `已抓取 ${formatNumber(fetched ?? 0)} / ${formatNumber(target ?? 0)} 条`;
    }
  }
  if (canonical === 'fetching_trend') {
    return '查询 Steam 官方月度聚合';
  }
  if (canonical === 'ai_analyzing') {
    const totalChunks = counts.chunks ?? counts.totalChunks;
    const completed = counts.completed ?? counts.chunk ?? counts.currentChunk;
    if (typeof totalChunks === 'number') {
      if (typeof completed === 'number') {
        return `分块 ${formatNumber(Math.min(completed + 1, totalChunks))} / ${formatNumber(totalChunks)}`;
      }
      return `共 ${formatNumber(totalChunks)} 块`;
    }
    return job.message ?? null;
  }
  if (canonical === 'generating_report') {
    return '校验证据并生成报告';
  }
  return null;
}

function errorHint(code: string | undefined): string | null {
  if (!code) return null;
  const hints: Record<string, string> = {
    INVALID_AI_KEY: 'API Key 无效或无权限。请在左侧检查 Key 是否正确，或更换 Key 后重试。',
    AI_RATE_LIMITED: 'DeepSeek 请求限流，请等待约 1 分钟后重试。',
    AI_TIMEOUT: 'AI 请求超时。可缩小抓取上限、关闭深度思考或更换模型后重试。',
    AI_INVALID_RESPONSE:
      'AI 返回数据无法解析或证据未通过校验，建议缩小样本或换模型重试。原有数据与报告不会受本次失败影响。',
    AI_CONTEXT_TOO_LARGE:
      '样本超出模型上下文。请降低抓取数量上限、减少语言或缩短趋势范围后重试。',
    STEAM_RATE_LIMITED:
      'Steam 请求过于频繁。请等待约 10 分钟后重试；GReview 已内置退避与短期缓存，也可在「本地数据」面板清除短期缓存。',
    STEAM_UNAVAILABLE:
      'Steam 暂时不可用（超时或 5xx）。请稍后重试；若持续失败，可清除短期缓存后重试。',
    STEAM_ENDPOINT_CHANGED:
      'Steam 接口结构发生变化或暂时异常。请确认版本并为项目提交 issue。',
    NO_REVIEWS: '筛选后没有评论。请放宽时间范围、语言、关键词或游玩时长限制。',
    JOB_LIMIT: '同时运行的分析任务过多（最多 2 个），请等待当前任务结束后再试。',
    JOB_NOT_FOUND: '任务不存在或已过期清理，请重新开始分析。',
    INTERNAL: '服务端发生未预期错误。可重试；若持续失败请查看日志。',
  };
  return hints[code] ?? null;
}

export function ProgressPanel({
  job,
  onCancel,
  onRetry,
  onAdjustFilters,
  onClearCache,
}: ProgressPanelProps) {
  const [logsOpen, setLogsOpen] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const cancelled = job.cancelled || job.status === 'cancelled';
  const failed = job.status === 'failed' || Boolean(job.error);
  const progress = clampProgress(job.progress);
  const currentIndex = stageIndex(job.stage);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.logs.length, logsOpen]);

  if (cancelled) {
    return (
      <section className="progress-panel" aria-live="polite">
        <div className="cancelled-state">
          <span className="badge badge-warning">已取消</span>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>任务已取消</h2>
          <p className="muted small">
            已完成的抓取与缓存会保留在本地数据目录，下次同条件分析可复用，不会重复请求 Steam。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={onRetry}>
              重新开始分析
            </button>
            <button type="button" className="btn btn-ghost" onClick={onAdjustFilters}>
              调整配置
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (failed) {
    const hint = errorHint(job.error?.code);
    const cacheRelated =
      job.error?.code === 'STEAM_UNAVAILABLE' || job.error?.code === 'STEAM_RATE_LIMITED';
    return (
      <section className="progress-panel">
        <ErrorBanner
          title="分析失败"
          code={job.error?.code ?? 'ERROR'}
          message={job.error?.message ?? '任务执行失败，请重试'}
          detail={job.error?.detail}
          action={
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                重试
              </button>
              {cacheRelated && onClearCache ? (
                <button type="button" className="btn btn-sm" onClick={onClearCache}>
                  清除 Steam 短期缓存
                </button>
              ) : null}
              <button type="button" className="btn btn-sm btn-ghost" onClick={onAdjustFilters}>
                调整筛选或模型
              </button>
            </div>
          }
        />
        {hint ? (
          <div style={{ marginTop: 12 }}>
            <InlineNotice tone="warning">{hint}</InlineNotice>
          </div>
        ) : null}
      </section>
    );
  }

  const percentText = `${progress.toFixed(0)}%`;

  return (
    <section className="progress-panel" aria-live="polite" aria-busy="true">
      <div className="progress-head">
        <div>
          <h2>正在分析</h2>
          <p className="small muted" aria-live="polite">
            {STAGE_LABELS[job.stage ?? 'queued'] ?? job.stage ?? '排队中'}
            {job.message ? ` · ${job.message}` : ''}
          </p>
        </div>
        <div className="progress-percent mono-num" aria-label={`总进度 ${percentText}`}>
          {percentText}
        </div>
      </div>

      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-label="分析总进度"
      >
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="stage-list" aria-label="分析阶段">
        {STAGE_SEQUENCE.map((stage, index) => {
          const isDone = currentIndex > index;
          const isCurrent = currentIndex === index && !isDone;
          const className = `stage-item${isDone ? ' done' : ''}${isCurrent ? ' current' : ''}`;
          const detail = isCurrent ? stageDetail(stage.key, job) : null;
          return (
            <div key={stage.key} className={className}>
              <span className="stage-dot" aria-hidden="true">
                {isDone ? '✓' : isCurrent ? '●' : index + 1}
              </span>
              <span>{stage.label}</span>
              {detail ? <span className="stage-detail">{detail}</span> : null}
              {isCurrent ? <span className="stage-detail">进行中</span> : null}
            </div>
          );
        })}
      </div>

      <div className="progress-meta">
        {typeof job.counts?.fetched === 'number' ? (
          <span>
            已抓取 <span className="mono-num">{formatNumber(job.counts.fetched)}</span> 条
          </span>
        ) : null}
        {typeof job.counts?.target === 'number' ? (
          <span>
            目标 <span className="mono-num">{formatNumber(job.counts.target)}</span> 条
          </span>
        ) : null}
        {typeof job.counts?.matchingTotal === 'number' ? (
          <span>
            Steam 匹配 <span className="mono-num">{formatNumber(job.counts.matchingTotal)}</span> 条
          </span>
        ) : null}
        {job.jobId ? <span className="dim mono" style={{ fontSize: 11 }}>任务 {job.jobId}</span> : null}
      </div>

      <div className="log-viewer">
        <div className="log-viewer-head">
          <span>实时日志</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn-link"
            onClick={() => setLogsOpen((prev) => !prev)}
            aria-expanded={logsOpen}
          >
            {logsOpen ? '收起' : '展开'}
          </button>
        </div>
        {logsOpen ? (
          <pre ref={logRef} aria-label="任务日志">
            {job.logs.length === 0
              ? '等待日志…'
              : job.logs.map((entry, index) => (
                  <span key={`${index}-${entry.message}`} className={`log-line ${entry.level}`}>
                    {entry.at ? `[${new Date(entry.at).toLocaleTimeString('zh-CN')}] ` : ''}
                    {entry.level ? `${entry.level.toUpperCase()} ` : ''}
                    {entry.message}
                  </span>
                ))}
          </pre>
        ) : null}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-danger"
          onClick={onCancel}
          disabled={job.cancelRequested}
        >
          {job.cancelRequested ? <span className="spinner" aria-hidden="true" /> : <IconStop size={14} />}
          {job.cancelRequested ? '取消中…' : '取消'}
        </button>
      </div>
    </section>
  );
}
