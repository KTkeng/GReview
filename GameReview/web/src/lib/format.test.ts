import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCostUsd,
  formatLanguages,
  formatNumber,
  formatPercent,
  formatPlaytimeHours,
  formatSeconds,
  gameName,
  languageName,
  normalizeRate,
  periodLabel,
  truncateText,
} from './format';

describe('数值格式化', () => {
  it('formatNumber 处理空值与非法值', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });

  it('normalizeRate 兼容 0-1 与 0-100', () => {
    expect(normalizeRate(0.5)).toBe(50);
    expect(normalizeRate(80)).toBe(80);
    expect(normalizeRate(null)).toBeNull();
  });

  it('formatPercent 输出百分比', () => {
    expect(formatPercent(0.875)).toBe('87.5%');
    expect(formatPercent(80)).toBe('80.0%');
    expect(formatPercent(80, 0)).toBe('80%');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('formatCostUsd 处理小额与零', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.0012)).toBe('$0.0012');
    expect(formatCostUsd(0.0123)).toBe('$0.012');
    expect(formatCostUsd(1.5)).toBe('$1.50');
    expect(formatCostUsd(undefined)).toBe('—');
  });

  it('formatSeconds 输出人类可读时间', () => {
    expect(formatSeconds(3.25)).toBe('3.3 秒');
    expect(formatSeconds(45)).toBe('45 秒');
    expect(formatSeconds(90)).toBe('1 分 30 秒');
    expect(formatSeconds(120)).toBe('2 分钟');
  });

  it('formatBytes 输出单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('文本与游戏信息', () => {
  it('gameName 兼容字符串、对象与缺省值', () => {
    expect(gameName('Dota 2')).toBe('Dota 2');
    expect(gameName({ appid: 570, name: 'Dota 2' })).toBe('Dota 2');
    expect(gameName({ appid: 570, name: '' })).toBe('AppID 570');
    expect(gameName(null)).toBe('未知游戏');
  });

  it('语言与时长展示', () => {
    expect(languageName('schinese')).toBe('简中');
    expect(languageName('klingon')).toBe('klingon');
    expect(formatLanguages(['schinese', 'english'])).toBe('简中 + 英文');
    expect(formatLanguages([])).toBe('全部语言');
    expect(formatPlaytimeHours(12.34)).toBe('12.3 小时');
  });

  it('periodLabel 与 truncateText', () => {
    expect(periodLabel('2025-11')).toBe('2025-11');
    expect(periodLabel('2025-Q4')).toBe('2025-Q4');
    expect(truncateText('abcdef', 3)).toBe('abc…');
    expect(truncateText('abc', 3)).toBe('abc');
  });
});
