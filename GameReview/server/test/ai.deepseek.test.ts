import { describe, expect, it } from 'vitest';
import {
  DeepSeekProvider,
  buildChatBody,
  parseJsonLoose,
  validateBaseUrl,
  baseUrlHost,
} from '../src/ai/deepseek';
import { AppError } from '../src/lib/errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chatResponse(content: string, prompt = 10, completion = 5): Response {
  return jsonResponse({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  });
}

function provider(fetchImpl: typeof fetch, opts: { timeoutMs?: number; sleeps?: number[] } = {}): DeepSeekProvider {
  return new DeepSeekProvider({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl,
    timeoutMs: opts.timeoutMs ?? 2000,
    sleep: async (ms) => {
      opts.sleeps?.push(ms);
    },
  });
}

const request = { model: 'deepseek-flash', system: 'sys', user: 'user', maxTokens: 128, thinking: true };

describe('DeepSeek request body and base URL', () => {
  it('maps thinking and JSON mode', () => {
    const body = buildChatBody({ ...request, thinking: true });
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      max_tokens: 128,
      stream: false,
      thinking: { type: 'enabled' },
      response_format: { type: 'json_object' },
    });
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('system');
    expect(body.temperature).toBeUndefined();

    const plain = buildChatBody({ ...request, thinking: false, json: false, temperature: 0.2 });
    expect(plain.thinking).toEqual({ type: 'disabled' });
    expect(plain.response_format).toBeUndefined();
    expect(plain.temperature).toBe(0.2);
  });

  it('only accepts http/https base URLs', () => {
    expect(validateBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(validateBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
    expect(baseUrlHost('https://api.deepseek.com')).toBe('api.deepseek.com');
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow('INVALID_PARAMS');
    expect(() => validateBaseUrl('data:text/plain,hi')).toThrow('INVALID_PARAMS');
    expect(() => validateBaseUrl('ftp://example.com')).toThrow('INVALID_PARAMS');
    expect(() => validateBaseUrl('not a url')).toThrow('INVALID_PARAMS');
    expect(baseUrlHost('file:///etc/passwd')).toBe('invalid');
    expect(() => new DeepSeekProvider({ apiKey: '', baseUrl: 'https://api.deepseek.com' })).toThrow(
      'INVALID_AI_KEY',
    );
  });

  it('parses fenced or prose-wrapped JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here is the result: {"a":[1,2]} thanks')).toEqual({ a: [1, 2] });
    expect(() => parseJsonLoose('')).toThrow('AI_INVALID_RESPONSE');
    expect(() => parseJsonLoose('just words')).toThrow('AI_INVALID_RESPONSE');
  });
});

describe('DeepSeek error mapping', () => {
  it('maps 401/403 to INVALID_AI_KEY without retrying', async () => {
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      return jsonResponse({ error: 'unauthorized' }, 401);
    }) as unknown as typeof fetch);
    await expect(p.chatJson(request)).rejects.toThrow('INVALID_AI_KEY');
    expect(calls).toBe(1);
  });

  it('backs off on 429 and exhausts to AI_RATE_LIMITED', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const p = provider(
      (async () => {
        calls += 1;
        return jsonResponse({ error: 'rate limited' }, 429);
      }) as unknown as typeof fetch,
      { sleeps },
    );
    await expect(p.chatJson(request)).rejects.toThrow('AI_RATE_LIMITED');
    expect(calls).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('recovers when a 429 is followed by success', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const p = provider(
      (async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, 429);
        return chatResponse('{"ok":true}');
      }) as unknown as typeof fetch,
      { sleeps },
    );
    const result = await p.chatJson<{ ok: boolean }>(request);
    expect(result.data.ok).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('maps aborts caused by timeout to AI_TIMEOUT', async () => {
    const p = provider(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch,
      { timeoutMs: 20 },
    );
    await expect(p.chatJson(request)).rejects.toThrow('AI_TIMEOUT');
  });

  it('propagates caller cancellation as CANCELLED', async () => {
    const controller = new AbortController();
    const p = provider(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          controller.abort();
        })) as unknown as typeof fetch,
      { timeoutMs: 5000 },
    );
    await expect(p.chatJson({ ...request, signal: controller.signal })).rejects.toThrow('CANCELLED');
  });
});

