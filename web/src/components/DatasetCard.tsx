import { useState } from 'react';
import type {
  DatasetDetail,
  DatasetReportRef,
  DatasetSummary,
  Report,
  ReportSource,
} from '../types';
import { api, toApiError } from '../lib/api';
import { formatBytes, formatNumber, formatRelativeTime, gameName } from '../lib/format';
import { ReportList } from './ReportList';
import { ConfirmDialog } from './ui';

interface DatasetCardProps {
  dataset: DatasetSummary;
  dataDir: string;
  onUse: (dataset: DatasetSummary) => void;
  onDeleted: () => void;
  onReportLoaded: (report: Report, source: ReportSource) => void;
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

  const isHealthy = dataset.status === 'complete' || dataset.status === 'ok';
  const reports = extractReports(detail);
  const reportCount = dataset.reportCount ?? (Array.isArray(detail?.reports) ? reports.length : 0);

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

  return (
    <div className="dataset-card">
      <div className="dataset-card-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="dataset-game" title={gameName(dataset.game)}>
            {gameName(dataset.game)}
          </div>
          <div className="dataset-meta">
            <span>AppID {dataset.appid}</span>
            <span>{formatNumber(dataset.reviewCount)} 条评论</span>
            <span>{formatNumber(reportCount)} 份报告</span>
            <span>{formatBytes(dataset.bytes)}</span>
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
            将删除「{gameName(dataset.game)}」的评论数据集（
            {formatNumber(dataset.reviewCount)} 条）及其关联报告。此操作不可撤销，但不会影响源码或其他游戏。
          </>
        }
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
