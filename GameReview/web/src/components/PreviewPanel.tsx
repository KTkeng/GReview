import type { GameMeta, PreviewResult, PreviewState } from '../types';
import {
  estimateFallback,
  gameDevelopers,
  gameGenres,
  gameHeaderImage,
  gamePublishers,
  gameReleaseDate,
  getMatchingTotal,
  getReuseInfo,
} from '../lib/preview';
import {
  formatCostUsd,
  formatNumber,
  formatPercent,
  formatSeconds,
  gameName,
} from '../lib/format';
import { ErrorBanner, InlineNotice } from './ui';
import { IconPlay, IconRefresh } from './Icon';

interface PreviewPanelProps {
  preview: PreviewState;
  game: GameMeta | null;
  appid: number | null;
  maxReviews: number;
  trendMonths: number;
  canStart: boolean;
  startDisabledReason: string | null;
  onRetry: () => void;
  onStart: () => void;
  onAdjustFilters: () => void;
}

function PreviewSkeleton() {
  return (
    <section className="preview-panel" aria-live="polite" aria-busy="true">
      <div className="empty-state">
        <span className="spinner large" aria-hidden="true" />
        <h2>正在查询 Steam 聚合数据</h2>
        <p>
          预览只调用一次官方聚合查询（num_per_page=1），不会抓取全量评论。若命中本地可复用数据，将直接读取本地。
        </p>
      </div>
    </section>
  );
}

function GameCard({ game, appid }: { game: GameMeta | null; appid: number | null }) {
  const image = gameHeaderImage(game);
  const developers = gameDevelopers(game);
  const publishers = gamePublishers(game);
  const genres = gameGenres(game);
  const release = gameReleaseDate(game);

  return (
    <article className="game-card">
      <div className="game-card-media">
        {image ? (
          <img src={image} alt={`${gameName(game)} 头图`} referrerPolicy="no-referrer" />
        ) : (
          <span className="placeholder" aria-hidden="true">
            APP
          </span>
        )}
      </div>
      <div className="game-card-body">
        <h2 className="game-card-title">{gameName(game)}</h2>
        <div className="game-card-meta">
          <span className="mono-num">AppID {appid ?? game?.appid ?? '—'}</span>
          {release ? <span>发行 {release}</span> : null}
          {developers.length > 0 ? <span>开发 {developers.join(' / ')}</span> : null}
          {publishers.length > 0 ? <span>发行商 {publishers.join(' / ')}</span> : null}
        </div>
        {genres.length > 0 ? (
          <div className="game-card-meta">
            {genres.map((genre) => (
              <span className="badge" key={genre}>
                {genre}
              </span>
            ))}
          </div>
        ) : null}
        {typeof (game?.shortDescription ?? game?.short_description) === 'string' ? (
          <p className="game-card-desc">{game?.shortDescription ?? game?.short_description}</p>
        ) : null}
      </div>
    </article>
  );
}

function estimateFor(result: PreviewResult, matching: number, maxReviews: number, trendMonths: number) {
  const fallback = estimateFallback(matching, maxReviews, trendMonths);
  const estimate = result.estimate ?? {};
  return {
    pages: estimate.pages ?? fallback.pages,
    seconds: estimate.seconds ?? fallback.seconds,
    trendRequests: estimate.trendRequests ?? fallback.trendRequests,
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    chunks: estimate.chunks,
    costUsd: estimate.costUsd,
  };
}

