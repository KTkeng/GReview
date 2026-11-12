import { useEffect, useRef, useState } from 'react';
import type { Report } from '../types';
import { gameTitleInfo } from '../lib/gameTitle';
import {
  ANALYSIS_SOURCE_LABELS,
  CONFIDENCE_LABELS,
  DATA_SOURCE_LABELS,
  PURCHASE_LABELS,
  REVIEW_TYPE_LABELS,
  SORT_LABELS,
  TREND_SOURCE_LABELS,
  formatDateTime,
  formatLanguages,
  formatNumber,
  formatPercent,
  formatUnixDate,
} from '../lib/format';
import { IconChevronDown } from './Icon';

interface MethodologyCollapseProps {
  report: Report;
}

export function MethodologyCollapse({ report }: MethodologyCollapseProps) {
  const [open, setOpen] = useState(false);
  const previousOpen = useRef(false);
  const sample = report.sample;
  const methodology = report.methodology;
  const isLocalReport = methodology?.analysisSource === 'local_report';
  const tokenUsage = sample?.tokenUsage;
  const filters = sample?.filters;
  const timezone = (report.trend as { timezone?: string } | undefined)?.timezone;
  const title = gameTitleInfo(report.game, report.game?.appid);

  // 打印时自动展开方法论，打印结束后恢复原状态
  useEffect(() => {
    const beforePrint = () => {
      previousOpen.current = open;
      setOpen(true);
    };
    const afterPrint = () => setOpen(previousOpen.current);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, [open]);

  return (
    <details
      className="methodology"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        方法与局限
        <span className="chevron" aria-hidden="true">
          <IconChevronDown size={16} />
        </span>
      </summary>
      <div className="methodology-body">
        <p className="methodology-note">{methodology?.note}</p>

        {isLocalReport ? (
          <div className="notice success">
            <span className="notice-icon" aria-hidden="true">
              ↺
            </span>
            <div>使用本地分析结果，本次未消耗 token。</div>
          </div>
        ) : (
          <div>
            <div className="evidence-title" style={{ marginBottom: 6 }}>
              本次消耗 token
            </div>
            {tokenUsage ? (
              <div className="meta-grid">
                <div className="meta-item">
                  <div className="meta-label">输入 token</div>
                  <div className="meta-value mono">{formatNumber(tokenUsage.input)}</div>
                </div>
                <div className="meta-item">
                  <div className="meta-label">输出 token</div>
                  <div className="meta-value mono">{formatNumber(tokenUsage.output)}</div>
                </div>
                <div className="meta-item">
                  <div className="meta-label">估算费用</div>
                  <div className="meta-value mono">
                    {typeof tokenUsage.estimatedCostUsd === 'number'
                      ? `$${tokenUsage.estimatedCostUsd.toFixed(4)}`
                      : '—'}
                  </div>
                </div>
              </div>
            ) : (
              <p className="field-hint">后端未返回 token 用量。</p>
            )}
          </div>
        )}

        <div>
          <div className="evidence-title" style={{ marginBottom: 6 }}>
            方法论信息
          </div>
          <div className="meta-grid">
            <Meta label="AI 模型" value={methodology?.aiModel} mono />
            <Meta
              label="思考模式"
              value={methodology?.thinkingEnabled ? '开启（更慢、费用更高）' : '关闭'}
            />
            <Meta label="提示词版本" value={methodology?.promptVersion} mono />
            <Meta label="置信度" value={CONFIDENCE_LABELS[report.conclusion?.confidence] ?? '—'} />
            <Meta
              label="数据来源"
              value={DATA_SOURCE_LABELS[methodology?.dataSource] ?? methodology?.dataSource ?? '—'}
            />
            <Meta
              label="趋势来源"
              value={TREND_SOURCE_LABELS[methodology?.trendSource] ?? methodology?.trendSource ?? '—'}
            />
            <Meta
              label="分析来源"
              value={
                ANALYSIS_SOURCE_LABELS[methodology?.analysisSource] ?? methodology?.analysisSource ?? '—'
              }
            />
            <Meta label="Steam 请求数" value={formatNumber(methodology?.steamRequests)} mono />
            <Meta label="缓存命中" value={formatNumber(methodology?.cacheHits)} mono />
            <Meta label="数据目录" value={methodology?.dataDir ?? '—'} mono />
            <Meta label="报告生成时间" value={formatDateTime(methodology?.reportGeneratedAt)} />
            <Meta label="数据集抓取时间" value={formatDateTime(methodology?.datasetFetchedAt)} />
            <Meta label="报告版本" value={report.version} mono />
            <Meta label="生成器" value={methodology?.generatedBy ?? 'GReview'} />
            {title.isCustom ? (
              <Meta
                label="游戏标题"
                value={`${title.customTitle ?? ''}（Steam 原名：${title.steamName ?? '未获取'}）`}
              />
            ) : null}
            {timezone ? <Meta label="趋势时区" value={timezone} mono /> : null}
          </div>
        </div>

        <div>
          <div className="evidence-title" style={{ marginBottom: 6 }}>
            抓取配置与样本
          </div>
          <div className="filter-chips">
            <span className="filter-chip">
              评论类型：<strong>{REVIEW_TYPE_LABELS[filters?.reviewType ?? ''] ?? '—'}</strong>
            </span>
            <span className="filter-chip">
              排序：<strong>{SORT_LABELS[filters?.sort ?? ''] ?? '—'}</strong>
            </span>
            <span className="filter-chip">
              购买来源：<strong>{PURCHASE_LABELS[filters?.purchaseType ?? ''] ?? '—'}</strong>
            </span>
            <span className="filter-chip">
              语言：<strong>{formatLanguages(sample?.languages ?? filters?.languages)}</strong>
            </span>
            <span className="filter-chip">
              抓取上限：<strong>{formatNumber(sample?.fetched)}</strong>
            </span>
            <span className="filter-chip">
              Steam 匹配：<strong>{formatNumber(sample?.matchedTotal)}</strong>
            </span>
            <span className="filter-chip">
              送入 AI：<strong>{formatNumber(sample?.usedForAI)}</strong>
            </span>
            <span className="filter-chip">
              接口：<strong>{sample?.sourceEndpoint === 'storefront' ? '商店回退接口' : 'Steam 官方接口'}</strong>
            </span>
            {filters?.minVotes ? (
              <span className="filter-chip">
                最低赞数：<strong>{formatNumber(filters.minVotes)}</strong>
              </span>
            ) : null}
            {filters?.minLength ? (
              <span className="filter-chip">
                最短字数：<strong>{formatNumber(filters.minLength)}</strong>
              </span>
            ) : null}
            {filters?.includeKeywords && filters.includeKeywords.length > 0 ? (
              <span className="filter-chip">
                包含：<strong>{filters.includeKeywords.join(' ')}</strong>
              </span>
            ) : null}
            {filters?.excludeKeywords && filters.excludeKeywords.length > 0 ? (
              <span className="filter-chip">
                排除：<strong>{filters.excludeKeywords.join(' ')}</strong>
              </span>
            ) : null}
            {filters?.excludeEarlyAccess ? (
              <span className="filter-chip">排除抢先体验</span>
            ) : null}
            {filters?.excludeFree ? <span className="filter-chip">排除免费获得</span> : null}
            <span className="filter-chip">
              离题过滤：<strong>{filters?.excludeOffTopic ? '开启' : '关闭'}</strong>
            </span>
            <span className="filter-chip">
              Steam 质量排序：<strong>{filters?.useReviewQuality ? '开启' : '关闭'}</strong>
            </span>
          </div>
          {sample?.dateCoverage ? (
            <p className="field-hint" style={{ marginTop: 6 }}>
              样本时间覆盖：{formatUnixDate(sample.dateCoverage.start)} 至{' '}
              {formatUnixDate(sample.dateCoverage.end)}
            </p>
          ) : null}
          <p className="field-hint" style={{ marginTop: 6 }}>
            样本好评率：{formatPercent(report.kpis?.samplePositiveRate)} · 趋势覆盖：
            {report.trend?.coverage?.start ?? '—'} 至 {report.trend?.coverage?.end ?? '—'}
          </p>
        </div>

        <div>
          <div className="evidence-title" style={{ marginBottom: 6 }}>
            采样偏差与局限
          </div>
          <ul className="caveat-list" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            <li>高赞样本天然偏向老评论与核心玩家，不代表全部玩家。</li>
            <li>语言筛选与离题过滤会改变样本构成；结果仅适用于对应条件。</li>
            <li>评论只代表愿意留下评论的玩家，不能推断销量、收入或在线人数。</li>
            <li>AI 归纳可能出现误读；证据引用以原文为准，并已通过评论 ID 与原文子串校验。</li>
          </ul>
        </div>
      </div>
    </details>
  );
}

function Meta({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="meta-item">
      <div className="meta-label">{label}</div>
      <div className={`meta-value${mono ? ' mono' : ''}`}>{value || '—'}</div>
    </div>
  );
}
