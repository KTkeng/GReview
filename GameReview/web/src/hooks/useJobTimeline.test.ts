import { describe, expect, it } from 'vitest';
import type { JobState } from '../types';
import {
  LOG_TRUNCATION_MARK,
  MAX_TIMELINE_LOGS,
  MAX_TIMELINE_LOG_CACHE,
  MAX_TIMELINE_LOG_MESSAGE,
  createInitialTimelineState,
  reduceProgress,
} from './useJobTimeline';

describe('reduceProgress 阶段推进', () => {
  it('依次激活 7 阶段并保留固定顺序', () => {
    let state = createInitialTimelineState();
    expect(state.stages.map((stage) => stage.key)).toEqual([
      'fetch',
      'trend',
      'preprocess',
      'ai_map',
      'ai_merge',
      'ai_final',
      'report',
    ]);
    expect(state.stages.every((stage) => stage.status === 'pending')).toBe(true);

    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 10,
      message: '抓取 Steam 评论',
    });
    expect(state.current.key).toBe('fetch');
    expect(state.stages[0].status).toBe('active');

    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_trends',
      progress: 25,
      message: '获取 12 个月官方趋势',
    });
    expect(state.stages[0].status).toBe('done');
    expect(state.stages[1].status).toBe('active');

    state = reduceProgress(state, {
      type: 'status',
      stage: 'preparing',
      progress: 38,
      message: '准备分析样本',
    });
    expect(state.stages[1].status).toBe('done');
    expect(state.stages[2].status).toBe('active');

    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 45,
      message: 'AI 分块分析 1/5',
      counts: { chunks: 5, completed: 0 },
    });
    expect(state.stages[2].status).toBe('done');
    expect(state.stages[3].status).toBe('active');
    expect(state.current.label).toBe('AI 分块 map');

    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 70,
      message: 'AI 合并主题中',
      counts: { chunks: 5 },
    });
    expect(state.stages[3].status).toBe('done');
    expect(state.stages[4].status).toBe('active');
    expect(state.current.key).toBe('ai_merge');

    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 80,
      message: 'AI 生成结论中',
      counts: { chunks: 5 },
    });
    expect(state.stages[4].status).toBe('done');
    expect(state.stages[5].status).toBe('active');
    expect(state.current.key).toBe('ai_final');

    // 后端在 final 之后的 “AI 分析完成” 仍属于 analyzing，不能回退到 map。
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 90,
      message: 'AI 分析完成',
      counts: { chunks: 5, completed: 5 },
    });
    expect(state.current.key).toBe('ai_final');
    expect(state.stages[3].status).toBe('done');
    expect(state.stages[5].status).toBe('active');

    state = reduceProgress(state, {
      type: 'status',
      stage: 'validating',
      progress: 93,
      message: '校验 AI 证据引用',
    });
    expect(state.stages[5].status).toBe('done');
    expect(state.stages[6].status).toBe('active');
    expect(state.current.label).toBe('校验/生成报告');
  });
});

describe('reduceProgress 未观察阶段', () => {
  it('中途进入时未收到事件的前置阶段显示未观察，不推断为已完成', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 55,
      message: 'AI 分块分析 2/5',
    });
    expect(state.current.key).toBe('ai_map');
    expect(state.stages[0].status).toBe('unobserved');
    expect(state.stages[1].status).toBe('unobserved');
    expect(state.stages[2].status).toBe('unobserved');
    expect(state.stages[3].status).toBe('active');
    // 后续阶段尚未收到事件，仍是待开始。
    expect(state.stages[4].status).toBe('pending');
    expect(state.stages[6].status).toBe('pending');
    expect(state.visited).toEqual(['ai_map']);
  });

  it('只有观察过的前置阶段在后续阶段到来时标为已完成', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 10,
      message: '抓取 Steam 评论',
    });
    state = reduceProgress(state, {
      type: 'status',
      stage: 'preparing',
      progress: 38,
      message: '准备分析样本',
    });
    // fetch 观察过 → done；trend 从未观察 → unobserved；不能把 trend 推断成功。
    expect(state.stages[0].status).toBe('done');
    expect(state.stages[1].status).toBe('unobserved');
    expect(state.stages[2].status).toBe('active');
  });
});

