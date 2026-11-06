import { describe, expect, it } from 'vitest';
import { validateEvidence } from '../src/analysis/evidence';
import { buildReport, refreshReport, type BuildReportInput } from '../src/analysis/report';
import { rollingWindowBounds } from '../src/lib/time';
import { reportToMarkdown } from '../src/storage/markdown';
import { withClientFilterDefaults, withFilterDefaults } from '../src/steam/filters';
import type { Report, TrendDataset } from '../src/types';
import { SAMPLE_ANALYSIS, SAMPLE_REVIEWS, SAMPLE_SUMMARY } from './helpers';

const TREND: TrendDataset = {
  granularity: 'month',
  source: 'official_aggregate',
  points: [
    { period: '2025-11', total: 100, positive: 80, negative: 20, positiveRate: 0.8 },
    { period: '2025-12', total: 100, positive: 85, negative: 15, positiveRate: 0.85 },
    { period: '2026-01', total: 100, positive: 95, negative: 5, positiveRate: 0.95 },
  ],
  coverage: { start: '2025-11', end: '2026-01', note: 'official' },
  timezone: 'Asia/Shanghai',
  sourceEndpoint: 'official',
  fetchedAt: '2026-01-05T00:00:00.000Z',
  trendHash: 'a'.repeat(16),
  trendContentHash: 'b'.repeat(16),
};

const ROLLING = {
  last30d: { total: 300, positive: 240, negative: 60, positiveRate: 0.8 },
  last90d: { total: 600, positive: 420, negative: 180, positiveRate: 0.7 },
  source: 'official_aggregate' as const,
  sources: { last30d: 'official_aggregate' as const, last90d: 'official_aggregate' as const },
};

const AGGREGATES_AT = '2026-01-05T00:00:00.000Z';

function input(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    game: { appid: 570, name: 'Test Game' },
    filters: withFilterDefaults(),
    clientFilters: withClientFilterDefaults(),
    reviews: SAMPLE_REVIEWS,
    usedForAI: 3,
    trend: TREND,
    summary: SAMPLE_SUMMARY,
    allTimeSummary: SAMPLE_SUMMARY,
    rollingKpis: ROLLING,
    analysis: validateEvidence(SAMPLE_ANALYSIS, SAMPLE_REVIEWS),
    usage: { input: 100, output: 50 },
    aiOptions: { model: 'deepseek-flash', thinking: true },
    includeTranslations: true,
    topReviews: 2,
    methodology: {
      dataSource: 'fresh',
      trendSource: 'official_aggregate',
      analysisSource: 'fresh',
      dataDir: '/tmp/data',
      datasetFetchedAt: '2026-01-05T00:00:00.000Z',
      aggregatesComputedAt: AGGREGATES_AT,
      reviewsHash: 'c'.repeat(16),
      trendHash: 'd'.repeat(16),
      steamRequests: 12,
      cacheHits: 1,
    },
    now: new Date('2026-01-06T00:00:00.000Z'),
    ...overrides,
  };
}

/** Replace every user-visible untrusted field with hostile text. */
function hostileReport(): Report {
  const report = buildReport(input());
  report.game.name = '游戏 <script>alert("x")</script>\n第二行';
  report.conclusion.label = '[label](https://evil.example/label)';
  report.conclusion.headline = '**粗体** <img src=x onerror="alert(1)">';
  report.conclusion.summary = '# 标题\n> 引用\n1. 列表 <iframe src="https://evil.example"></iframe>';
  report.conclusion.caveats = ['- 项目\n![图](https://evil.example/x.png)'];
  report.trend.coverage.note = '趋势 [链接](javascript:alert(1))';
  report.methodology.note = '<svg onload=alert(1)>\n[点击](https://evil.example) 与 www.evil.example';

  const theme = report.ai.appealPoints[0];
  theme.name = '主题 <b onmouseover=alert(1)>';
  theme.summary = '摘要 ![图](https://evil.example/x.png) 和 [链接](https://evil.example/y)\n第二行';
  theme.quotes = [
    {
      reviewId: 'r1',
      original: '引用 <script>x</script>\n- 项目',
      zh: '翻译 [链接](https://evil.example/z)\n换行',
      votesUp: 3,
      votedUp: true,
    },
  ];
  report.ai.recommendations[0] = {
    title: '建议 <img src=x onerror=alert(2)>',
    detail: '详情 [链接](https://evil.example/d)\n1. 编号',
    priority: 'high',
    evidenceIds: ['r1'],
  };
  report.topReviews[0] = {
    ...report.topReviews[0],
    text: '表格 | 内容 <img src=x onerror=alert(3)>\n第二行',
  };
  return report;
}

