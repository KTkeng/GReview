export const meta = {
  name: 'greview-pipeline',
  description: 'Fable 前端设计/验收 + GPT-6 后端监督 + DeepSeek 实现的三模型开发流水线',
  whenToUse: '传入需求规格后，由 claude-fable-5（经 fable-bridge）负责前端设计与最终验收、gpt-6-astra 负责后端架构与实现监督、deepseek-flash 负责具体编码与修复',
  phases: [
    { title: 'Contract', detail: 'Fable 前端设计 + GPT-6 后端架构，合并为契约' },
    { title: 'Build', detail: 'DeepSeek 实现后端与前端并集成' },
    { title: 'Backend Review', detail: 'GPT-6 监督后端实现并驱动修复' },
    { title: 'Frontend Acceptance', detail: 'Fable 验收前端并驱动修复' },
    { title: 'Report', detail: '汇总验收报告' },
  ],
}

const MODEL_DEEPSEEK = 'deepseek-flash'
const FABLE_MODEL = 'claude-fable-5'

const input = (typeof args === 'object' && args !== null) ? args : { requirement: typeof args === 'string' ? args : '' }
const requirement = String(input.requirement || input.spec || '').trim()
const projectRoot = String(input.projectRoot || 'D:/GReview').replace(/\/+$/, '')
const workDir = `${projectRoot}/.greview`
const bridgePath = input.bridgePath || 'D:/GReview/tools/gpt6-bridge.mjs'
const fableBridgePath = input.fableBridgePath || 'D:/GReview/tools/fable-bridge.mjs'
const specPath = String(input.specPath || '').trim()
const specHint = specPath
  ? `设计文档：${specPath}。实现前先阅读设计文档；契约是摘要，冲突时以设计文档为准。`
  : '设计文档：需求描述即规格。'
const stackHint = String(input.stack || '未指定。由架构阶段选择成熟、可测试、依赖少的方案。')
const maxRounds = Math.min(Math.max(Number(input.maxRounds) || 3, 1), 5)
const frontendDir = String(input.frontendDir || 'web')
const backendDir = String(input.backendDir || 'server')

if (!requirement) {
  return {
    ok: false,
    needsInput: true,
    message: '缺少需求。请以 args 传入 { "requirement": "需求描述", "projectRoot": "D:/GReview" }，或使用 /greview <需求> 运行。',
  }
}

// ---------- schemas ----------

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          purpose: { type: 'string' },
          components: { type: 'array', items: { type: 'string' } },
          states: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'purpose', 'components', 'states'],
      },
    },
    designTokens: {
      type: 'object',
      properties: {
        colors: { type: 'array', items: { type: 'string' } },
        typography: { type: 'array', items: { type: 'string' } },
        spacing: { type: 'array', items: { type: 'string' } },
      },
      required: ['colors', 'typography', 'spacing'],
    },
    acceptanceChecklist: { type: 'array', items: { type: 'string' } },
  },
  required: ['overview', 'pages', 'designTokens', 'acceptanceChecklist'],
}

const BACKEND_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    architecture: { type: 'string' },
    stack: { type: 'array', items: { type: 'string' } },
    dataModels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'fields'],
      },
    },
    apiEndpoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          request: { type: 'string' },
          response: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['method', 'path', 'request', 'response', 'errors'],
      },
    },
    security: { type: 'array', items: { type: 'string' } },
    testStrategy: { type: 'string' },
    acceptanceChecklist: { type: 'array', items: { type: 'string' } },
  },
  required: ['architecture', 'stack', 'dataModels', 'apiEndpoints', 'security', 'testStrategy', 'acceptanceChecklist'],
}

const CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    frontendPlan: { type: 'string' },
    backendPlan: { type: 'string' },
    apiContract: { type: 'array', items: { type: 'string' } },
    integrationNotes: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    contractPath: { type: 'string' },
    designPath: { type: 'string' },
  },
  required: ['summary', 'frontendPlan', 'backendPlan', 'apiContract', 'integrationNotes', 'openQuestions', 'contractPath', 'designPath'],
}

const CONTRACT_DATA_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    frontendPlan: { type: 'string' },
    backendPlan: { type: 'string' },
    apiContract: { type: 'array', items: { type: 'string' } },
    integrationNotes: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'frontendPlan', 'backendPlan', 'apiContract', 'integrationNotes', 'openQuestions'],
}

