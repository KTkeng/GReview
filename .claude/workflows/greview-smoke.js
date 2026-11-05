export const meta = {
  name: 'greview-smoke',
  description: '三模型冒烟验证：Fable 设计/验收、GPT-6 bridge 后端监督、DeepSeek 实现',
  whenToUse: '验证 GReview 三模型工作流的模型连通性、角色分工与结构化输出是否正常（不构建真实项目）',
  phases: [
    { title: 'Design', detail: 'Fable 产出迷你规格与验收标准' },
    { title: 'Implement', detail: 'DeepSeek 产出实现片段' },
    { title: 'Supervise', detail: 'GPT-6 经本地 bridge 评审实现' },
    { title: 'Accept', detail: 'Fable 对照验收标准给出结论' },
  ],
}

const MODEL_DEEPSEEK = 'deepseek-flash'
const GPT6_BRIDGE = 'D:/GReview/tools/gpt6-bridge.mjs'
const FABLE_BRIDGE = 'D:/GReview/tools/fable-bridge.mjs'
const TMP_DIR = 'D:/GReview/.greview-tmp'

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    feature: { type: 'string' },
    uiRequirements: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    apiExpectations: { type: 'array', items: { type: 'string' } },
  },
  required: ['feature', 'uiRequirements', 'acceptanceCriteria', 'apiExpectations'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    backendCode: { type: 'string' },
    frontendCode: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['backendCode', 'frontendCode', 'notes'],
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

const ACCEPT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'revise'] },
    passedCriteria: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['verdict', 'passedCriteria', 'gaps', 'summary'],
}

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

function bridgeWrapperPrompt({ instruction, context, instructionPath, contextPath, maxTokens, tag }) {
  return `你是 GPT-6 Astra 的传输代理（transport wrapper）。你自己不要做任何评审、分析、改写或补充。

步骤：
1) 用 Bash 运行：mkdir -p "${TMP_DIR}"
2) 用 Write 工具把下方 <<<INSTRUCTION>>> 与 <<<END INSTRUCTION>>> 之间的内容【逐字原样】写入文件：
   ${instructionPath}
3) 用 Write 工具把下方 <<<CONTEXT>>> 与 <<<END CONTEXT>>> 之间的内容【逐字原样】写入文件：
   ${contextPath}
4) 用 Bash 运行：
   node "${GPT6_BRIDGE}" --prompt-file "${instructionPath}" --prompt-file "${contextPath}" --json --json-mode --max-tokens ${maxTokens}
5) 该命令会输出一行 JSON（形如 {"ok":true,"content":"..."}）。
   - 成功：返回 { ok: true, content: <content 字段原文>, error: "" }
   - 失败：返回 { ok: false, content: "", error: <命令输出中的 error> }
禁止改写、总结、翻译、评价 GPT-6 的输出；content 必须逐字复制。

<<<INSTRUCTION>>>
${instruction}
<<<END INSTRUCTION>>>

<<<CONTEXT>>>
${context}
<<<END CONTEXT>>>

本次传输标识：${tag}
`
}

function safeTag(label) {
  return String(label).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
}

function fableWrapperPrompt({ instruction, context, instructionPath, contextPath, maxTokens, tag }) {
  return `你是 Claude Fable 5 的传输代理（transport wrapper）。你自己不要做任何设计、评审、改写或补充。

步骤：
1) 用 Bash 运行：mkdir -p "${TMP_DIR}"
2) 用 Write 工具把下方 <<<INSTRUCTION>>> 与 <<<END INSTRUCTION>>> 之间的内容【逐字原样】写入文件：
   ${instructionPath}
3) 用 Write 工具把下方 <<<CONTEXT>>> 与 <<<END CONTEXT>>> 之间的内容【逐字原样】写入文件：
   ${contextPath}
4) 用 Bash 运行：
   node "${FABLE_BRIDGE}" --prompt-file "${instructionPath}" --prompt-file "${contextPath}" --json --json-mode --max-tokens ${maxTokens}
5) 该命令会输出一行 JSON（形如 {"ok":true,"content":"..."}）。
   - 成功：返回 { ok: true, content: <content 字段原文>, error: "" }
   - 失败：返回 { ok: false, content: "", error: <命令输出中的 error> }
禁止改写、总结、翻译、评价 Fable 的输出；content 必须逐字复制。

<<<INSTRUCTION>>>
${instruction}
<<<END INSTRUCTION>>>

<<<CONTEXT>>>
${context || ''}
<<<END CONTEXT>>>

本次传输标识：${tag}
`
}

