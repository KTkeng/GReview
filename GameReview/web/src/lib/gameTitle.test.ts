import { describe, expect, it } from 'vitest';
import type { GamePresentation } from '../types';
import {
  TITLE_MAX_CODE_POINTS,
  TITLE_VALIDATION_MESSAGE,
  gameTitleInfo,
  isPlaceholderTitle,
  normalizeTitle,
  resolveGameTitle,
  titleCodePointLength,
  toGamePresentation,
  validateCustomTitle,
} from './gameTitle';

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
    coverUrl: 'https://cdn.example.com/header.jpg',
    coverPlaceholder: 'AppID 570',
    warnings: [],
    ...overrides,
  };
}

describe('标题校验（契约：NFC + trim、1–120 码点、禁换行/控制/双向字符）', () => {
  it('规范化 NFC 并去除首尾空白', () => {
    expect(normalizeTitle('  é  ')).toBe('é');
    const result = validateCustomTitle('  赛博朋克 2077  ');
    expect(result).toEqual({ ok: true, value: '赛博朋克 2077' });
  });

  it('空白输入返回契约文案', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const result = validateCustomTitle(raw);
      expect(result).toEqual({ ok: false, error: TITLE_VALIDATION_MESSAGE });
    }
    expect(TITLE_VALIDATION_MESSAGE).toBe('标题需为 1–120 个字符且不含换行');
  });

  it('按 Unicode 码点计数：120 合法、121 拒绝，代理对只算 1 个字符', () => {
    expect(titleCodePointLength('🎮')).toBe(1);
    expect(TITLE_MAX_CODE_POINTS).toBe(120);

    const allowed = validateCustomTitle('🎮'.repeat(120));
    expect(allowed.ok).toBe(true);

    const tooLong = validateCustomTitle('游'.repeat(121));
    expect(tooLong).toEqual({ ok: false, error: TITLE_VALIDATION_MESSAGE });
  });

  it('拒绝换行、控制字符与双向文本控制字符', () => {
    for (const raw of [
      '第一行\n第二行',
      '制表\t符',
      '控制\u0007字符',
      '方向\u202e欺骗',
      '行分隔\u2028符',
    ]) {
      expect(validateCustomTitle(raw)).toEqual({
        ok: false,
        error: TITLE_VALIDATION_MESSAGE,
      });
    }
  });

  it('正常中文、空格与常见符号可通过', () => {
    expect(validateCustomTitle('艾尔登法环：黄金树幽影')).toEqual({
      ok: true,
      value: '艾尔登法环：黄金树幽影',
    });
    expect(validateCustomTitle('Half-Life 2: Episode One')).toEqual({
      ok: true,
      value: 'Half-Life 2: Episode One',
    });
  });
});

describe('展示标题回退链（自定义 → Steam 原名 → AppID 占位）', () => {
  it('优先使用后端 displayTitle 与 titleSource', () => {
    const info = gameTitleInfo(
      presentation({
        customTitle: '我的 Dota',
        displayTitle: '我的 Dota',
        titleSource: '自定义',
      }),
    );
    expect(info.displayTitle).toBe('我的 Dota');
    expect(info.name).toBe('我的 Dota');
    expect(info.isCustom).toBe(true);
    expect(info.steamName).toBe('Dota 2');
    expect(info.titleRevision).toBe(3);
  });

  it('缺少 displayTitle 时按 customTitle → steamName → AppID 回退', () => {
    expect(
      gameTitleInfo({ appid: 570, name: '', customTitle: '自定义名', steamName: 'Dota 2' })
        .displayTitle,
    ).toBe('自定义名');
    expect(gameTitleInfo({ appid: 570, name: '', steamName: 'Dota 2' }).displayTitle).toBe(
      'Dota 2',
    );
    expect(gameTitleInfo({ appid: 570, name: '' }).displayTitle).toBe('AppID 570');
    expect(resolveGameTitle(null, 730)).toBe('AppID 730');
  });

  it('把 AppID 形式的占位名称视为缺失，不冒充 Steam 原名', () => {
    expect(isPlaceholderTitle('AppID 570', 570)).toBe(true);
    expect(isPlaceholderTitle('570', 570)).toBe(true);
    expect(isPlaceholderTitle('Dota 2', 570)).toBe(false);
    expect(isPlaceholderTitle('   ', 570)).toBe(true);

    const info = gameTitleInfo({ appid: 570, name: 'AppID 570' });
    expect(info.displayTitle).toBe('AppID 570');
    expect(info.steamName).toBeNull();
    expect(info.isCustom).toBe(false);
  });

  it('后端标题不可编辑时保留 titleEditable=false 与 warnings', () => {
    const info = gameTitleInfo(
      presentation({
        titleEditable: false,
        warnings: ['标题文件损坏，已回退到自动标题', '  '],
      }),
    );
    expect(info.titleEditable).toBe(false);
    expect(info.warnings).toEqual(['标题文件损坏，已回退到自动标题']);
  });

  it('兼容旧后端 header_image 封面与自定义 coverPlaceholder', () => {
    const legacy = gameTitleInfo({
      appid: 10,
      name: '旧游戏',
      header_image: 'https://cdn.example.com/legacy.jpg',
    });
    expect(legacy.coverUrl).toBe('https://cdn.example.com/legacy.jpg');
    expect(legacy.coverPlaceholder).toBe('AppID 10');

    const custom = gameTitleInfo({
      appid: 10,
      name: '旧游戏',
      coverPlaceholder: 'AppID 10',
    });
    expect(custom.coverUrl).toBeNull();
    expect(custom.coverPlaceholder).toBe('AppID 10');
  });
});

describe('toGamePresentation', () => {
  it('把旧 GameMeta 归一为统一展示模型', () => {
    const result = toGamePresentation({ appid: 10, name: '传送门 2' }, 10);
    expect(result.appid).toBe(10);
    expect(result.name).toBe('传送门 2');
    expect(result.displayTitle).toBe('传送门 2');
    expect(result.titleSource).toBe('自动读取');
    expect(result.titleRevision).toBe(0);
    expect(result.titleEditable).toBe(true);
    expect(result.coverPlaceholder).toBe('AppID 10');
  });

  it('占位名称归一为「编号占位」', () => {
    const result = toGamePresentation({ appid: 10, name: 'AppID 10' });
    expect(result.displayTitle).toBe('AppID 10');
    expect(result.titleSource).toBe('编号占位');
  });
});