const WRITE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    contractPath: { type: 'string' },
    designPath: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['contractPath', 'designPath', 'summary'],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'string' } },
    testOutput: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['ok', 'filesTouched', 'commands', 'testOutput', 'failures', 'notes'],
}

const PACKET_SCHEMA = {
  type: 'object',
  properties: {
    packetPath: { type: 'string' },
    fileCount: { type: 'number' },
    byteCount: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['packetPath', 'fileCount', 'byteCount', 'summary'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'string' } },
    testOutput: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['ok', 'changedFiles', 'commands', 'testOutput', 'notes'],
}

const ACCEPTANCE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'revise'] },
    passedCriteria: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          issue: { type: 'string' },
          requiredChange: { type: 'string' },
        },
        required: ['severity', 'issue', 'requiredChange'],
      },
    },
    evidence: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['verdict', 'passedCriteria', 'findings', 'evidence', 'summary'],
}

const BRIDGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    content: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok', 'content'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    reportPath: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['reportPath', 'summary'],
}

// ---------- helpers ----------

function parseLooseJson(text) {
  if (!text) return null
  const raw = String(text).trim()
  try { return JSON.parse(raw) } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) } catch {}
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

function safeLabel(label) {
  return String(label).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
}

function bridgeWrapperPrompt({ instruction, context, contextPath, instructionPath, extraFiles, maxTokens, tag }) {
  const writeContext = context != null
    ? `3) 用 Write 工具把下方 <<<CONTEXT>>> 与 <<<END CONTEXT>>> 之间的内容【逐字原样】写入文件：\n   ${contextPath}\n`
    : ''
  const contextSection = context != null
    ? `\n<<<CONTEXT>>>\n${context}\n<<<END CONTEXT>>>\n`
    : ''
  const contextArgs = []
  if (context != null) contextArgs.push(`--prompt-file "${contextPath}"`)
  for (const f of extraFiles || []) contextArgs.push(`--prompt-file "${f}"`)

  return `你是 GPT-6 Astra 的传输代理（transport wrapper）。你自己不要做任何评审、分析、改写或补充。

步骤：
1) 用 Bash 运行：mkdir -p "${workDir}"
2) 用 Write 工具把下方 <<<INSTRUCTION>>> 与 <<<END INSTRUCTION>>> 之间的内容【逐字原样】写入文件：
   ${instructionPath}
${writeContext}4) 用 Bash 运行：
   node "${bridgePath}" --prompt-file "${instructionPath}" ${contextArgs.join(' ')} --json --json-mode --max-tokens ${maxTokens}
5) 该命令会输出一行 JSON（形如 {"ok":true,"content":"..."}）。
   - 成功：返回 { ok: true, content: <content 字段原文>, error: "" }
   - 失败：返回 { ok: false, content: "", error: <命令输出中的 error> }
禁止改写、总结、翻译、评价 GPT-6 的输出；content 必须逐字复制。

<<<INSTRUCTION>>>
${instruction}
<<<END INSTRUCTION>>>
${contextSection}
本次传输标识：${tag}
`
}

async function askGpt6({ label, phaseName, instruction, context, contextFiles, maxTokens, includeSpec = true }) {
  const tag = safeLabel(label)
  const instructionPath = `${workDir}/gpt6-${tag}.instruction.md`
  const contextPath = context != null ? `${workDir}/gpt6-${tag}.context.md` : null
  const extraFiles = [...(contextFiles || [])]
  if (includeSpec && specPath) extraFiles.push(specPath)
  const wrapperPrompt = bridgeWrapperPrompt({
    instruction,
    context,
    contextPath,
    instructionPath,
    extraFiles,
    maxTokens: maxTokens || 3000,
    tag,
  })
  const bridged = await agent(wrapperPrompt, {
    label: `gpt6:${tag}`,
    phase: phaseName,
    model: MODEL_DEEPSEEK,
    effort: 'low',
    schema: BRIDGE_RESULT_SCHEMA,
  })
  const parsed = bridged && bridged.ok ? parseLooseJson(bridged.content) : null
  return {
    ok: Boolean(bridged && bridged.ok && parsed),
    bridged,
    parsed,
    raw: bridged ? bridged.content : '',
    error: bridged ? (bridged.error || '') : 'bridge wrapper 未返回结果',
  }
}

