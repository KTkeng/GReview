# GReview v0.1.0 验收与已知问题

- 日期：2026-11-06
- 版本：v0.1.0
- 构建/测试：`npm test` 通过；后端 **217 passed / 1 skipped**，前端 **70 passed**；`npm run build`、`npm run lint` 均 exit 0。
- 真实 Steam + DeepSeek 端到端冒烟：尚未执行，需使用者在本机填入自己的 Key 后验证。

## 三模型流水线结果

| 阶段 | 结果 |
| --- | --- |
| Fable 前端设计 | 通过（经 `tools/fable-bridge.mjs`） |
| GPT-6 后端架构 | 通过（经 `tools/gpt6-bridge.mjs`） |
| DeepSeek 实现/集成 | 通过 |
| GPT-6 后端监督 | 原 3 轮 `revise/revise/unparsed`；用户授权外发后补做 R3–R6，最终 R6 仍为 `revise`（5 major + 1 minor，无 blocker） |
| Fable 前端验收 | 原 3 轮 `revise`；修复 G1/G3 后定点 R4 **accept** |

按设计文档 §13.4，后端监督未取得 `approve`，因此不能宣称后端完全通过；前端在定点复验中已 `accept`。

## R6 剩余已知问题（v0.1.0 不阻塞使用，但未关闭）

1. **Steam 串行调度的取消穿透**（`server/src/steam/client.ts`，major）
   排队节点被取消时会提前释放队列位置，可能让后续请求越过仍在执行的请求。正常低并发使用不受影响；高并发/取消场景需修。

2. **AI 数字一致性校验仍有边界漏洞**（`server/src/analysis/conclusion.ts`，major）
   “较上月”未唯一绑定最新月份对；少数无量词计数可能被正则回溯误匹配。可能影响报告数字校验的严格性。

3. **AI 正文读取超时映射**（`server/src/ai/deepseek.ts`，major）
   响应头已返回但正文停滞时，超时可能被映射为 `AI_INVALID_RESPONSE` 而不是 `AI_TIMEOUT`；错误提示会不够精确。

4. **最终主题限制可被绕过**（`server/src/analysis/pipeline.ts`，major）
   final 阶段沿用已有主题 ID/名称但替换内容时，可能绕过“不得引入新主题”的限制；预期落差/更新影响也需更严格的合并约束。

5. **报告 JSON/Markdown 提交非事务**（`server/src/storage/report.ts`，major）
   两个文件分别原子写；极端写入失败或同键并发时，可能留下 JSON 与 Markdown 不一致的报告。数据集已有串行/恢复机制，报告侧尚未对齐。

6. **预览错误码不一致**（`server/src/routes/game.ts`，minor）
   appid=0/负数/超范围时返回 `INVALID_REQUEST`，契约写的是 `INVALID_URL`；不影响功能，影响错误码一致性。

## 其他已知限制

- Windows 上有 1 项文件符号链接测试按平台权限显式跳过；目录 junction 测试已执行。
- 生产主 JS chunk 约 784 KB（gzip 263 KB），超过 Vite 500 KB 警告阈值；不影响构建。
- 6 项前端验收点（真实 Steam、真实 DeepSeek、浏览器兼容性、打印、无障碍工具、性能监控）标记为 deferred，需真实环境验证。
- 测试与验收报告位于 `reports/`（gitignored）；本文件是提交到仓库的公开摘要。

## 如何验证

```bash
npm install
npm test
npm run build
npm run dev
```

打开 <http://127.0.0.1:5173>，填入自己的 DeepSeek Key，使用一个 Steam AppID（如 `1145360`）抓 20 条评论、12 个月趋势，确认报告、证据引用和本地数据复用。真实网络 smoke 会消耗少量 DeepSeek token。
