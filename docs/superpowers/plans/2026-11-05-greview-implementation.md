# GReview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build GReview — a local, open-source Steam review analysis web app — through the existing three-model `greview-pipeline`, then verify it with automated tests and a real DeepSeek smoke.

**Architecture:** The pipeline's Contract phase produces Fable's frontend design and GPT-6's backend architecture; DeepSeek implements `server/` (Node/Express/TS) and `web/` (React/Vite/TS/ECharts); GPT-6 reviews the backend and Fable accepts the frontend. This plan wraps that pipeline with preflight, gap-fix, real-smoke, and open-source delivery gates. The approved design doc is the sole product spec.

**Tech Stack:** Node 20+, npm workspaces, TypeScript, React + Vite, ECharts, Express, Vitest, DeepSeek OpenAI-compatible API, Steam `IUserReviewsService/GetAppReviews` with `/ajaxappreviews` fallback.

**Spec:** `docs/superpowers/specs/2026-11-05-greview-design.md`

**Execution method:** `greview-pipeline` (user-selected; Tasks 1–2 run it, Tasks 3–7 verify/fix/deliver).

> 2026-11-06 仓库结构调整：产品代码已移至 `GameReview/`；本计划中的 `web/`、`server/`、`package.json`、`data/` 均相对于 `GameReview/`。流水线使用 `projectRoot: 'D:/GReview/GameReview'`，`specPath` 仍指向根 `docs/superpowers/specs/...`。

## Global Constraints

- The design doc is the sole source of truth. If the pipeline's contract conflicts with it, the design wins.
- Local-only: bind `127.0.0.1`; no accounts, database, cloud sync, desktop shell, or hosted service.
- API Key: browser localStorage → `X-DeepSeek-Key` header → job memory only. Never in logs, cache, `data/`, exports, or git.
- Steam: official `IUserReviewsService/GetAppReviews/v1` first; `/ajaxappreviews/<appid>` fallback; 350–500 ms between requests; 429 backoff; `day_range=0` for all-time helpful reviews; monthly `date_range` aggregates for trend.
- Local data: default `./data` (gitignored), custom absolute path allowed; auto-save reviews/trends/reports; reuse dataset and report by default; content hashes invalidate stale reports.
- AI: default `deepseek-flash`; user-controlled thinking toggle (default off); JSON mode; evidence ID + quote-substring validation; server-computed label/confidence.
- Report priority: conclusion → reputation trend → AI synthesis; Markdown export + browser print-to-PDF.
- UI Chinese; product name GReview; license MIT; Node `>=20`.
- Build via `greview-pipeline` with `maxRounds: 3`; artifacts in `.greview/` and `reports/` are gitignored.
- Do not push to GitHub unless the user explicitly asks.

## Review Focus

The five failure modes most likely to bite a user, each pinned to a test in the owning task:

1. **Steam endpoint drift.** The official response is wrapped in `response`; the old `/appreviews` path returns HTML; empty page, bad appid, and bad cursor can look identical. Expected: clear `APP_NOT_FOUND` / `NO_REVIEWS` / `STEAM_ENDPOINT_CHANGED`, never a silent empty report. Tested in Task 3.
2. **Rate limits and long jobs.** Steam anonymous 429s and DeepSeek 429/timeouts during multi-chunk analysis. Expected: backoff, cancel, job survives SSE reconnect, actionable error. Tested in Task 3.
3. **AI invalid JSON / hallucinated quotes.** DeepSeek JSON mode replaces unparseable output with spaces. Expected: one repair retry, Zod validation, quote-substring check, drop invalid themes, fail clearly if none survive. Tested in Task 3.
4. **Local data reuse correctness.** Content changes, model/thinking changes, Top N changes, corrupted JSON, custom data dir. Expected: content-hash key, no false cache hit, force flags work, path validation. Tested in Task 3.
5. **Local API / key safety.** Cross-origin abuse, key leakage, arbitrary data-dir writes. Expected: same-origin 403, key redaction, source-dir blacklist, no key in `data/`. Tested in Task 3.

---

## File Structure

