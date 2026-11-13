# GReview v0.2.1 验收与已知问题

- 日期：2026-11-13
- 版本：v0.2.1
- 构建/测试：`npm test` 通过；后端 **297 passed / 5 skipped**，前端 **178 passed**；`npm run build`、`npm run lint` 均 exit 0。
- CI：push 后由 GitHub Actions `ubuntu-latest` + `windows-latest` 矩阵验证。
- 真实 Steam + DeepSeek 端到端冒烟：需要使用者在本机填入自己的 Key 后验证。

## v0.1.2 修复

- **100+ 条评论分析稳定性**：兼容 AI 返回的 `mixed` 情感；final 阶段不再覆盖主题，报告以 merge/map 中已验证的主题为准；分块/合并输出上限提升到 8192。
- **报告写入校验**：报告持久化层接受 `mixed`，避免分析成功但保存时报 INTERNAL。
- **数据集复用**：多页抓取保留第一页的完整 `query_summary`，不再被后续残缺页覆盖；修复 200 条数据集被误判 `corrupted` 的问题。

## v0.1.3 新增

- **Windows 一键启动器**：`start-greview.bat` 会检查 Node.js 20+/npm、首次运行安装依赖、构建产物缺失时构建、启动服务并打开浏览器；已在运行时不会重复启动。
- **Release 安装包**：`GReview-v0.1.3-windows.zip` 包含已构建的前端/后端、启动器和文档，解压后双击即可使用；用户不需要手动执行 npm 命令。
- macOS/Linux 用户仍按 README 使用 `npm install` / `npm run dev`。

## v0.2.0 新增

- **自定义游戏标题**：本地数据面板支持编辑、保存、取消与恢复默认；标题持久化到 `data/<appid>/title.json`，独立于 Steam 元数据，不进入抓取/趋势/分析哈希。统一展示回退链为 `customTitle > steamName > AppID <id>`，报告、复用提示、Markdown 导出、任务完成与 SSE 使用同一名称；封面加载失败显示 AppID 占位。
- **标题并发与安全**：`expectedRevision` 乐观并发、409 冲突保留用户草稿、原子写与统一存储锁、数据目录/链接隔离、同源 Origin/Host 校验。
- **思考模式稳定性**：64K 思考预算、截断自动升档、600s 超时与中断重试，详见下节。
- **双平台 CI**：新增 Ubuntu + Windows 矩阵；Windows 上 5 项符号链接/大小写权限用例按平台显式跳过，目录 junction 用例实际执行，Ubuntu CI 全部执行。

### 思考模式分析失败

- **根因**：DeepSeek 思考模式的 `reasoning_content` 与正文共享 `max_tokens`。此前各分析阶段固定 8192，开启思考后推理会把预算耗尽，接口以 HTTP 200 返回空 `content` 和 `finish_reason: "length"`；随后的 JSON 修复重试同样被思考耗尽，最终表现为 `AI_INVALID_RESPONSE`。
- 思考模式下每阶段初始 `max_tokens` 对齐 DeepSeek 的 64K 思考默认值（65536）；`DeepSeekProvider` 检测到 `finish_reason: "length"` 后自动将预算翻倍（上限 131072），保留思考开关，不静默降级。
- 思考请求超时下限提升到 600s（10 分钟，可随时取消）；正文读取阶段的超时正确映射为 `AI_TIMEOUT`，调用方取消仍优先返回 `CANCELLED`。
- DeepSeek 文档中的 `insufficient_system_resource`/`aborted` 中断会自动退避重试 2 次；`content_filter` 直接返回明确错误，不再走无意义的 JSON 修复。
- 输出仍被截断时返回明确错误（含 `finish_reason`、`max_tokens` 与思考内容长度），不再只显示“AI 返回内容无法解析”。
- 自定义 Base URL 若拒绝 64K `max_tokens`（例如只支持 8K 的兼容端点），自动回退到 8192 并保持思考开启，不会再次升到被拒绝的区间。
- 新增 13 项回归测试覆盖预算提升、64K→128K 升档、修复预算复用、截断错误、思考超时、正文读取超时、取消优先级、非思考预算、自定义端点回退与中断重试。

## v0.2.1 新增

