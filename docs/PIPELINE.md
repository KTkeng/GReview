# GReview 三模型工作流

> 本文档描述三模型开发流水线设施；产品使用说明见根 [README.md](../README.md)。

这是一个面向 Claude Code `Workflow` 引擎的三模型协作流水线：

| 角色 | 模型 | 职责 |
| --- | --- | --- |
| 前端设计与验收 | `claude-fable-5` | 页面/组件/设计 token、验收清单、最终前端验收 |
| 后端架构与监督 | `gpt-6-astra` | 数据模型、API 契约、实现审查、驱动修复 |
| 具体实现 | `deepseek-v4.1-flash` | 前后端编码、集成、按监督/验收意见修复、写报告 |

> 当前目录只包含工作流设施，不包含具体产品代码。运行主流水线时通过参数传入需求即可。

## 目录

```text
D:/GReview
├─ .claude/
│  ├─ commands/
│  │  ├─ greview.md          # /greview <需求> 运行主流水线
│  │  └─ verify-greview.md   # /verify-greview 运行冒烟验证
│  └─ workflows/
│     ├─ greview-pipeline.js # 主流水线（设计 → 实现 → 监督 → 验收 → 报告）
│     └─ greview-smoke.js    # 三模型冒烟验证（不构建项目）
├─ tools/
│  └─ gpt6-bridge.mjs        # GPT-6 OpenAI 协议桥
└─ README.md
```

## 为什么 GPT-6 需要 bridge

实测（本机 CC Switch 聚合环境）：

- `claude-fable-5`、`deepseek-v4.1-flash` 可通过 `agent({ model })` 原生调用；
- `gpt-6-astra` 的 Anthropic 协议被上游拒绝：
  `403 This group does not allow /v1/messages dispatch`；
- 同一密钥的 OpenAI 协议可用：
  `POST https://api.cocoapi.top/v1/chat/completions` → 200，且支持 `response_format: json_object`。

因此工作流里所有 GPT-6 调用都经过 `tools/gpt6-bridge.mjs`。桥接是"传输代理"模式：一个轻量 agent 只负责把提示词写入临时文件、执行 bridge、把 GPT-6 的回复逐字返回，不做二次创作。

## 快速验证

### 方式一：斜杠命令

```text
/verify-greview
```

### 方式二：直接对话

```text
运行 greview-smoke 工作流
```

### 方式三：只验证 GPT-6 连通性

```bash
node tools/gpt6-bridge.mjs --probe --json
```

期望输出包含 `"ok": true`、`"model": "gpt-6-astra"`、`"content": "OK"`。

### 方式四：查看 bridge 识别到的提供商

```bash
node tools/gpt6-bridge.mjs --list-providers
```

冒烟验证检查四项：

1. `fableDesign`：Fable 返回结构化前端规格；
2. `deepseekImplement`：DeepSeek 返回后端 + 前端代码片段；
3. `gpt6Bridge`：GPT-6 经 bridge 返回可解析的监督 JSON；
4. `fableAcceptance`：Fable 返回结构化验收结论。

四项全真时 `ok: true`。

## 运行主流水线

```text
/greview 做一个支持 Markdown 的团队周报应用：登录、周报编辑、评论、按人筛选
```

或显式传参：

```js
Workflow({
  name: 'greview-pipeline',
  args: {
    requirement: '需求描述',
    projectRoot: 'D:/GReview',
    frontendDir: 'web',
    backendDir: 'server',
    stack: 'React + Vite / Node + Express（可选）',
    maxRounds: 3
  }
})
```

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `requirement` | 必填 | 需求规格；为空时流水线直接返回提示 |
| `projectRoot` | `D:/GReview` | 工程根目录 |
| `frontendDir` | `web` | 前端目录（相对 projectRoot） |
| `backendDir` | `server` | 后端目录 |
| `stack` | 未指定 | 技术栈提示；不填则由架构阶段决定 |
| `maxRounds` | `3` | 后端监督 / 前端验收各自的最大修复轮次（1–5） |
| `bridgePath` | `D:/GReview/tools/gpt6-bridge.mjs` | GPT-6 bridge 路径 |

## 主流水线阶段

1. **Contract**
   - Fable 产出前端设计（页面、组件、状态、tokens、验收清单）；
   - GPT-6 产出后端架构（数据模型、API 契约、安全、测试策略、验收清单）；
   - Fable 合并为 `.greview/contract.json` 与 `.greview/contract.md`，API 契约以 GPT-6 为准。