```text
D:/GReview
├─ docs/superpowers/specs/2026-11-05-greview-design.md   # approved spec
├─ docs/superpowers/plans/2026-11-05-greview-implementation.md
├─ package.json                    # npm workspaces + root scripts (pipeline/integration)
├─ package-lock.json               # committed after npm install
├─ .gitignore                      # data/, .cache/, .greview/, reports/, .env
├─ README.md                       # quick start, config, privacy, data dir, disclaimer
├─ LICENSE                         # MIT
├─ .github/workflows/ci.yml        # Node 20, npm ci, test, build
├─ web/                            # pipeline-created React frontend
├─ server/                         # pipeline-created Node backend
├─ data/                           # runtime datasets/reports (gitignored)
├─ .greview/                       # pipeline artifacts (gitignored)
└─ reports/                        # pipeline acceptance report (gitignored)
```

Root scripts (design §10.1):

```json
{
  "dev": "concurrently -n server,web -c blue,green \"npm:dev -w server\" \"npm:dev -w web\"",
  "build": "npm run build -w web && npm run build -w server",
  "start": "npm run start -w server",
  "test": "npm run test -w server && npm run test -w web",
  "lint": "npm run lint -w server && npm run lint -w web"
}
```

Key interfaces the pipeline must produce (full definitions in the design doc):

- HTTP API: `/api/game/resolve`, `/api/game/preview`, `/api/ai/test`, `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/stream`, `/api/jobs/:id/cancel`, `/api/jobs/:id/report`, dataset/report endpoints, `/api/cache/clear`, `/api/health`.
- Job request: `CreateJobRequest` with `data.dataDir`, `reuseDataset`, `reuseReport`, `forceFetch`, `forceAnalyze`; `ai.thinking`.
- Local data: `data/<appid>/reviews/<reviewsHash>/`, `data/<appid>/trends/<trendHash>.json`, `data/<appid>/reports/<analysisHash>.json`.
- Report: `Report` type in design §9.4, including `methodology.dataSource`, `trendSource`, `analysisSource`, `reviewsHash`, `trendHash`, `thinkingEnabled`.

---

### Task 1: Pipeline preflight

**Files:** none (commands only).

**Interfaces:**
- Consumes: `tools/gpt6-bridge.mjs`, `.claude/workflows/greview-smoke.js`.
- Produces: confidence that Fable, GPT-6 bridge, and DeepSeek are reachable before the long build.

- [ ] **Step 1: Confirm clean baseline**

Run: `git -C D:/GReview status --short`
Expected: empty, or only the already-committed design/plan docs.

- [ ] **Step 2: Confirm Node and npm**

Run: `node --version && npm --version`
Expected: Node `v20.x` or newer; npm available.

- [ ] **Step 3: Probe GPT-6 bridge**

Run: `node D:/GReview/tools/gpt6-bridge.mjs --probe --json`
Expected: JSON with `"ok": true`, `"model": "gpt-6-astra"`, `"content": "OK"`. If it fails, set `GPT6_API_KEY` / `GPT6_BASE_URL` or stop and report.

- [ ] **Step 4: Run the three-model smoke**

Run the `greview-smoke` workflow (or `/verify-greview`).
Expected: `ok: true` and four checks true: `fableDesign`, `deepseekImplement`, `gpt6Bridge`, `fableAcceptance`. If any is false, record which role failed and stop.

- [ ] **Step 5: Commit only if a preflight fix was needed**

If no files changed, no commit. If a bridge/config fix was made, commit it with a focused message.

---

### Task 2: Run the main pipeline

**Files:**
- Create (pipeline): `.greview/contract.json`, `.greview/contract.md`, `web/`, `server/`, `reports/acceptance-report.md`.
- Read: `docs/superpowers/specs/2026-11-05-greview-design.md`.

**Interfaces:**
- Consumes: preflight from Task 1.
- Produces: `backend.status`, `frontend.status`, contract, acceptance report, generated code.

- [ ] **Step 1: Invoke `greview-pipeline`**

Fable and GPT-6 are called through bridges and cannot read files. The pipeline adds `specPath` as a prompt file to both bridges; keep `requirement` as a short instruction.

Use the Workflow tool:

```js
Workflow({
  name: 'greview-pipeline',
  args: {
    requirement: '严格按 specPath 的 GReview 设计文档实现。设计文档是唯一需求来源；不得引入账号、数据库、桌面壳；不得提交密钥。',
    specPath: 'D:/GReview/docs/superpowers/specs/2026-11-05-greview-design.md',
    projectRoot: 'D:/GReview/GameReview',
    frontendDir: 'web',
    backendDir: 'server',
    stack: 'React + Vite + TypeScript / Node + Express + TypeScript / ECharts / Vitest',
    maxRounds: 3
  }
})
```