describe('reduceProgress 分块计数', () => {
  it('按字段合并 chunks / completed，不补全也不钳制', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 45,
      message: 'AI 分块分析 1/5',
      counts: { chunks: 5, completed: 2 },
    });
    expect(state.chunks).toEqual({ total: 5, completed: 2, invalid: false });

    // 同一 map 阶段后续状态未携带 completed 时保留已有完成数。
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 60,
      message: 'AI 分块分析 3/5',
      counts: { chunks: 5 },
    });
    expect(state.chunks).toEqual({ total: 5, completed: 2, invalid: false });

    // 进入 merge 时不再由前端补全为 5/5；后端未提供就保留 2。
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 70,
      message: 'AI 合并主题中',
      counts: { chunks: 5 },
    });
    expect(state.chunks).toEqual({ total: 5, completed: 2, invalid: false });

    // completed > chunks：标记非法，不钳制。
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 72,
      message: 'AI 分块分析 6/5',
      counts: { chunks: 5, completed: 9 },
    });
    expect(state.chunks).toEqual({ total: 5, completed: 9, invalid: true });

    // 后续合法计数恢复可用。
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 74,
      message: 'AI 分块分析 5/5',
      counts: { chunks: 5, completed: 5 },
    });
    expect(state.chunks).toEqual({ total: 5, completed: 5, invalid: false });
  });

  it('负数或非整数计数标记 invalid，不取整掩盖非法值', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 50,
      message: 'AI 分块分析',
      counts: { chunks: 5, completed: -1 },
    });
    expect(state.chunks.invalid).toBe(true);
    expect(state.chunks.completed).toBe(-1);

    state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 50,
      message: 'AI 分块分析',
      counts: { chunks: 2.5, completed: 1 },
    });
    expect(state.chunks.invalid).toBe(true);
    expect(state.chunks.total).toBe(2.5);
  });

  it('缺少 counts 时保持 null（界面显示暂无分块数据）', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'preprocessing',
      progress: 38,
      message: '准备分析样本',
    });
    expect(state.chunks).toEqual({ total: null, completed: null, invalid: false });
  });
});

describe('reduceProgress 日志缓存', () => {
  it(`缓存最多 ${MAX_TIMELINE_LOG_CACHE} 条，并累计被省略数量`, () => {
    let state = createInitialTimelineState();
    const total = MAX_TIMELINE_LOG_CACHE + 5;
    for (let index = 0; index < total; index += 1) {
      state = reduceProgress(state, {
        type: 'log',
        level: index % 3 === 0 ? 'warn' : 'info',
        message: `日志 ${index}`,
      });
    }
    expect(state.logs).toHaveLength(MAX_TIMELINE_LOG_CACHE);
    expect(state.omittedLogs).toBe(5);
    expect(state.logs[0].message).toBe('日志 5');
    expect(state.logs[state.logs.length - 1].message).toBe(`日志 ${total - 1}`);
    expect(state.logs[0].level).toBe('info');
    // 渲染层仍只渲染最近 200 条。
    expect(MAX_TIMELINE_LOGS).toBe(200);
  });

  it('单条超过 2000 字符时截断并明确标记', () => {
    let state = createInitialTimelineState();
    const longMessage = 'x'.repeat(MAX_TIMELINE_LOG_MESSAGE + 500);
    state = reduceProgress(state, { type: 'log', message: longMessage });
    const stored = state.logs[0].message;
    expect(stored.length).toBe(MAX_TIMELINE_LOG_MESSAGE + LOG_TRUNCATION_MARK.length);
    expect(stored.startsWith('x'.repeat(MAX_TIMELINE_LOG_MESSAGE))).toBe(true);
    expect(stored.endsWith(LOG_TRUNCATION_MARK)).toBe(true);
  });

  it('有 id 时按 id 去重；无 id 时保留重复文本', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, { type: 'log', message: '分块开始', id: 'log-1' });
    state = reduceProgress(state, { type: 'log', message: '分块开始（重放）', id: 'log-1' });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0].message).toBe('分块开始');

    state = reduceProgress(state, { type: 'log', message: '重试成功' });
    state = reduceProgress(state, { type: 'log', message: '重试成功' });
    expect(state.logs).toHaveLength(3);
  });
});

describe('reduceProgress 进度钳制', () => {
  it('progress 钳制在 0–100，不做 0–1 小数换算', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 140,
      message: '异常进度',
    });
    expect(state.current.progress).toBe(100);

    state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: -5,
      message: '异常进度',
    });
    expect(state.current.progress).toBe(0);

    // 0.5 按取整规则显示 1%，而不是 50%。
    state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 0.5,
      message: '小数进度',
    });
    expect(state.current.progress).toBe(1);

    state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 0.4,
      message: '小数进度',
    });
    expect(state.current.progress).toBe(0);
  });

  it('不强制单调递增，非法值才回退上一值', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 55,
      message: '进度 55',
    });
    state = reduceProgress(state, {
      type: 'status',
      stage: 'preparing',
      progress: 20,
      message: '进度回落',
    });
    expect(state.current.progress).toBe(20);

    state = reduceProgress(state, {
      type: 'status',
      stage: 'preparing',
      progress: Number.NaN,
      message: '非法进度',
    });
    expect(state.current.progress).toBe(20);

    state = reduceProgress(state, {
      type: 'status',
      stage: 'preparing',
      progress: undefined,
      message: '缺失进度',
    });
    expect(state.current.progress).toBe(20);
  });
});

