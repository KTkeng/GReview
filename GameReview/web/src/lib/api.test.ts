import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamePresentation } from '../types';
import { ApiError, api } from './api';

const game: GamePresentation = {
  appid: 570,
  name: '我的 Dota',
  steamName: 'Dota 2',
  customTitle: '我的 Dota',
  displayTitle: '我的 Dota',
  titleSource: '自定义',
  titleRevision: 4,
  titleUpdatedAt: '2026-01-02T00:00:00.000Z',
  titleEditable: true,
  coverUrl: null,
  coverPlaceholder: 'AppID 570',
  warnings: [],
};

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function jsonResponse(status: number, body: unknown): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, body: string): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'text/markdown; charset=utf-8' },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PATCH /api/datasets/:appid/title', () => {
  it('发送严格请求体与 expectedRevision，并返回 GamePresentation', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { game, changed: true }),
    );

    const result = await api.updateDatasetTitle(
      570,
      { customTitle: '我的 Dota', expectedRevision: 3 },
      'D:/GReview/data',
    );

    expect(result).toEqual({ game, changed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/datasets/570/title?dataDir=D%3A%2FGReview%2Fdata');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      customTitle: '我的 Dota',
      expectedRevision: 3,
    });
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual([
      'customTitle',
      'expectedRevision',
    ]);
  });

  it('恢复默认发送 customTitle: null', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { game, changed: true }));

    await api.updateDatasetTitle(570, { customTitle: null, expectedRevision: 4 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/datasets/570/title');
    expect(JSON.parse(String(init.body))).toEqual({
      customTitle: null,
      expectedRevision: 4,
    });
  });

  it('409 冲突把 currentGame 与 field 暴露给调用方，不自动覆盖', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'TITLE_CONFLICT',
          message: '标题已被其他窗口修改',
          field: 'expectedRevision',
          currentGame: {
            ...game,
            displayTitle: '其他窗口的标题',
            titleRevision: 5,
          },
        },
      }),
    );

    let caught: unknown;
    try {
      await api.updateDatasetTitle(570, { customTitle: '我的草稿', expectedRevision: 3 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.code).toBe('TITLE_CONFLICT');
    expect(apiError.status).toBe(409);
    expect(apiError.field).toBe('expectedRevision');
    expect(apiError.currentGame?.displayTitle).toBe('其他窗口的标题');
    expect(apiError.currentGame?.titleRevision).toBe(5);
  });

  it('409 标题文件损坏时 currentGame 为空', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: 'TITLE_CORRUPTED', message: '标题文件损坏' },
      }),
    );

    await expect(
      api.updateDatasetTitle(570, { customTitle: '草稿', expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: 'TITLE_CORRUPTED',
      status: 409,
      currentGame: undefined,
    });
  });
});

describe('GET /api/reports/:appid/:analysisHash?format=markdown', () => {
  it('读取服务端按当前展示报告生成的 Markdown 文本', async () => {
    fetchMock.mockResolvedValue(textResponse(200, '# GReview 报告：我的 Dota\n'));

    const markdown = await api.getReportMarkdown(570, 'abc123', 'D:/data');

    expect(markdown).toBe('# GReview 报告：我的 Dota\n');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method ?? 'GET').toBe('GET');
    const parsed = new URL(url, 'http://127.0.0.1:53821');
    expect(parsed.pathname).toBe('/api/reports/570/abc123');
    expect(parsed.searchParams.get('format')).toBe('markdown');
    expect(parsed.searchParams.get('dataDir')).toBe('D:/data');
  });

  it('非 2xx 响应转换为 ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: { code: 'REPORT_NOT_FOUND', message: '报告不存在' },
      }),
    );

    await expect(api.getReportMarkdown(570, 'missing')).rejects.toMatchObject({
      code: 'REPORT_NOT_FOUND',
      status: 404,
    });
  });
});