async function askFable({ label, phaseName, instruction, context, maxTokens, tag }) {
  const safe = safeTag(tag || label)
  const instructionPath = `${TMP_DIR}/smoke-fable-${safe}.instruction.md`
  const contextPath = `${TMP_DIR}/smoke-fable-${safe}.context.md`
  const wrapped = await agent(
    fableWrapperPrompt({
      instruction,
      context: context || '',
      instructionPath,
      contextPath,
      maxTokens: maxTokens || 6000,
      tag: safe,
    }),
    { label: `fable:${safe}`, phase: phaseName, model: MODEL_DEEPSEEK, effort: 'low', schema: BRIDGE_RESULT_SCHEMA }
  )
  const parsed = wrapped && wrapped.ok ? parseLooseJson(wrapped.content) : null
  return {
    ok: Boolean(wrapped && wrapped.ok && parsed),
    wrapped,
    parsed,
    raw: wrapped ? wrapped.content : '',
    error: wrapped ? (wrapped.error || '') : 'Fable bridge wrapper 未返回结果',
  }
}

function isSpec(obj) {
  return Boolean(
    obj &&
    typeof obj.feature === 'string' &&
    Array.isArray(obj.uiRequirements) &&
    Array.isArray(obj.acceptanceCriteria) &&
    Array.isArray(obj.apiExpectations)
  )
}

function isAcceptance(obj) {
  return Boolean(
    obj &&
    (obj.verdict === 'accept' || obj.verdict === 'revise') &&
    Array.isArray(obj.passedCriteria) &&
    Array.isArray(obj.gaps) &&
    typeof obj.summary === 'string'
  )
}

phase('Design')
log('角色 1/3 · claude-fable-5 负责前端设计与验收标准')

const designResult = await askFable({
  label: 'fable:design',
  phaseName: 'Design',
  instruction: `你是 claude-fable-5，负责前端界面设计与验收。当前是三模型流水线的冒烟验证：不构建真实项目、不写文件、不运行命令。

需求：设计一个极简的「服务健康状态徽章」组件，数据来自后端 GET /api/health。

输出严格 JSON（不要 Markdown 代码块），结构必须匹配以下 JSON Schema：
${JSON.stringify(SPEC_SCHEMA, null, 2)}

要求：
- feature：一句话说明
- uiRequirements：3-4 条界面/交互要求（含状态色与文案）
- acceptanceCriteria：3-4 条可验证的验收标准
- apiExpectations：2-3 条前端对后端接口的期望（路径、状态码、字段）`,
  maxTokens: 8000,
  tag: 'design',
})

const spec = designResult.parsed
if (!designResult.ok || !isSpec(spec)) {
  return {
    ok: false,
    error: 'Fable 设计阶段未返回可解析结果',
    detail: designResult.error || String(designResult.raw || '').slice(0, 2000),
    checks: { fableDesign: false },
  }
}

phase('Implement')
log('角色 3/3 · DeepSeek V4.1 Flash 负责具体实现')

const implementation = await agent(
  `你是 DeepSeek V4.1 Flash，负责具体实现。当前是冒烟验证：不写文件、不运行命令。

规格（JSON）：
${JSON.stringify(spec, null, 2)}

请返回：
- backendCode：一段最小 Node/Express 健康检查实现，包含 GET /api/health
- frontendCode：一段最小 HTML/JS，请求该接口并渲染健康状态徽章
- notes：实现取舍（2-3 句）

代码要能直接看懂即可，不需要完整工程或依赖安装。`,
  { label: 'deepseek:implement', phase: 'Implement', model: MODEL_DEEPSEEK, effort: 'medium', schema: IMPL_SCHEMA }
)

