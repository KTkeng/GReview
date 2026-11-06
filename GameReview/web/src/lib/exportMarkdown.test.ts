import { describe, expect, it } from 'vitest';
import type { Report } from '../types';
import { buildMarkdown, markdownFilename, safeFilename } from './exportMarkdown';

const report: Report = {
  version: '1.0',
  generatedAt: '2026-01-02T03:04:05.000Z',
  game: { appid: 570, name: 'Dota 2' },
  sample: {
    filters: {
      languages: ['schinese', 'english'],
      reviewType: 'all',
      sort: 'helpful',
      purchaseType: 'all',
      dateRange: null,
      excludeOffTopic: true,
      useReviewQuality: true,
      minVotes: 0,
      minLength: 0,
      includeKeywords: [],
      excludeKeywords: [],
      excludeEarlyAccess: false,
      excludeFree: false,
    },
    fetched: 200,
    matchedTotal: 1000,
    usedForAI: 180,
    languages: ['schinese', 'english'],
    sourceEndpoint: 'official',
    tokenUsage: { input: 12000, output: 3000, estimatedCostUsd: 0.0123 },
  },
  kpis: {
    allTime: { total: 100000, positive: 80000, negative: 20000, positiveRate: 80, reviewScoreDesc: '特别好评' },
    last30d: { total: 5000, positive: 4000, negative: 1000, positiveRate: 80, reviewScoreDesc: '特别好评' },
    last90d: { total: 15000, positive: 12000, negative: 3000, positiveRate: 80, reviewScoreDesc: '特别好评' },
    samplePositiveRate: 78.5,
  },
  trend: {
    granularity: 'month',
    source: 'official_aggregate',
    points: [
      { period: '2025-12', total: 1000, positive: 800, negative: 200, positiveRate: 80 },
      { period: '2026-01', total: 1200, positive: 900, negative: 300, positiveRate: 75 },
    ],
    coverage: { start: '2025-01', end: '2026-01', note: '官方月度聚合' },
  },
  conclusion: {
    label: '特别好评',
    headline: '口碑稳健，核心玩法获认可',
    summary: '第一段总结。\n\n第二段总结。',
    confidence: 'high',
    caveats: ['高赞样本偏向老玩家'],
  },
  ai: {
    appealPoints: [
      {
        id: 'appeal-1',
        name: '玩法深度',
        category: 'gameplay',
        sentiment: 'positive',
        mentions: 42,
        summary: '玩家认为英雄与策略空间大。',
        evidenceIds: ['r1'],
        quotes: [
          {
            reviewId: 'r1',
            original: 'Deep gameplay | huge hero pool',
            zh: '玩法有深度，英雄池很大',
            votesUp: 120,
            votedUp: true,
          },
        ],
      },
    ],
    frictionPoints: [],
    expectationGaps: [],
    updateImpact: [],
    recommendations: [
      {
        title: '优化新手引导',
        detail: '补充分路与装备教程',
        priority: 'high',
        evidenceIds: ['r1'],
      },
    ],
  },
  topReviews: [
    {
      reviewId: 'r1',
      text: 'Deep gameplay | huge hero pool',
      votesUp: 120,
      votedUp: true,
      language: 'english',
      playtimeHours: 120.5,
      createdAt: 1700000000,
    },
  ],
  methodology: {
    note: '基于筛选后的高赞样本，对照官方聚合趋势。',
    steamRequests: 7,
    cacheHits: 2,
    dataSource: 'fresh',
    trendSource: 'official_aggregate',
    analysisSource: 'fresh',
    dataDir: 'D:/GReview/data',
    aiModel: 'deepseek-flash',
    thinkingEnabled: false,
    promptVersion: 'prompt-1',
    generatedBy: 'GReview',
  },
};

describe('buildMarkdown', () => {
  const markdown = buildMarkdown(report);

  it('包含全部报告章节', () => {
    for (const heading of [
      '# GReview 报告：Dota 2',
      '## 结论',
      '## 关键指标',
      '## 口碑趋势',
      '## AI 归纳',
      '## 可行动建议',
      '## 高赞评论',
      '## 方法与局限',
      '### 采样偏差说明',
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it('包含证据引用与 AI 翻译标注', () => {
    expect(markdown).toContain('AI 翻译：玩法有深度，英雄池很大');
    expect(markdown).toContain('原文：Deep gameplay | huge hero pool');
    expect(markdown).toContain('高优先级：优化新手引导');
  });

  it('包含 token 用量与估算费用', () => {
    expect(markdown).toContain('本次消耗 token：输入 12,000 / 输出 3,000');
    expect(markdown).toContain('估算费用：$0.0123');
  });

  it('转义表格中的竖线，避免破坏 Markdown 表格', () => {
    expect(markdown).toContain('Deep gameplay \\| huge hero pool');
  });

  it('本地报告复用时不显示 token 消耗', () => {
    const local = buildMarkdown({
      ...report,
      methodology: { ...report.methodology, analysisSource: 'local_report' },
    });
    expect(local).toContain('使用本地分析结果，本次未消耗 token。');
    expect(local).not.toContain('本次消耗 token');
  });
});

describe('文件名', () => {
  it('清理非法字符', () => {
    expect(safeFilename('Dota 2: Review?')).toBe('Dota 2_ Review_');
    expect(safeFilename('   ')).toBe('greview-report');
  });

  it('生成带日期的文件名', () => {
    expect(markdownFilename(report)).toMatch(/^GReview-Dota 2-\d{8}-\d{4}\.md$/);
  });
});
