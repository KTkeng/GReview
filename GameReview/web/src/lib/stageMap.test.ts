import { describe, expect, it } from 'vitest';
import { liveStageDisplayLabel, resolveLiveStage } from './stageMap';

describe('liveStageDisplayLabel', () => {
  it('已知 stage 返回统一中文名', () => {
    expect(liveStageDisplayLabel('fetching_reviews')).toBe('读取/抓取');
    expect(liveStageDisplayLabel('analyzing', 'AI 合并主题中')).toBe('合并 merge');
  });

  it('未知 stage 返回「其他阶段（原始标识）」并保留原文', () => {
    const label = liveStageDisplayLabel('mystery_stage');
    expect(label).toBe('其他阶段（mystery_stage）');
    expect(label).toContain('mystery_stage');
    expect(resolveLiveStage('mystery_stage')).toBeNull();
  });

  it('生命周期值给出中文说明，空值显示等待任务', () => {
    expect(liveStageDisplayLabel('queued')).toBe('排队中');
    expect(liveStageDisplayLabel('cancelled')).toBe('已取消');
    expect(liveStageDisplayLabel(undefined)).toBe('等待任务');
    expect(liveStageDisplayLabel('')).toBe('等待任务');
  });
});