- [ ] **Step 2: Inspect the returned status**

Expected: `backend.status === 'approved'` and `frontend.status === 'accepted'`. `build.backend.ok`, `build.frontend.ok`, `build.integration.ok` true. If not, record the findings and continue to Task 3/4 gap fixes; do not claim success.

- [ ] **Step 3: Read the contract and report**

Read `.greview/contract.md` and `reports/acceptance-report.md`.
Expected: contract matches design §10.4; report lists open questions and rounds. Extract unresolved findings into a gap list.

- [ ] **Step 4: Inventory generated files**

Run: `git -C D:/GReview status --short`
Expected: `web/`, `server/`, root files, and pipeline artifacts. Do not commit yet; verification follows.

---

### Task 3: Backend verification and gap fixes

**Files:**
- Modify: `server/**`, root `package.json` if missing.
- Test: `server/test/steam.normalize.test.ts`, `server/test/steam.filters.test.ts`, `server/test/storage.dataset.test.ts`, `server/test/storage.report.test.ts`, `server/test/ai.deepseek.test.ts`, `server/test/analysis.evidence.test.ts`, `server/test/security.origin.test.ts`.
- Reference: design §6.9, §7, §8, §10, §12, §13.

**Interfaces:**
- Consumes: generated `server/` from Task 2; design API contract.
- Produces: passing backend tests/build and verified critical behaviors.
- Required exports (create/adjust in these modules; the tests import from here):
  - `server/src/steam/url.ts` → `parseSteamUrl(input: string): number`
  - `server/src/steam/normalize.ts` → `normalizeSteamPage(raw: unknown, source: 'official' | 'storefront'): SteamPage`
  - `server/src/steam/appdetails.ts` → `resolveGame(appid: number, deps?: { fetchAppDetails?: () => Promise<unknown> }): Promise<GameMeta>`
  - `server/src/storage/paths.ts` → `resolveDataDir(input?: string): string`
  - `server/src/storage/dataset.ts` → `buildReviewsHash(input: ReviewsHashInput): string`
  - `server/src/storage/report.ts` → `buildAnalysisHash(input: AnalysisHashInput): string`
  - `server/src/ai/deepseek.ts` → `buildChatBody(input: ChatBodyInput): object`
  - `server/src/analysis/evidence.ts` → `validateEvidence(analysis: RawAnalysis, reviews: Review[]): ValidatedAnalysis`
  - `server/src/lib/origin.ts` → `allowWrite(req: { method: string; origin?: string }): boolean`, `allowRead(req: { method: string; origin?: string }): boolean`
  - `server/src/analysis/chunk.ts` → `estimateTokens(text: string): number`, `buildChunks(reviews: Review[], opts: { maxTokensPerChunk: number; maxChunks: number }): Review[][]`
  - `server/src/analysis/conclusion.ts` → `conclusionLabel(input: { reviewScoreDesc: string; allTimeRate: number; last90dRate: number }): string`, `confidenceFor(input: { sampleSize: number; trendMonths: number; nonZeroMonths: number }): 'high' | 'medium' | 'low'`

- [ ] **Step 1: Ensure the root workspace exists**

If root `package.json` is missing or lacks workspaces/scripts, create it per design §10.1 with `workspaces: ["web","server"]`, the five scripts, and `engines.node >= 20`. Run `npm install` at `D:/GReview`.

- [ ] **Step 2: Run the generated backend tests and build**

Run: `npm test -w server && npm run build -w server`
Expected: exit 0. If tests are missing, add the tests below; if they fail, fix `server/` first.

- [ ] **Step 3: Pin Steam URL parsing, normalization and filters**

Add/verify `server/test/steam.normalize.test.ts`:

```ts
expect(parseSteamUrl('https://store.steampowered.com/app/570/Dota_2/')).toBe(570);
expect(parseSteamUrl('https://steamcommunity.com/app/570')).toBe(570);
expect(parseSteamUrl('570')).toBe(570);
expect(() => parseSteamUrl('https://example.com/app/570')).toThrow('INVALID_URL');
expect(() => parseSteamUrl('0')).toThrow('INVALID_URL');

const raw = { recommendationid: 'r1', author: { playtime_forever: 120, playtime_at_review: 60 }, language: 'english', review: 'Combat feels great', timestamp_created: 1700000000, voted_up: true, votes_up: 42, weighted_vote_score: '0.8', comment_count: 1, steam_purchase: true, received_for_free: false, written_during_early_access: false, primarily_steam_deck: false, refunded: false };

const official = normalizeSteamPage({ response: { reviews: [raw], cursor: 'c1', query_summary: { total_positive: 9, total_negative: 1, total_reviews: 10 }, total_matching: 10 } }, 'official');
expect(official.reviews[0].id).toBe('r1');
expect(official.summary?.totalPositive).toBe(9);
expect(official.matchingTotal).toBe(10);
expect(official.source).toBe('official');

const fallback = normalizeSteamPage({ success: 1, reviews: [raw], cursor: 'c2', query_summary: { total_positive: 9, total_negative: 1, total_reviews: 10 } }, 'storefront');
expect(fallback.source).toBe('storefront');
expect(fallback.reviews[0].text).toContain('Combat');

const game = await resolveGame(570, { fetchAppDetails: () => Promise.reject(new Error('offline')) });
expect(game.appid).toBe(570);
```

Also assert mapping: `sort=helpful → filter:0`, `purchaseType=all → purchase_type:1`, `day_range=0` for all-time, `dateRange` → `date_range_start/end`, multi-language array → `languages`. Assert `normalizeSteamPage({ unexpected: true }, 'official')` throws `STEAM_ENDPOINT_CHANGED`; a 429 response retries with backoff and then throws `STEAM_RATE_LIMITED`; an empty page with an exhausted cursor throws `NO_REVIEWS`, while a bad appid throws `APP_NOT_FOUND`.

- [ ] **Step 4: Pin local dataset hashing and path validation**

Add/verify `server/test/storage.dataset.test.ts`:

```ts
const base = { appid: 1145360, filters: { languages: ['schinese','english'], reviewType: 'all', sort: 'helpful', purchaseType: 'all', dateRange: null, excludeOffTopic: true, useReviewQuality: true }, clientFilters: { minVotes: 0, minLength: 0, includeKeywords: [], excludeKeywords: [], excludeEarlyAccess: false, excludeFree: false }, maxReviews: 200 };
expect(buildReviewsHash(base)).toBe(buildReviewsHash({ ...base }));
expect(buildReviewsHash({ ...base, maxReviews: 500 })).not.toBe(buildReviewsHash(base));
expect(() => resolveDataDir('relative/path')).toThrow('DATA_DIR_NOT_ABSOLUTE');
expect(() => resolveDataDir('C:/GReview/server/src')).toThrow('DATA_DIR_FORBIDDEN');
```

Assert write/read roundtrip, atomic replace, and corrupted JSON is marked and not reused.

- [ ] **Step 5: Pin report cache invalidation**

Add/verify `server/test/storage.report.test.ts`:

```ts
const a = buildAnalysisHash({ reviewsContentHash: 'r1', trendContentHash: 't1', provider: 'deepseek', model: 'deepseek-flash', baseUrlHost: 'api.deepseek.com', promptVersion: 'v1', thinking: false, includeTranslations: true });
expect(buildAnalysisHash({ reviewsContentHash: 'r2', trendContentHash: 't1', provider: 'deepseek', model: 'deepseek-flash', baseUrlHost: 'api.deepseek.com', promptVersion: 'v1', thinking: false, includeTranslations: true })).not.toBe(a);
expect(buildAnalysisHash({ reviewsContentHash: 'r1', trendContentHash: 't1', provider: 'deepseek', model: 'deepseek-flash', baseUrlHost: 'api.deepseek.com', promptVersion: 'v1', thinking: true, includeTranslations: true })).not.toBe(a);
```

Assert `reuseReport=true` returns the cached report with `analysisSource: 'local_report'` and leaves the file unchanged; `forceAnalyze=true` bypasses; changing Top N regenerates `topReviews` without changing `analysisHash`.

- [ ] **Step 6: Pin DeepSeek JSON/thinking/error behavior**

Add/verify `server/test/ai.deepseek.test.ts`:

