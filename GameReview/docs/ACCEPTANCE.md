# GReview v0.1.3 验收与已知问题

- 日期：2026-11-06
- 版本：v0.1.3
- 构建/测试：`npm test` 通过；后端 **222 passed / 1 skipped**，前端 **72 passed**；`npm run build`、`npm run lint` 均 exit 0。
- 真实 Steam + DeepSeek 端到端冒烟：需要使用者在本机填入自己的 Key 后验证。

## v0.1.2 修复

- **100+ 条评论分析稳定性**：兼容 AI 返回的 `mixed` 情感；final 阶段不再覆盖主题，报告以 merge/map 中已验证的主题为准；分块/合并输出上限提升到 8192。
- **报告写入校验**：报告持久化层接受 `mixed`，避免分析成功但保存时报 INTERNAL。
- **数据集复用**：多页抓取保留第一页的完整 `query_summary`，不再被后续残缺页覆盖；修复 200 条数据集被误判 `corrupted` 的问题。

## v0.1.3 新增

- **Windows 一键启动器**：`start-greview.bat` 会检查 Node.js 20+/npm、首次运行安装依赖、构建产物缺失时构建、启动服务并打开浏览器；已在运行时不会重复启动。
- **Release 安装包**：`GReview-v0.1.3-windows.zip` 包含已构建的前端/后端、启动器和文档，解压后双击即可使用；用户不需要手动执行 npm 命令。
- macOS/Linux 用户仍按 README 使用 `npm install` / `npm run dev`。

## 验收状态

- 本地只读/写接口、Steam 抓取、官方月度趋势聚合、DeepSeek 结构化分析、证据校验、本地数据集/报告复用、Markdown 导出与打印均已实现。
- 构建、类型检查和自动化测试通过；集成测试不依赖真实 Steam/DeepSeek 网络。
- 真实网络路径（Steam 请求、DeepSeek 调用、浏览器打印）需要本机环境验证。

## 已知问题（v0.1.3，不阻塞正常使用）

1. **Steam 串行调度的取消穿透**（`server/src/steam/client.ts`，major）
   排队节点被取消时会提前释放队列位置，可能让后续请求越过仍在执行的请求。正常低并发使用不受影响；高并发/取消场景需修。

2. **AI 数字一致性校验仍有边界漏洞**（`server/src/analysis/conclusion.ts`，major）
   “较上月”未唯一绑定最新月份对；少数无量词计数可能被正则回溯误匹配。可能影响报告数字校验的严格性。

3. **AI 正文读取超时映射**（`server/src/ai/deepseek.ts`，major）
   响应头已返回但正文停滞时，超时可能被映射为 `AI_INVALID_RESPONSE` 而不是 `AI_TIMEOUT`；错误提示会不够精确。

4. **最终主题限制可被绕过**（`server/src/analysis/pipeline.ts`，major）
   final 阶段沿用已有主题 ID/名称但替换内容时，可能绕过“不得引入新主题”的限制；预期落差/更新影响也需更严格的合并约束。

5. **报告 JSON/Markdown 提交非事务**（`server/src/storage/report.ts`，major）
   两个文件分别原子写；极端写入失败或同键并发时，可能留下 JSON 与 Markdown 不一致的报告。

6. **预览错误码不一致**（`server/src/routes/game.ts`，minor）
   appid=0/负数/超范围时返回 `INVALID_REQUEST`，契约写的是 `INVALID_URL`；不影响功能，影响错误码一致性。

## 其他已知限制

- Windows 上有 1 项文件符号链接测试按平台权限显式跳过；目录 junction 测试已执行。
- 生产主 JS chunk 约 784 KB（gzip 263 KB），超过 Vite 500 KB 警告阈值；不影响构建。
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