describe('DeepSeek JSON repair', () => {
  it('repairs invalid JSON exactly once and accumulates usage', async () => {
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      if (calls === 1) return chatResponse('not json at all', 10, 5);
      return chatResponse('{"themes":[]}', 7, 3);
    }) as unknown as typeof fetch);
    const result = await p.chatJson<{ themes: unknown[] }>(request);
    expect(result.data).toEqual({ themes: [] });
    expect(result.usage).toEqual({ input: 17, output: 8 });
    expect(calls).toBe(2);
  });

  it('throws AI_INVALID_RESPONSE when the single repair also fails', async () => {
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      return chatResponse('still not json');
    }) as unknown as typeof fetch);
    await expect(p.chatJson(request)).rejects.toThrow('AI_INVALID_RESPONSE');
    expect(calls).toBe(2);
  });

  it('repairs an empty response exactly once and accumulates both usages', async () => {
    let calls = 0;
    const bodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
    const p = provider((async (_url: string, init: RequestInit) => {
      calls += 1;
      bodies.push(JSON.parse(String(init.body)) as { messages?: Array<{ role: string; content: string }> });
      if (calls === 1) return chatResponse('', 10, 5);
      return chatResponse('{"ok":true}', 7, 3);
    }) as unknown as typeof fetch);
    const result = await p.chatJson<{ ok: boolean }>(request);
    expect(result.data).toEqual({ ok: true });
    // Empty output must go through the one repair flow, and the first call's
    // billed usage must not be dropped (review Major 9).
    expect(calls).toBe(2);
    expect(result.usage).toEqual({ input: 17, output: 8 });
    expect(bodies[1].messages?.[1].content).toContain('模型返回了空内容');
  });

  it('throws AI_INVALID_RESPONSE when an empty response is not repaired', async () => {
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      return chatResponse('', 10, 5);
    }) as unknown as typeof fetch);
    await expect(p.chatJson(request)).rejects.toThrow('AI_INVALID_RESPONSE');
    expect(calls).toBe(2);
  });

  it('does not retry without thinking for unrelated 400 errors', async () => {
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'bad request: malformed messages' } }, 400);
    }) as unknown as typeof fetch);
    await expect(p.chatJson(request)).rejects.toThrow('AI_INVALID_RESPONSE');
    expect(calls).toBe(1);
  });

  it('retries once without the thinking parameter when the model rejects it', async () => {
    const bodies: unknown[] = [];
    const p = provider((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ('thinking' in body) {
        return jsonResponse({ error: { message: 'thinking is not supported' } }, 400);
      }
      return chatResponse('{"ok":true}');
    }) as unknown as typeof fetch);
    const result = await p.chatJson<{ ok: boolean }>(request);
    expect(result.data.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect('thinking' in (bodies[0] as object)).toBe(true);
    expect('thinking' in (bodies[1] as object)).toBe(false);
  });

  it('does not leak the API key in thrown messages', async () => {
    const p = provider((async () => {
      return jsonResponse({ error: 'nope' }, 400);
    }) as unknown as typeof fetch);
    try {
      await p.chatJson(request);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('AI_INVALID_RESPONSE');
      expect(String((err as Error).message)).not.toContain('sk-test');
      expect(String((err as AppError).detail ?? '')).not.toContain('sk-test');
    }
  });

  it('redacts a non-sk API key echoed in an upstream error body', async () => {
    const key = 'local-relay-token-9f3a';
    const p = new DeepSeekProvider({
      apiKey: key,
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () => {
        // Providers sometimes echo the Authorization header back in the body.
        return jsonResponse({ error: { message: `invalid api key: ${key}`, key } }, 400);
      }) as unknown as typeof fetch,
      timeoutMs: 2000,
      sleep: async () => undefined,
    });
    try {
      await p.chatJson(request);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('AI_INVALID_RESPONSE');
      expect(String((err as AppError).detail)).toContain('[REDACTED]');
      expect(String((err as AppError).detail)).not.toContain(key);
      expect(String((err as Error).message)).not.toContain(key);
    }
  });

  it('redacts a non-sk API key from transport exception messages', async () => {
    const key = 'local-relay-token-9f3a';
    const p = new DeepSeekProvider({
      apiKey: key,
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () => {
        throw new Error(`socket failed while sending Bearer ${key}`);
      }) as unknown as typeof fetch,
      timeoutMs: 2000,
      sleep: async () => undefined,
    });
    try {
      await p.chatJson(request);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(String((err as AppError).detail)).toContain('[REDACTED]');
      expect(String((err as AppError).detail)).not.toContain(key);
    }
  });
});

describe('DeepSeek cancellation boundaries', () => {
  it('never touches the network when the signal is already aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const p = provider((async () => {
      calls += 1;
      return chatResponse('{"ok":true}');
    }) as unknown as typeof fetch);
    await expect(p.chatJson({ ...request, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(calls).toBe(0);
  });

  it('does not issue the paid repair call when cancelled after the first response', async () => {
    const controller = new AbortController();
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      return {
        status: 200,
        ok: true,
        json: async () => {
          // The first response has fully arrived; cancellation now happens
          // before the repair request would be built or sent.
          controller.abort();
          return {
            choices: [{ message: { role: 'assistant', content: 'this is not valid json' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      } as unknown as Response;
    }) as unknown as typeof fetch);
    await expect(p.chatJson({ ...request, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(calls).toBe(1);
  });

  it('does not downgrade the thinking parameter after cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    const p = provider((async () => {
      calls += 1;
      return {
        status: 400,
        ok: false,
        text: async () => {
          controller.abort();
          return JSON.stringify({ error: { message: 'thinking is not supported' } });
        },
      } as unknown as Response;
    }) as unknown as typeof fetch);
    await expect(p.chatJson({ ...request, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(calls).toBe(1);
  });

  it('keeps the caller thinking setting on the JSON repair request', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const p = provider((async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (bodies.length === 1) return chatResponse('not json');
      return chatResponse('{"ok":true}');
    }) as unknown as typeof fetch);
    const result = await p.chatJson<{ ok: boolean }>({ ...request, thinking: true });
    expect(result.data.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].thinking).toEqual({ type: 'enabled' });
    expect(bodies[1].temperature).toBe(0);
  });
});
