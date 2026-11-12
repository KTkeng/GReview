import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type {
  DatasetDetail,
  DatasetReportRef,
  DatasetSummary,
  GamePresentation,
  Report,
  ReportSource,
} from '../types';
import { api, toApiError } from '../lib/api';
import { formatBytes, formatNumber, formatRelativeTime } from '../lib/format';
import {
  TITLE_MAX_CODE_POINTS,
  gameTitleInfo,
  normalizeTitle,
  titleCodePointLength,
  validateCustomTitle,
} from '../lib/gameTitle';
import { ReportList } from './ReportList';
import { ConfirmDialog } from './ui';
import { CustomTitleBadge, CoverThumb } from './GameTitle';
import { IconPencil } from './Icon';

interface DatasetCardProps {
  dataset: DatasetSummary;
  dataDir: string;
  onUse: (dataset: DatasetSummary) => void;
  onDeleted: () => void;
  onReportLoaded: (report: Report, source: ReportSource) => void;
  /** 保存成功或冲突刷新时通知父级按 dataDir+appid 更新相关视图。 */
  onTitleSaved?: (game: GamePresentation) => void;
}

function extractReports(detail: DatasetDetail | null): DatasetReportRef[] {
  if (!detail || !Array.isArray(detail.reports)) return [];
  return detail.reports.filter(
    (item): item is DatasetReportRef =>
      Boolean(item) && typeof item === 'object' && typeof item.analysisHash === 'string',
  );
}

