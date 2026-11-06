---
description: 运行 GReview 三模型开发流水线（Fable 设计/验收 + GPT-6 监督 + DeepSeek 实现）
argument-hint: <需求描述>
---

使用 Workflow 工具运行预定义工作流：

- `name`: `greview-pipeline`
- `args`: `{ "requirement": "$ARGUMENTS", "projectRoot": "D:/GReview/GameReview", "specPath": "D:/GReview/docs/superpowers/specs/2026-11-05-greview-design.md" }`

如果 `$ARGUMENTS` 为空或只有空白，不要运行工作流，先向用户询问需求。

工作流完成后，用中文汇报：

1. 后端监督结论（approved / needs_attention / error）与轮次、关键 findings；
2. 前端验收结论（accepted / needs_attention / error）与轮次、passedCriteria；
3. 报告路径与未解决问题；
4. 如果失败，给出具体错误和下一步建议。
