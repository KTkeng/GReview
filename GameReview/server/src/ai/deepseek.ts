import { AppError, isAppError } from '../lib/errors';
import type { TokenUsage } from '../types';
import { type SleepFn, realSleep } from '../lib/rate-limit';
import { DEFAULT_MODEL, FALLBACK_MODELS } from './pricing';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const CHAT_TIMEOUT_MS = 120000;
export const REDACTED_SECRET = '[REDACTED]';

/**
 * Remove the exact current API key from any upstream-derived text. Providers
 * sometimes echo the Authorization header or request body back in an error
 * payload; such a body must never reach AppError.detail, job snapshots, SSE or
 * logs. Matching the exact value (not only `sk-` prefixes) also covers custom
 * and non-`sk-` keys.
 */
export function redactSecret(text: string, secret: string): string {
  if (!text || !secret) return text;
  return text.split(secret).join(REDACTED_SECRET);
}

const RETRY_DELAYS = [1000, 2000, 4000];

export interface ChatBodyInput {
  model: string;
  system?: string;
  user?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  json?: boolean;
  stream?: boolean;
}

/** Map internal options to the OpenAI-compatible DeepSeek request body (design §8.2). */
export function buildChatBody(input: ChatBodyInput): Record<string, unknown> {
  const messages =
    input.messages && input.messages.length
      ? input.messages
      : [
          { role: 'system' as const, content: input.system ?? '' },
          { role: 'user' as const, content: input.user ?? '' },
        ];
  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    max_tokens: input.maxTokens ?? 4096,
    thinking: { type: input.thinking ? 'enabled' : 'disabled' },
    stream: input.stream ?? false,
  };
  if (input.json !== false) body.response_format = { type: 'json_object' };
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  return body;
}

/** Validate the user-supplied AI base URL: only http/https, no file:/data:. */
export function validateBaseUrl(input?: string): string {
  const raw = (input ?? DEFAULT_BASE_URL).trim();
  if (!raw) throw new AppError('INVALID_PARAMS', 'Base URL 不能为空');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_PARAMS', 'Base URL 格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_PARAMS', 'Base URL 只接受 http/https');
  }
  if (!url.hostname) throw new AppError('INVALID_PARAMS', 'Base URL 缺少主机名');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function baseUrlHost(input?: string): string {
  try {
    return new URL(validateBaseUrl(input)).host;
  } catch {
    return 'invalid';
  }
}

/** Strip Markdown fences and surrounding prose before JSON.parse. */
export function parseJsonLoose(raw: string): unknown {
  if (typeof raw !== 'string' || !raw.trim()) throw new AppError('AI_INVALID_RESPONSE', 'AI 返回为空');
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall back to the outermost object/array.
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new AppError('AI_INVALID_RESPONSE', 'AI 返回不是合法 JSON');
  }
}

export interface AIChatRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  thinking?: boolean;
  json?: boolean;
  signal?: AbortSignal;
}

export interface AIChatResult<T = unknown> {
  data: T;
  usage: TokenUsage;
  raw: string;
}

export interface AITestResult {
  ok: true;
  latencyMs: number;
  models: string[];
}

export interface AIProvider {
  listModels(signal?: AbortSignal): Promise<string[]>;
  testConnection(model?: string, signal?: AbortSignal): Promise<AITestResult>;
  chatJson<T = unknown>(req: AIChatRequest): Promise<AIChatResult<T>>;
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: SleepFn;
  timeoutMs?: number;
  now?: () => number;
}

function mapHttpError(status: number, detail: string): AppError {
  if (status === 401 || status === 403) return new AppError('INVALID_AI_KEY', detail);
  if (status === 429) return new AppError('AI_RATE_LIMITED', detail);
  if (status === 413) return new AppError('AI_CONTEXT_TOO_LARGE', detail);
  return new AppError('AI_INVALID_RESPONSE', detail);
}

