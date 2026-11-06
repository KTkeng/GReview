import type { Report, Theme } from '../types';
import {
  ANALYSIS_SOURCE_LABELS,
  CONFIDENCE_LABELS,
  DATA_SOURCE_LABELS,
  PRIORITY_LABELS,
  REVIEW_TYPE_LABELS,
  TREND_SOURCE_LABELS,
  formatDateTime,
  formatLanguages,
  formatNumber,
  formatPercent,
  formatPlaytimeHours,
  languageName,
} from './format';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function escapeInline(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function themeSection(title: string, themes: Theme[], lines: string[]): void {
  lines.push(`### ${title}`, '');
  if (!themes || themes.length === 0) {
    lines.push('_本组暂无 AI 归纳主题。_', '');
    return;
  }
  for (const theme of themes) {
    lines.push(`#### ${escapeInline(theme.name)}（提及 ${theme.mentions} 次）`, '');
    lines.push(escapeInline(theme.summary || '（无摘要）'), '');
    if (theme.quotes && theme.quotes.length > 0) {
      lines.push('证据引用：', '');
      for (const quote of theme.quotes) {
        const voteText =
          typeof quote.votesUp === 'number' ? `，赞 ${quote.votesUp}` : '';
        const sentiment = quote.votedUp === true ? '，好评' : quote.votedUp === false ? '，差评' : '';
        lines.push(
          `- \`${quote.reviewId}\`（${sentiment.replace(/^，/, '') || '情感未知'}${voteText}）`,
        );
        lines.push(`  - 原文：${escapeInline(quote.original)}`);
        if (quote.zh) {
          lines.push(`  - AI 翻译：${escapeInline(quote.zh)}`);
        }
      }
      lines.push('');
    } else if (theme.evidenceIds && theme.evidenceIds.length > 0) {
      lines.push(`证据评论 ID：${theme.evidenceIds.map((id) => `\`${id}\``).join('、')}`, '');
    }
    if (theme.evidenceIds && theme.evidenceIds.length > 0 && theme.quotes && theme.quotes.length > 0) {
      lines.push(`证据 ID：${theme.evidenceIds.map((id) => `\`${id}\``).join('、')}`, '');
    }
  }
}

/**
 * 将 Report 渲染为 Markdown（结论、趋势表格、主题清单、引用、评论与方法论）。
 * 纯函数，便于单元测试。
 */
export function buildMarkdown(report: Report): string {
  const lines: string[] = [];
  const gameName = report.game?.name || `AppID ${report.game?.appid ?? ''}`.trim();
  const isLocalReport = report.methodology?.analysisSource === 'local_report';

  lines.push(`# GReview 报告：${escapeInline(gameName)}`, '');
  lines.push(`- 分析时间：${formatDateTime(report.generatedAt)}`);
  lines.push(`- 游戏 AppID：${report.game?.appid ?? '—'}`);
  if (report.methodology?.aiModel) {
    lines.push(`- AI 模型：${report.methodology.aiModel}`);
  }
  lines.push(`- 报告版本：${report.version ?? '1.0'}`, '');

  if (isLocalReport) {
    lines.push('> 使用本地分析结果，本次未消耗 token。', '');
  }

  /* 结论 */
  lines.push('## 结论', '');
  lines.push(`**${escapeInline(report.conclusion?.label ?? '')}**`, '');
  lines.push(`**${escapeInline(report.conclusion?.headline ?? '')}**`, '');
  for (const paragraph of String(report.conclusion?.summary ?? '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    lines.push(paragraph, '');
  }
  lines.push(
    `- 置信度：${CONFIDENCE_LABELS[report.conclusion?.confidence] ?? report.conclusion?.confidence ?? '—'}`,
  );
  for (const caveat of report.conclusion?.caveats ?? []) {
    lines.push(`- 局限：${escapeInline(caveat)}`);
  }
  lines.push('');

  /* KPI */
  lines.push('## 关键指标', '');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(
    `| 全部时间好评率 | ${formatPercent(report.kpis?.allTime?.positiveRate)} |`,
  );
  lines.push(
    `| 总评论数 | ${formatNumber(report.kpis?.allTime?.total)} |`,
  );
  lines.push(
    `| 近 30 天好评率 | ${formatPercent(report.kpis?.last30d?.positiveRate)} |`,
  );
  lines.push(`| 近 30 天评论数 | ${formatNumber(report.kpis?.last30d?.total)} |`);
  lines.push(`| 近 90 天好评率 | ${formatPercent(report.kpis?.last90d?.positiveRate)} |`);
  lines.push(`| 本次样本量 | ${formatNumber(report.sample?.usedForAI)} |`);
  lines.push(`| 样本好评率 | ${formatPercent(report.kpis?.samplePositiveRate)} |`);
  lines.push('');

  /* 趋势 */
  lines.push('## 口碑趋势', '');
  const points = report.trend?.points ?? [];
  if (points.length === 0) {
    lines.push('_本次没有可用的趋势数据，图表见应用内报告。_', '');
  } else {
    lines.push('| 月份 | 评论数 | 好评 | 差评 | 好评率 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const point of points) {
      lines.push(
        `| ${point.period} | ${formatNumber(point.total)} | ${formatNumber(
          point.positive,
        )} | ${formatNumber(point.negative)} | ${formatPercent(point.positiveRate)} |`,
      );
    }
    lines.push('');
  }
  const trendSource = TREND_SOURCE_LABELS[report.trend?.source] ?? report.trend?.source ?? '—';
  lines.push(
    `- 数据源：${trendSource}`,
    `- 覆盖区间：${report.trend?.coverage?.start ?? '—'} 至 ${report.trend?.coverage?.end ?? '—'}`,
  );
  if (report.trend?.coverage?.note) {
    lines.push(`- 说明：${escapeInline(report.trend.coverage.note)}`);
  }
  lines.push('- 图表（双轴：评论量柱状 + 好评率折线）见应用内报告或打印 PDF。', '');

  /* AI 归纳 */
  lines.push('## AI 归纳', '');
  themeSection('吸引点', report.ai?.appealPoints ?? [], lines);
  themeSection('劝退点', report.ai?.frictionPoints ?? [], lines);
  themeSection('预期落差', report.ai?.expectationGaps ?? [], lines);
  themeSection('更新影响', report.ai?.updateImpact ?? [], lines);

  /* 建议 */
  lines.push('## 可行动建议', '');
  const recommendations = report.ai?.recommendations ?? [];
  if (recommendations.length === 0) {
    lines.push('_暂无建议。_', '');
  } else {
    for (const item of recommendations) {
      const priority = PRIORITY_LABELS[item.priority] ?? item.priority;
      lines.push(`- **${priority}：${escapeInline(item.title)}**`);
      lines.push(`  - ${escapeInline(item.detail)}`);
      if (item.evidenceIds && item.evidenceIds.length > 0) {
        lines.push(`  - 证据：${item.evidenceIds.map((id) => `\`${id}\``).join('、')}`);
      }
    }
    lines.push('');
  }

  /* 高赞评论 */
  lines.push('## 高赞评论', '');
  const topReviews = report.topReviews ?? [];
  if (topReviews.length === 0) {
    lines.push('_暂无高赞评论数据。_', '');
  } else {
    lines.push('| # | 评论 | 赞数 | 游玩时长 | 评价 | 语言 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    topReviews.forEach((review, index) => {
      lines.push(
        `| ${index + 1} | ${escapeCell(review.text ?? '')} | ${formatNumber(
          review.votesUp,
        )} | ${formatPlaytimeHours(review.playtimeHours)} | ${
          review.votedUp ? '好评' : '差评'
        } | ${languageName(review.language)} |`,
      );
    });
    lines.push('');
  }

  /* 方法论 */
  lines.push('## 方法与局限', '');
  const m = report.methodology;
  if (m) {
    lines.push(`- ${escapeInline(m.note ?? '')}`, '');
    lines.push('| 项目 | 值 |');
    lines.push('| --- | --- |');
    lines.push(`| 数据来源 | ${DATA_SOURCE_LABELS[m.dataSource] ?? m.dataSource} |`);
    lines.push(`| 趋势来源 | ${TREND_SOURCE_LABELS[m.trendSource] ?? m.trendSource} |`);
    lines.push(`| 分析来源 | ${ANALYSIS_SOURCE_LABELS[m.analysisSource] ?? m.analysisSource} |`);
    lines.push(`| AI 模型 | ${m.aiModel} |`);
    lines.push(`| 思考模式 | ${m.thinkingEnabled ? '开启' : '关闭'} |`);
    lines.push(`| 提示词版本 | ${m.promptVersion} |`);
    lines.push(`| Steam 请求数 | ${formatNumber(m.steamRequests)} |`);
    lines.push(`| 缓存命中 | ${formatNumber(m.cacheHits)} |`);
    lines.push(`| 数据目录 | ${m.dataDir} |`);
    if (m.reportGeneratedAt) lines.push(`| 报告生成时间 | ${formatDateTime(m.reportGeneratedAt)} |`);
    if (m.datasetFetchedAt) lines.push(`| 数据集抓取时间 | ${formatDateTime(m.datasetFetchedAt)} |`);
    lines.push('');
  }

  const tokenUsage = report.sample?.tokenUsage;
  if (tokenUsage && !isLocalReport) {
    lines.push(
      `- 本次消耗 token：输入 ${formatNumber(tokenUsage.input)} / 输出 ${formatNumber(
        tokenUsage.output,
      )}`,
    );
    if (typeof tokenUsage.estimatedCostUsd === 'number') {
      lines.push(`- 估算费用：$${tokenUsage.estimatedCostUsd.toFixed(4)}（估算）`);
    }
    lines.push('');
  } else if (!isLocalReport) {
    lines.push('- token 用量：后端未返回');
    lines.push('');
  }

  /* 抓取与样本 */
  const sample = report.sample;
  if (sample) {
    lines.push('### 抓取与样本', '');
    lines.push(`- 抓取配置：评论类型 ${REVIEW_TYPE_LABELS[sample.filters?.reviewType] ?? '—'}，语言 ${formatLanguages(sample.languages)}`);
    lines.push(`- 抓取数量：${formatNumber(sample.fetched)} 条；Steam 匹配总数：${formatNumber(sample.matchedTotal)} 条；送入 AI：${formatNumber(sample.usedForAI)} 条`);
    lines.push(`- 样本好评率：${formatPercent(report.kpis?.samplePositiveRate)}`);
    lines.push('');
  }

  lines.push('### 采样偏差说明', '');
  lines.push(
    '- 趋势来自官方月度聚合，不使用高赞样本绘制；高赞样本天然偏向老评论与核心玩家，不能代表全部玩家。',
  );
  lines.push('- 评论仅代表愿意留下评论的玩家，无法据此推断销量、收入或在线人数。');
  lines.push('- AI 归纳基于筛选后的样本，可能低估长尾玩家与小语种社区的声音；引用以原文为准。');
  lines.push('');
  lines.push('---', '');
  lines.push('由 GReview 生成。GReview 是非 Valve 官方工具，与 Valve 无关联。');
  lines.push('');

  return lines.join('\n');
}

export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'greview-report';
}

export function markdownFilename(report: Report): string {
  const name = safeFilename(report.game?.name || `app-${report.game?.appid ?? 'report'}`);
  const date = new Date(report.generatedAt);
  const valid = !Number.isNaN(date.getTime());
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = valid
    ? `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
        date.getHours(),
      )}${pad(date.getMinutes())}`
    : 'report';
  return `GReview-${name}-${stamp}.md`;
}

export function downloadMarkdown(report: Report): string {
  const content = buildMarkdown(report);
  const filename = markdownFilename(report);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