2. **Build**
   - DeepSeek 并行实现 `server/` 与 `web/`（目录隔离，避免写冲突）；
   - DeepSeek 集成检查：跑测试/构建、核对前后端字段。
3. **Backend Review**
   - DeepSeek 收集审查包（变更、源码、真实测试输出、敏感信息剔除）；
   - GPT-6 经 bridge 审查，输出 `verdict` + `findings`；
   - 有 blocker/major 时 DeepSeek 修复，循环至通过或达到 `maxRounds`。
4. **Frontend Acceptance**
   - Fable 直接读源码、跑构建、按验收清单检查（环境允许时可截图）；
   - 不通过则由 DeepSeek 修复，循环。
5. **Report**
   - DeepSeek 写入 `reports/acceptance-report.md`；
   - 返回 `backend.status`、`frontend.status`、轮次历史与未解决问题。

状态值：`approved` / `accepted` 为通过；`needs_attention` 表示达到轮次上限或存在未解决问题；`error` 表示 agent 或 bridge 失败。

## GPT-6 Bridge

GPT-6 默认使用简体中文回复；JSON 字段名与提示词指定的枚举值保持英文，其余字段值用中文。

```bash
# 最小连通性测试
node tools/gpt6-bridge.mjs --probe --json

# 单提示词 + JSON 模式
node tools/gpt6-bridge.mjs --prompt "审查这段代码..." --json --json-mode

# 指令 + 上下文（按顺序拼接）
node tools/gpt6-bridge.mjs \
  --prompt-file instruction.md \
  --prompt-file review-packet.md \
  --json --json-mode --max-tokens 3000

# 查看提供商（不回显密钥）
node tools/gpt6-bridge.mjs --list-providers
```

密钥解析顺序：

1. 环境变量 `GPT6_API_KEY`（推荐；可配合 `GPT6_BASE_URL`、`GPT6_MODEL`）；
2. `~/.cc-switch/cc-switch.db` 中名称/模型/地址含 `gpt` 的 Claude 提供商配置。

密钥只用于 `Authorization` 头，不打印、不落盘。工作流中的临时提示词与审查包写入 `.greview/`，请勿提交真实密钥。

## 重要限制

- **数据外发**：GPT-6 监督会把审查包（后端源码、测试输出）发送到 GPT 中转服务。敏感项目请先脱敏，或改用 `Fable 兼任监督` 方案。
- **Token 开销**：实测 GPT-6 中转每次调用约有 4k–22k 的隐式 prompt 开销。流水线已尽量合并调用（架构 1 次 + 每轮监督 1 次），仍建议控制 `maxRounds`。
- **CC Switch 依赖**：bridge 默认从 CC Switch 数据库读取 GPT 中转配置；若换机器，设置 `GPT6_API_KEY` / `GPT6_BASE_URL` 即可脱离该依赖。
- **原生模型调用**：`deepseek-v4.1-flash` 实际模型 ID 为 `ccs-claude-deepseek--deepseek-flash[1M]`；`claude-fable-5` 为 `ccs-claude-claude--claude-fable-5`。这些 ID 来自本机 CC Switch 聚合配置，换环境需同步修改工作流常量。
- **文件修改**：主流水线会真实写文件。建议在 git 仓库中运行，便于回滚。
- **验收边界**：GPT-6 的 `approve` 是后端监督结论；Fable 的 `accept` 是前端验收结论。最终 `ok` 需要两者同时通过。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `403 This group does not allow /v1/messages dispatch` | 用了 Anthropic 协议调 GPT。bridge 已改用 `/v1/chat/completions`；确认 `baseUrl` 指向 GPT 中转 |
| `401` | `GPT6_API_KEY` 或 CC Switch 中的 GPT 密钥无效 |
| `未找到 CC Switch 数据库` | 设置 `GPT6_API_KEY` + `GPT6_BASE_URL` |
| `agent 返回 null` | 对应模型调用失败；查看 `/workflows` 或 transcript 中的错误 |
| GPT-6 输出无法解析 | 已启用 `--json-mode`；仍失败时监督轮次会标记 `needs_attention`，不会无限循环 |
| Fable 验收无法启动预览 | 验收 agent 会退化为静态审查 + 构建验证，不强行安装浏览器依赖 |
