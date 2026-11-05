#!/usr/bin/env node
/**
 * fable-bridge.mjs — 让当前只有 DeepSeek 模型的 agent 环境也能调用 Claude Fable 5。
 *
 * 背景：当前 Claude Code 会话的 Anthropic 端点只接受 deepseek-flash / deepseek-v4-pro；
 * Fable 模型存在于 CC Switch 的 Claude 提供商（默认 https://cocoapi.top），
 * 支持 Anthropic /v1/messages 协议。本脚本负责鉴权、协议调用与 JSON 输出。
 *
 * 密钥解析顺序：
 *   1. 环境变量 FABLE_API_KEY（可配合 FABLE_BASE_URL / FABLE_MODEL）
 *   2. CC Switch 本地数据库 ~/.cc-switch/cc-switch.db 中的 Claude 提供商
 * 密钥只用于 Authorization 头，绝不打印、绝不落盘。
 *
 * 用法：
 *   node tools/fable-bridge.mjs --probe --json
 *   node tools/fable-bridge.mjs --prompt "..." --json
 *   node tools/fable-bridge.mjs --prompt-file instruction.md --json --json-mode
 *   node tools/fable-bridge.mjs --list-providers
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = {
  model: process.env.FABLE_MODEL || 'claude-fable-5',
  baseUrl: process.env.FABLE_BASE_URL || '',
  maxTokens: 4096,
  temperature: 0.2,
  timeoutMs: 180000,
  maxRetries: 2,
};

const DEFAULT_SYSTEM_PROMPT = '始终使用简体中文回复。结构化输出只输出 JSON；JSON 字段名保持英文，提示词明确指定的枚举值（如 approve/revise、blocker/major/minor）保持英文，其余字段值使用简体中文。';

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
    maxRetries: DEFAULTS.maxRetries,
    thinking: false,
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
      case '--json': opts.json = true; break;
      case '--json-mode': opts.jsonMode = true; break;
      case '--probe': opts.probe = true; break;
      case '--list-providers': opts.listProviders = true; break;
      case '--thinking': opts.thinking = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

function readStdinIfAvailable() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
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
  const parts = [DEFAULT_SYSTEM_PROMPT];
  for (const p of opts.systemParts) parts.push(p);
  for (const f of opts.systemFiles) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`system 文件不存在: ${abs}`);
    parts.push(fs.readFileSync(abs, 'utf8'));
  }
  return parts.join('\n\n');
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
      const baseUrl = (env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || '';
      const defaultModel = env.ANTHROPIC_MODEL || '';
      if (!apiKey || !baseUrl) continue;
      const haystack = `${row.name || ''} ${defaultModel} ${baseUrl}`.toLowerCase();
      if (!haystack.includes('claude') || haystack.includes('gpt')) continue;
      candidates.push({
        id: row.id,
        name: row.name,
        baseUrl,
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
    if (/^claude$/i.test(c.name || '')) score += 10;
    if (/fable/i.test(c.defaultModel || '')) score += 5;
    if (/cocoapi/i.test(c.baseUrl || '')) score += 3;
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].c;
}

async function resolveCredentials(opts) {
  if (process.env.FABLE_API_KEY) {
    if (!opts.baseUrl) throw new Error('设置了 FABLE_API_KEY 但没有 FABLE_BASE_URL 或 --base-url');
    return {
      source: 'env',
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
      apiKey: process.env.FABLE_API_KEY,
      model: process.env.FABLE_MODEL || opts.model,
    };
  }

  const loaded = await loadFromCCSwitch();
  const provider = chooseProvider(loaded.candidates);
  if (!provider) {
    throw new Error(loaded.error || '未找到可用的 Claude 提供商；请设置 FABLE_API_KEY + FABLE_BASE_URL + FABLE_MODEL');
  }
  return {
    source: 'cc-switch',
    provider: provider.name,
    baseUrl: (opts.baseUrl || provider.baseUrl).replace(/\/+$/, ''),
    apiKey: provider.apiKey,
    model: opts.model || provider.defaultModel || DEFAULTS.model,
  };
}

function formatHttpError(status, text) {
  const short = String(text || '').replace(/\s+/g, ' ').slice(0, 600);
  if (status === 401 || status === 403) {
    return `Fable 鉴权失败 (${status})：检查 FABLE_API_KEY 或 CC Switch 的 Claude 提供商密钥。${short ? ` 响应: ${short}` : ''}`;
  }
  if (status === 429) {
    return `Fable 请求被限流 (429)：稍后重试或降低并发。${short ? ` 响应: ${short}` : ''}`;
  }
  return `Fable HTTP ${status}${short ? `: ${short}` : ''}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAnthropic(opts, creds, userPrompt, systemPrompt) {
  const url = `${creds.baseUrl}/v1/messages`;
  const system = [systemPrompt, opts.jsonMode ? '只输出一个 JSON 对象；不要输出 Markdown 代码块标记或 JSON 之外的文字。' : '']
    .filter(Boolean)
    .join('\n\n');

  const body = {
    model: creds.model || opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: [{ role: 'user', content: userPrompt }],
    thinking: opts.thinking
      ? { type: 'enabled', budget_tokens: Math.max(1024, Math.min(4096, Math.floor(opts.maxTokens / 2))) }
      : { type: 'disabled' },
  };
  if (system) body.system = system;

  let lastError;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(formatHttpError(res.status, text));
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      const json = JSON.parse(text);
      const content = (json.content || [])
        .filter(block => block && block.type === 'text')
        .map(block => block.text)
        .join('\n');
      return {
        content,
        usage: json.usage || null,
        model: json.model || body.model,
        latencyMs: Date.now() - started,
        stopReason: json.stop_reason || null,
      };
    } catch (e) {
      lastError = e;
      if (!e.retryable || attempt === opts.maxRetries) break;
    }
  }
  throw lastError;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.help) {
    console.log(`fable-bridge — 通过 Anthropic /v1/messages 调用 Claude Fable 5

用法:
  node tools/fable-bridge.mjs --probe --json
  node tools/fable-bridge.mjs --prompt "..." --json
  node tools/fable-bridge.mjs --prompt-file instruction.md --json --json-mode
  node tools/fable-bridge.mjs --list-providers

参数:
  --prompt <text>          提示词（可重复）
  --prompt-file <path>     提示词文件（可重复，按顺序拼接）
  --system <text>          系统提示（可重复）
  --system-file <path>     系统提示文件
  --model <id>             默认 claude-fable-5
  --base-url <url>         默认从 FABLE_BASE_URL 或 CC Switch 读取
  --max-tokens <n>         默认 ${DEFAULTS.maxTokens}
  --temperature <n>        默认 ${DEFAULTS.temperature}
  --timeout-ms <n>         默认 ${DEFAULTS.timeoutMs}
  --json                   输出结构化结果
  --json-mode              要求模型只输出 JSON
  --thinking               开启 thinking（默认关闭，避免 JSON 被思考 token 截断）
  --probe                  最小连通性测试
  --list-providers         列出 CC Switch 中的 Claude 提供商（不回显密钥）

密钥来源:
  FABLE_API_KEY（推荐，显式）> CC Switch 的 ~/.cc-switch/cc-switch.db
`);
    return;
  }

  if (opts.listProviders) {
    const loaded = await loadFromCCSwitch();
    console.log(JSON.stringify({
      dbPath: loaded.dbPath,
      providers: loaded.candidates.map(c => ({
        name: c.name,
        baseUrl: c.baseUrl,
        defaultModel: c.defaultModel,
        hasApiKey: Boolean(c.apiKey),
      })),
      error: loaded.error || undefined,
    }, null, 2));
    return;
  }

  const creds = await resolveCredentials(opts);

  if (opts.probe) {
    const result = await callAnthropic(
      { ...opts, maxTokens: 16, jsonMode: false },
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
      provider: creds.provider,
    }, null, 2));
    return;
  }

  const prompt = buildPrompt(opts);
  const systemPrompt = buildSystem(opts);
  const result = await callAnthropic(opts, creds, prompt, systemPrompt);

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      model: result.model,
      content: result.content,
      usage: result.usage,
      latencyMs: result.latencyMs,
      stopReason: result.stopReason,
      source: creds.source,
      provider: creds.provider,
    }, null, 2));
  } else {
    console.log(result.content);
  }
}

main().catch(e => {
  console.error(JSON.stringify({
    ok: false,
    error: String(e && e.message ? e.message : e),
    status: e && e.status,
  }));
  process.exitCode = 1;
});