function fableWrapperPrompt({ instruction, context, contextPath, instructionPath, extraFiles, maxTokens, tag }) {
  const writeContext = context != null
    ? `3) 用 Write 工具把下方 <<<CONTEXT>>> 与 <<<END CONTEXT>>> 之间的内容【逐字原样】写入文件：\n   ${contextPath}\n`
    : ''
  const contextSection = context != null
    ? `\n<<<CONTEXT>>>\n${context}\n<<<END CONTEXT>>>\n`
    : ''
  const contextArgs = []
  if (context != null) contextArgs.push(`--prompt-file "${contextPath}"`)
  for (const f of extraFiles || []) contextArgs.push(`--prompt-file "${f}"`)

  return `你是 Claude Fable 5 的传输代理（transport wrapper）。你自己不要做任何设计、评审、分析、改写或补充。

步骤：
1) 用 Bash 运行：mkdir -p "${workDir}"
2) 用 Write 工具把下方 <<<INSTRUCTION>>> 与 <<<END INSTRUCTION>>> 之间的内容【逐字原样】写入文件：
   ${instructionPath}
${writeContext}4) 用 Bash 运行：
   node "${fableBridgePath}" --prompt-file "${instructionPath}" ${contextArgs.join(' ')} --json --json-mode --max-tokens ${maxTokens}
5) 该命令会输出一行 JSON（形如 {"ok":true,"content":"..."}）。
   - 成功：返回 { ok: true, content: <content 字段原文>, error: "" }
   - 失败：返回 { ok: false, content: "", error: <命令输出中的 error> }
禁止改写、总结、翻译、评价 Fable 的输出；content 必须逐字复制。

<<<INSTRUCTION>>>
${instruction}
<<<END INSTRUCTION>>>
${contextSection}
本次传输标识：${tag}
`
}

async function askFable({ label, phaseName, instruction, context, contextFiles, maxTokens, includeSpec = true }) {
  const tag = safeLabel(label)
  const instructionPath = `${workDir}/fable-${tag}.instruction.md`
  const contextPath = context != null ? `${workDir}/fable-${tag}.context.md` : null
  const extraFiles = [...(contextFiles || [])]
  if (includeSpec && specPath) extraFiles.push(specPath)
  const wrapperPrompt = fableWrapperPrompt({
    instruction,
    context,
    contextPath,
    instructionPath,
    extraFiles,
    maxTokens: maxTokens || 6000,
    tag,
  })
  const bridged = await agent(wrapperPrompt, {
    label: `fable:${tag}`,
    phase: phaseName,
    model: MODEL_DEEPSEEK,
    effort: 'low',
    schema: BRIDGE_RESULT_SCHEMA,
  })
  const parsed = bridged && bridged.ok ? parseLooseJson(bridged.content) : null
  return {
    ok: Boolean(bridged && bridged.ok && parsed),
    bridged,
    parsed,
    raw: bridged ? bridged.content : '',
    error: bridged ? (bridged.error || '') : 'Fable bridge wrapper 未返回结果',
  }
}

function isDesign(obj) {
  return Boolean(
    obj &&
    typeof obj.overview === 'string' &&
    Array.isArray(obj.pages) &&
    obj.pages.every(p => p && typeof p.name === 'string' && typeof p.purpose === 'string' &&
      Array.isArray(p.components) && Array.isArray(p.states)) &&
    obj.designTokens &&
    Array.isArray(obj.designTokens.colors) &&
    Array.isArray(obj.designTokens.typography) &&
    Array.isArray(obj.designTokens.spacing) &&
    Array.isArray(obj.acceptanceChecklist)
  )
}

function isContractData(obj) {
  return Boolean(
    obj &&
    typeof obj.summary === 'string' &&
    typeof obj.frontendPlan === 'string' &&
    typeof obj.backendPlan === 'string' &&
    Array.isArray(obj.apiContract) &&
    Array.isArray(obj.integrationNotes) &&
    Array.isArray(obj.openQuestions)
  )
}

