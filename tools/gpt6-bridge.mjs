#!/usr/bin/env node
/**
 * gpt6-bridge.mjs — 让 Claude Code 工作流能够调用 GPT-6 Astra。
 *
 * 背景：CC Switch 的 GPT 中转分组拒绝 Anthropic 的 /v1/messages（403），
 * 但其 OpenAI 兼容接口 /v1/chat/completions 可用。本脚本负责协议转换与鉴权。
 *
 * 密钥解析顺序：
 *   1. 环境变量 GPT6_API_KEY（可配合 GPT6_BASE_URL / GPT6_MODEL）
 *   2. CC Switch 本地数据库 ~/.cc-switch/cc-switch.db 中的 GPT 中转配置
 * 密钥只用于 Authorization 头，绝不打印、绝不落盘。
 *
 * 用法：
 *   node tools/gpt6-bridge.mjs --prompt "..." --json
 *   node tools/gpt6-bridge.mjs --prompt-file instruction.md --prompt-file packet.md --json --json-mode
 *   node tools/gpt6-bridge.mjs --probe --json
 *   node tools/gpt6-bridge.mjs --list-providers
 *   echo "prompt" | node tools/gpt6-bridge.mjs --json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = {
  model: process.env.GPT6_MODEL || 'gpt-6-astra',
  baseUrl: process.env.GPT6_BASE_URL || '',
  maxTokens: 4096,
  temperature: 0.2,
  timeoutMs: 180000,
  maxRetries: 2,
  protocol: 'chat', // chat | responses
};

function parseArgv(argv) {
  const opts = {
    promptParts: [],
    promptFiles: [],
    systemParts: [],
    systemFiles: [],
    json: false,
    jsonMode: false,
    probe: false,
    listProviders: false,
    model: DEFAULTS.model,
    baseUrl: DEFAULTS.baseUrl,
    maxTokens: DEFAULTS.maxTokens,
    temperature: DEFAULTS.temperature,
    timeoutMs: DEFAULTS.timeoutMs,
    protocol: DEFAULTS.protocol,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`缺少参数值: ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--prompt': opts.promptParts.push(next()); break;
      case '--prompt-file': opts.promptFiles.push(next()); break;
      case '--system': opts.systemParts.push(next()); break;
      case '--system-file': opts.systemFiles.push(next()); break;
      case '--model': opts.model = next(); break;
      case '--base-url': opts.baseUrl = next(); break;
      case '--max-tokens': opts.maxTokens = Number(next()); break;
      case '--temperature': opts.temperature = Number(next()); break;
      case '--timeout-ms': opts.timeoutMs = Number(next()); break;
      case '--protocol': opts.protocol = next(); break;
      case '--json': opts.json = true; break;
      case '--json-mode': opts.jsonMode = true; break;
      case '--probe': opts.probe = true; break;
      case '--list-providers': opts.listProviders = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function loadFromCCSwitch() {
  const dbPath = process.env.CC_SWITCH_DB || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (!fs.existsSync(dbPath)) return { dbPath, candidates: [], error: `未找到 CC Switch 数据库: ${dbPath}` };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    return { dbPath, candidates: [], error: `当前 Node 不支持 node:sqlite（需要 Node >= 22.5）: ${e.message}` };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT id, name, app_type, settings_config FROM providers WHERE app_type = 'claude'"
    ).all();

    const candidates = [];
    for (const row of rows) {
      let cfg = {};
      try { cfg = JSON.parse(row.settings_config || '{}'); } catch { continue; }
      const env = cfg.env || cfg;
      const baseUrl = env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL || '';
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || '';
      const defaultModel = env.ANTHROPIC_MODEL || '';
      if (!apiKey) continue;
      const haystack = `${row.name || ''} ${defaultModel} ${baseUrl}`.toLowerCase();
      if (!haystack.includes('gpt')) continue;
      candidates.push({
        id: row.id,
        name: row.name,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey,
        defaultModel,
      });
    }
    return { dbPath, candidates };
  } catch (e) {
    return { dbPath, candidates: [], error: `读取 CC Switch 数据库失败: ${e.message}` };
  } finally {
    try { db?.close(); } catch {}
  }
}

function chooseProvider(candidates) {
  if (!candidates.length) return null;
  const scored = candidates.map(c => {
    let score = 0;
    if (/gpt/i.test(c.name || '')) score += 10;
    if (/cocoapi/i.test(c.baseUrl || '')) score += 3;
    if (/gpt-6/i.test(c.defaultModel || '')) score += 5;
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].c;
}

async function resolveCredentials(opts) {
  const envKey = process.env.GPT6_API_KEY || process.env.CCS_GPT_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: (process.env.GPT6_BASE_URL || opts.baseUrl || 'https://api.cocoapi.top').replace(/\/+$/, ''),
      source: 'env',
      providerName: 'environment',
    };
  }

  const { dbPath, candidates, error } = await loadFromCCSwitch();
  if (error) throw new Error(error);
  const provider = chooseProvider(candidates);
  if (!provider) {
    throw new Error(
      `未在 ${dbPath} 中找到可用的 GPT 中转配置。\n` +
      '请设置环境变量 GPT6_API_KEY（可选 GPT6_BASE_URL / GPT6_MODEL），\n' +
      '或在 CC Switch 中配置一个 name/model 含 "gpt" 的 Claude 应用提供商。'
    );
  }
  return {
    apiKey: provider.apiKey,
    baseUrl: (opts.baseUrl || provider.baseUrl || 'https://api.cocoapi.top').replace(/\/+$/, ''),
    source: 'cc-switch',
    providerName: provider.name,
    defaultModel: provider.defaultModel,
  };
}

function buildPrompt(opts) {
  const parts = [];
  for (const p of opts.promptParts) parts.push(p);
  for (const f of opts.promptFiles) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`prompt 文件不存在: ${abs}`);
    parts.push(fs.readFileSync(abs, 'utf8'));
  }
  if (!parts.length) {
    const stdin = readStdinIfAvailable();
    if (stdin.trim()) parts.push(stdin);
  }
  if (!parts.length) throw new Error('没有 prompt。使用 --prompt、--prompt-file 或通过 stdin 传入。');
  return parts.join('\n\n');
}

function buildSystem(opts) {
  const parts = [];
  for (const p of opts.systemParts) parts.push(p);
  for (const f of opts.systemFiles) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`system 文件不存在: ${abs}`);
    parts.push(fs.readFileSync(abs, 'utf8'));
  }
  return parts.join('\n\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callChat(opts, creds, userPrompt, systemPrompt) {
  const url = `${creds.baseUrl}/v1/chat/completions`;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    stream: false,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  let lastError;
  for (let attempt = 0; attempt <= DEFAULTS.maxRetries; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(formatHttpError(res.status, text, creds.baseUrl));
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      let data;
      try { data = JSON.parse(text); } catch {
        throw new Error(`上游返回了非 JSON 响应（HTTP ${res.status}）: ${text.slice(0, 300)}`);
      }
      if (data.error) {
        throw new Error(`上游返回错误: ${JSON.stringify(data.error).slice(0, 500)}`);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`响应中没有 choices[0].message.content: ${text.slice(0, 300)}`);
      }
      return {
        content,
        usage: data.usage || null,
        finishReason: data.choices?.[0]?.finish_reason || null,
        latencyMs: Date.now() - started,
        model: data.model || opts.model,
        attempts: attempt + 1,
      };
    } catch (e) {
      lastError = e;
      if (!e.retryable || attempt === DEFAULTS.maxRetries) break;
    }
  }
  throw lastError;
}

async function callResponses(opts, creds, userPrompt, systemPrompt) {
  const url = `${creds.baseUrl}/v1/responses`;
  const input = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    : userPrompt;

  const body = {
    model: opts.model,
    input,
    max_output_tokens: opts.maxTokens,
  };

  let lastError;
  for (let attempt = 0; attempt <= DEFAULTS.maxRetries; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(formatHttpError(res.status, text, creds.baseUrl));
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      const data = JSON.parse(text);
      const content =
        data.output_text ||
        data.output?.flatMap(o => o.content || []).map(c => c.text || '').join('') ||
        '';
      if (!content) throw new Error(`Responses 响应中没有文本输出: ${text.slice(0, 300)}`);
      return {
        content,
        usage: data.usage || null,
        finishReason: data.status || null,
        latencyMs: Date.now() - started,
        model: data.model || opts.model,
        attempts: attempt + 1,
      };
    } catch (e) {
      lastError = e;
      if (!e.retryable || attempt === DEFAULTS.maxRetries) break;
    }
  }
  throw lastError;
}

function formatHttpError(status, body, baseUrl) {
  const snippet = String(body || '').slice(0, 600);
  if (status === 403) {
    return (
      `HTTP 403（上游网关拒绝）。baseUrl=${baseUrl}\n` +
      '若提示 "This group does not allow /v1/messages dispatch"，说明该中转分组只允许 OpenAI 协议；' +
      '本 bridge 已使用 /v1/chat/completions，请确认 baseUrl 指向 GPT 中转而不是 Claude 分组。\n' +
      `上游响应: ${snippet}`
    );
  }
  if (status === 401) {
    return `HTTP 401 鉴权失败，请检查 GPT6_API_KEY 或 CC Switch 中的 GPT 中转密钥。上游响应: ${snippet}`;
  }
  return `HTTP ${status} 调用 ${baseUrl} 失败。上游响应: ${snippet}`;
}

function printHelp() {
  console.log(`gpt6-bridge — 通过 OpenAI 兼容协议调用 GPT-6 Astra

选项:
  --prompt <text>          追加一段 prompt（可重复）
  --prompt-file <path>     追加一个 prompt 文件（可重复，按顺序拼接）
  --system <text>          系统提示（可重复）
  --system-file <path>     系统提示文件
  --model <id>             默认 gpt-6-astra（或环境变量 GPT6_MODEL）
  --base-url <url>         ｜默认读取 CC Switch GPT 中转配置
  --max-tokens <n>         默认 4096
  --temperature <n>        默认 0.2
  --timeout-ms <n>         默认 180000
  --protocol chat|responses  默认 chat（chat = /v1/chat/completions）
  --json                   输出结构化结果（包含 usage / latencyMs）
  --json-mode              要求模型返回 JSON（response_format=json_object）
  --probe                  发送最小连通性测试
  --list-providers         列出 CC Switch 中识别到的 GPT 中转提供商（不回显密钥）

密钥来源:
  GPT6_API_KEY（推荐，显式） > CC Switch 的 ~/.cc-switch/cc-switch.db
`);
}

function printProviders(candidates, dbPath) {
  const safe = candidates.map(c => ({
    name: c.name,
    baseUrl: c.baseUrl,
    defaultModel: c.defaultModel,
    hasApiKey: Boolean(c.apiKey),
  }));
  console.log(JSON.stringify({ dbPath, providers: safe }, null, 2));
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.listProviders) {
    const { dbPath, candidates, error } = await loadFromCCSwitch();
    if (error) throw new Error(error);
    printProviders(candidates, dbPath);
    return;
  }

  const creds = await resolveCredentials(opts);

  if (opts.probe) {
    const result = await callChat(
      { ...opts, maxTokens: 32, jsonMode: false },
      creds,
      'Reply with exactly: OK',
      'You are a connectivity probe. Reply with exactly OK.'
    );
    console.log(JSON.stringify({
      ok: true,
      mode: 'probe',
      model: result.model,
      content: result.content.trim(),
      usage: result.usage,
      latencyMs: result.latencyMs,
      source: creds.source,
      provider: creds.providerName,
    }, null, 2));
    return;
  }

  const userPrompt = buildPrompt(opts);
  const systemPrompt = buildSystem(opts);
  const call = opts.protocol === 'responses' ? callResponses : callChat;
  const result = await call(opts, creds, userPrompt, systemPrompt);

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      model: result.model,
      content: result.content,
      usage: result.usage,
      finishReason: result.finishReason,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      source: creds.source,
      provider: creds.providerName,
    }));
  } else {
    process.stdout.write(result.content);
    if (!result.content.endsWith('\n')) process.stdout.write('\n');
  }
}

main().catch(err => {
  const payload = { ok: false, error: err.message };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(`[gpt6-bridge] ${err.message}`);
  }
  process.exit(1);
});