- **AI 分析实时可视化**：分析进行中可在进度面板展开/收起阶段时间线、AI 分块进度、当前阶段与日志流；默认展开，用户选择写入 `localStorage`（`greview.liveviz.expanded`）。
- **阶段时间线**：读取/抓取、趋势聚合、预处理、AI 分块 map、合并、最终总结、校验/报告；支持待开始、进行中、已完成、已跳过（复用本地）、未观察、失败、取消。
- **分块进度**：使用后端 `counts.chunks/completed`；缺失显示「暂无分块数据」，非法显示「分块进度暂不可用」，前端不再自行补全。
- **日志流**：自动滚动、回到最新、500 条缓存、渲染最近 200 条、超长截断；断线恢复提示；打印隐藏；reduced-motion 支持。
- **后端只补进度字段**：`counts.completed`、快照 `message`，不新增接口或依赖；GPT-6 后端复审已 approve。
- **已知边缘问题（不阻塞正常使用）**：
  - 任务过期 404 时，进度视图可能切换到错误视图，未保留已显示的实时可视化。
  - 断线恢复在并发快照请求下存在极小概率的重连竞态；`onOpen` 后未再次校准快照。
  - 无障碍播报主要覆盖百分比里程碑，阶段变化和失败/取消分支的 `aria-live` 覆盖不足。
  - 复用/跳过识别依赖后端中文 message 正则，后端改文案会失效。
  - `LiveCounters` 保留休眠实现，仅当 `counts` 含 `themes/evidence/tokens` 时渲染。

## 验收状态

- 本地只读/写接口、Steam 抓取、官方月度趋势聚合、DeepSeek 结构化分析、证据校验、本地数据集/报告复用、Markdown 导出与打印均已实现。
- 构建、类型检查和自动化测试通过；集成测试不依赖真实 Steam/DeepSeek 网络。
- 真实网络路径（Steam 请求、DeepSeek 调用、浏览器打印）需要本机环境验证。

## 已知问题（v0.2.1，不阻塞正常使用）

1. **Steam 串行调度的取消穿透**（`server/src/steam/client.ts`，major）
   排队节点被取消时会提前释放队列位置，可能让后续请求越过仍在执行的请求。正常低并发使用不受影响；高并发/取消场景需修。

2. **AI 数字一致性校验仍有边界漏洞**（`server/src/analysis/conclusion.ts`，major）
   “较上月”未唯一绑定最新月份对；少数无量词计数可能被正则回溯误匹配。可能影响报告数字校验的严格性。

3. **最终主题限制可被绕过**（`server/src/analysis/pipeline.ts`，major）
   final 阶段沿用已有主题 ID/名称但替换内容时，可能绕过“不得引入新主题”的限制；预期落差/更新影响也需更严格的合并约束。

4. **报告 JSON/Markdown 提交非事务**（`server/src/storage/report.ts`，major）
   两个文件分别原子写；极端写入失败或同键并发时，可能留下 JSON 与 Markdown 不一致的报告。

5. **预览错误码不一致**（`server/src/routes/game.ts`，minor）
   appid=0/负数/超范围时返回 `INVALID_REQUEST`，契约写的是 `INVALID_URL`；不影响功能，影响错误码一致性。

## 其他已知限制

- Windows 上有 5 项符号链接/大小写权限测试按平台显式跳过；目录 junction 测试已执行；Ubuntu CI 全部执行。
- 生产主 JS chunk 约 813 KB（gzip 272 KB），超过 Vite 500 KB 警告阈值；不影响构建。
- v0.2.1 的 LiveViz 经过 Fable 三轮验收，仍有上述 3 个 major 边缘问题未闭环；核心功能、178 项前端测试与构建通过。
- 6 项前端验收点（真实 Steam、真实 DeepSeek、浏览器兼容性、打印、无障碍工具、性能监控）标记为 deferred，需真实环境验证。
- 内部验收报告不随公开仓库发布；本文件是公开的验收摘要。

## 如何验证

```bash
npm install
npm test
npm run build
npm run dev
```

打开 <http://127.0.0.1:5173>，填入自己的 DeepSeek Key，使用一个 Steam AppID（如 `1145360`）抓 20 条评论、12 个月趋势，确认报告、证据引用和本地数据复用。真实网络 smoke 会消耗少量 DeepSeek token。