function isAcceptance(obj) {
  return Boolean(
    obj &&
    (obj.verdict === 'accept' || obj.verdict === 'revise') &&
    Array.isArray(obj.passedCriteria) &&
    Array.isArray(obj.findings) &&
    obj.findings.every(f => f && ['blocker', 'major', 'minor'].includes(f.severity) &&
      typeof f.issue === 'string' && typeof f.requiredChange === 'string') &&
    Array.isArray(obj.evidence) &&
    typeof obj.summary === 'string'
  )
}

function reviewJsonBlock() {
  return `输出严格 JSON，不要输出 JSON 以外的任何文字：
{"verdict":"approve"|"revise","findings":[{"severity":"blocker"|"major"|"minor","file":"相对路径","issue":"问题","requiredChange":"必须的修改"}],"summary":"一句话结论"}
判定：存在 blocker 或 major 时必须 revise；只有 minor 时可 approve，但仍需列出。`
}

// ---------- Phase: Contract ----------

phase('Contract')
log('阶段 1/5 · Fable 负责前端设计，GPT-6 负责后端架构')

const designResult = await askFable({
  label: 'fable:design',
  phaseName: 'Contract',
  instruction: `你是 claude-fable-5，负责前端界面设计与最终验收。请为下面的需求产出可执行的前端设计方案。

需求：
${requirement}

工程根目录：${projectRoot}
前端目录：${frontendDir}
技术栈提示：${stackHint}

要求：
- 页面/组件拆分要能直接指导实现；
- designTokens 给出具体颜色值、字体、间距；
- acceptanceChecklist 必须可验证（可观察、可断言），不要写"体验良好"这类空话；
- 只做设计，不写实现代码；不要写文件，只返回 JSON。

输出严格 JSON（不要 Markdown 代码块），结构必须匹配以下 JSON Schema：
${JSON.stringify(DESIGN_SCHEMA, null, 2)}`,
  maxTokens: 12000,
})

const design = designResult.parsed
if (!designResult.ok || !isDesign(design)) {
  return {
    ok: false,
    error: 'Fable 前端设计阶段失败',
    detail: designResult.error || String(designResult.raw || '').slice(0, 2000),
  }
}

const backendInstruction = `你是 GPT-6 Astra，负责后端架构与实现监督。请基于需求给出可执行的后端方案。

需求：
${requirement}

工程根目录：${projectRoot}
后端目录：${backendDir}
技术栈提示：${stackHint}

要求：
- apiEndpoints 要给出 method/path/request/response/errors，前端可以据此编码；
- 明确数据模型、安全边界、测试策略；
- acceptanceChecklist 必须可验证；
- 不要写完整实现代码，只给架构与契约。

输出严格 JSON，不要输出 JSON 以外的任何文字，结构如下：
{"architecture":"...","stack":["..."],"dataModels":[{"name":"...","fields":["..."]}],"apiEndpoints":[{"method":"GET","path":"/api/...","request":"...","response":"...","errors":["..."]}],"security":["..."],"testStrategy":"...","acceptanceChecklist":["..."]}`

const backendArch = await askGpt6({
  label: 'backend-architecture',
  phaseName: 'Contract',
  instruction: backendInstruction,
  context: `需求原文：\n${requirement}`,
  maxTokens: 4000,
})

if (!backendArch.ok || !backendArch.parsed) {
  return {
    ok: false,
    error: 'GPT-6 后端架构阶段失败',
    detail: backendArch.error || backendArch.raw || '无法解析 GPT-6 的 JSON 输出',
  }
}

const backendPlan = backendArch.parsed

const contractResult = await askFable({
  label: 'fable:contract',
  phaseName: 'Contract',
  instruction: `你是 claude-fable-5，负责前端设计，并作为设计与后端契约的对齐者。请把上下文中的前端设计与 GPT-6 后端方案合并为一份实现契约。

要求：
1. 后端 apiContract 以 GPT-6 方案为准，不得擅自改动路径/字段；如前端有额外需求，写入 integrationNotes 或 openQuestions；
2. frontendPlan 要整合设计稿与 API 契约，明确数据如何流入组件；
3. 不要写文件，只返回 JSON。

输出严格 JSON（不要 Markdown 代码块），结构必须匹配以下 JSON Schema：
${JSON.stringify(CONTRACT_DATA_SCHEMA, null, 2)}`,
  context: JSON.stringify({ requirement, design, gpt6BackendPlan: backendPlan }, null, 2),
  maxTokens: 16000,
})

