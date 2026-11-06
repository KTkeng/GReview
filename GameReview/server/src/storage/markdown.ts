import type { Report, Theme, TopReview } from '../types';
import { rollingWindowBounds } from '../lib/time';

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Escape text for inline Markdown. AI-controlled strings must not be able to
 * emit raw HTML, images, links or emphasis/heading syntax. HTML is entity-
 * encoded first, then Markdown control characters are backslash-escaped.
 */
function escapeInline(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1')
    // GFM autolinks bare URLs even when surrounding Markdown syntax was
    // escaped, so break the scheme/prefix itself. The backslash escaped
    // slashes/dot still render as literal text.
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/www\./gi, 'www\\.');
}

/**
 * Escape a multi-line body block. Each line is escaped inline and line-start
 * list markers are neutralised so untrusted text cannot start a new block.
 */
function escapeBlock(value: string): string {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const escaped = escapeInline(line);
      return escaped
        .replace(/^(\s*)([-+])(\s)/, '$1\\$2$3')
        .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4');
    })
    .join('\n');
}

function escapeHeading(value: string): string {
  return escapeInline(String(value ?? '').replace(/\r?\n/g, ' '));
}

function escapeListItem(value: string): string {
  return escapeBlock(String(value ?? '').replace(/\r?\n/g, ' '));
}

function cell(value: string | number): string {
  return escapeBlock(String(value ?? '').replace(/\r?\n/g, ' '));
}