export function PreviewPanel({
  preview,
  game,
  appid,
  maxReviews,
  trendMonths,
  canStart,
  startDisabledReason,
  onRetry,
  onStart,
  onAdjustFilters,
}: PreviewPanelProps) {
  if (preview.status === 'loading') return <PreviewSkeleton />;

  if (preview.status === 'error') {
    const error = preview.error;
    return (
      <section className="preview-panel">
        <ErrorBanner
          title="预览失败"
          code={error?.code}
          message={
            error?.message === '链接或 AppID 无效' || error?.code === 'INVALID_URL'
              ? '链接或 AppID 无效'
              : error?.message ?? 'Steam 请求失败，请稍后重试'
          }
          detail={error?.detail}
          action={
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                <IconRefresh size={14} />
                重试
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={onAdjustFilters}>
                放宽筛选条件
              </button>
            </div>
          }
        />
        <div className="notice" style={{ marginTop: 12 }}>
          <span className="notice-icon" aria-hidden="true">
            i
          </span>
          <div>
            Steam 匿名接口有频率限制。若遇到 STEAM_RATE_LIMITED，请等待约 10 分钟再试；若为
            STEAM_UNAVAILABLE，请检查网络或稍后重试。
          </div>
        </div>
      </section>
    );
  }

  if (preview.status !== 'success' && preview.status !== 'no_match') {
    return null;
  }

  // 后端对 0 匹配返回 HTTP 422（F3），此时没有 result，但语义仍是“无匹配”。
  if (preview.status === 'no_match' && !preview.result) {
    return (
      <section className="preview-panel" aria-live="polite">
        <InlineNotice tone="warning">
          {preview.error?.message || '无匹配评论，请放宽筛选条件'}
        </InlineNotice>
        <div className="preview-actions">
          <button type="button" className="btn btn-primary" disabled>
            开始分析
          </button>
          <button type="button" className="btn btn-secondary" onClick={onAdjustFilters}>
            放宽筛选条件
          </button>
          <button type="button" className="btn btn-ghost" onClick={onRetry}>
            重新预览
          </button>
        </div>
      </section>
    );
  }

  const result = preview.result;
  if (!result) return null;
  const summary = result.summary;
  const matching = getMatchingTotal(result);
  const total = summary?.total ?? 0;
  const positive = summary?.positive ?? 0;
  const negative = summary?.negative ?? 0;
  const positiveRate = summary?.positiveRate ?? 0;
  const rate = Math.max(0, Math.min(100, positiveRate <= 1 ? positiveRate * 100 : positiveRate));
  const estimate = estimateFor(result, matching, maxReviews, trendMonths);
  const reuse = getReuseInfo(result);
  const noMatch = preview.status === 'no_match' || matching <= 0;
  const clientNotice =
    result.clientFilterNotice ??
    '预览匹配数为 Steam 侧聚合结果，未计入最低赞数、关键词、最短字数、排除抢先体验/免费获得等客户端二次筛选条件。';

  return (
    <section className="preview-panel" aria-live="polite">
      <div className="preview-hero">
        <GameCard game={result.game ?? game} appid={result.appid ?? appid} />
        <div className="score-card">
          <div className="score-label">Steam 全部时间好评率</div>
          <div className="score-big">{formatPercent(positiveRate)}</div>
          <div className="score-bar" role="img" aria-label={`好评率 ${formatPercent(positiveRate)}`}>
            <span className="positive" style={{ width: `${rate}%` }} />
          </div>
          <div className="score-label">
            {summary?.reviewScoreDesc || '评分描述未知'} · 共 {formatNumber(total)} 条评论
          </div>
          <div className="small dim">
            好评 {formatNumber(positive)} · 差评 {formatNumber(negative)}
          </div>
        </div>
      </div>

      <div className="metric-grid">
        <div className="metric">
          <div className="metric-value">{formatNumber(total)}</div>
          <div className="metric-label">总评论数（Steam 全量）</div>
        </div>
        <div className="metric">
          <div className={`metric-value ${matching > 0 ? 'accent' : 'positive'}`}>
            {formatNumber(matching)}
          </div>
          <div className="metric-label">Steam 侧匹配数</div>
        </div>
        <div className="metric">
          <div className="metric-value">{formatNumber(estimate.pages)}</div>
          <div className="metric-label">预估页数（100 条/页）</div>
        </div>
        <div className="metric">
          <div className="metric-value">{formatSeconds(estimate.seconds)}</div>
          <div className="metric-label">预估耗时（不含 AI）</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">成本估算</div>
        <div className="estimate-grid">
          <div className="estimate-item">
            <strong>{formatNumber(estimate.chunks)}</strong>
            AI 分块数
          </div>
          <div className="estimate-item">
            <strong>{formatNumber(estimate.trendRequests)}</strong>
            趋势请求数
          </div>
          <div className="estimate-item">
            <strong>{formatNumber(estimate.inputTokens)}</strong>
            预计输入 token
          </div>
          <div className="estimate-item">
            <strong>{formatNumber(estimate.outputTokens)}</strong>
            预计输出 token
          </div>
          <div className="estimate-item">
            <strong>{formatCostUsd(estimate.costUsd)}</strong>
            预计费用（估算）
          </div>
        </div>
        <p className="field-hint" style={{ marginTop: 10 }}>
          耗时为本地保守估算；AI 实际耗时与费用取决于模型、样本量与思考模式。当前抓取上限{' '}
          {formatNumber(maxReviews)} 条，趋势 {trendMonths} 个月。
        </p>
      </div>

      <div className="notice">
        <span className="notice-icon" aria-hidden="true">
          i
        </span>
        <div>{clientNotice}</div>
      </div>

      {reuse.dataset || reuse.report || reuse.historicalReport ? (
        <div className="reuse-prompt">
          <div className="reuse-prompt-title">
            <span aria-hidden="true">●</span>
            本地数据与报告
          </div>
          {reuse.dataset ? (
            <div>
              本地数据：{formatNumber(reuse.dataset.reviewCount)} 条，抓取于{' '}
              {new Date(reuse.dataset.fetchedAt).toLocaleString('zh-CN')} —— 默认复用，不请求 Steam。
            </div>
          ) : null}
          {reuse.report ? (
            <div>本地报告：使用后本次不消耗 token（可在左侧关闭复用或点击「重新分析」）。</div>
          ) : null}
          {reuse.historicalReport ? (
            <div>
              历史报告：生成于{' '}
              {new Date(reuse.historicalReport.generatedAt).toLocaleString('zh-CN')}
              {reuse.historicalReport.model ? `，模型 ${reuse.historicalReport.model}` : ''}
              —— 与当前数据集/模型/提示词/思考模式不一致，不会复用，开始分析会重新调用 AI 并消耗 token。
            </div>
          ) : null}
        </div>
      ) : null}

      {noMatch ? (
        <InlineNotice tone="warning">无匹配评论，请放宽筛选条件</InlineNotice>
      ) : null}

      <div className="preview-actions">
        <button type="button" className="btn btn-primary" onClick={onStart} disabled={!canStart || noMatch}>
          <IconPlay size={14} />
          开始分析
        </button>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          重新预览
        </button>
        {!canStart && startDisabledReason ? (
          <span className="field-hint" role="status">
            {startDisabledReason}
          </span>
        ) : (
          <span className="field-hint">开始后可随时取消；已抓取的数据会保留供下次复用。</span>
        )}
      </div>
    </section>
  );
}