```ts
expect(buildChatBody({ model: 'deepseek-flash', thinking: false, json: true })).toMatchObject({ model: 'deepseek-flash', response_format: { type: 'json_object' }, thinking: { type: 'disabled' } });
expect(buildChatBody({ model: 'deepseek-flash', thinking: true, json: true })).toMatchObject({ thinking: { type: 'enabled' } });
```

Assert: blank/invalid JSON triggers exactly one repair retry; a second failure throws `AI_INVALID_RESPONSE`; HTTP 401 → `INVALID_AI_KEY`; HTTP 429 → retry/backoff then `AI_RATE_LIMITED`; timeout → `AI_TIMEOUT`.

- [ ] **Step 7: Pin evidence validation**

Add/verify `server/test/analysis.evidence.test.ts`:

```ts
const reviews = [{ id: 'r1', text: 'Combat feels great' }];
const result = validateEvidence({ themes: [{ name: 'Combat', evidenceIds: ['r1', 'missing'], quotes: [{ reviewId: 'r1', original: 'Combat feels' }] }] }, reviews);
expect(result.themes[0].evidenceIds).toEqual(['r1']);
expect(result.themes[0].quotes).toHaveLength(1);
expect(validateEvidence({ themes: [{ name: 'X', evidenceIds: [], quotes: [] }] }, reviews).themes).toHaveLength(0);
```

Assert: a quote not found as a normalized substring is dropped; a theme with no valid evidence is dropped; all themes dropped → `AI_INVALID_RESPONSE`.

- [ ] **Step 8: Pin chunking and token estimation**

Add/verify `server/test/analysis.chunk.test.ts`:

```ts
expect(estimateTokens('中文评论')).toBeGreaterThan(0);
expect(buildChunks(shortReviews, { maxTokensPerChunk: 60000, maxChunks: 8 })).toHaveLength(1);
const chunks = buildChunks(longReviews, { maxTokensPerChunk: 1000, maxChunks: 8 });
expect(new Set(chunks.flat().map(r => r.id)).size).toBe(longReviews.length);
expect(() => buildChunks(hugeReviews, { maxTokensPerChunk: 1000, maxChunks: 8 })).toThrow('AI_CONTEXT_TOO_LARGE');
```

Assert: every review appears exactly once; single-pass branch when total ≤80k; each chunk ≤60k; overflow beyond 8 chunks fails with `AI_CONTEXT_TOO_LARGE` rather than silently dropping reviews.

- [ ] **Step 9: Pin conclusion rules**

Add/verify `server/test/report.conclusion.test.ts`:

```ts
expect(conclusionLabel({ reviewScoreDesc: '特别好评', allTimeRate: 0.91, last90dRate: 0.84 })).toBe('特别好评 · 近期下滑');
expect(conclusionLabel({ reviewScoreDesc: '褒贬不一', allTimeRate: 0.55, last90dRate: 0.60 })).toBe('褒贬不一 · 近期回升');
expect(confidenceFor({ sampleSize: 120, trendMonths: 12, nonZeroMonths: 6 })).toBe('high');
expect(confidenceFor({ sampleSize: 40, trendMonths: 2, nonZeroMonths: 2 })).toBe('medium');
expect(confidenceFor({ sampleSize: 10, trendMonths: 0, nonZeroMonths: 0 })).toBe('low');
```

Assert: label is Steam desc + trend direction (≥5 percentage points up/down, else 持平); confidence follows design §9.3; AI text containing 销量/收入/在线人数 is rejected or replaced.

- [ ] **Step 10: Pin same-origin and key safety**

Add/verify `server/test/security.origin.test.ts`:

```ts
expect(allowWrite({ method: 'POST', origin: 'https://evil.example' })).toBe(false);
expect(allowWrite({ method: 'POST', origin: 'http://127.0.0.1:53821' })).toBe(true);
expect(allowRead({ method: 'GET', origin: undefined })).toBe(true);
```

Assert: cross-origin DELETE/POST → 403; GET health without Origin → 200; logs redact `Authorization`/`X-DeepSeek-Key`; dataset/report JSON contains no key.

- [ ] **Step 11: Run backend tests and build**

Run: `npm test -w server && npm run build -w server`
Expected: all pass. Fix `server/` gaps; do not delete or weaken tests.

- [ ] **Step 12: Commit backend verification**

