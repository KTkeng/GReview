import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GamePresentation, Report } from '../types';
import { api } from './api';
import { buildMarkdown, downloadReportMarkdown, markdownFilename } from './exportMarkdown';

function presentation(overrides: Partial<GamePresentation> = {}): GamePresentation {
  return {
    appid: 570,
    name: 'Dota 2',
    steamName: 'Dota 2',
    customTitle: null,
    displayTitle: 'Dota 2',
    titleSource: '自动读取',
    titleRevision: 3,
    titleUpdatedAt: null,
    titleEditable: true,
    coverUrl: null,
    coverPlaceholder: 'AppID 570',
    warnings: [],
    ...overrides,
  };
}

function makeReport(game: GamePresentation): Report {
  return {
    version: '1.0',
    generatedAt: '2026-01-02T03:04:05.000Z',
    game,
    sample: {
      filters: {
        languages: ['schinese'],
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
      fetched: 10,
      matchedTotal: 10,
      usedForAI: 10,
      languages: ['schinese'],
      sourceEndpoint: 'official',
    },
    kpis: {
      allTime: { total: 100, positiveRate: 80, reviewScoreDesc: '特别好评' },
      last30d: { total: 10, positiveRate: 80, reviewScoreDesc: '特别好评' },
      last90d: { total: 30, positiveRate: 80, reviewScoreDesc: '特别好评' },
      samplePositiveRate: 80,
    },
    trend: {
      granularity: 'month',
      source: 'official_aggregate',
      points: [],
      coverage: { start: '2025-01', end: '2026-01', note: '' },
    },
    conclusion: {
      label: '特别好评',
      headline: '口碑稳健',
      summary: '总结',
      confidence: 'high',
      caveats: [],
    },
    ai: {
      appealPoints: [],
      frictionPoints: [],
      expectationGaps: [],
      updateImpact: [],
      recommendations: [],
    },
    topReviews: [],
    methodology: {
      note: '方法论说明',
      steamRequests: 1,
      cacheHits: 0,
      dataSource: 'fresh',
      trendSource: 'official_aggregate',
      analysisSource: 'fresh',
      dataDir: 'D:/data',
      aiModel: 'deepseek-flash',
      thinkingEnabled: false,
      promptVersion: 'prompt-1',
      generatedBy: 'GReview',
    },
  };
}

const customGame = presentation({
  customTitle: '我的 Dota',
  displayTitle: '我的 Dota',
  titleSource: '自定义',
});

describe('Markdown 导出使用合并后的 displayTitle', () => {
  it('标题与方法论都使用自定义标题，并保留 Steam 原名', () => {
    const markdown = buildMarkdown(makeReport(customGame));

    expect(markdown.split('\n')[0]).toBe('# GReview 报告：我的 Dota');
    expect(markdown).toContain('- 游戏标题：我的 Dota（Steam 原名：Dota 2）');
  });

  it('非自定义标题不添加标题字段', () => {
    const markdown = buildMarkdown(makeReport(presentation()));
    expect(markdown.split('\n')[0]).toBe('# GReview 报告：Dota 2');
    expect(markdown).not.toContain('- 游戏标题：');
  });

  it('转义 HTML 与 Markdown 结构字符，避免注入或破坏结构', () => {
    const game = presentation({
      customTitle: 'Pwn <img src=x> #1',
      displayTitle: 'Pwn <img src=x> #1',
      titleSource: '自定义',
      steamName: 'A&B <i>',
    });
    const markdown = buildMarkdown(makeReport(game));

    expect(markdown.split('\n')[0]).toBe(
      '# GReview 报告：Pwn &lt;img src=x&gt; \\#1',
    );
    expect(markdown).not.toContain('<img');
    expect(markdown).toContain('（Steam 原名：A&B &lt;i&gt;）');
  });

  it('文件名使用 displayTitle 并清理非法字符', () => {
    expect(markdownFilename(makeReport(customGame))).toMatch(
      /^GReview-我的 Dota-\d{8}-\d{4}\.md$/,
    );
    const unsafe = presentation({
      customTitle: 'A/B: C?',
      displayTitle: 'A/B: C?',
      titleSource: '自定义',
    });
    expect(markdownFilename(makeReport(unsafe))).toMatch(/^GReview-A_B_ C_-/);
  });
});

describe('downloadReportMarkdown 服务端导出链路', () => {
  const originalURL = globalThis.URL;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubDownloads() {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    class MockURL extends originalURL {}
    Object.defineProperty(MockURL, 'createObjectURL', { value: createObjectURL });
    Object.defineProperty(MockURL, 'revokeObjectURL', { value: revokeObjectURL });
    vi.stubGlobal('URL', MockURL);

    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    return {
      created: createObjectURL,
      getDownloaded: () => downloaded,
    };
  }

  it('历史报告调用 GET /api/reports/:appid/:analysisHash?format=markdown 并使用固定文件名', async () => {
    const downloads = stubDownloads();
    const getSpy = vi
      .spyOn(api, 'getReportMarkdown')
      .mockResolvedValue('# GReview 报告：我的 Dota\n');

    const filename = await downloadReportMarkdown(makeReport(customGame), {
      appid: 570,
      analysisHash: 'abc123',
      dataDir: 'D:/data',
    });

    expect(getSpy).toHaveBeenCalledWith(570, 'abc123', 'D:/data');
    expect(filename).toBe('GReview-570-abc123.md');
    expect(downloads.created).toHaveBeenCalledTimes(1);
    expect(downloads.getDownloaded()).toBe('GReview-570-abc123.md');
  });

  it('服务端不支持或报告不存在时回退本地渲染，仍使用同一标题', async () => {
    const downloads = stubDownloads();
    vi.spyOn(api, 'getReportMarkdown').mockRejectedValue(new Error('NOT_SUPPORTED'));

    const filename = await downloadReportMarkdown(makeReport(customGame), {
      appid: 570,
      analysisHash: 'abc123',
    });

    expect(filename).toMatch(/^GReview-我的 Dota-\d{8}-\d{4}\.md$/);
    expect(downloads.getDownloaded()).toBe(filename);
  });
});