const contractData = contractResult.parsed
if (!contractResult.ok || !isContractData(contractData)) {
  return {
    ok: false,
    error: '契约合并阶段失败（Fable 返回不可解析）',
    detail: contractResult.error || String(contractResult.raw || '').slice(0, 2000),
  }
}

const contractWrite = await agent(
  `你是 DeepSeek V4.1 Flash，负责把已对齐的契约落盘。工程根目录：${projectRoot}。

请用 Write 工具创建目录并写两个文件：
- ${workDir}/contract.json：自包含契约，至少包含 design、backendPlan（GPT-6 对象）、summary、frontendPlan、backendPlanText、apiContract、integrationNotes、openQuestions
- ${workDir}/contract.md：人类可读版本，包含需求摘要、页面/组件、API 契约、数据模型、集成注意事项、开放问题

数据：
${JSON.stringify({ design, gpt6BackendPlan: backendPlan, contractData }, null, 2)}

返回 contractPath（.json）与 designPath（.md）的绝对路径。`,
  { label: 'deepseek:write-contract', phase: 'Contract', model: MODEL_DEEPSEEK, effort: 'medium', schema: WRITE_RESULT_SCHEMA }
)

if (!contractWrite || !contractWrite.contractPath || !contractWrite.designPath) {
  return { ok: false, error: '契约落盘阶段失败（DeepSeek 未返回路径）' }
}

const contract = {
  ...contractData,
  contractPath: contractWrite.contractPath,
  designPath: contractWrite.designPath,
}

// ---------- Phase: Build ----------

phase('Build')
log('阶段 2/5 · DeepSeek 负责具体实现（后端与前端并行，随后集成）')

const buildBase = `你是 DeepSeek V4.1 Flash，负责具体实现。工程根目录：${projectRoot}。
${specHint}
只修改分配给你的目录，不要动另一个目录，不要删除测试，不要伪造命令输出。
完成后必须真实运行构建/测试命令，并如实返回输出。`

const [backendBuild, frontendBuild] = await parallel([
  () => agent(
    `${buildBase}

你的范围：${backendDir}/**

实现契约（JSON）：
${JSON.stringify({ backendPlan, apiContract: contract.apiContract, integrationNotes: contract.integrationNotes }, null, 2)}

要求：
- 在 ${projectRoot}/${backendDir} 内建立可运行的后端工程；
- 实现 contract 中的全部 API，包括错误处理与输入校验；
- 编写至少一组自动化测试（能用 node:test / vitest / pytest 等现有工具即可）；
- 运行测试与构建，记录真实命令与输出；
- 不启动需要长期驻留的服务进程。

返回 ok、filesTouched、commands、testOutput、failures、notes。`,
    { label: 'deepseek:build-backend', phase: 'Build', model: MODEL_DEEPSEEK, effort: 'high', schema: BUILD_SCHEMA }
  ),
  () => agent(
    `${buildBase}

你的范围：${frontendDir}/**

前端设计（JSON）：
${JSON.stringify(design, null, 2)}

API 契约：
${JSON.stringify(contract.apiContract, null, 2)}

要求：
- 在 ${projectRoot}/${frontendDir} 内建立可运行的前端工程；
- 实现设计中的全部页面/组件/状态，使用设计 tokens；
- 对接 API 契约；接口不可用时要有明确的错误/空状态；
- 运行构建（npm run build 或等价命令），记录真实输出；
- 不启动需要长期驻留的 dev server。

返回 ok、filesTouched、commands、testOutput、failures、notes。`,
    { label: 'deepseek:build-frontend', phase: 'Build', model: MODEL_DEEPSEEK, effort: 'high', schema: BUILD_SCHEMA }
  ),
])

const integration = await agent(
  `${buildBase}

你是集成负责人。后端与前端已分别实现：
- 后端：${projectRoot}/${backendDir}
- 前端：${projectRoot}/${frontendDir}

请：
1. 检查两个目录的文件结构与启动/构建脚本；
2. 运行后端测试、前端构建；如存在根级脚本则一并运行；
3. 检查前端请求路径/字段是否与后端契约一致（静态检查即可）；
4. 修复明显的集成问题（只做必要修改）；
5. 不要启动长期驻留进程，不要安装与项目无关的重型依赖。

后端构建结果：
${JSON.stringify(backendBuild, null, 2)}

前端构建结果：
${JSON.stringify(frontendBuild, null, 2)}

返回 ok、filesTouched、commands、testOutput、failures、notes。`,
  { label: 'deepseek:integrate', phase: 'Build', model: MODEL_DEEPSEEK, effort: 'high', schema: BUILD_SCHEMA }
)