describe('Markdown export escapes untrusted content per context', () => {
  it('renders HTML, event attributes, links and images as inert text', () => {
    const markdown = reportToMarkdown(hostileReport());

    // No raw HTML tag may survive in any context (heading, body, quote, cell).
    expect(markdown).not.toMatch(/<script/i);
    expect(markdown).not.toMatch(/<img/i);
    expect(markdown).not.toMatch(/<iframe/i);
    expect(markdown).not.toMatch(/<svg/i);
    expect(markdown).not.toMatch(/<b\s/i);
    expect(markdown).toContain('&lt;script&gt;alert\\("x"\\)&lt;/script&gt;');
    expect(markdown).toContain('&lt;img src=x onerror="alert\\(1\\)"&gt;');
    expect(markdown).toContain('&lt;b onmouseover=alert\\(1\\)&gt;');

    // Markdown images/links cannot become active, including bare URL autolinks.
    expect(markdown).not.toContain('![');
    expect(markdown).not.toContain('](');
    expect(markdown).not.toContain('https://');
    expect(markdown).not.toContain('www.evil.example');
    expect(markdown).toContain('\\!\\[图\\]\\(https:\\/\\/evil.example/x.png\\)');
    expect(markdown).toContain('\\[链接\\]\\(https:\\/\\/evil.example/y\\)');
    expect(markdown).toContain('\\[链接\\]\\(javascript:alert\\(1\\)\\)');
    expect(markdown).toContain('www\\.evil.example');

    // Newlines cannot break headings or table rows; list/heading/quote markers
    // inside bodies stay text instead of starting new blocks.
    const heading = markdown.split('\n')[0];
    expect(heading).toBe('# GReview 口碑报告：游戏 &lt;script&gt;alert\\("x"\\)&lt;/script&gt; 第二行');
    expect(markdown).toContain('| 表格 \\| 内容 &lt;img src=x onerror=alert\\(3\\)&gt; 第二行 |');
    expect(markdown).toContain('- 局限：\\- 项目 \\!\\[图\\]\\(https:\\/\\/evil.example/x.png\\)');
    expect(markdown).toContain('\\# 标题');
    expect(markdown).toContain('&gt; 引用');
    expect(markdown).toContain('1\\. 列表');
    expect(markdown).not.toContain('\n# 标题');
    expect(markdown).not.toMatch(/^> 引用$/m);
    expect(markdown).not.toContain('\n- 项目');
    expect(markdown).not.toContain('\n1. 编号');
    expect(markdown).toContain('\\- 项目');
    expect(markdown).toContain('1. 编号');

    // Ordinary review prose is still exported unchanged.
    expect(markdown).toContain('Too expensive');
    expect(markdown).toContain('**HIGH**');
  });
});

describe('Markdown export states the frozen rolling KPI window', () => {
  it('exports the aggregate computation time and exact 30/90-day boundaries', () => {
    const report = buildReport(input());
    const markdown = reportToMarkdown(report);
    const w30 = rollingWindowBounds(AGGREGATES_AT, 30);
    const w90 = rollingWindowBounds(AGGREGATES_AT, 90);
    expect(w30).not.toBeNull();
    expect(w90).not.toBeNull();

    expect(markdown).toContain(`| 滚动 KPI 聚合时间 | ${AGGREGATES_AT} |`);
    expect(markdown).toContain(`| 最近 30 天窗口 | ${w30!.start} \\~ ${w30!.end} |`);
    expect(markdown).toContain(`| 最近 90 天窗口 | ${w90!.start} \\~ ${w90!.end} |`);
    expect(markdown).toContain(`滚动 KPI 聚合计算于 ${AGGREGATES_AT}`);
    expect(markdown).toContain(`最近30天窗口 ${w30!.start} 至 ${w30!.end}`);
    expect(markdown).toContain(`最近90天窗口 ${w90!.start} 至 ${w90!.end}`);
  });

  it('uses the refreshed aggregate time and windows when a report is reused on a later date', () => {
    const original = buildReport(input());
    const refreshedAt = '2026-03-10T12:00:00.000Z';
    const refreshed = refreshReport(original, {
      reviews: SAMPLE_REVIEWS,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: ROLLING,
      trend: TREND,
      filters: withFilterDefaults(),
      clientFilters: withClientFilterDefaults(),
      sourceEndpoint: 'official',
      matchedTotal: SAMPLE_SUMMARY.matchingTotal,
      includeTranslations: true,
      methodology: {
        trendSource: 'official_aggregate',
        steamRequests: 0,
        cacheHits: 0,
        aggregatesComputedAt: refreshedAt,
        dataSource: 'local_dataset',
        dataDir: '/tmp/data',
        datasetFetchedAt: '2026-03-09T00:00:00.000Z',
        reviewsHash: 'c'.repeat(16),
      },
      now: new Date('2026-03-11T00:00:00.000Z'),
    });

    expect(refreshed.generatedAt).toBe(original.generatedAt);
    const markdown = reportToMarkdown(refreshed);
    const old30 = rollingWindowBounds(AGGREGATES_AT, 30)!;
    const new30 = rollingWindowBounds(refreshedAt, 30)!;
    const new90 = rollingWindowBounds(refreshedAt, 90)!;
    expect(markdown).toContain(`| 滚动 KPI 聚合时间 | ${refreshedAt} |`);
    expect(markdown).toContain(`| 最近 30 天窗口 | ${new30.start} \\~ ${new30.end} |`);
    expect(markdown).toContain(`| 最近 90 天窗口 | ${new90.start} \\~ ${new90.end} |`);
    expect(markdown).toContain(`滚动 KPI 聚合计算于 ${refreshedAt}`);
    expect(markdown).not.toContain(`| 滚动 KPI 聚合时间 | ${AGGREGATES_AT} |`);
    expect(markdown).not.toContain(old30.start);
    expect(markdown).toContain('数据集抓取时间：2026-03-09T00:00:00.000Z');
  });

  it('does not claim window boundaries when the aggregate snapshot time is unknown', () => {
    const report = buildReport(
      input({
        methodology: {
          ...input().methodology,
          aggregatesComputedAt: undefined,
        },
      }),
    );
    const markdown = reportToMarkdown(report);
    expect(markdown).not.toContain('滚动 KPI 聚合时间');
    expect(markdown).not.toContain('最近 30 天窗口');
    expect(markdown).not.toContain('最近 90 天窗口');
    expect(markdown).not.toContain('滚动 KPI 聚合计算于');
  });
});
