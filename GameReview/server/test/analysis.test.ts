import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import {
  estimateTokens,
  reviewTokens,
  totalTokens,
  buildChunks,
  estimateChunkCount,
  PREVIEW_AVERAGE_TOKENS_PER_REVIEW,
} from '../src/analysis/chunk';
import {
  conclusionLabel,
  confidenceFor,
  scoreDescForRate,
  trendDirection,
  scrubForbiddenClaims,
  containsForbiddenClaim,
  buildCaveats,
  BASE_CAVEATS,
} from '../src/analysis/conclusion';
import { validateEvidence, splitThemes, isQuoteSubstring, normalizeForMatch } from '../src/analysis/evidence';
import { buildReport, refreshReport } from '../src/analysis/report';
import { reportToMarkdown } from '../src/storage/markdown';
import { analyzeReviews, ANALYSIS_MAX_TOKENS, ANALYSIS_THINKING_MAX_TOKENS } from '../src/analysis/pipeline';
import { parseAnalysis } from '../src/ai/schema';
import type { AIChatRequest } from '../src/ai/deepseek';
import type { TrendDataset } from '../src/types';
import { FakeAIProvider, SAMPLE_ANALYSIS, SAMPLE_REVIEWS, SAMPLE_SUMMARY, makeReview } from './helpers';

const TREND: TrendDataset = {
  granularity: 'month',
  source: 'official_aggregate',
  points: [
    { period: '2025-10', total: 100, positive: 80, negative: 20, positiveRate: 0.8 },
    { period: '2025-11', total: 100, positive: 85, negative: 15, positiveRate: 0.85 },
    { period: '2025-12', total: 100, positive: 95, negative: 5, positiveRate: 0.95 },
    { period: '2026-01', total: 50, positive: 40, negative: 10, positiveRate: 0.8 },
  ],
  coverage: { start: '2025-10', end: '2026-01', note: '' },
  timezone: 'Asia/Shanghai',
  sourceEndpoint: 'official',
  fetchedAt: '2026-01-05T00:00:00.000Z',
  trendHash: 'a'.repeat(16),
  trendContentHash: 'b'.repeat(16),
};

const AI_OPTIONS = { model: 'deepseek-flash', thinking: true };