// ---------- Phase: Backend Review (GPT-6 loop) ----------

phase('Backend Review')
log('阶段 3/5 · GPT-6 监督后端实现，DeepSeek 按发现修复')

let backendRounds = 0
let backendStatus = 'pending'
const backendHistory = []

while (backendRounds < maxRounds && backendStatus !== 'approved') {
  backendRounds++

  const packet = await agent(
    `你是 DeepSeek V4.1 Flash，负责为 GPT-6 后端监督准备审查包。工程根目录：${projectRoot}。
${specPath ? `设计文档：${specPath}。请把设计文档中与后端相关的要求（尤其 §6.9、§8、§10、§12、§13）摘录进审查包。` : '设计文档：需求描述即规格。'}

请收集并写入审查包文件 ${workDir}/backend-packet-r${backendRounds}.md：
1. 变更概览：若存在 git 仓库，运行 git status --short 与 git diff --stat；否则列出 ${backendDir}/ 文件树（排除 node_modules、dist、build、.git）；
2. 架构与契约摘要：引用 ${workDir}/contract.json 中与后端相关的内容；
3. 关键源码：读取 ${backendDir}/ 下所有源码文件（单文件超过 40KB 只保留前 40KB；总量控制在约 120KB 内），按文件路径分节粘贴；
4. 测试与构建：运行后端测试/构建命令，粘贴真实的 stdout/stderr（最多 8000 字符）；
5. 已知问题：列出你注意到的风险。

硬性要求：
- 排除 .env、密钥、token、证书等敏感内容；
- 不得伪造命令输出；
- 审查包必须自足，GPT-6 不需要访问仓库即可评审。

完成后返回 packetPath、fileCount、byteCount、summary。`,
    { label: `deepseek:collect-backend-r${backendRounds}`, phase: 'Backend Review', model: MODEL_DEEPSEEK, effort: 'medium', schema: PACKET_SCHEMA }
  )

  if (!packet) {
    backendStatus = 'error'
    backendHistory.push({ round: backendRounds, error: '审查包收集失败' })
    break
  }

  const review = await askGpt6({
    label: `backend-review-r${backendRounds}`,
    phaseName: 'Backend Review',
    instruction: `你是 GPT-6 Astra，负责后端实现监督。请依据后端架构契约与审查包，审查 DeepSeek 的后端实现。

审查重点：
1. API 路径、方法、请求/响应字段、错误码是否与契约一致；
2. 输入校验、错误处理、安全（注入、越权、密钥泄漏、CORS）；
3. 测试是否真实覆盖关键路径，是否存在伪造/空测试；
4. 数据模型与持久化是否可靠；
5. 是否满足 acceptanceChecklist。

${reviewJsonBlock()}`,
    contextFiles: [packet.packetPath, contract.contractPath],
    maxTokens: 3000,
  })

  const reviewData = review.parsed
  backendHistory.push({
    round: backendRounds,
    packet: { path: packet.packetPath, files: packet.fileCount, bytes: packet.byteCount },
    verdict: reviewData ? reviewData.verdict : 'unparsed',
    review: reviewData || review.raw.slice(0, 4000),
    bridgeError: review.error || '',
  })

  if (!reviewData) {
    backendStatus = 'needs_attention'
    log(`后端监督第 ${backendRounds} 轮：GPT-6 输出无法解析，停止自动循环`)
    break
  }

  if (reviewData.verdict === 'approve') {
    backendStatus = 'approved'
    log(`后端监督第 ${backendRounds} 轮：GPT-6 通过`)
    break
  }

  if (backendRounds >= maxRounds) {
    backendStatus = 'needs_attention'
    log(`后端监督达到最大轮次 ${maxRounds}，仍有未解决问题`)
    break
  }

  const fix = await agent(
    `你是 DeepSeek V4.1 Flash，负责按 GPT-6 的监督意见修复后端。工程根目录：${projectRoot}，范围：${backendDir}/**。
${specHint} 修复以设计文档和契约为准。

GPT-6 审查结论（JSON）：
${JSON.stringify(reviewData, null, 2)}

要求：
- 逐条落实 requiredChange，优先 blocker，其次 major；
- 不得删除或弱化测试来"通过"验收，不得伪造输出；
- 修改后运行测试与构建，记录真实命令与输出；
- 不启动长期驻留进程。

返回 ok、changedFiles、commands、testOutput、notes。`,
    { label: `deepseek:fix-backend-r${backendRounds}`, phase: 'Backend Review', model: MODEL_DEEPSEEK, effort: 'high', schema: FIX_SCHEMA }
  )

  backendHistory.push({ round: backendRounds, fix })

  if (!fix || !fix.ok) {
    backendStatus = 'needs_attention'
    log(`后端修复第 ${backendRounds} 轮未成功，停止自动循环`)
    break
  }
}