function quoteBlock(value: string): string {
  return escapeBlock(value)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function themeSection(title: string, themes: Theme[]): string[] {
  const lines: string[] = [`### ${escapeInline(title)}`, ''];
  if (themes.length === 0) {
    lines.push('无。', '');
    return lines;
  }
  for (const theme of themes) {
    const mentionsLabel =
      theme.mentions !== undefined
        ? `（提及 ${theme.mentions}${theme.mentionsEstimated ? '，AI 估计' : ''}）`
        : '';
    lines.push(`#### ${escapeHeading(theme.name)}${mentionsLabel}`, '');
    if (theme.summary) lines.push(escapeBlock(theme.summary), '');
    if (theme.quotes.length) {
      lines.push('证据引用：', '');
      for (const quote of theme.quotes) {
        lines.push(quoteBlock(quote.original));
        if (quote.zh) {
          lines.push('>');
          lines.push(`> AI 翻译：${escapeInline(quote.zh.replace(/\r?\n/g, ' '))}`);
        }
        lines.push(`> — 评论 ${escapeInline(quote.reviewId)}，赞 ${quote.votesUp}`, '');
      }
    }
  }
  return lines;
}

function topReviewRow(review: TopReview): string {
  const text = review.text.length > 160 ? `${review.text.slice(0, 160)}…` : review.text;
  return `| ${cell(review.reviewId)} | ${review.votedUp ? '好评' : '差评'} | ${cell(review.votesUp)} | ${cell(review.playtimeHours)} | ${cell(review.language)} | ${cell(text)} |`;
}

/** Markdown export (design §6.7). Untrusted text is escaped per context. */
export function reportToMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# GReview 口碑报告：${escapeHeading(report.game.name)}`, '');
  lines.push(`- 生成时间：${escapeInline(report.generatedAt)}`);
  lines.push(`- 版本：${escapeInline(report.version)}`);
  lines.push(`- 数据目录：${escapeInline(report.methodology.dataDir)}`);
  lines.push(
    `- AI 模型：${escapeInline(report.methodology.aiModel)}；思考模式：${report.methodology.thinkingEnabled ? '开启' : '关闭'}`,
  );
  lines.push('');
  lines.push('## 结论', '');
  lines.push(
    `**${escapeInline(report.conclusion.label)} — ${escapeInline(report.conclusion.headline)}**`,
    '',
  );
  lines.push(escapeBlock(report.conclusion.summary), '');
  lines.push(`- 置信度：${escapeInline(report.conclusion.confidence)}`);
  for (const caveat of report.conclusion.caveats) lines.push(`- 局限：${escapeListItem(caveat)}`);
  lines.push('');

  lines.push('## KPI', '');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 全部时间好评率 | ${pct(report.kpis.allTime.positiveRate)} |`);
  lines.push(`| 总评论数 | ${cell(report.kpis.allTime.total)} |`);
  lines.push(`| 最近 30 天好评率 | ${pct(report.kpis.last30d.positiveRate)} |`);
  lines.push(`| 最近 90 天好评率 | ${pct(report.kpis.last90d.positiveRate)} |`);
  if (report.methodology.aggregatesComputedAt) {
    // Rolling aggregates are frozen at the computation time. A bare "last 30
    // days" would silently become wrong after the report sits in the cache, so
    // export both the snapshot time and the actual window boundaries.
    lines.push(`| 滚动 KPI 聚合时间 | ${cell(report.methodology.aggregatesComputedAt)} |`);
    const w30 = rollingWindowBounds(report.methodology.aggregatesComputedAt, 30);
    const w90 = rollingWindowBounds(report.methodology.aggregatesComputedAt, 90);
    if (w30) lines.push(`| 最近 30 天窗口 | ${cell(`${w30.start} ~ ${w30.end}`)} |`);
    if (w90) lines.push(`| 最近 90 天窗口 | ${cell(`${w90.start} ~ ${w90.end}`)} |`);
  }
  lines.push(`| 本次样本好评率 | ${pct(report.kpis.samplePositiveRate)} |`);
  lines.push(`| 本次样本量 | ${cell(report.sample.usedForAI)} / ${cell(report.sample.fetched)} |`);
  lines.push('');

  lines.push('## 口碑趋势', '');
  lines.push(`- 数据源：${escapeInline(report.trend.source)}`);
  lines.push(
    `- 覆盖区间：${escapeInline(report.trend.coverage.start)} ~ ${escapeInline(report.trend.coverage.end)}`,
  );
  lines.push(`- 说明：${escapeListItem(report.trend.coverage.note)}`);
  lines.push('');
  lines.push('| 月份 | 评论数 | 好评 | 差评 | 好评率 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const point of report.trend.points) {
    lines.push(
      `| ${cell(point.period)} | ${cell(point.total)} | ${cell(point.positive)} | ${cell(point.negative)} | ${pct(point.positiveRate)} |`,
    );
  }
  lines.push('');
  lines.push('> 图表见应用内趋势图或打印版 PDF。', '');

  lines.push('## AI 归纳', '');
  lines.push(...themeSection('吸引点', report.ai.appealPoints));
  lines.push(...themeSection('劝退点', report.ai.frictionPoints));
  lines.push(...themeSection('预期落差', report.ai.expectationGaps));
  lines.push(...themeSection('更新影响', report.ai.updateImpact));

  lines.push('### 可行动建议', '');
  if (report.ai.recommendations.length === 0) lines.push('无。', '');
  for (const rec of report.ai.recommendations) {
    lines.push(
      `- **${escapeInline(rec.priority.toUpperCase())}** ${escapeListItem(rec.title)}：${escapeListItem(rec.detail)}`,
    );
  }
  lines.push('');

  lines.push('## 高赞评论 Top N', '');
  lines.push('| 评论 ID | 类型 | 赞 | 游玩小时 | 语言 | 摘要 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const review of report.topReviews) lines.push(topReviewRow(review));
  lines.push('');

  lines.push('## 方法与局限', '');
  lines.push(escapeBlock(report.methodology.note));
  lines.push('');
  lines.push(`- 样本抓取端点：${escapeInline(report.sample.sourceEndpoint)}`);
  lines.push(`- 数据来源：${escapeInline(report.methodology.dataSource)}`);
  lines.push(`- 趋势来源：${escapeInline(report.methodology.trendSource)}`);
  lines.push(`- 分析来源：${escapeInline(report.methodology.analysisSource)}`);
  lines.push(
    `- Steam 请求数：${cell(report.methodology.steamRequests)}；缓存命中：${cell(report.methodology.cacheHits)}`,
  );
  if (report.methodology.datasetFetchedAt) {
    lines.push(`- 数据集抓取时间：${escapeInline(report.methodology.datasetFetchedAt)}`);
  }
  if (report.methodology.aggregatesComputedAt) {
    lines.push(`- 滚动 KPI 聚合时间：${escapeInline(report.methodology.aggregatesComputedAt)}`);
  }
  if (report.sample.tokenUsage) {
    lines.push(
      `- Token 用量：输入 ${cell(report.sample.tokenUsage.input)}，输出 ${cell(report.sample.tokenUsage.output)}`,
    );
  }
  lines.push(`- 提示词版本：${escapeInline(report.methodology.promptVersion)}`);
  lines.push('');
  lines.push('> 高赞样本存在偏差；语言筛选、离题过滤与样本上限会影响结论。评论不代表全部玩家，本报告不推断销量、收入或商业成败。');
  lines.push('');
  lines.push('> GReview 是非 Valve 官方产品，与 Valve 无关联。评论为公开 UGC，请遵守 Steam 使用条款。');
  lines.push('');
  return lines.join('\n');
}
