# GReview

[![CI](https://github.com/KTkeng/GReview/actions/workflows/ci.yml/badge.svg)](https://github.com/KTkeng/GReview/actions/workflows/ci.yml)

**Local-first Steam review analysis for game designers.** Bring your own DeepSeek API key; GReview fetches configurable review samples, builds a bias-free reputation trend from Steam's official aggregates, and produces an evidence-backed report with charts, themes, and actionable findings.

> 中文简介：GReview 是一个本地运行的 Steam 评论分析工具。填入自己的 DeepSeek Key，按条件抓取评论，用 Steam 官方聚合画真实口碑趋势，再由 AI 归纳吸引点、劝退点和可行动建议。应用代码全部在 [`GameReview/`](GameReview/)。

No account, no hosted server, no telemetry. Runs on `127.0.0.1` and stores datasets/reports locally.

## Repository layout

```text
GameReview/          # The application
  web/               # React + Vite + TypeScript frontend
  server/            # Node + Express + TypeScript backend
  docs/              # Acceptance status and known issues
  README.md          # Full application documentation
.github/workflows/   # CI (runs in GameReview/)
LICENSE
README.md
```

The application lives entirely in [`GameReview/`](GameReview/).

## Quick start

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

You will need a [DeepSeek API key](https://platform.deepseek.com/). The key is stored only in your browser's `localStorage` and sent per request; it is not written to the repo, logs, datasets, or reports.

## What it does

- Configurable Steam review sampling: helpful/recent/updated, positive/negative, languages, date range, purchase type, playtime, keywords, and more.
- Pre-fetch preview with match count, page/time estimate, and AI cost estimate.
- Reputation trend from Steam's official monthly aggregates, not from the top-voted sample.
- DeepSeek structured analysis: appeal points, friction points, expectation gaps, update impact, recommendations, and verified quotes.
- Local dataset/report reuse: repeat analyses avoid re-fetching Steam and re-spending tokens.
- Markdown export and browser print-to-PDF.

## Documentation

- [Application README](GameReview/README.md) — features, configuration, local data, privacy, troubleshooting
- [Acceptance and known issues](GameReview/docs/ACCEPTANCE.md) — test status, known limitations, deferred real-environment checks

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

GReview is not affiliated with Valve. Steam reviews are public user-generated content; respect Steam's terms and local law, and keep request rates reasonable. "Reputation performance" in reports does not imply sales, revenue, or commercial success.
