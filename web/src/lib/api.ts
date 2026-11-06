import type {
  AiTestResult,
  ClientFilters,
  DatasetDetail,
  DatasetListResponse,
  GameResolveResult,
  HealthResult,
  JobSnapshot,
  PreviewResult,
  Report,
  ScrapeFilters,
} from '../types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;

  constructor(code: string, message: string, status = 0, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const NETWORK_MESSAGE =
  '无法连接后端服务，请确认 GReview 服务已启动（默认 http://127.0.0.1:53821）';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  apiKey?: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.apiKey) headers['X-DeepSeek-Key'] = options.apiKey;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') {
      throw new ApiError('ABORTED', '请求已取消', 0);
    }
    throw new ApiError('NETWORK_ERROR', NETWORK_MESSAGE, 0);
  }

  const contentType = response.headers.get('content-type') ?? '';
  let payload: unknown = null;
  if (response.status !== 204) {
    try {
      if (contentType.includes('application/json')) {
        payload = await response.json();
      } else {
        const text = await response.text();
        payload = text ? { raw: text } : null;
      }
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorPayload = (payload as { error?: unknown } | null)?.error;
    if (errorPayload && typeof errorPayload === 'object') {
      const record = errorPayload as { code?: string; message?: string; detail?: unknown };
      throw new ApiError(
        record.code ?? `HTTP_${response.status}`,
        record.message ?? `请求失败（HTTP ${response.status}）`,
        response.status,
        record.detail,
      );
    }
    if (typeof errorPayload === 'string') {
      throw new ApiError(`HTTP_${response.status}`, errorPayload, response.status);
    }
    throw new ApiError(
      `HTTP_${response.status}`,
      `请求失败（HTTP ${response.status}）`,
      response.status,
      (payload as { raw?: string } | null)?.raw,
    );
  }

  return payload as T;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) return new ApiError('UNKNOWN', error.message);
  return new ApiError('UNKNOWN', String(error ?? '未知错误'));
}

export interface JobAiOptions {
  baseUrl?: string;
  model: string;
  temperature?: number;
  thinking: boolean;
}

export interface JobOptions {
  maxReviews: number;
  includeTranslations: boolean;
  topReviews: number;
}

export interface JobDataOptions {
  dataDir?: string;
  reuseDataset?: boolean;
  reuseReport?: boolean;
  forceFetch?: boolean;
  forceAnalyze?: boolean;
}

export interface PreviewRequest {
  appid: number;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  trend: { months: number };
  /**
   * 与 `POST /api/jobs` 相同的 AI 选项。缺省时后端会按 deepseek-flash /
   * thinking=false 估算，导致成本预览与报告复用判断失真。
   */
  ai: JobAiOptions;
  /** 与任务一致的数量与翻译选项，用于 reviewsHash、页数与 token 估算。 */
  options: JobOptions;
  dataDir?: string;
}

export interface CreateJobRequest {
  appid: number;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  trend: { months: number };
  ai: JobAiOptions;
  options: JobOptions;
  data: JobDataOptions;
}

export interface AiTestRequest {
  baseUrl?: string;
  model?: string;
}