describe('reduceProgress 未知 stage', () => {
  it('不崩溃，当前阶段显示「其他阶段（原始标识）」，节点保持待开始', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'mystery_stage',
      progress: 33,
      message: '后端新增阶段',
    });
    expect(state.current.key).toBeNull();
    expect(state.current.rawStage).toBe('mystery_stage');
    expect(state.current.label).toContain('mystery_stage');
    expect(state.current.label).toContain('其他阶段');
    expect(state.current.progress).toBe(33);
    expect(state.stages.every((stage) => stage.status === 'pending')).toBe(true);
  });
});

describe('reduceProgress 终态', () => {
  it('error 事件标记失败节点与错误码，并忽略后续状态', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 55,
      message: 'AI 分块分析 2/5',
      counts: { chunks: 5, completed: 2 },
    });
    state = reduceProgress(state, {
      type: 'error',
      code: 'AI_TIMEOUT',
      message: 'AI 请求超时',
    });
    expect(state.terminal).toBe('failed');
    expect(state.errorCode).toBe('AI_TIMEOUT');
    const failedStage = state.stages.find((stage) => stage.key === 'ai_map');
    expect(failedStage?.status).toBe('failed');
    expect(failedStage?.detail).toContain('AI_TIMEOUT');
    expect(state.logs).toHaveLength(0);

    const after = reduceProgress(state, {
      type: 'status',
      stage: 'generating_report',
      progress: 90,
      message: '不应生效',
    });
    expect(after).toBe(state);
  });

  it('cancelled 事件标记当前节点已取消，未观察节点不会被补成已完成', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'validating',
      progress: 93,
      message: '校验 AI 证据引用',
    });
    state = reduceProgress(state, { type: 'cancelled' });
    expect(state.terminal).toBe('cancelled');
    expect(state.stages[6].status).toBe('cancelled');
    expect(state.stages[6].detail).toBe('已取消');
    expect(state.stages.slice(0, 6).every((stage) => stage.status === 'unobserved')).toBe(true);

    const after = reduceProgress(state, {
      type: 'status',
      stage: 'saving',
      progress: 98,
      message: '保存报告',
    });
    expect(after).toBe(state);
  });

  it('done 事件只把已观察阶段标为已完成，进度 100% 且不补全分块数', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'analyzing',
      progress: 55,
      message: 'AI 分块分析 2/5',
      counts: { chunks: 5, completed: 2 },
    });
    state = reduceProgress(state, { type: 'done' });
    expect(state.terminal).toBe('done');
    expect(state.current.progress).toBe(100);
    // 后端只报告完成 2 块，前端不得自行补成 5。
    expect(state.chunks).toEqual({ total: 5, completed: 2, invalid: false });
    expect(state.stages[3].status).toBe('done');
    // 从未观察的 fetch/trend/preprocess 保持未观察，不能推断为成功。
    expect(state.stages[0].status).toBe('unobserved');
    expect(state.stages[1].status).toBe('unobserved');
    expect(state.stages[2].status).toBe('unobserved');
    // 未执行的 merge/final/report 保持待开始。
    expect(state.stages[4].status).toBe('pending');
    expect(state.stages[5].status).toBe('pending');
    expect(state.stages[6].status).toBe('pending');
  });
});

describe('reduceProgress 复用本地数据/报告', () => {
  it('从 status / log 文案识别跳过阶段，不依赖颜色', () => {
    let state = createInitialTimelineState();
    state = reduceProgress(state, {
      type: 'status',
      stage: 'fetching_reviews',
      progress: 20,
      message: '复用本地数据：200 条，抓取于 2026-01-01',
      counts: { fetched: 200, target: 200 },
    });
    expect(state.stages[0].status).toBe('skipped');
    expect(state.stages[0].detail).toBe('已跳过（复用本地）');

    state = reduceProgress(state, { type: 'log', level: 'info', message: '复用本地趋势 trend-hash' });
    expect(state.stages[1].status).toBe('skipped');

    state = reduceProgress(state, {
      type: 'log',
      level: 'info',
      message: '使用本地分析结果（KPI 已按本次数据刷新），本次未消耗 token',
    });
    expect(state.stages[3].status).toBe('skipped');
    expect(state.stages[4].status).toBe('skipped');
    expect(state.stages[5].status).toBe('skipped');
    expect(state.reusedStages).toContain('ai_map');
  });
});