// ---------- Phase: Frontend Acceptance (Fable loop) ----------

phase('Frontend Acceptance')
log('阶段 4/5 · Fable 验收前端，DeepSeek 按发现修复')

let frontendRounds = 0
let frontendStatus = 'pending'
const frontendHistory = []

while (frontendRounds < maxRounds && frontendStatus !== 'accepted') {
  frontendRounds++

  const packet = await agent(
    `你是 DeepSeek V4.1 Flash，负责为 Fable 前端验收准备验收包。工程根目录：${projectRoot}，前端目录：${frontendDir}。
${specPath ? `设计文档：${specPath}。请把设计文档中与前端相关的要求（尤其 §6、§9、§11、§13）摘录进验收包。` : '设计文档：需求描述即规格。'}

请写入 ${workDir}/frontend-packet-r${frontendRounds}.md：
1. 验收依据：读取 ${workDir}/contract.json，提取 design、apiContract、integrationNotes、acceptanceChecklist，并摘录到验收包。
2. 前端源码：读取 ${frontendDir}/ 下源码与样式（排除 node_modules、dist、build、.git；单文件超过 40KB 只保留前 40KB；总量约 120KB），按文件路径分节粘贴。
3. 构建与测试：运行前端构建命令（如 npm run build），粘贴真实 stdout/stderr（最多 8000 字符）。
4. 静态一致性检查：前端请求路径/字段是否与契约一致。
5. 已知风险。

硬性要求：
- 不得伪造命令输出；
- 不得包含 .env、密钥、token、证书；
- 验收包必须自足，Fable 不需要访问仓库即可评审。

完成后返回 packetPath、fileCount、byteCount、summary。`,
    { label: `deepseek:collect-frontend-r${frontendRounds}`, phase: 'Frontend Acceptance', model: MODEL_DEEPSEEK, effort: 'medium', schema: PACKET_SCHEMA }
  )

  if (!packet) {
    frontendStatus = 'error'
    frontendHistory.push({ round: frontendRounds, error: '前端验收包收集失败' })
    break
  }

  const acceptResult = await askFable({
    label: `fable:accept-frontend-r${frontendRounds}`,
    phaseName: 'Frontend Acceptance',
    instruction: `你是 claude-fable-5，前端验收负责人。工程根目录：${projectRoot}，前端目录：${frontendDir}。

请依据验收包与契约执行验收：
1. 对照 acceptanceChecklist 逐条判断；
2. 核对页面、组件、状态、designTokens；
3. 检查构建输出是否真实通过；
4. 检查与 API 契约的字段一致性。

输出严格 JSON（不要 Markdown 代码块），结构必须匹配以下 JSON Schema：
${JSON.stringify(ACCEPTANCE_SCHEMA, null, 2)}

存在 blocker/major 时必须 revise；只有 minor 时可 accept，但仍需列出。`,
    contextFiles: [packet.packetPath, contract.contractPath],
    maxTokens: 12000,
  })

  const acceptance = acceptResult.parsed
  if (!acceptResult.ok || !isAcceptance(acceptance)) {
    frontendStatus = 'error'
    frontendHistory.push({
      round: frontendRounds,
      error: 'Fable 验收返回不可解析',
      detail: acceptResult.error || String(acceptResult.raw || '').slice(0, 2000),
      packet: { path: packet.packetPath, files: packet.fileCount, bytes: packet.byteCount },
    })
    break
  }

  frontendHistory.push({
    round: frontendRounds,
    packet: { path: packet.packetPath, files: packet.fileCount, bytes: packet.byteCount },
    acceptance,
  })

  if (acceptance.verdict === 'accept') {
    frontendStatus = 'accepted'
    log(`前端验收第 ${frontendRounds} 轮：Fable 通过`)
    break
  }

  if (frontendRounds >= maxRounds) {
    frontendStatus = 'needs_attention'
    log(`前端验收达到最大轮次 ${maxRounds}，仍有未解决问题`)
    break
  }

  const fix = await agent(
    `你是 DeepSeek V4.1 Flash，负责按 Fable 的验收意见修复前端。工程根目录：${projectRoot}，范围：${frontendDir}/**。
${specHint} 修复以设计文档和契约为准。

Fable 验收结论（JSON）：
${JSON.stringify(acceptance, null, 2)}

要求：
- 逐条落实 requiredChange，优先 blocker，其次 major；
- 保持与 API 契约兼容；
- 修改后运行构建，记录真实命令与输出；
- 不启动长期驻留进程。

返回 ok、changedFiles、commands、testOutput、notes。`,
    { label: `deepseek:fix-frontend-r${frontendRounds}`, phase: 'Frontend Acceptance', model: MODEL_DEEPSEEK, effort: 'high', schema: FIX_SCHEMA }
  )

  frontendHistory.push({ round: frontendRounds, fix })

  if (!fix || !fix.ok) {
    frontendStatus = 'needs_attention'
    log(`前端修复第 ${frontendRounds} 轮未成功，停止自动循环`)
    break
  }
}