```bash
git add server package.json package-lock.json
git commit -m "test(server): verify steam, storage, ai and security contracts"
```

---

### Task 4: Frontend verification and gap fixes

**Files:**
- Modify: `web/**`.
- Test: `web/src/components/ReusePrompt.test.tsx`, `web/src/lib/exportMarkdown.test.ts` (or equivalents).
- Reference: design §9, §11.

**Interfaces:**
- Consumes: backend API from Task 3; design report schema.
- Produces: passing frontend build and verified UI flow.

- [ ] **Step 1: Run the generated frontend build/tests**

Run: `npm run build -w web && npm test -w web` (if a test script exists).
Expected: exit 0.

- [ ] **Step 2: Verify config and reuse UI**

Start `npm run dev`; open the Vite URL. Confirm:
- Steam URL/AppID input, preview card, matched count, estimate.
- AI key, model list, test connection, thinking toggle (persists after reload).
- Data directory display, custom path validation, reuse prompt for dataset and report.
- “本次未消耗 token” and “未请求 Steam” badges appear on reuse.

- [ ] **Step 3: Verify report UI**

With a seeded/mock report or a real run, confirm:
- Conclusion card (label, headline, summary, confidence, caveats) is first.
- Trend chart shows monthly bars + positive-rate line and a source/coverage note.
- AI themes tabs (吸引点/劝退点/预期落差/更新影响), evidence quotes, translation labeled “AI 翻译”.
- Top reviews, methodology, Markdown export, print CSS hides config/progress.
- Keyboard navigation, visible focus, labeled inputs, `aria-live` progress; contrast meets AA.

- [ ] **Step 4: Add the reuse/thinking tests if missing**

`web/src/components/ReusePrompt.test.tsx`:
```tsx
render(<ReusePrompt dataset={{ count: 200, fetchedAt: '2026-11-05T10:00:00Z' }} report={{ generatedAt: '2026-11-05T10:05:00Z' }} onReuse={fn} onRefresh={fn} />);
expect(screen.getByText(/复用本地数据/)).toBeInTheDocument();
expect(screen.getByText(/本次未消耗 token/)).toBeInTheDocument();
```

`web/src/lib/exportMarkdown.test.ts`: fixture report → Markdown contains the conclusion headline, a trend table row, and a theme quote; no `<script>`/HTML injection is emitted.

- [ ] **Step 5: Run frontend tests and build**

Run: `npm test -w web && npm run build -w web`
Expected: all pass.

- [ ] **Step 6: Commit frontend verification**

```bash
git add web
git commit -m "test(web): verify report, reuse and export flows"
```

---

### Task 5: Real Steam + DeepSeek smoke

**Files:** none committed; evidence goes to `.greview/smoke-notes.md` (gitignored).

**Interfaces:**
- Consumes: running app from Task 4; user's real DeepSeek key.
- Produces: evidence that the real pipeline works and token reuse is real.

- [ ] **Step 1: Start the app**

Run: `npm run dev` (or `npm run build && npm start`). Open `http://127.0.0.1:53821`.

- [ ] **Step 2: Run a small real analysis**

Use AppID `1145360` (Hades), 20 reviews, 12-month trend, default languages 简中+英文, `deepseek-flash`, thinking off. Enter the key in the browser only; do not put it in a file or command line.
Expected: report renders with conclusion, a 12-point monthly trend whose source note says official aggregate (or local cache), AI themes, evidence quotes; no crash.

- [ ] **Step 3: Verify local data and key safety**

Check `data/1145360/` contains `reviews/`, `trends/`, `reports/`. Search `data/`, `.greview/`, `server/.cache/` for `Authorization`, `Bearer`, and the key value.
Expected: no key material. Record paths and token usage in `.greview/smoke-notes.md`.

- [ ] **Step 4: Verify reuse saves tokens**

Run the same config again without changing model/thinking.
Expected: UI shows “复用本地数据 / 本次未消耗 token”; no new Steam request; report served from `reports/`; token usage 0 change.

- [ ] **Step 5: Verify force paths**

Click “重新分析”.
Expected: new AI call; token usage increases; report updates. Click “重新抓取” (if offered) and confirm a fresh Steam request.

- [ ] **Step 6: Verify invalid key**

Enter an invalid key and click “测试连接” or start analysis.
Expected: clear `INVALID_AI_KEY` message; no crash; no key in logs.