if (!implementation) {
  return { ok: false, error: 'DeepSeek 实现阶段未返回结果', checks: { fableDesign: true, deepseekImplement: false } }
}

phase('Supervise')
log('角色 2/3 · GPT-6 Astra 经本地 bridge 进行后端实现监督')

const reviewInstruction = `你是 GPT-6 Astra，负责后端实现监督。请对照规格审查 DeepSeek 的实现：
1. 接口路径、状态码、响应字段是否满足 apiExpectations；
2. 后端是否有明显的错误处理、CORS、安全或健壮性问题；
3. 前端取值是否与后端响应字段一致（交叉检查即可）。

输出严格 JSON，不要输出 JSON 以外的任何文字：
{"verdict":"approve"|"revise","findings":[{"severity":"blocker"|"major"|"minor","issue":"问题描述","requiredChange":"必须的修改"}],"summary":"一句话结论"}
没有 blocker/major 问题时 verdict 必须是 approve。`

const reviewContext = JSON.stringify({ spec, implementation }, null, 2)

const bridged = await agent(
  bridgeWrapperPrompt({
    instruction: reviewInstruction,
    context: reviewContext,
    instructionPath: `${TMP_DIR}/smoke-gpt6.instruction.md`,
    contextPath: `${TMP_DIR}/smoke-gpt6.context.md`,
    maxTokens: 1200,
    tag: 'smoke-review',
  }),
  { label: 'gpt6:supervise', phase: 'Supervise', model: MODEL_DEEPSEEK, effort: 'low', schema: BRIDGE_RESULT_SCHEMA }
)

const review = bridged && bridged.ok ? parseLooseJson(bridged.content) : null

phase('Accept')
log('角色 1/3 · claude-fable-5 给出最终验收结论')

const acceptResult = await askFable({
  label: 'fable:accept',
  phaseName: 'Accept',
  instruction: `你是 claude-fable-5，前端验收负责人。当前是冒烟验证：不写文件、不运行命令。

请对照规格中的 acceptanceCriteria，并参考 GPT-6 的审查意见，判断这份实现是否可接受。

输出严格 JSON（不要 Markdown 代码块），结构必须匹配以下 JSON Schema：
${JSON.stringify(ACCEPT_SCHEMA, null, 2)}

要求：verdict 只能是 accept/revise；passedCriteria 与 gaps 为字符串数组；summary 为一句话中文结论。`,
  context: JSON.stringify({ spec, implementation, gpt6Review: review }, null, 2),
  maxTokens: 10000,
  tag: 'accept',
})

const acceptance = acceptResult.parsed
if (!acceptResult.ok || !isAcceptance(acceptance)) {
  log('Fable 验收返回不可解析，冒烟将标记为未通过')
}

const checks = {
  fableDesign: Boolean(spec),
  deepseekImplement: Boolean(implementation),
  gpt6Bridge: Boolean(bridged && bridged.ok && review && (review.verdict === 'approve' || review.verdict === 'revise')),
  fableAcceptance: Boolean(acceptance && (acceptance.verdict === 'accept' || acceptance.verdict === 'revise')),
}

const ok = Object.values(checks).every(Boolean)

log(ok ? '冒烟验证通过：三个角色均已按预期响应' : '冒烟验证未完全通过，请查看 checks 与 error')

return {
  ok,
  checks,
  roles: {
    designer: 'claude-fable-5',
    supervisor: 'gpt-6-astra (via tools/gpt6-bridge.mjs)',
    implementer: 'deepseek-v4.1-flash',
  },
  outputs: {
    spec,
    implementation,
    gpt6Review: review,
    gpt6Raw: bridged ? { ok: bridged.ok, error: bridged.error || '' } : null,
    fableAcceptance: acceptance,
  },
  verdicts: {
    gpt6: review ? review.verdict : 'unavailable',
    fable: acceptance ? acceptance.verdict : 'unavailable',
  },
}