function usageOf(raw: unknown): TokenUsage {
  const usage = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).usage : undefined;
  const obj = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};
  const input = Number(obj.prompt_tokens ?? obj.input_tokens ?? 0);
  const output = Number(obj.completion_tokens ?? obj.output_tokens ?? 0);
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 };
}

/**
 * True only for an explicit "this API does not accept the thinking
 * parameter" rejection. Transient or unrelated 400s must not silently retry
 * without thinking (review Major 9).
 */
export function isThinkingUnsupportedError(err: unknown): boolean {
  if (!isAppError(err) || err.code !== 'AI_INVALID_RESPONSE') return false;
  const text = `${err.detail ?? ''}`.toLowerCase();
  if (!text.includes('thinking')) return false;
  return /(unsupported|not\s+support|does\s+not\s+support|unknown|unrecognized|unexpected|invalid|extra)/.test(text);
}

export class DeepSeekProvider implements AIProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: SleepFn;
  private readonly timeoutMs: number;

  constructor(opts: DeepSeekProviderOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) throw new AppError('INVALID_AI_KEY', '缺少 API Key');
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = validateBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Throw before any new network attempt, parameter downgrade or repair call. */
  private ensureActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AppError('CANCELLED');
  }

  private async requestJson(
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    // Never touch the network when the caller already cancelled, and re-check
    // after every asynchronous boundary below.
    if (init.signal?.aborted) throw new AppError('CANCELLED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    timer.unref?.();
    const timeoutMarker = setTimeout(() => {
      timedOut = true;
    }, this.timeoutMs + 5);
    timeoutMarker.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw mapHttpError(response.status, 'AI Key 被拒绝');
      }
      if (response.status === 429) {
        const err = mapHttpError(429, 'AI 请求被限流');
        throw err;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const safe = redactSecret(text, this.apiKey);
        throw mapHttpError(response.status, `AI HTTP ${response.status} ${safe.slice(0, 200)}`);
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new AppError('AI_INVALID_RESPONSE', 'AI 响应不是合法 JSON');
      }
    } catch (err) {
      if (isAppError(err)) {
        // Defence in depth: any provider message that slipped through must lose
        // the current key before it can be stored or logged.
        if (err.detail) {
          const detail = redactSecret(err.detail, this.apiKey);
          if (detail !== err.detail) throw new AppError(err.code, detail);
        }
        throw err;
      }
      if (init.signal?.aborted) throw new AppError('CANCELLED');
      if (timedOut || (err instanceof Error && err.name === 'AbortError')) {
        throw new AppError('AI_TIMEOUT');
      }
      throw new AppError(
        'AI_INVALID_RESPONSE',
        redactSecret(err instanceof Error ? err.message : String(err), this.apiKey),
      );
    } finally {
      clearTimeout(timer);
      clearTimeout(timeoutMarker);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async requestWithRetry(
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      this.ensureActive(init.signal);
      try {
        return await this.requestJson(url, init);
      } catch (err) {
        this.ensureActive(init.signal);
        if (isAppError(err) && err.code === 'AI_RATE_LIMITED' && attempt < RETRY_DELAYS.length) {
          try {
            await this.sleep(RETRY_DELAYS[attempt], init.signal);
          } catch (sleepErr) {
            if (init.signal?.aborted) throw new AppError('CANCELLED');
            throw sleepErr;
          }
          this.ensureActive(init.signal);
          continue;
        }
        throw err;
      }
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const raw = (await this.requestWithRetry(`${this.baseUrl}/models`, { method: 'GET', signal })) as {
      data?: Array<{ id?: unknown }>;
    };
    const models = Array.isArray(raw?.data)
      ? raw.data.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter(Boolean)
      : [];
    if (models.length === 0) throw new AppError('AI_INVALID_RESPONSE', '模型列表为空');
    return models;
  }

  async testConnection(model?: string, signal?: AbortSignal): Promise<AITestResult> {
    const started = Date.now();
    try {
      const models = await this.listModels(signal);
      return { ok: true, latencyMs: Date.now() - started, models };
    } catch (err) {
      if (!isAppError(err) || err.code === 'INVALID_AI_KEY' || err.code === 'CANCELLED') throw err;
      // /models may be unavailable; fall back to a minimal chat call.
      const body = buildChatBody({
        model: model ?? DEFAULT_MODEL,
        system: 'Reply with json.',
        user: '{"ok":true}',
        maxTokens: 8,
        thinking: false,
        json: true,
      });
      const probe = await this.chatOnce(body, signal);
      if (!probe.content.trim()) throw new AppError('AI_INVALID_RESPONSE', 'AI 返回内容为空');
      return { ok: true, latencyMs: Date.now() - started, models: [model ?? DEFAULT_MODEL, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i) };
    }
  }

  private async chatCompletionOnce(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage: TokenUsage; raw: unknown }> {
    const raw = (await this.requestWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      body,
      signal,
    })) as Record<string, unknown>;
    const choices = Array.isArray(raw?.choices) ? (raw.choices as Array<Record<string, unknown>>) : [];
    const message = choices[0]?.message && typeof choices[0].message === 'object' ? (choices[0].message as Record<string, unknown>) : null;
    const content = message && typeof message.content === 'string' ? message.content : '';
    // Empty content is a valid transport result here: chatJson must be able to
    // run its single JSON repair retry with the original (empty) output and
    // account for this call's usage (review Major 9).
    return { content, usage: usageOf(raw), raw };
  }

  private async chatOnce(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; usage: TokenUsage; raw: unknown }> {
    this.ensureActive(signal);
    try {
      return await this.chatCompletionOnce(body, signal);
    } catch (err) {
      // Retry without thinking only when the upstream explicitly rejects that
      // parameter. Unrelated errors must surface as-is (review Major 9).
      this.ensureActive(signal);
      if ('thinking' in body && isThinkingUnsupportedError(err)) {
        const fallback = { ...body };
        delete fallback.thinking;
        this.ensureActive(signal);
        return this.chatCompletionOnce(fallback, signal);
      }
      throw err;
    }
  }

  /**
   * Structured JSON chat with exactly one repair retry (design §8.2).
   * DeepSeek JSON mode can return blank content for unparseable output.
   */
  async chatJson<T = unknown>(req: AIChatRequest): Promise<AIChatResult<T>> {
    this.ensureActive(req.signal);
    const body = buildChatBody({
      model: req.model,
      system: req.system,
      user: req.user,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      thinking: req.thinking,
      json: req.json !== false,
    });
    const first = await this.chatOnce(body, req.signal);
    let usage = { ...first.usage };
    try {
      const data = parseJsonLoose(first.content) as T;
      return { data, usage, raw: first.content };
    } catch (parseError) {
      // The repair call is a second paid request: never issue it after cancel.
      this.ensureActive(req.signal);
      const failedOutput = first.content.trim() ? first.content.slice(0, 12000) : '（模型返回了空内容）';
      const repairBody = buildChatBody({
        model: req.model,
        system: '你是 JSON 修复器。只输出合法 JSON，不得输出解释或 Markdown。',
        user: `下面是一次失败的 JSON 输出：\n${failedOutput}\n\n解析错误：${parseError instanceof Error ? parseError.message : String(parseError)}\n请修复并只输出合法 json。`,
        maxTokens: req.maxTokens,
        temperature: 0,
        // The repair request must use the caller's thinking setting; a silent
        // downgrade would change cost and output semantics.
        thinking: req.thinking,
        json: true,
      });
      this.ensureActive(req.signal);
      const repaired = await this.chatOnce(repairBody, req.signal);
      usage = { input: usage.input + repaired.usage.input, output: usage.output + repaired.usage.output };
      const data = parseJsonLoose(repaired.content) as T;
      return { data, usage, raw: repaired.content };
    }
  }
}
