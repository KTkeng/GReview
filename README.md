# GReview

[![CI](https://github.com/KTkeng/GReview/actions/workflows/ci.yml/badge.svg)](https://github.com/KTkeng/GReview/actions/workflows/ci.yml)

[English](#english) | [中文](#中文)

---

## English

**Local-first Steam review analysis for game designers.** Bring your own DeepSeek API key; GReview fetches configurable review samples, builds a bias-free reputation trend from Steam's official aggregates, and produces an evidence-backed report with charts, themes, and actionable findings.

No account, no hosted server, no telemetry. It runs on `127.0.0.1` and stores datasets/reports locally.

### Repository layout

```text
GameReview/          # The application
  web/               # React + Vite + TypeScript frontend
  server/            # Node + Express + TypeScript backend
  docs/              # Acceptance status and known issues
  README.md          # Full application documentation (Chinese)
.github/workflows/   # CI (runs in GameReview/)
LICENSE
README.md
```

The application lives entirely in [`GameReview/`](GameReview/).

### Quick start

Requires Node.js 20+.

```bash
cd GameReview
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Production mode:

```bash
npm run build
npm start
```

Then open <http://127.0.0.1:53821>.

You need a [DeepSeek API key](https://platform.deepseek.com/). The key is stored only in your browser's `localStorage` and sent per request; it is not written to the repo, logs, datasets, or reports.

### Features

- Configurable Steam review sampling: helpful/recent/updated, positive/negative, languages, date range, purchase type, playtime, keywords, and more.
- Pre-fetch preview with match count, page/time estimate, and AI cost estimate.
- Reputation trend from Steam's official monthly aggregates, not from the top-voted sample.
- DeepSeek structured analysis: appeal points, friction points, expectation gaps, update impact, recommendations, and verified quotes.
- Local dataset/report reuse: repeat analyses avoid re-fetching Steam and re-spending tokens.
- Markdown export and browser print-to-PDF.

### Documentation

- [Application README](GameReview/README.md) — full documentation (Chinese)
- [Acceptance and known issues](GameReview/docs/ACCEPTANCE.md) — test status, known limitations, deferred checks

### Feedback / Bug reports

Found a bug or have a suggestion? Email **ktkengtu@163.com**. Please include the game AppID, the error code/message, and whether a real DeepSeek key was used. **Never send your API key.**

### License

MIT — see [LICENSE](LICENSE).

### Disclaimer

GReview is not affiliated with Valve. Steam reviews are public user-generated content; respect Steam's terms and local law, and keep request rates reasonable. "Reputation performance" in reports does not imply sales, revenue, or commercial success.

---

## 中文

**面向游戏策划的本地 Steam 评论分析工具。** 填入你自己的 DeepSeek API Key，按条件抓取评论，用 Steam 官方聚合数据画出真实口碑趋势，再由 AI 归纳吸引点、劝退点、玩家预期落差与可行动建议；每条结论附证据原话。

无账号、无托管服务器、无遥测。应用只监听 `127.0.0.1`，数据集与报告保存在本地。

### 仓库结构

```text
GameReview/          # 应用本体
  web/               # React + Vite + TypeScript 前端
  server/            # Node + Express + TypeScript 后端
  docs/              # 验收状态与已知问题
  README.md          # 完整应用说明
.github/workflows/   # CI（在 GameReview/ 下执行）
LICENSE
README.md
```

软件源码全部在 [`GameReview/`](GameReview/)。

### 快速开始

需要 Node.js 20+。

```bash
cd GameReview
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。生产模式：

```bash
npm run build
npm start
```

然后打开 <http://127.0.0.1:53821>。

你需要一个 [DeepSeek API Key](https://platform.deepseek.com/)。Key 只保存在浏览器 `localStorage`，随请求头发送；不会写入仓库、日志、数据集或报告。

### 功能

- 灵活的 Steam 评论抓取：高赞/最新/最近更新、好评/差评、语言、时间范围、购买来源、游玩时长、关键词等。
- 抓取前预览：命中数、页数/耗时估算、AI 费用估算。
- 口碑趋势来自 Steam 官方月度聚合，不用高赞样本冒充时间趋势。
- DeepSeek 结构化分析：吸引点、劝退点、预期落差、版本影响、可行动建议，并附经过校验的证据引用。
- 本地数据集/报告复用：同条件再次分析不重复抓取 Steam、不重复消耗 token。
- Markdown 导出与浏览器打印为 PDF。

### 文档

- [完整应用说明](GameReview/README.md)
- [验收与已知问题](GameReview/docs/ACCEPTANCE.md)

### 反馈与问题上报

发现 bug 或有建议，请发邮件到 **ktkengtu@163.com**。请附上游戏 AppID、错误码/错误信息、是否使用真实 DeepSeek Key；**不要发送 API Key**。

### 许可证

MIT — 见 [LICENSE](LICENSE)。

### 免责声明

GReview 不是 Valve 官方产品，与 Valve 无关联。Steam 评论是玩家公开内容；请遵守 Steam 使用条款与当地法律，合理控制请求频率。报告中的“口碑表现”不代表销量、收入或商业成败。