describe('reduceProgress sync 快照', () => {
  it('把 JobState（含日志与终态）同步进时间线', () => {
    const job: JobState = {
      jobId: 'job-1',
      status: 'running',
      stage: 'analyzing',
      progress: 55,
      message: 'AI 分块分析 2/5',
      counts: { chunks: 5, completed: 1 },
      logs: [
        { level: 'info', message: '抓取完成：200 条' },
        { level: 'warn', message: '有一块重试后成功' },
      ],
    };
    let state = reduceProgress(createInitialTimelineState(), { type: 'sync', job });
    expect(state.jobId).toBe('job-1');
    expect(state.current.key).toBe('ai_map');
    expect(state.logs).toHaveLength(2);
    expect(state.chunks).toEqual({ total: 5, completed: 1, invalid: false });

    state = reduceProgress(state, {
      type: 'sync',
      job: { ...job, status: 'completed', stage: 'completed', progress: 100 },
    });
    expect(state.terminal).toBe('done');
    expect(state.current.progress).toBe(100);
  });

  it('sync 时 jobId 变化先重置旧任务的阶段、计数与日志', () => {
    const first: JobState = {
      jobId: 'job-1',
      status: 'running',
      stage: 'analyzing',
      progress: 55,
      message: 'AI 分块分析 2/5',
      counts: { chunks: 5, completed: 2 },
      logs: [{ level: 'info', message: '旧任务日志' }],
    };
    let state = reduceProgress(createInitialTimelineState(), { type: 'sync', job: first });
    expect(state.jobId).toBe('job-1');

    state = reduceProgress(state, {
      type: 'sync',
      job: {
        jobId: 'job-2',
        status: 'running',
        stage: 'fetching_reviews',
        progress: 12,
        message: '抓取 Steam 评论',
        logs: [],
      },
    });
    expect(state.jobId).toBe('job-2');
    expect(state.current.key).toBe('fetch');
    expect(state.current.progress).toBe(12);
    expect(state.chunks).toEqual({ total: null, completed: null, invalid: false });
    expect(state.logs).toHaveLength(0);
    expect(state.omittedLogs).toBe(0);
    expect(state.stages[0].status).toBe('active');
  });

  it('快照日志超过缓存上限时保留最近 500 条并记录省略数', () => {
    const logs = Array.from({ length: MAX_TIMELINE_LOG_CACHE + 3 }, (_, index) => ({
      level: 'info' as const,
      message: `快照日志 ${index}`,
    }));
    const state = reduceProgress(createInitialTimelineState(), {
      type: 'sync',
      job: { jobId: 'job-log', status: 'running', stage: 'analyzing', progress: 50, logs },
    });
    expect(state.logs).toHaveLength(MAX_TIMELINE_LOG_CACHE);
    expect(state.omittedLogs).toBe(3);
    expect(state.logs[0].message).toBe('快照日志 3');
  });

  it('使用 App 累计的 logOmitted 作为省略数', () => {
    const state = reduceProgress(createInitialTimelineState(), {
      type: 'sync',
      job: {
        jobId: 'job-omitted',
        status: 'running',
        stage: 'analyzing',
        progress: 50,
        logs: [{ level: 'info', message: '当前缓存' }],
        logOmitted: 42,
      },
    });
    expect(state.logs).toHaveLength(1);
    expect(state.omittedLogs).toBe(42);
  });

  it('终态后收到 queued/0/空日志视为重试，重置时间线', () => {
    const failed = reduceProgress(createInitialTimelineState(), {
      type: 'sync',
      job: {
        status: 'failed',
        stage: 'analyzing',
        progress: 55,
        logs: [{ level: 'warn', message: '重试后仍失败' }],
        error: { code: 'AI_TIMEOUT', message: '超时' },
      },
    });
    expect(failed.terminal).toBe('failed');
    expect(failed.logs[0].level).toBe('warn');

    const restarted = reduceProgress(failed, {
      type: 'sync',
      job: { status: 'queued', stage: 'queued', progress: 0, logs: [] },
    });
    expect(restarted.terminal).toBeNull();
    expect(restarted.errorCode).toBeNull();
    expect(restarted.logs).toHaveLength(0);
    expect(restarted.stages.every((stage) => stage.status === 'pending')).toBe(true);
  });
});