- [ ] **Step 7: Record smoke evidence**

Write `.greview/smoke-notes.md` with: AppID, sample size, trend months, model, thinking, token usage first run, token usage second run (0), data paths, and any deviations. Do not include the key.

---

### Task 6: Open-source delivery

**Files:**
- Modify: `README.md`, `LICENSE`, `.github/workflows/ci.yml`, `package.json`, `.gitignore`.
- Reference: design §14.

**Interfaces:**
- Consumes: verified app from Tasks 3–5.
- Produces: repository ready for the user to push.

- [ ] **Step 1: Write the README**

Include: what GReview is; quick start (`npm install`, `npm run dev`, `npm run build && npm start`); how to get a DeepSeek key; config overview; local data directory and reuse; privacy/key handling; Steam rate limits and caching; troubleshooting; disclaimer (not affiliated with Valve; reviews are public UGC; respect Steam terms). Chinese primary, short English summary.

- [ ] **Step 2: Add the MIT license**

Use `Copyright (c) 2026 GReview contributors` (or the user's preferred name). Do not include personal email unless the user asks.

- [ ] **Step 3: Add CI**

`.github/workflows/ci.yml`: Node 20; `npm ci`; `npm test`; `npm run build`; matrix `ubuntu-latest` and `windows-latest`. Ensure `package-lock.json` is committed.

- [ ] **Step 4: Verify ignore rules**

Run: `git status --short` and `git check-ignore -v data .cache .greview reports .env`.
Expected: runtime data and secrets ignored; `server/test/fixtures/` tracked.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit and tag**

```bash
git add README.md LICENSE .github/workflows/ci.yml package.json package-lock.json .gitignore
git commit -m "docs: add open-source README, license and CI"
git tag v0.1.0
```

Do not push.

---

### Task 7: Final acceptance and handoff

**Files:** none committed (summary in the conversation or `.greview/final-notes.md`).

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: honest final status against design §13.3.

- [ ] **Step 1: Walk the acceptance checklist**

Go through design §13.3 item by item. Mark each pass/fail/deferred with evidence (command output, file path, screenshot, smoke note). Do not mark an item passed without evidence.

- [ ] **Step 2: Report pipeline statuses**

Record `backend.status`, `frontend.status`, rounds, and unresolved findings from `reports/acceptance-report.md`.

- [ ] **Step 3: Report real-smoke results**

Record first-run token usage, second-run 0-token reuse, data paths, and any deviations from Task 5.

- [ ] **Step 4: Handoff**

Summarize: how to run, where data lives, how to clear it, what is deferred, and what to do if Steam changes its endpoint. Remind the user that pushing to GitHub is theirs to do (or ask explicitly).

---

## Spec Coverage Map

| Spec section | Covered by |
| --- | --- |
| §3 goals/non-goals | Tasks 2–7; Global Constraints |
| §5 flow | Task 4 UI verification |
| §6.1 game resolution | Task 3 URL parsing, Task 4 UI |
| §6.2 scrape config | Task 3 filters, Task 4 UI |
| §6.3 preview | Task 3 API, Task 4 UI |
| §6.4 fetch/cache | Task 3 Steam tests |
| §6.5 trend | Task 3 API, Task 5 real smoke |
| §6.6 AI analysis | Task 3 AI/evidence tests, Task 5 smoke |
| §6.7 report/export | Task 4 tests |
| §6.8 key/settings | Task 3 security, Task 4 UI |
| §6.9 local data reuse | Task 3 storage tests, Task 5 smoke |
| §7.1–7.2 Steam APIs | Task 3 normalization/filter tests |
| §7.3 appdetails | Task 3 resolveGame fallback |
| §8.1–8.2 AI design | Task 3 AI/evidence tests |
| §8.3 chunking | Task 3 chunk tests |
| §8.4–8.6 schema/evidence/cost | Task 3 evidence tests, Task 5 token usage |
| §9.3 conclusion rules | Task 3 conclusion tests |
| §9 report design | Task 4 UI/tests |
| §10 architecture/API | Task 3 API contract, Task 6 CI |
| §11 UI/UX | Task 4 UI verification |
| §12 security | Task 3 origin/key tests |
| §13 acceptance | Tasks 3–7 |
| §14 open source | Task 6 |