export function DatasetCard({
  dataset,
  dataDir,
  onUse,
  onDeleted,
  onReportLoaded,
  onTitleSaved,
}: DatasetCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [openingHash, setOpeningHash] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [conflictGame, setConflictGame] = useState<GamePresentation | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const titleInputId = useId();
  const titleErrorId = useId();

  const title = gameTitleInfo(dataset.game, dataset.appid);
  const isHealthy =
    dataset.status === 'complete' || dataset.status === 'ok' || dataset.status === '完整';
  const reports = extractReports(detail);
  const reportCount = dataset.reportCount ?? (Array.isArray(detail?.reports) ? reports.length : 0);
  const size = dataset.sizeBytes ?? dataset.bytes;
  const expectedRevision = conflictGame?.titleRevision ?? title.titleRevision;

  useEffect(() => {
    if (!savedNotice) return undefined;
    const timer = window.setTimeout(() => setSavedNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  /* 点击编辑器外区域等同取消（保存中不打断请求）。 */
  useEffect(() => {
    if (!editing) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (saving) return;
      const target = event.target as Node | null;
      if (target && editorRef.current?.contains(target)) return;
      setEditing(false);
      setDraft('');
      setEditorError(null);
      setConflictGame(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [editing, saving]);

  const beginEdit = () => {
    if (!title.titleEditable) return;
    setDraft(title.customTitle ?? '');
    setEditorError(null);
    setConflictGame(null);
    setEditing(true);
  };

  const cancelEdit = useCallback(() => {
    if (saving) return;
    setEditing(false);
    setDraft('');
    setEditorError(null);
    setConflictGame(null);
  }, [saving]);

  const submitTitle = useCallback(
    async (customTitle: string | null) => {
      setSaving(true);
      setEditorError(null);
      try {
        const result = await api.updateDatasetTitle(
          dataset.appid,
          { customTitle, expectedRevision },
          dataDir || undefined,
        );
        setSaving(false);
        setEditing(false);
        setDraft('');
        setConflictGame(null);
        setSavedNotice('已保存');
        onTitleSaved?.(result.game);
      } catch (caught) {
        const apiError = toApiError(caught);
        setSaving(false);
        if (apiError.currentGame) {
          // 409 冲突：刷新展示数据，但保留用户草稿，绝不自动覆盖。
          setConflictGame(apiError.currentGame);
          onTitleSaved?.(apiError.currentGame);
          const latest = gameTitleInfo(apiError.currentGame, dataset.appid).displayTitle;
          setEditorError(
            `标题版本冲突：最新标题为「${latest}」。已展示最新版本，你的草稿未改动，请确认后再次保存。`,
          );
        } else if (apiError.status === 409) {
          setEditorError(`标题文件损坏，暂时无法修改：${apiError.message}`);
        } else {
          setEditorError(`${apiError.code}: ${apiError.message}`);
        }
      }
    },
    [dataDir, dataset.appid, expectedRevision, onTitleSaved],
  );

  const handleSave = () => {
    if (saving) return;
    const validation = validateCustomTitle(draft);
    if (!validation.ok) {
      setEditorError(validation.error);
      return;
    }
    if (title.customTitle === validation.value) {
      cancelEdit();
      return;
    }
    void submitTitle(validation.value);
  };

  const handleRestoreDefault = () => {
    if (saving || !title.customTitle) return;
    void submitTitle(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  };

  const handleToggleReports = async () => {
    if (reportsOpen) {
      setReportsOpen(false);
      return;
    }
    setReportsOpen(true);
    setOpenError(null);
    if (detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await api.getDatasetDetail(
        dataset.appid,
        dataset.reviewsHash,
        dataDir || undefined,
      );
      setDetail(result);
    } catch (error) {
      setDetailError(toApiError(error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleOpenReport = async (analysisHash: string) => {
    setOpeningHash(analysisHash);
    setOpenError(null);
    try {
      const report = await api.getSavedReport(
        dataset.appid,
        analysisHash,
        dataDir || undefined,
        50,
      );
      // 带上 analysisHash，报告表格展开时可再次从数据集重建 Top N。
      onReportLoaded(report, {
        appid: dataset.appid,
        analysisHash,
        dataDir: dataDir || undefined,
      });
    } catch (error) {
      const apiError = toApiError(error);
      setOpenError(`${apiError.code}: ${apiError.message}`);
    } finally {
      setOpeningHash(null);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteDataset(dataset.appid, dataset.reviewsHash, dataDir || undefined);
      setConfirmOpen(false);
      onDeleted();
    } catch (error) {
      const apiError = toApiError(error);
      setDeleteError(`${apiError.code}: ${apiError.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const titleTooltip =
    title.isCustom && title.steamName ? `Steam 原名：${title.steamName}` : title.displayTitle;

  return (
    <div className="dataset-card">
      <div className="dataset-card-head">
        <CoverThumb game={dataset.game} appid={dataset.appid} />
        <div className="dataset-card-body">
          {editing ? (
            <div
              className="dataset-title-editor"
              ref={editorRef}
              role="group"
              aria-label="编辑游戏标题"
              aria-busy={saving}
            >
              <label className="sr-only" htmlFor={titleInputId}>
                游戏标题
              </label>
              <input
                id={titleInputId}
                ref={inputRef}
                className="input dataset-title-input"
                value={draft}
                placeholder={title.steamName ?? title.coverPlaceholder}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (editorError) setEditorError(null);
                }}
                onKeyDown={handleKeyDown}
                disabled={saving}
                aria-invalid={Boolean(editorError)}
                aria-describedby={editorError ? titleErrorId : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="dataset-title-editor-foot">
                <span className="dataset-title-count" aria-live="polite">
                  {titleCodePointLength(normalizeTitle(draft))}/{TITLE_MAX_CODE_POINTS}
                </span>
                <div className="dataset-title-editor-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? <span className="spinner" aria-hidden="true" /> : null}
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={saving}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={handleRestoreDefault}
                    disabled={saving || !title.customTitle}
                    title="清除自定义标题，回退到 Steam 原名或 AppID"
                  >
                    恢复默认
                  </button>
                </div>
              </div>
              <p className="field-hint">
                此标题按当前数据目录与 AppID 生效，同一游戏的数据集与报告会同步更新。
              </p>
              {editorError ? (
                <p id={titleErrorId} className="field-error dataset-title-error" role="alert">
                  {editorError}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="dataset-title-line">
              <span className="dataset-game" title={titleTooltip}>
                {title.displayTitle}
              </span>
              {title.isCustom ? <CustomTitleBadge /> : null}
              <button
                type="button"
                className="btn btn-icon dataset-title-edit"
                aria-label="编辑游戏标题"
                title={
                  title.titleEditable
                    ? '编辑游戏标题'
                    : '标题文件损坏，暂时无法编辑'
                }
                onClick={beginEdit}
                disabled={!title.titleEditable}
              >
                <IconPencil size={14} />
              </button>
              {savedNotice ? (
                <span className="dataset-title-saved" role="status">
                  {savedNotice}
                </span>
              ) : null}
            </div>
          )}

          {title.isCustom ? (
            <div className="dataset-title-hint">Steam 原名：{title.steamName ?? '未获取'}</div>
          ) : null}
          {title.warnings.map((warning, index) => (
            <div className="dataset-title-warning" role="status" key={`${warning}-${index}`}>
              {warning}
            </div>
          ))}

          <div className="dataset-meta">
            <span>AppID {dataset.appid}</span>
            <span>{formatNumber(dataset.reviewCount)} 条评论</span>
            <span>{formatNumber(reportCount)} 份报告</span>
            <span>{formatBytes(size)}</span>
          </div>
          <div className="dataset-meta">
            <span>抓取于 {formatRelativeTime(dataset.fetchedAt)}</span>
            {dataset.trendCoverage?.start && dataset.trendCoverage?.end ? (
              <span>
                趋势 {dataset.trendCoverage.start} ~ {dataset.trendCoverage.end}
              </span>
            ) : null}
            {!isHealthy ? <span className="corrupt">数据异常（{dataset.status}），不可复用</span> : null}
          </div>
        </div>
      </div>
      <div className="dataset-actions">
        <button type="button" className="btn btn-sm" onClick={() => onUse(dataset)}>
          填入配置
        </button>
        {reportCount > 0 ? (
          <button type="button" className="btn btn-sm" onClick={handleToggleReports}>
            {reportsOpen ? '收起报告' : '查看报告'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            setDeleteError(null);
            setConfirmOpen(true);
          }}
        >
          删除
        </button>
      </div>

      {reportsOpen ? (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          {detailLoading ? (
            <div className="loading-row">
              <span className="spinner" aria-hidden="true" />
              读取数据集详情…
            </div>
          ) : null}
          {detailError ? (
            <p className="field-error" role="alert">
              {detailError}
            </p>
          ) : null}
          {detail && Array.isArray(detail.reports) ? (
            <ReportList
              reports={reports}
              openingHash={openingHash}
              error={openError}
              onOpen={handleOpenReport}
            />
          ) : null}
          {detail && !Array.isArray(detail.reports) ? (
            <p className="field-hint">
              报告数量：{formatNumber(Number(detail.reports) || reportCount)}（接口未返回报告列表）
            </p>
          ) : null}
          {detail && Array.isArray(detail.reports) && reports.length === 0 ? (
            <p className="field-hint">该数据集暂无已保存报告。</p>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="删除本地数据集"
        danger
        confirmLabel="删除"
        busy={deleting}
        error={deleteError}
        description={
          <>
            将删除「{title.displayTitle}」的评论数据集（{formatNumber(dataset.reviewCount)}{' '}
            条）及其关联报告。此操作不可撤销，但不会影响源码或其他游戏。
          </>
        }
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
