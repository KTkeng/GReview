import { describe, expect, it } from 'vitest';
import {
  canonicalStage,
  STAGE_ALIASES,
  STAGE_LABELS,
  STAGE_SEQUENCE,
} from './defaults';

describe('canonicalStage', () => {
  it('把后端的趋势阶段名映射到前端五阶段', () => {
    expect(canonicalStage('fetching_trends')).toBe('fetching_trend');
  });

  it('把后端的预处理、分析、校验与保存阶段映射到前端阶段', () => {
    expect(canonicalStage('preparing')).toBe('preprocessing');
    expect(canonicalStage('analyzing')).toBe('ai_analyzing');
    expect(canonicalStage('validating')).toBe('generating_report');
    expect(canonicalStage('saving')).toBe('generating_report');
  });

  it('resolving 归入抓取准备阶段', () => {
    expect(canonicalStage('resolving')).toBe('fetching_reviews');
  });

  it('已经标准的阶段名保持不变', () => {
    expect(canonicalStage('fetching_reviews')).toBe('fetching_reviews');
    expect(canonicalStage('ai_analyzing')).toBe('ai_analyzing');
    expect(canonicalStage(undefined)).toBeUndefined();
  });

  it('每个后端阶段都有可读标签', () => {
    const backendStages = [
      'resolving',
      'fetching_reviews',
      'fetching_trends',
      'preparing',
      'analyzing',
      'validating',
      'saving',
      'completed',
      'cancelled',
    ];
    for (const stage of backendStages) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
    }
  });

  it('别名都指向五阶段中的合法阶段', () => {
    const keys = new Set(STAGE_SEQUENCE.map((stage) => stage.key));
    for (const target of Object.values(STAGE_ALIASES)) {
      expect(keys.has(target)).toBe(true);
    }
  });

  it('五阶段顺序包含抓取、趋势、预处理、AI 与报告', () => {
    expect(STAGE_SEQUENCE.map((stage) => stage.key)).toEqual([
      'fetching_reviews',
      'fetching_trend',
      'preprocessing',
      'ai_analyzing',
      'generating_report',
    ]);
    expect(STAGE_SEQUENCE).toHaveLength(5);
  });
});