describe('token estimation and chunking', () => {
  it('estimates CJK and latin text conservatively', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好')).toBe(3);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('你好 world')).toBeGreaterThanOrEqual(3);
    expect(reviewTokens(SAMPLE_REVIEWS[0])).toBeGreaterThan(30);
    expect(totalTokens(SAMPLE_REVIEWS)).toBe(
      SAMPLE_REVIEWS.reduce((sum, r) => sum + reviewTokens(r), 0),
    );
  });

  it('keeps small samples in one holistic chunk', () => {
    const chunks = buildChunks(SAMPLE_REVIEWS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
    expect(buildChunks([])).toEqual([]);
  });

  it('splits larger samples and refuses to exceed the chunk cap', () => {
    const big = Array.from({ length: 3 }, (_, i) =>
      makeReview({ id: `big-${i}`, text: 'x'.repeat(400) }),
    );
    const chunks = buildChunks(big, { maxTokensPerChunk: 100, maxChunks: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((r) => r.id)).toEqual(['big-0', 'big-1', 'big-2']);

    try {
      buildChunks(big, { maxTokensPerChunk: 100, maxChunks: 1 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('AI_CONTEXT_TOO_LARGE');
    }
    expect(estimateChunkCount(100)).toBe(1);
    expect(estimateChunkCount(200000)).toBe(4);
    expect(PREVIEW_AVERAGE_TOKENS_PER_REVIEW).toBe(300);
  });
});

describe('server-computed conclusion rules', () => {
  it('maps positive rates to Steam-like descriptions', () => {
    expect(scoreDescForRate(0.96, 10)).toBe('好评如潮');
    expect(scoreDescForRate(0.9, 10)).toBe('特别好评');
    expect(scoreDescForRate(0.82, 10)).toBe('好评');
    expect(scoreDescForRate(0.75, 10)).toBe('多半好评');
    expect(scoreDescForRate(0.5, 10)).toBe('褒贬不一');
    expect(scoreDescForRate(0.1, 10)).toBe('差评');
    expect(scoreDescForRate(0.5, 0)).toBe('暂无评论');
  });

  it('labels trend direction with a five point threshold', () => {
    expect(trendDirection(0.8, 0.86)).toBe('近期回升');
    expect(trendDirection(0.8, 0.74)).toBe('近期下滑');
    expect(trendDirection(0.8, 0.84)).toBe('持平');
    expect(conclusionLabel({ reviewScoreDesc: '特别好评', allTimeRate: 0.9, last90dRate: 0.9 })).toBe(
      '特别好评 · 持平',
    );
    expect(conclusionLabel({ reviewScoreDesc: '特别好评', allTimeRate: 0.8, last90dRate: 0.7 })).toBe(
      '特别好评 · 近期下滑',
    );
  });

  it('applies the documented confidence rule', () => {
    expect(confidenceFor({ sampleSize: 150, trendMonths: 5, nonZeroMonths: 4 })).toBe('high');
    expect(confidenceFor({ sampleSize: 100, trendMonths: 3, nonZeroMonths: 2 })).toBe('high');
    expect(confidenceFor({ sampleSize: 50, trendMonths: 12, nonZeroMonths: 10 })).toBe('medium');
    expect(confidenceFor({ sampleSize: 10, trendMonths: 2, nonZeroMonths: 2 })).toBe('medium');
    expect(confidenceFor({ sampleSize: 10, trendMonths: 8, nonZeroMonths: 8 })).toBe('low');
    expect(confidenceFor({ sampleSize: 500, trendMonths: 8, nonZeroMonths: 1 })).toBe('low');
  });

  it('scrubs sales/revenue/online claims and keeps baseline caveats', () => {
    expect(containsForbiddenClaim('这游戏销量很高')).toBe(true);
    expect(containsForbiddenClaim('战斗手感很好')).toBe(false);
    expect(scrubForbiddenClaims('销量大涨，但口碑不错。')).toContain('不推断销量');
    expect(scrubForbiddenClaims('战斗不错，销量也高。口碑很好。')).toBe('口碑很好。');
    expect(scrubForbiddenClaims('销量大涨', 'safe')).toBe('safe');
    expect(scrubForbiddenClaims('', 'fallback')).toBe('fallback');
    const caveats = buildCaveats(['AI 附加局限', '销量增长']);
    expect(caveats).toContain('AI 附加局限');
    expect(caveats).not.toContain('销量增长');
    for (const base of BASE_CAVEATS) expect(caveats).toContain(base);
    expect(caveats.length).toBeLessThanOrEqual(10);
  });

  it('keeps every required caveat ahead of optional AI caveats', () => {
    const ai = Array.from({ length: 12 }, (_, i) => `AI 局限 ${i}`);
    const caveats = buildCaveats(ai, ['服务端动态警告']);
    // Required (dynamic + five baseline) caveats are never truncated by a
    // large AI list; only the optional tail is capped (review R3 Major).
    expect(caveats.slice(0, 6)).toEqual(['服务端动态警告', ...BASE_CAVEATS]);
    expect(caveats).toHaveLength(10);
    expect(caveats.filter((c) => c.startsWith('AI 局限'))).toHaveLength(4);
    for (const base of BASE_CAVEATS) expect(caveats).toContain(base);
  });
});

describe('evidence validation', () => {
  it('keeps valid themes and trusts only source votes', () => {
    const analysis = {
      ...SAMPLE_ANALYSIS,
      themes: SAMPLE_ANALYSIS.themes.map((t) => ({
        ...t,
        quotes: t.quotes.map((q) => ({ ...q, votesUp: 9999, votedUp: false })),
      })),
    };
    const validated = validateEvidence(analysis, SAMPLE_REVIEWS);
    expect(validated.themes).toHaveLength(2);
    expect(validated.themes[0].quotes[0]).toMatchObject({ reviewId: 'r1', votesUp: 50, votedUp: true });
    expect(validated.themes[1].quotes[0]).toMatchObject({ reviewId: 'r2', votesUp: 20, votedUp: false });
    expect(validated.themes[0].id).toBe('t1');
    expect(validated.recommendations[0].evidenceIds).toEqual(['r1']);
    expect(splitThemes(validated.themes).appealPoints).toHaveLength(1);
    expect(splitThemes(validated.themes).frictionPoints).toHaveLength(1);
  });

  it('marks AI mentions above the verified evidence count as an estimate', () => {
    const validated = validateEvidence(
      {
        ...SAMPLE_ANALYSIS,
        themes: [
          { ...SAMPLE_ANALYSIS.themes[0], mentions: 999 },
          { ...SAMPLE_ANALYSIS.themes[1], mentions: 1 },
        ],
      },
      SAMPLE_REVIEWS,
    );
    // An AI count larger than the cited evidence is kept but must be labelled
    // as an estimate; it may cover comments the AI did not cite (review R3 Minor).
    expect(validated.themes[0]).toMatchObject({ mentions: 999, mentionsEstimated: true });
    expect(validated.themes[1].mentions).toBe(1);
    expect(validated.themes[1].mentionsEstimated).toBeUndefined();
  });

  it('drops invalid ids, non-substring quotes and evidence-less themes', () => {
    const validated = validateEvidence(
      {
        themes: [
          {
            name: '有效主题',
            summary: 's',
            sentiment: 'positive',
            evidenceIds: ['r1', 'nope'],
            quotes: [
              { reviewId: 'r1', original: 'Combat feels great' },
              { reviewId: 'r2', original: 'Too expensive' },
              { reviewId: 'r1', original: 'totally absent phrase' },
              { reviewId: 'r1', original: 'COMBAT, feels GREAT!!!' },
            ],
          },
          {
            name: '无效主题',
            summary: 's',
            evidenceIds: ['nope', 'also-nope'],
            quotes: [{ reviewId: 'nope', original: 'x' }],
          },
        ],
        expectationGaps: [],
        updateImpact: [],
        recommendations: [{ title: 'r', detail: 'd', priority: 'high', evidenceIds: ['r2', 'nope'] }],
        conclusion: null,
      },
      SAMPLE_REVIEWS,
    );
    expect(validated.themes).toHaveLength(1);
    expect(validated.themes[0].evidenceIds).toEqual(['r1']);
    expect(validated.themes[0].quotes).toHaveLength(1);
    expect(validated.themes[0].quotes[0].original).toBe('Combat feels great');
    expect(validated.recommendations[0].evidenceIds).toEqual(['r2']);
  });

  it('accepts mixed sentiment from the model', () => {
    const parsed = parseAnalysis({
      themes: [{ name: '争议主题', sentiment: 'mixed', evidenceIds: ['r1'] }],
    });
    expect(parsed.themes[0].sentiment).toBe('mixed');
  });

  it('puts mixed themes in both appeal and friction groups', () => {
    const split = splitThemes([
      { id: 't1', name: '争议主题', mentions: 1, summary: '', evidenceIds: ['r1'], quotes: [], sentiment: 'mixed' },
    ]);
    expect(split.appealPoints).toHaveLength(1);
    expect(split.frictionPoints).toHaveLength(1);
  });

  it('normalizes quotes for matching across case, punctuation and width', () => {
    expect(normalizeForMatch('ＣＯＭＢＡＴ， feels   great!')).toBe('combatfeelsgreat');
    expect(isQuoteSubstring('combat, feels GREAT', 'Combat feels great and the boss fights are fun')).toBe(true);
    expect(isQuoteSubstring('not there', 'Combat feels great')).toBe(false);
    expect(isQuoteSubstring('', 'anything')).toBe(false);
  });

  it('accepts the grouped appealPoints/frictionPoints shape', () => {
    const validated = validateEvidence(
      {
        appealPoints: [
          { name: '战斗', evidenceIds: ['r1'], quotes: [{ reviewId: 'r1', original: 'boss fights' }] },
        ],
        frictionPoints: [{ name: '价格', evidenceIds: ['r2'], quotes: [] }],
      },
      SAMPLE_REVIEWS,
    );
    expect(validated.themes).toHaveLength(2);
    expect(validated.themes[0].sentiment).toBe('positive');
    expect(validated.themes[1].sentiment).toBe('negative');
  });
});

describe('AI analysis pipeline', () => {
  const input = {
    game: { appid: 570, name: 'Test Game' },
    reviews: SAMPLE_REVIEWS,
    trend: TREND,
    summary: SAMPLE_SUMMARY,
    filters: {
      languages: ['schinese', 'english'],
      reviewType: 'all' as const,
      sort: 'helpful' as const,
      purchaseType: 'all' as const,
      dateRange: null,
      excludeOffTopic: true,
      useReviewQuality: true,
    },
  };

  it('runs one holistic call and validates evidence', async () => {
    const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
    const progress: string[] = [];
    const result = await analyzeReviews({
      ...input,
      ai,
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      onProgress: (p) => progress.push(p.stage),
    });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].maxTokens).toBe(ANALYSIS_THINKING_MAX_TOKENS);
    expect(result.usedForAI).toBe(3);
    expect(result.analysis.themes).toHaveLength(2);
    expect(result.usage).toEqual({ input: 100, output: 50 });
    expect(progress).toContain('validating');
  });

  it('uses the base output budget when thinking is off', async () => {
    const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
    await analyzeReviews({
      ...input,
      ai,
      aiOptions: { ...AI_OPTIONS, thinking: false },
      includeTranslations: false,
    });
    expect(ai.calls[0].maxTokens).toBe(ANALYSIS_MAX_TOKENS);
  });

  it('throws AI_INVALID_RESPONSE when every theme loses its evidence', async () => {
    const ai = new FakeAIProvider({
      themes: [
        {
          name: '虚构主题',
          summary: 's',
          evidenceIds: ['missing'],
          quotes: [{ reviewId: 'missing', original: 'nothing' }],
        },
      ],
      expectationGaps: [],
      updateImpact: [],
      recommendations: [],
      conclusion: { label: 'x', headline: 'h', summary: 's', confidence: 'high', caveats: [] },
    });
    await expect(
      analyzeReviews({ ...input, ai, aiOptions: AI_OPTIONS, includeTranslations: false }),
    ).rejects.toThrow('AI_INVALID_RESPONSE');
  });

  it('rejects themes introduced only by the final stage', async () => {
    let call = 0;
    const newTheme = {
      name: '全新主题',
      category: 'gameplay',
      sentiment: 'positive' as const,
      summary: '只出现在最终结论里的主题',
      evidenceIds: ['r3'],
      quotes: [{ reviewId: 'r3', original: 'Performance is great' }],
    };
    const ai = new FakeAIProvider(() => {
      call += 1;
      if (call <= 3) return SAMPLE_ANALYSIS; // map calls
      if (call === 4) return SAMPLE_ANALYSIS; // merge: [战斗手感, 价格偏高]
      return { ...SAMPLE_ANALYSIS, themes: [SAMPLE_ANALYSIS.themes[0], newTheme] };
    });
    const result = await analyzeReviews({
      ...input,
      ai,
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      maxTokensPerChunk: 1,
      maxChunks: 10,
    });
    expect(ai.calls).toHaveLength(5); // 3 map + merge + final
    // The thinking budget applies to every stage, not only the holistic call.
    expect(ai.calls.every((c) => c.maxTokens === ANALYSIS_THINKING_MAX_TOKENS)).toBe(true);
    expect(result.analysis.themes.some((t) => t.name === '战斗手感')).toBe(true);
    expect(result.analysis.themes.some((t) => t.name === '全新主题')).toBe(false);
  });

  it('keeps merge themes when the final stage returns a matching theme with no evidence', async () => {
    let call = 0;
    const ai = new FakeAIProvider((req: AIChatRequest) => {
      call += 1;
      if (call <= 3) {
        const id = /"id":"(r\d+)"/.exec(req.user)?.[1] ?? 'r1';
        return {
          themes: [{ name: `主题${call}`, sentiment: 'mixed', summary: 's', evidenceIds: [id] }],
        };
      }
      if (call === 4) {
        return {
          themes: [
            {
              name: '合并主题',
              sentiment: 'mixed',
              summary: 's',
              evidenceIds: ['r1'],
              quotes: [{ reviewId: 'r1', original: 'Combat feels great' }],
            },
          ],
        };
      }
      return {
        conclusion: { label: 'x', headline: 'h', summary: 's', confidence: 'high', caveats: [] },
        themes: [{ name: '合并主题', sentiment: 'mixed', summary: 'bad', evidenceIds: ['missing'] }],
        recommendations: [],
      };
    });
    const result = await analyzeReviews({
      ...input,
      ai,
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      maxTokensPerChunk: 1,
      maxChunks: 10,
    });
    expect(ai.calls).toHaveLength(5); // 3 map + merge + final
    expect(result.analysis.themes).toHaveLength(1);
    expect(result.analysis.themes[0].name).toBe('合并主题');
    expect(result.analysis.themes[0].evidenceIds).toEqual(['r1']);
  });

  const TRANSLATED_ANALYSIS = {
    ...SAMPLE_ANALYSIS,
    themes: SAMPLE_ANALYSIS.themes.map((theme) => ({
      ...theme,
      quotes: theme.quotes.map((quote) => ({ ...quote, zh: `译:${quote.original}` })),
    })),
  };

  function reportFrom(analysis: ReturnType<typeof validateEvidence>, includeTranslations: boolean) {
    return buildReport({
      ...input,
      clientFilters: {
        minVotes: 0,
        minLength: 0,
        includeKeywords: [],
        excludeKeywords: [],
        excludeEarlyAccess: false,
        excludeFree: false,
      },
      allTimeSummary: SAMPLE_SUMMARY,
      analysis,
      usage: { input: 100, output: 50 },
      aiOptions: AI_OPTIONS,
      includeTranslations,
      topReviews: 2,
      methodology: {
        dataSource: 'fresh',
        trendSource: 'official_aggregate',
        analysisSource: 'fresh',
        dataDir: '/tmp/data',
        steamRequests: 1,
        cacheHits: 0,
      },
      now: new Date('2026-01-06T00:00:00.000Z'),
    });
  }

  it('threads includeTranslations=true into holistic and map/merge/final prompts', async () => {
    const holisticAi = new FakeAIProvider(TRANSLATED_ANALYSIS);
    const holistic = await analyzeReviews({
      ...input,
      ai: holisticAi,
      aiOptions: AI_OPTIONS,
      includeTranslations: true,
    });
    expect(holisticAi.calls).toHaveLength(1);
    expect(holisticAi.calls[0].system).toContain('必须提供 zh 字段');
    expect(holisticAi.calls[0].user).toContain('"zh"');
    expect(holistic.analysis.themes[0].quotes[0].zh).toBe('译:Combat feels great');
    const report = reportFrom(holistic.analysis, true);
    expect(JSON.stringify(report)).toContain('译:Combat feels great');

    const stagedAi = new FakeAIProvider(TRANSLATED_ANALYSIS);
    const staged = await analyzeReviews({
      ...input,
      ai: stagedAi,
      aiOptions: AI_OPTIONS,
      includeTranslations: true,
      maxTokensPerChunk: 1,
      maxChunks: 10,
    });
    expect(stagedAi.calls).toHaveLength(5); // 3 map + merge + final
    for (const call of stagedAi.calls.slice(0, 3)) {
      expect(call.system).toContain('必须提供 zh 字段');
      expect(call.user).toContain('"zh"');
    }
    expect(stagedAi.calls[3].system).toContain('保留 quotes 中已有的 zh 翻译');
    expect(stagedAi.calls[4].system).toContain('保留服务端主题 quotes 中已有的 zh 翻译');
    expect(staged.analysis.themes[0].quotes[0].zh).toBe('译:Combat feels great');
  });

  it('threads includeTranslations=false and strips model-supplied zh', async () => {
    const holisticAi = new FakeAIProvider(TRANSLATED_ANALYSIS);
    const holistic = await analyzeReviews({
      ...input,
      ai: holisticAi,
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
    });
    expect(holisticAi.calls).toHaveLength(1);
    expect(holisticAi.calls[0].system).toContain('不得输出 zh 字段');
    expect(holisticAi.calls[0].user).not.toContain('"zh"');
    expect(holistic.analysis.themes[0].quotes[0].zh).toBeUndefined();
    const report = reportFrom(holistic.analysis, false);
    expect(JSON.stringify(report)).not.toContain('译:Combat feels great');
    expect(reportToMarkdown(report)).not.toContain('译:Combat feels great');

    const stagedAi = new FakeAIProvider(TRANSLATED_ANALYSIS);
    const staged = await analyzeReviews({
      ...input,
      ai: stagedAi,
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      maxTokensPerChunk: 1,
      maxChunks: 10,
    });
    expect(stagedAi.calls).toHaveLength(5);
    for (const call of stagedAi.calls.slice(0, 3)) {
      expect(call.system).toContain('不得输出 zh 字段');
      expect(call.user).not.toContain('"zh"');
    }
    expect(stagedAi.calls[3].system).toContain('丢弃 quotes 中可能存在的 zh 字段');
    expect(stagedAi.calls[4].system).toContain('输出中不得包含 zh 字段');
    expect(staged.analysis.themes[0].quotes[0].zh).toBeUndefined();
    // Even a model that ignores the prompt cannot leak zh into the report.
    expect(JSON.stringify(reportFrom(staged.analysis, false))).not.toContain('译:Combat feels great');
  });

  it('throws NO_REVIEWS for an all-empty sample', async () => {
    const ai = new FakeAIProvider(SAMPLE_ANALYSIS);
    await expect(
      analyzeReviews({
        ...input,
        reviews: [makeReview({ id: 'empty', text: '   ' })],
        ai,
        aiOptions: AI_OPTIONS,
        includeTranslations: false,
      }),
    ).rejects.toThrow('NO_REVIEWS');
    expect(ai.calls).toHaveLength(0);
  });
});

describe('report assembly', () => {
  const baseReportInput = () => ({
    game: { appid: 570, name: 'Test Game' },
    filters: {
      languages: ['schinese', 'english'],
      reviewType: 'all' as const,
      sort: 'helpful' as const,
      purchaseType: 'all' as const,
      dateRange: null,
      excludeOffTopic: true,
      useReviewQuality: true,
    },
    clientFilters: {
      minVotes: 0,
      minLength: 0,
      includeKeywords: [],
      excludeKeywords: [],
      excludeEarlyAccess: false,
      excludeFree: false,
    },
    reviews: SAMPLE_REVIEWS,
    usedForAI: 3,
    trend: TREND,
    summary: SAMPLE_SUMMARY,
    allTimeSummary: SAMPLE_SUMMARY as typeof SAMPLE_SUMMARY | null,
    analysis: validateEvidence(SAMPLE_ANALYSIS, SAMPLE_REVIEWS),
    usage: { input: 100, output: 50 },
    aiOptions: AI_OPTIONS,
    includeTranslations: false,
    topReviews: 2,
    methodology: {
      dataSource: 'fresh' as const,
      trendSource: 'official_aggregate' as const,
      analysisSource: 'fresh' as const,
      dataDir: '/tmp/data',
      steamRequests: 12,
      cacheHits: 1,
      reviewsHash: 'c'.repeat(16),
      trendHash: 'd'.repeat(16),
    },
    now: new Date('2026-01-06T00:00:00.000Z'),
  });

  it('labels a sample fallback when the independent all-time aggregate is missing', () => {
    const input = baseReportInput();
    input.allTimeSummary = null;
    // A filtered fetch summary must never be relabelled as all-time (review Major 3).
    input.summary = {
      total: 3,
      positive: 3,
      negative: 0,
      positiveRate: 1,
      reviewScoreDesc: '好评如潮',
      matchingTotal: 3,
      sourceEndpoint: 'official',
    };
    const report = buildReport({ ...input, filters: { ...input.filters, reviewType: 'positive' } });
    expect(report.kpis.allTimeSource).toBe('sample_estimate');
    expect(report.kpis.allTime.total).toBe(SAMPLE_REVIEWS.length);
    expect(report.kpis.allTime.positiveRate).toBeCloseTo(2 / 3);
    expect(report.methodology.note).toContain('筛选样本估算');
    expect(report.conclusion.caveats).toContain(
      '全部时间 KPI 缺少独立官方聚合，当前使用筛选样本估算，不代表 Steam 全站口径。',
    );
  });

  it('marks per-window sample sources and warns about their impact', () => {
    const report = buildReport({
      ...baseReportInput(),
      rollingKpis: {
        last30d: { total: 50, positive: 40, negative: 10, positiveRate: 0.8 },
        last90d: { total: 30, positive: 15, negative: 15, positiveRate: 0.5 },
        source: 'sample_estimate',
        sources: { last30d: 'official_aggregate', last90d: 'sample_estimate' },
      },
    });
    expect(report.kpis.sources).toEqual({
      last30d: 'official_aggregate',
      last90d: 'sample_estimate',
    });
    expect(report.kpis.allTimeSource).toBe('official_aggregate');
    expect(report.conclusion.caveats).toContain('最近 90 天 KPI 为筛选样本估算，不代表 Steam 全站口径。');
  });

  it('computes KPIs, label, confidence and Top N on the server', () => {
    const analysis = validateEvidence(SAMPLE_ANALYSIS, SAMPLE_REVIEWS);
    const report = buildReport({
      game: { appid: 570, name: 'Test Game' },
      filters: {
        languages: ['schinese', 'english'],
        reviewType: 'all',
        sort: 'helpful',
        purchaseType: 'all',
        dateRange: null,
        excludeOffTopic: true,
        useReviewQuality: true,
      },
      clientFilters: {
        minVotes: 0,
        minLength: 0,
        includeKeywords: [],
        excludeKeywords: [],
        excludeEarlyAccess: false,
        excludeFree: false,
      },
      reviews: SAMPLE_REVIEWS,
      usedForAI: 3,
      trend: TREND,
      summary: SAMPLE_SUMMARY,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: {
        last30d: { total: 50, positive: 40, negative: 10, positiveRate: 0.8 },
        last90d: { total: 250, positive: 220, negative: 30, positiveRate: 0.88 },
        source: 'official_aggregate',
        sources: { last30d: 'official_aggregate', last90d: 'official_aggregate' },
      },
      analysis,
      usage: { input: 100, output: 50 },
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      topReviews: 2,
      methodology: {
        dataSource: 'fresh',
        trendSource: 'official_aggregate',
        analysisSource: 'fresh',
        dataDir: '/tmp/data',
        steamRequests: 12,
        cacheHits: 1,
        reviewsHash: 'c'.repeat(16),
        trendHash: 'd'.repeat(16),
      },
      now: new Date('2026-01-06T00:00:00.000Z'),
    });
    expect(report.version).toBe('1.0');
    expect(report.kpis.allTime).toMatchObject({ total: 1000, positiveRate: 0.9, reviewScoreDesc: '特别好评' });
    expect(report.kpis.last30d).toMatchObject({ total: 50, positiveRate: 0.8, reviewScoreDesc: '好评' });
    expect(report.kpis.last90d.total).toBe(250);
    expect(report.kpis.last90d.positiveRate).toBeCloseTo(0.88);
    expect(report.kpis.last90d.reviewScoreDesc).toBe('特别好评');
    // AI-supplied label is ignored in favour of the server rule.
    expect(report.conclusion.label).toBe('特别好评 · 持平');
    expect(report.conclusion.confidence).toBe('low');
    expect(report.topReviews.map((r) => r.reviewId)).toEqual(['r1', 'r2']);
    expect(report.topReviews[0].votesUp).toBe(50);
    expect(report.conclusion.caveats).toContain('AI 附加局限');
    expect(report.conclusion.caveats).not.toContain('销量增长');
    expect(report.ai.appealPoints).toHaveLength(1);
    expect(report.ai.frictionPoints).toHaveLength(1);
    expect(report.methodology).toMatchObject({
      aiModel: 'deepseek-flash',
      thinkingEnabled: true,
      promptVersion: 'greview-prompt-v1',
      reviewsHash: 'c'.repeat(16),
      steamRequests: 12,
      cacheHits: 1,
    });
    expect(report.methodology.reportGeneratedAt).toBe('2026-01-06T00:00:00.000Z');
    expect(report.generatedAt).toBe('2026-01-06T00:00:00.000Z');
    expect(JSON.stringify(report)).not.toContain('sk-');

    const markdown = reportToMarkdown(report);
    expect(markdown).toContain('# GReview 口碑报告：Test Game');
    expect(markdown).toContain('| 全部时间好评率 | 90.0% |');
    expect(markdown).toContain('| 2025-12 | 100 | 95 | 5 | 95.0% |');
    expect(markdown).toContain('#### 战斗手感');
    expect(markdown).toContain('> Combat feels great');
    expect(markdown).toContain('高赞样本存在偏差');
  });

  it('removes unverifiable numeric claims from the report JSON and Markdown', () => {
    const base = baseReportInput();
    const validated = validateEvidence(SAMPLE_ANALYSIS, SAMPLE_REVIEWS);
    const conclusion = validated.conclusion ?? {
      label: '',
      headline: '',
      summary: '',
      confidence: 'low' as const,
      caveats: [],
    };
    const report = buildReport({
      ...base,
      analysis: {
        ...validated,
        conclusion: {
          ...conclusion,
          summary:
            '全部时间评论总数为 1000。全部时间评论总数为 9999。较上月下降 5 个百分点。战斗体验整体不错。',
        },
      },
    });
    // The correct unit-less KPI count survives; the wrong count and the
    // direction-reversed delta are removed as whole sentences.
    expect(report.conclusion.summary).toContain('全部时间评论总数为 1000。');
    expect(report.conclusion.summary).toContain('战斗体验整体不错。');
    expect(report.conclusion.summary).not.toContain('9999');
    expect(report.conclusion.summary).not.toContain('较上月下降');
    expect(report.conclusion.caveats).toContain(
      'AI 文本中的数字与服务器 KPI/趋势不一致，已删除或替换为服务端模板摘要。',
    );

    const json = JSON.stringify(report);
    expect(json).not.toContain('9999');
    expect(json).not.toContain('较上月下降 5 个百分点');

    const markdown = reportToMarkdown(report);
    expect(markdown).toContain('全部时间评论总数为 1000。');
    expect(markdown).not.toContain('9999');
    expect(markdown).not.toContain('较上月下降 5 个百分点');
  });

  it('uses an independent all-time summary and real rolling windows', () => {
    const now = new Date('2026-01-06T00:00:00.000Z');
    const nowSec = Math.floor(now.getTime() / 1000);
    const reviews = SAMPLE_REVIEWS.map((r, i) => ({
      ...r,
      createdAt: nowSec - [5, 10, 40][i] * 86400,
    }));
    const filteredSummary = {
      total: 10,
      positive: 10,
      negative: 0,
      positiveRate: 1,
      reviewScoreDesc: '好评如潮',
      matchingTotal: 10,
      sourceEndpoint: 'official' as const,
    };
    const allTimeSummary = {
      total: 1000,
      positive: 800,
      negative: 200,
      positiveRate: 0.8,
      reviewScoreDesc: '好评',
      matchingTotal: 1000,
      sourceEndpoint: 'official' as const,
    };
    const report = buildReport({
      game: { appid: 570, name: 'Test Game' },
      filters: {
        languages: ['schinese', 'english'],
        reviewType: 'positive',
        sort: 'helpful',
        purchaseType: 'all',
        dateRange: { start: 100, end: 200 },
        excludeOffTopic: true,
        useReviewQuality: true,
      },
      clientFilters: {
        minVotes: 0,
        minLength: 0,
        includeKeywords: [],
        excludeKeywords: [],
        excludeEarlyAccess: false,
        excludeFree: false,
      },
      reviews,
      trend: TREND,
      summary: filteredSummary,
      allTimeSummary,
      analysis: validateEvidence(SAMPLE_ANALYSIS, reviews),
      usage: { input: 1, output: 1 },
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      topReviews: 2,
      methodology: {
        dataSource: 'fresh',
        trendSource: 'official_aggregate',
        analysisSource: 'fresh',
        dataDir: '/tmp/data',
        steamRequests: 0,
        cacheHits: 0,
      },
      now,
    });
    // All-time KPI ignores the positive-only, date-filtered fetch summary.
    expect(report.kpis.allTime).toMatchObject({ total: 1000, positiveRate: 0.8, reviewScoreDesc: '好评' });
    // Sample matching total still comes from the filtered fetch.
    expect(report.sample.matchedTotal).toBe(10);
    // No rolling aggregate supplied: fall back to timestamps, never natural months.
    expect(report.kpis.last30d).toMatchObject({ total: 2, positiveRate: 0.5 });
    expect(report.kpis.last90d.total).toBe(3);
    expect(report.kpis.last90d.positiveRate).toBeCloseTo(2 / 3);
  });

  it('replaces AI prose whose numbers contradict server KPI/trend values', () => {
    const badAnalysis = validateEvidence(
      {
        ...SAMPLE_ANALYSIS,
        conclusion: {
          ...SAMPLE_ANALYSIS.conclusion,
          headline: '好评率高达 99.9%',
          summary: '共 9999 条评论，好评率 99.9%。',
        },
      },
      SAMPLE_REVIEWS,
    );
    const report = buildReport({
      game: { appid: 570, name: 'Test Game' },
      filters: {
        languages: ['schinese', 'english'],
        reviewType: 'all',
        sort: 'helpful',
        purchaseType: 'all',
        dateRange: null,
        excludeOffTopic: true,
        useReviewQuality: true,
      },
      clientFilters: {
        minVotes: 0,
        minLength: 0,
        includeKeywords: [],
        excludeKeywords: [],
        excludeEarlyAccess: false,
        excludeFree: false,
      },
      reviews: SAMPLE_REVIEWS,
      trend: TREND,
      summary: SAMPLE_SUMMARY,
      allTimeSummary: SAMPLE_SUMMARY,
      analysis: badAnalysis,
      usage: { input: 1, output: 1 },
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      topReviews: 2,
      methodology: {
        dataSource: 'fresh',
        trendSource: 'official_aggregate',
        analysisSource: 'fresh',
        dataDir: '/tmp/data',
        steamRequests: 0,
        cacheHits: 0,
      },
      now: new Date('2026-01-06T00:00:00.000Z'),
    });
    expect(report.conclusion.headline).not.toContain('99.9');
    expect(report.conclusion.summary).not.toContain('9999');
    expect(report.conclusion.headline).toContain('基于 3 条评论样本');
    expect(report.conclusion.summary).toContain('数字均由服务端计算');
    expect(report.conclusion.caveats.some((c) => c.includes('数字与服务器'))).toBe(true);
  });

  it('keeps AI prose whose numbers match server KPI/trend values', () => {
    const goodAnalysis = validateEvidence(
      {
        ...SAMPLE_ANALYSIS,
        conclusion: {
          ...SAMPLE_ANALYSIS.conclusion,
          headline: '全部时间好评率 90.0%',
          summary: '基于 3 条评论样本，全部时间好评率 90.0%。',
        },
      },
      SAMPLE_REVIEWS,
    );
    const report = buildReport({
      game: { appid: 570, name: 'Test Game' },
      filters: {
        languages: ['schinese', 'english'],
        reviewType: 'all',
        sort: 'helpful',
        purchaseType: 'all',
        dateRange: null,
        excludeOffTopic: true,
        useReviewQuality: true,
      },
      clientFilters: {
        minVotes: 0,
        minLength: 0,
        includeKeywords: [],
        excludeKeywords: [],
        excludeEarlyAccess: false,
        excludeFree: false,
      },
      reviews: SAMPLE_REVIEWS,
      trend: TREND,
      summary: SAMPLE_SUMMARY,
      allTimeSummary: SAMPLE_SUMMARY,
      analysis: goodAnalysis,
      usage: { input: 1, output: 1 },
      aiOptions: AI_OPTIONS,
      includeTranslations: false,
      topReviews: 2,
      methodology: {
        dataSource: 'fresh',
        trendSource: 'official_aggregate',
        analysisSource: 'fresh',
        dataDir: '/tmp/data',
        steamRequests: 0,
        cacheHits: 0,
      },
      now: new Date('2026-01-06T00:00:00.000Z'),
    });
    expect(report.conclusion.headline).toBe('全部时间好评率 90.0%');
    expect(report.conclusion.summary).toContain('基于 3 条评论样本');
    expect(report.conclusion.caveats.some((c) => c.includes('数字与服务器'))).toBe(false);
  });

  it('scrubs forbidden commercial claims from AI prose', () => {
    const analysis = validateEvidence(
      {
        ...SAMPLE_ANALYSIS,
        conclusion: {
          label: 'AI label',
          headline: '商业成功',
          summary: '销量大涨，但口碑不错。',
          confidence: 'high',
          caveats: ['销量增长'],
        },
      },
      SAMPLE_REVIEWS,
    );
    const report = buildReport({
      game: { appid: 570, name: 'Test Game' },
      filters: {
        languages: ['schinese', 'english'],
        reviewType: 'all',
        sort: 'helpful',
        purchaseType: 'all',
        dateRange: null,
        excludeOffTopic: true,
        useReviewQuality: true,
      },
      clientFilters: {
        minVotes: 0,
        minLength: 0,
        includeKeywords: [],
        excludeKeywords: [],
        excludeEarlyAccess: false,
        excludeFree: false,
      },
      reviews: SAMPLE_REVIEWS,
      trend: TREND,
      summary: SAMPLE_SUMMARY,
      analysis,
      usage: { input: 1, output: 1 },
      aiOptions: AI_OPTIONS,
      includeTranslations: true,
      topReviews: 5,
      methodology: {
        dataSource: 'fresh',
        trendSource: 'official_aggregate',
        analysisSource: 'fresh',
        dataDir: '/tmp/data',
        steamRequests: 0,
        cacheHits: 0,
      },
    });
    expect(report.conclusion.summary).not.toContain('销量大涨');
    expect(report.conclusion.headline).not.toContain('商业成功');
    expect(report.conclusion.caveats.some((c) => c.includes('销量增长'))).toBe(false);
    expect(report.conclusion.caveats.some((c) => c.includes('AI 翻译'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('销量大涨');
  });

  it('marks AI-estimated theme mentions in the Markdown export', () => {
    const analysis = validateEvidence(
      {
        ...SAMPLE_ANALYSIS,
        themes: [{ ...SAMPLE_ANALYSIS.themes[0], mentions: 999 }, SAMPLE_ANALYSIS.themes[1]],
      },
      SAMPLE_REVIEWS,
    );
    const report = buildReport({ ...baseReportInput(), analysis });
    expect(report.ai.appealPoints[0]).toMatchObject({ mentions: 999, mentionsEstimated: true });
    expect(reportToMarkdown(report)).toContain('#### 战斗手感（提及 999，AI 估计）');
  });

  it('scrubs unverifiable numbers and commercial claims from every AI narrative field', () => {
    const analysis = validateEvidence(
      {
        themes: [
          {
            name: '战斗手感 99.9%',
            category: 'gameplay',
            sentiment: 'positive',
            summary: '销量突破 999 万，口碑不错。战斗表现优秀。',
            evidenceIds: ['r1'],
            quotes: [{ reviewId: 'r1', original: 'Combat feels great' }],
          },
          SAMPLE_ANALYSIS.themes[1],
        ],
        expectationGaps: [
          {
            name: '内容量 88%',
            sentiment: 'negative',
            summary: '共 777 条评论认为内容不足。价格偏高。',
            evidenceIds: ['r2'],
            quotes: [],
          },
        ],
        updateImpact: [
          {
            name: '更新影响',
            sentiment: 'positive',
            summary: '在线人数达到 12345 人。性能改善明显。',
            evidenceIds: ['r3'],
            quotes: [],
          },
        ],
        recommendations: [
          { title: '销量提升 66%', detail: '收入翻倍', priority: 'high', evidenceIds: ['r1'] },
          { title: '优化性能', detail: '玩家反馈 42% 卡顿。', priority: 'high', evidenceIds: ['r3'] },
        ],
        conclusion: {
          label: 'x',
          headline: '好评率 90.0%',
          summary: '基于 3 条评论样本，好评率 90.0%。',
          confidence: 'high',
          caveats: ['AI 附加局限'],
        },
      },
      SAMPLE_REVIEWS,
    );
    const report = buildReport({ ...baseReportInput(), analysis });
    // Theme names/summaries...
    expect(report.ai.appealPoints[0].name).not.toContain('99.9');
    expect(report.ai.appealPoints[0].summary).not.toContain('销量');
    expect(report.ai.appealPoints[0].summary).toBe('战斗表现优秀。');
    // ...expectation gaps...
    expect(report.ai.expectationGaps[0].name).toBe('未命名主题');
    expect(report.ai.expectationGaps[0].summary).toBe('价格偏高。');
    // ...update impact...
    expect(report.ai.updateImpact[0].summary).toBe('性能改善明显。');
    // ...and recommendations, where an entirely unverifiable title drops the
    // recommendation instead of leaving a fabricated heading (review R3 Major).
    expect(report.ai.recommendations).toHaveLength(1);
    expect(report.ai.recommendations[0].title).toBe('优化性能');
    expect(report.ai.recommendations[0].detail).toBe('详见证据原文。');
    expect(report.conclusion.caveats).toContain(
      'AI 归纳中的数字与服务器 KPI/趋势不一致，相关句子已删除或降级处理。',
    );
    expect(JSON.stringify(report)).not.toContain('销量突破');
    expect(JSON.stringify(report)).not.toContain('12345');
    expect(JSON.stringify(report)).not.toContain('999 万');
  });

  it('recomputes dynamic caveats on refresh instead of re-merging stale ones', () => {
    const sampleTrend: TrendDataset = { ...TREND, source: 'sample_estimate' };
    const officialKpis = {
      last30d: { total: 50, positive: 40, negative: 10, positiveRate: 0.8 },
      last90d: { total: 250, positive: 220, negative: 30, positiveRate: 0.88 },
      source: 'official_aggregate' as const,
      sources: { last30d: 'official_aggregate' as const, last90d: 'official_aggregate' as const },
    };
    const original = buildReport({ ...baseReportInput(), trend: sampleTrend });
    expect(original.conclusion.caveats).toContain(
      '趋势数据为样本估算，仅作方向参考，不代表 Steam 全站口径。',
    );
    expect(original.conclusion.caveats).toContain('AI 附加局限');

    const refreshed = refreshReport(original, {
      reviews: SAMPLE_REVIEWS,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: officialKpis,
      trend: TREND,
      filters: baseReportInput().filters,
      clientFilters: baseReportInput().clientFilters,
      includeTranslations: false,
      methodology: {
        trendSource: 'official_aggregate',
        steamRequests: 0,
        cacheHits: 1,
        aggregatesComputedAt: '2026-01-01T00:00:00.000Z',
        dataSource: 'fresh',
        dataDir: '/tmp/data',
        datasetFetchedAt: '2026-01-01T00:00:00.000Z',
        reviewsHash: 'c'.repeat(16),
      },
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    // The stale sample-trend warning must not survive an official refresh...
    expect(refreshed.conclusion.caveats).not.toContain(
      '趋势数据为样本估算，仅作方向参考，不代表 Steam 全站口径。',
    );
    // ...while AI-origin and baseline caveats are preserved.
    expect(refreshed.conclusion.caveats).toContain('AI 附加局限');
    for (const base of BASE_CAVEATS) expect(refreshed.conclusion.caveats).toContain(base);
    expect(refreshed.methodology.aggregatesComputedAt).toBe('2026-01-01T00:00:00.000Z');

    // Reverse direction: an official report refreshed from sample trend data
    // gains the current sample warning rather than keeping stale caveats.
    const official = buildReport({ ...baseReportInput() });
    expect(official.conclusion.caveats).not.toContain(
      '趋势数据为样本估算，仅作方向参考，不代表 Steam 全站口径。',
    );
    const sampleRefreshed = refreshReport(official, {
      reviews: SAMPLE_REVIEWS,
      allTimeSummary: SAMPLE_SUMMARY,
      rollingKpis: officialKpis,
      trend: sampleTrend,
      filters: baseReportInput().filters,
      clientFilters: baseReportInput().clientFilters,
      includeTranslations: false,
      methodology: {
        trendSource: 'sample_estimate',
        steamRequests: 0,
        cacheHits: 1,
        dataSource: 'fresh',
        dataDir: '/tmp/data',
        datasetFetchedAt: '2026-01-01T00:00:00.000Z',
        reviewsHash: 'c'.repeat(16),
      },
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(sampleRefreshed.conclusion.caveats).toContain(
      '趋势数据为样本估算，仅作方向参考，不代表 Steam 全站口径。',
    );
    expect(sampleRefreshed.conclusion.caveats).toContain('AI 附加局限');
  });
});
