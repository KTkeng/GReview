import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatasetSummary, GamePresentation, Report, ReportSource } from '../types';
import { api, toApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatNumber } from '../lib/format';
import { gameTitleInfo, toGamePresentation } from '../lib/gameTitle';
import { DatasetCard } from './DatasetCard';
import { ConfirmDialog, ErrorBanner, InlineNotice } from './ui';

/** 目录比较键：统一分隔符并去掉末尾斜杠；大小写保持原样以兼容大小写敏感系统。 */
function normalizeDataDirForCompare(value: string): string {
  return value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

interface LocalDataPanelProps {
  dataDir: string;
  refreshKey: number;
  onUseDataset: (dataset: DatasetSummary) => void;
  onOpenReport: (report: Report, source: ReportSource) => void;
  onChanged?: () => void;
  /** 标题保存成功或冲突刷新后通知 App，按 dataDir+appid 更新复用提示与报告头部。 */
  onTitleUpdated?: (game: GamePresentation) => void;
}

export function LocalDataPanel({
  dataDir,
  refreshKey,
  onUseDataset,
  onOpenReport,
  onChanged,
  onTitleUpdated,
}: LocalDataPanelProps) {
  const [resolvedDir, setResolvedDir] = useState<string>('');
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [reloadToken, setReloadToken] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);

  /**
   * 已确认的最新标题（按 dataDir + AppID）。标题按数据目录隔离，异步列表响应
   * 或保存响应晚到时，只要 titleRevision 更旧就不得覆盖较新的标题。
   */
  const latestGamesRef = useRef(new Map<string, GamePresentation>());
  const dataDirRef = useRef(dataDir);

  useEffect(() => {
    dataDirRef.current = dataDir;
  }, [dataDir]);

  const gameCacheKey = useCallback(
    (appid: number) => `${normalizeDataDirForCompare(dataDir || '')}|${appid}`,
    [dataDir],
  );

  const rememberGame = useCallback((game: GamePresentation) => {
    if (!game || !Number.isFinite(game.appid) || game.appid <= 0) return;
    const key = gameCacheKey(game.appid);
    const existing = latestGamesRef.current.get(key);
    if (
      !existing ||
      gameTitleInfo(game, game.appid).titleRevision >=
        gameTitleInfo(existing, game.appid).titleRevision
    ) {
      latestGamesRef.current.set(key, game);
    }
  }, [gameCacheKey]);

  const mergeLatestGame = useCallback((dataset: DatasetSummary): DatasetSummary => {
    const latest = latestGamesRef.current.get(gameCacheKey(dataset.appid));
    if (!latest) return dataset;
    const incomingRevision = gameTitleInfo(dataset.game, dataset.appid).titleRevision;
    const latestRevision = gameTitleInfo(latest, dataset.appid).titleRevision;
    return latestRevision > incomingRevision ? { ...dataset, game: latest } : dataset;
  }, [gameCacheKey]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listDatasets(dataDir || undefined, signal);
        const datasets = Array.isArray(result.datasets) ? result.datasets : [];
        for (const dataset of datasets) {
          rememberGame(toGamePresentation(dataset.game, dataset.appid));
        }
        setResolvedDir(result.dataDir ?? '');
        setDatasets(datasets.map(mergeLatestGame));
        setLoadedOnce(true);
      } catch (caught) {
        if ((caught as { name?: string }).name === 'AbortError') return;
        const apiError = toApiError(caught);
        setError(`${apiError.code}: ${apiError.message}`);
      } finally {
        setLoading(false);
      }
    },
    [dataDir, mergeLatestGame, rememberGame],
  );

  const handleTitleSaved = useCallback(
    (game: GamePresentation) => {
      // 保存请求可能跨越数据目录切换：旧目录的迟到响应不得写入当前目录的列表。
      if (
        normalizeDataDirForCompare(dataDir || '') !==
        normalizeDataDirForCompare(dataDirRef.current || '')
      ) {
        return;
      }
      const key = gameCacheKey(game.appid);
      const existing = latestGamesRef.current.get(key);
      if (
        existing &&
        gameTitleInfo(existing, game.appid).titleRevision >
          gameTitleInfo(game, game.appid).titleRevision
      ) {
        // 迟到的旧响应：保留已展示的新标题。
        return;
      }
      rememberGame(game);
      setDatasets((previous) =>
        previous.map((dataset) =>
          dataset.appid === game.appid ? { ...dataset, game } : dataset,
        ),
      );
      onTitleUpdated?.(game);
    },
    [dataDir, gameCacheKey, onTitleUpdated, rememberGame],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey, reloadToken]);

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const displayPath = resolvedDir || dataDir || '默认目录（工程根 ./data）';

  const handleCopy = async () => {
    const target = resolvedDir || dataDir;
    if (!target) {
      setCopyState('fail');
      return;
    }
    const ok = await copyText(target);
    setCopyState(ok ? 'ok' : 'fail');
  };

  const handleDelete = () => {
    setMessage('已删除数据集及其关联报告。');
    setReloadToken((value) => value + 1);
    onChanged?.();
  };

  const handleClear = async () => {
    setClearing(true);
    setClearError(null);
    try {
      await api.clearData(dataDir || undefined);
      setClearOpen(false);
      setMessage('已清空全部数据。');
      setDatasets([]);
      setReloadToken((value) => value + 1);
      onChanged?.();
    } catch (caught) {
      const apiError = toApiError(caught);
      setClearError(`${apiError.code}: ${apiError.message}`);
    } finally {
      setClearing(false);
    }
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    setCacheError(null);
    try {
      await api.clearCache();
      setMessage('已清除 Steam 短期请求缓存（不影响本地数据集与报告）。');
    } catch (caught) {
      const apiError = toApiError(caught);
      setCacheError(`${apiError.code}: ${apiError.message}`);
    } finally {
      setClearingCache(false);
    }
  };

  return (
    <div>
      <div className="data-dir-box">
        <div className="data-dir-label">当前数据目录</div>
        <div className="data-dir-path" title={displayPath}>
          {displayPath}
        </div>
        <div className="data-dir-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleCopy}
            disabled={!resolvedDir && !dataDir}
          >
            {copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制路径'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新列表'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void handleClearCache()}
            disabled={clearingCache}
            title="仅清理 server/.cache/steam 下的短期请求缓存，不影响数据集与报告"
          >
            {clearingCache ? '清除中…' : '清除 Steam 短期缓存'}
          </button>
        </div>
      </div>

      {message ? (
        <div style={{ marginTop: 8 }}>
          <InlineNotice tone="success">{message}</InlineNotice>
        </div>
      ) : null}

      {cacheError ? (
        <p className="field-error" role="alert" style={{ marginTop: 8 }}>
          清除短期缓存失败：{cacheError}
        </p>
      ) : null}

      <div className="section-heading" style={{ marginTop: 12, marginBottom: 8 }}>
        <h3 style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
          本地数据集（{formatNumber(datasets.length)}）
        </h3>
      </div>

      {error ? (
        <ErrorBanner
          code={error.split(':')[0]}
          message={error.slice(error.indexOf(':') + 1).trim() || error}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              重试
            </button>
          }
        />
      ) : null}

      {!error && loading && !loadedOnce ? (
        <div className="loading-row">
          <span className="spinner" aria-hidden="true" />
          读取本地数据集…
        </div>
      ) : null}

      {!error && loadedOnce && datasets.length === 0 && !loading ? (
        <p className="field-hint" style={{ padding: '8px 0' }}>
          还没有本地数据。完成一次分析后，评论数据集与报告会自动保存到上述目录。
        </p>
      ) : null}

      {datasets.length > 0 ? (
        <div className="dataset-list">
          {datasets.map((dataset) => (
            <DatasetCard
              key={`${dataDir}|${dataset.appid}-${dataset.reviewsHash}`}
              dataset={dataset}
              dataDir={dataDir}
              onUse={onUseDataset}
              onDeleted={handleDelete}
              onReportLoaded={onOpenReport}
              onTitleSaved={handleTitleSaved}
            />
          ))}
        </div>
      ) : null}

      <div className="data-panel-footer">
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={datasets.length === 0 || loading}
          onClick={() => {
            setClearError(null);
            setClearOpen(true);
          }}
        >
          清空全部数据
        </button>
        <span className="field-hint">仅清空数据目录，不影响源码与其他游戏数据。</span>
      </div>

      <ConfirmDialog
        open={clearOpen}
        title="清空全部本地数据"
        danger
        confirmLabel="清空全部"
        requireText="确认"
        inputLabel="输入「确认」以清空全部数据集与报告"
        busy={clearing}
        error={clearError}
        description={
          <>
            将删除数据目录 <span className="mono">{displayPath}</span> 下的全部数据集、趋势与报告。
            此操作不可撤销。如需保留，请先备份该目录。
          </>
        }
        onCancel={() => setClearOpen(false)}
        onConfirm={handleClear}
      />
    </div>
  );
}