// ---------- Phase: Report ----------

phase('Report')
log('阶段 5/5 · DeepSeek 汇总验收报告')

const overallOk = backendStatus === 'approved' && frontendStatus === 'accepted'

const report = await agent(
  `你是 DeepSeek V4.1 Flash，负责汇总本次三模型流水线的验收报告。工程根目录：${projectRoot}。
${specHint}

请用 Write 工具创建 ${projectRoot}/reports/ 目录并写入 ${projectRoot}/reports/acceptance-report.md，内容包含：
1. 需求摘要；
2. 角色分工：claude-fable-5（前端设计/验收，经 tools/fable-bridge.mjs）、gpt-6-astra（后端架构/监督，经 tools/gpt6-bridge.mjs）、deepseek-flash（实现/修复）；
3. 契约与产物路径；
4. 后端监督过程：每轮 verdict 与关键 findings；
5. 前端验收过程：每轮 verdict、passedCriteria、gaps；
6. 最终结论：backendStatus=${backendStatus}，frontendStatus=${frontendStatus}，overallOk=${overallOk}；
7. 未解决问题与后续建议（必须如实列出 openQuestions 和 needs_attention 的原因）。

数据：
${JSON.stringify({
    requirement,
    projectRoot,
    contract,
    integration,
    backend: { status: backendStatus, rounds: backendRounds, history: backendHistory },
    frontend: { status: frontendStatus, rounds: frontendRounds, history: frontendHistory },
  }, null, 2)}

返回 reportPath 与一段 summary。`,
  { label: 'deepseek:report', phase: 'Report', model: MODEL_DEEPSEEK, effort: 'medium', schema: REPORT_SCHEMA }
)

return {
  ok: overallOk,
  requirement,
  projectRoot,
  roles: {
    designerAndAcceptor: `${FABLE_MODEL} (via tools/fable-bridge.mjs)`,
    backendSupervisor: 'gpt-6-astra (via tools/gpt6-bridge.mjs)',
    implementer: 'deepseek-flash',
  },
  contract: {
    path: contract.contractPath,
    designPath: contract.designPath,
    openQuestions: contract.openQuestions,
  },
  build: {
    backend: backendBuild ? { ok: backendBuild.ok, failures: backendBuild.failures } : null,
    frontend: frontendBuild ? { ok: frontendBuild.ok, failures: frontendBuild.failures } : null,
    integration: integration ? { ok: integration.ok, failures: integration.failures } : null,
  },
  backend: {
    status: backendStatus,
    rounds: backendRounds,
    history: backendHistory,
  },
  frontend: {
    status: frontendStatus,
    rounds: frontendRounds,
    history: frontendHistory,
  },
  report: report || null,
}
