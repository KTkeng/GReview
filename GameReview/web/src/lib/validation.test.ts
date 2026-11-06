import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_PATH_MESSAGE,
  INVALID_LINK_MESSAGE,
  SOURCE_DIR_MESSAGE,
  extractAppId,
  parseKeywordList,
  validateConfig,
  validateDataDir,
  validateDateRange,
  validateMaxReviews,
  validatePlaytimeRange,
} from './validation';
import { DEFAULT_CONFIG } from './defaults';
import type { AnalysisConfig } from '../types';

describe('extractAppId', () => {
  it('接受纯 AppID', () => {
    expect(extractAppId('570')).toBe(570);
    expect(extractAppId('  730  ')).toBe(730);
  });

  it('从 Steam 商店与社区链接提取 AppID', () => {
    expect(extractAppId('https://store.steampowered.com/app/570/Dota_2/')).toBe(570);
    expect(extractAppId('https://store.steampowered.com/app/730/?l=schinese')).toBe(730);
    expect(extractAppId('https://steamcommunity.com/app/570')).toBe(570);
    expect(extractAppId('https://www.steamcommunity.com/app/570/discussions/')).toBe(570);
    expect(extractAppId('https://www.store.steampowered.com/app/570/')).toBe(570);
    expect(extractAppId('https://help.steampowered.com/app/570/')).toBe(570);
  });

  it('拒绝非 Steam 链接、非法协议与非法 AppID', () => {
    expect(extractAppId('')).toBeNull();
    expect(extractAppId('abc123')).toBeNull();
    expect(extractAppId('https://evil.example.com/app/570')).toBeNull();
    expect(extractAppId('ftp://store.steampowered.com/app/570')).toBeNull();
    expect(extractAppId('https://store.steampowered.com/app/abc')).toBeNull();
    expect(extractAppId('0')).toBeNull();
    expect(extractAppId('4294967296')).toBeNull();
    expect(extractAppId('2147483648')).toBeNull();
  });

  it('接受与后端契约一致的 AppID 上限', () => {
    expect(extractAppId('2147483647')).toBe(2147483647);
  });

  it('提取非法链接时给出统一文案', () => {
    expect(extractAppId('not-a-link')).toBeNull();
    expect(INVALID_LINK_MESSAGE).toBe('链接或 AppID 无效');
  });
});

describe('validateDataDir', () => {
  it('空值表示使用默认目录', () => {
    expect(validateDataDir('')).toBeNull();
    expect(validateDataDir('   ')).toBeNull();
  });

  it('要求绝对路径', () => {
    expect(validateDataDir('data/reviews')).toBe(ABSOLUTE_PATH_MESSAGE);
    expect(validateDataDir('./data')).toBe(ABSOLUTE_PATH_MESSAGE);
  });

  it('拒绝路径穿越与源码目录', () => {
    expect(validateDataDir('D:/data/../secrets')).toBe('路径不能包含 ..');
    expect(validateDataDir('D:/GReview/web/src/assets')).toBe(SOURCE_DIR_MESSAGE);
    expect(validateDataDir('D:/GReview/server/src/data')).toBe(SOURCE_DIR_MESSAGE);
    expect(validateDataDir('D:/work/node_modules/pkg')).toBe(SOURCE_DIR_MESSAGE);
    expect(validateDataDir('/home/user/.git/objects')).toBe(SOURCE_DIR_MESSAGE);
  });

  it('接受常见绝对路径', () => {
    expect(validateDataDir('D:\\GReview\\data')).toBeNull();
    expect(validateDataDir('/var/lib/greview')).toBeNull();
    expect(validateDataDir('\\\\server\\share\\greview')).toBeNull();
  });
});

describe('其他校验', () => {
  it('校验抓取数量', () => {
    expect(validateMaxReviews(200)).toBeNull();
    expect(validateMaxReviews(0)).not.toBeNull();
    expect(validateMaxReviews(1001)).not.toBeNull();
    expect(validateMaxReviews(1.5)).not.toBeNull();
  });

  it('校验游玩时长与日期范围', () => {
    expect(validatePlaytimeRange(1, 10)).toBeNull();
    expect(validatePlaytimeRange(10, 1)).not.toBeNull();
    expect(validatePlaytimeRange(-1, undefined)).not.toBeNull();
    expect(validateDateRange({ start: 1, end: 2 })).toBeNull();
    expect(validateDateRange({ start: 2 })).not.toBeNull();
    expect(validateDateRange({ start: 2, end: 1 })).not.toBeNull();
  });

  it('解析关键词列表', () => {
    expect(parseKeywordList('卡顿, 闪退；联机  掉线')).toEqual(['卡顿', '闪退', '联机', '掉线']);
  });
});

describe('validateConfig', () => {
  const base: AnalysisConfig = {
    ...DEFAULT_CONFIG,
    gameUrl: 'https://store.steampowered.com/app/570/',
    apiKey: 'sk-test',
  };

  it('必填项齐全时通过', () => {
    expect(validateConfig(base, 570).valid).toBe(true);
  });

  it('缺少 API Key 或 AppID 时给出错误', () => {
    const noKey = { ...base, apiKey: '' };
    expect(validateConfig(noKey, 570).errors.apiKey).toBeTruthy();
    expect(validateConfig(base, null).errors.game).toBeTruthy();
  });

  it('数据目录不合法时给出错误', () => {
    const invalidDir = { ...base, dataDir: 'relative/path' };
    expect(validateConfig(invalidDir, 570).errors.dataDir).toBe(ABSOLUTE_PATH_MESSAGE);
  });
});