export const api = {
  health(signal?: AbortSignal): Promise<HealthResult> {
    return request<HealthResult>('/api/health', { signal });
  },

  resolveGame(url: string, signal?: AbortSignal): Promise<GameResolveResult> {
    return request<GameResolveResult>('/api/game/resolve', {
      method: 'POST',
      body: { url },
      signal,
    });
  },

  preview(body: PreviewRequest, signal?: AbortSignal): Promise<PreviewResult> {
    return request<PreviewResult>('/api/game/preview', {
      method: 'POST',
      body,
      signal,
    });
  },

  testAi(key: string, body: AiTestRequest, signal?: AbortSignal): Promise<AiTestResult> {
    return request<AiTestResult>('/api/ai/test', {
      method: 'POST',
      body,
      apiKey: key,
      signal,
    });
  },

  createJob(key: string, body: CreateJobRequest, signal?: AbortSignal): Promise<{ jobId: string }> {
    return request<{ jobId: string }>('/api/jobs', {
      method: 'POST',
      body,
      apiKey: key,
      signal,
    });
  },

  getJob(jobId: string, signal?: AbortSignal): Promise<JobSnapshot> {
    return request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
  },

  getJobReport(jobId: string, signal?: AbortSignal): Promise<Report> {
    return request<Report>(`/api/jobs/${encodeURIComponent(jobId)}/report`, { signal });
  },

  cancelJob(jobId: string): Promise<{ status: string }> {
    return request<{ status: string }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
  },

  listDatasets(dataDir?: string, signal?: AbortSignal): Promise<DatasetListResponse> {
    return request<DatasetListResponse>('/api/datasets', {
      query: { dataDir: dataDir || undefined },
      signal,
    });
  },

  deleteDataset(
    appid: number,
    reviewsHash: string,
    dataDir?: string,
  ): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(
      `/api/datasets/${encodeURIComponent(String(appid))}/${encodeURIComponent(reviewsHash)}`,
      {
        method: 'DELETE',
        query: { dataDir: dataDir || undefined },
      },
    );
  },

  getDatasetDetail(
    appid: number,
    reviewsHash: string,
    dataDir?: string,
    signal?: AbortSignal,
  ): Promise<DatasetDetail> {
    return request<DatasetDetail>(
      `/api/datasets/${encodeURIComponent(String(appid))}/${encodeURIComponent(reviewsHash)}`,
      {
        query: { dataDir: dataDir || undefined },
        signal,
      },
    );
  },

  /**
   * 读取已保存报告。`topReviews` 仅在响应中从数据集重建 Top N（默认 10，最大 50），
   * 不改写磁盘报告；Top N 不进入 analysisHash，也不会触发 AI 重跑。
   */
  getSavedReport(
    appid: number,
    analysisHash: string,
    dataDir?: string,
    topReviews?: number,
    signal?: AbortSignal,
  ): Promise<Report> {
    return request<Report>(
      `/api/reports/${encodeURIComponent(String(appid))}/${encodeURIComponent(analysisHash)}`,
      {
        query: { dataDir: dataDir || undefined, topReviews },
        signal,
      },
    );
  },

  validateDataDir(dataDir: string): Promise<{ dataDir: string; writable: boolean }> {
    return request<{ dataDir: string; writable: boolean }>('/api/data/validate', {
      method: 'POST',
      body: { dataDir },
    });
  },

  clearData(dataDir?: string): Promise<{ cleared: boolean }> {
    return request<{ cleared: boolean }>('/api/data/clear', {
      method: 'POST',
      body: { dataDir: dataDir || undefined, confirm: true },
    });
  },

  clearCache(appid?: number): Promise<{ cleared: boolean }> {
    return request<{ cleared: boolean }>('/api/cache/clear', {
      method: 'POST',
      body: appid ? { appid } : {},
    });
  },
};

/* ---------------- SSE ---------------- */

export interface JobStreamHandlers {
  onStatus?: (payload: {
    stage?: string;
    progress?: number;
    message?: string;
    counts?: Record<string, number | undefined>;
  }) => void;
  onLog?: (payload: { level?: string; message?: string }) => void;
  onDone?: (payload: { report?: Report }) => void;
  onError?: (payload: { code?: string; message?: string; detail?: unknown }) => void;
  onCancelled?: () => void;
  /** 连接断开（浏览器会自动重连）；用于触发状态快照恢复 */
  onDisconnected?: () => void;
}

/**
 * 订阅任务 SSE。返回取消订阅函数。
 * 服务端在任务结束后会关闭连接；前端仍需以 done/error/cancelled 事件为准。
 */
export function subscribeJob(jobId: string, handlers: JobStreamHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    return () => undefined;
  }

  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
  let closed = false;

  const parse = <T>(event: MessageEvent): T | null => {
    try {
      return JSON.parse(event.data) as T;
    } catch {
      return null;
    }
  };

  const onStatus = (event: MessageEvent) => {
    const payload = parse<Parameters<NonNullable<JobStreamHandlers['onStatus']>>[0]>(event);
    if (payload) handlers.onStatus?.(payload);
  };
  const onLog = (event: MessageEvent) => {
    const payload = parse<{ level?: string; message?: string }>(event);
    if (payload) handlers.onLog?.(payload);
  };
  const onDone = (event: MessageEvent) => {
    const payload = parse<{ report?: Report }>(event);
    if (payload) handlers.onDone?.(payload);
    close();
  };
  const onErrorEvent = (event: MessageEvent) => {
    const payload = parse<{ code?: string; message?: string; detail?: unknown }>(event);
    if (payload) handlers.onError?.(payload);
    close();
  };
  const onCancelled = () => {
    handlers.onCancelled?.();
    close();
  };
  const onConnectionError = () => {
    if (!closed) handlers.onDisconnected?.();
  };

  source.addEventListener('status', onStatus);
  source.addEventListener('log', onLog);
  source.addEventListener('done', onDone);
  source.addEventListener('error', (event) => {
    // 服务端自定义 error 事件带 data；网络错误为 Event
    if (event instanceof MessageEvent && event.data) {
      onErrorEvent(event);
    } else {
      onConnectionError();
    }
  });
  source.addEventListener('cancelled', onCancelled);

  function close() {
    if (!closed) {
      closed = true;
      source.close();
    }
  }

  return () => {
    closed = true;
    source.close();
  };
}
