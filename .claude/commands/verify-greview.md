---
description: 冒烟验证 GReview 三模型工作流（不构建项目）
---

使用 Workflow 工具运行预定义工作流 `greview-smoke`（无需 args）。

完成后用中文表格汇报：

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| fableDesign | 通过/失败 | 规格摘要 |
| deepseekImplement | 通过/失败 | 实现摘要 |
| gpt6Bridge | 通过/失败 | GPT-6 verdict / 错误 |
| fableAcceptance | 通过/失败 | Fable verdict |

并给出总体 `ok`、GPT-6 与 Fable 的 verdict，以及失败时的具体错误与修复建议。
