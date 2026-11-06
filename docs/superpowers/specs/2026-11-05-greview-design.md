# GReview 设计文档：Steam 评论分析工具

- 日期：2026-11-05
- 状态：已批准（Approved）— 2026-11-05
- 工作名：GReview（可改）
- 构建方式：`greview-pipeline`（Fable 前端设计/验收 + GPT-6 后端架构/监督 + DeepSeek 实现）

> 2026-11-06 仓库结构调整：产品代码位于 `GameReview/`；下文的 `web/`、`server/`、`package.json`、`data/` 路径均相对于 `GameReview/`。仓库根目录的 `.claude/`、`tools/`、`docs/superpowers/` 是开发流水线与设计文档。

---

## 1. 摘要

GReview 是一个**本地运行、自用、开源**的小型 Web 应用。游戏策划粘贴 Steam 游戏链接、填入自己的 DeepSeek API Key，配置抓取范围后，工具抓取评论、生成一份以**结论、口碑趋势、AI 归纳**为核心的可视化报告，并支持导出。

它不判断游戏的商业成败（拿不到销量），只判断**口碑表现**：玩家为什么买账、为什么劝退、近期在变好还是变差。

## 2. 背景与用户

- 用户：游戏策划/制作人，需要快速理解一款 Steam 游戏的玩家反馈，用于立项参考、竞品分析、版本复盘。
- 现状：人工翻评论耗时，高赞评论与真实口碑趋势容易混淆；通用 AI 聊天窗口无法稳定抓取和结构化呈现。
- 使用方式：本机启动，浏览器操作；不需要账号、服务器、数据库。
- 开源：代码公开在 GitHub，任何人可自行运行；API Key 由使用者自备，不进入仓库。

## 3. 目标 / 非目标 / 反目标

### 3.1 目标

| 编号 | 目标 |
| --- | --- |
| G1 | 从 Steam 商店链接、社区链接或纯 AppID 解析出游戏 |
| G2 | 提供足够细的抓取配置，并在抓取前展示命中数量与预估成本 |
| G3 | 抓取高赞评论样本，并支持按赞数、好评/差评、语言、时间、购买来源、游玩时长、关键词等筛选 |
| G4 | 用 Steam 官方聚合数据生成**不受采样偏差影响**的月度口碑趋势 |
| G5 | 用用户自己的 DeepSeek Key 做分块归纳，输出吸引点、劝退点、预期落差、更新影响、可行动建议，并附证据原话 |
| G6 | 生成以“结论 / 口碑趋势 / AI 归纳”为前三块的可视化报告，支持打印为 PDF 与导出 Markdown |
| G7 | 本地优先、无账号、密钥不落盘、请求有节流与缓存 |
| G8 | 通过现有 `greview-pipeline` 完成实现与验收 |
| G9 | 抓取数据与分析结果自动保存到本地（默认目录或自定义目录），复用时不再抓取、不再消耗 token |

### 3.2 非目标

- 账号体系、登录、云同步、多用户协作。
- 销量、收入、在线人数、商业成败判断。
- 代替人发布评论、自动回复、刷评、运营自动化。
- 多游戏横向对比（v1 不做；数据结构预留）。
- 桌面安装包（v1 不做；架构预留 Electron 壳）。
- 非 Steam 平台（TapTap、Epic、主机商店等）。
- 定时监控、增量快照、告警。
- 训练/微调模型。

### 3.3 反目标（即使“能跑”也算失败）

- 把“口碑好”写成“商业成功”。
- 用高赞样本直接画趋势而不标注偏差。
- AI 编造评论原文或证据。
- 无节制请求 Steam，触发限流或违反 Valve 的使用条款。
- API Key 出现在日志、缓存、导出物、Git 历史或前端构建产物中。
- 报告只有漂亮图表、没有可核对的证据。

## 4. 已决策事项

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 产品形态 | 本地 Web 应用（Node 后端 + 浏览器前端） | 配置项多、需要实时预览与报告交互；比 CLI 好用，比桌面壳轻 |
| 桌面端 | v1 不做，架构预留 Electron 壳 | 前端只通过 HTTP 调后端，Key/缓存/API 地址可替换 |
| 构建方式 | `greview-pipeline` | 复用仓库已有的三模型流水线 |
| 报告优先级 | 结论 → 口碑趋势 → AI 归纳 | 用户指定 |
| 趋势口径 | 官方聚合查询，不用高赞样本画趋势 | 高赞样本天然偏老，会误导 |
| AI 输出 | 结构化 JSON + 固定图表组件 | 图表稳定可复现，AI 只做归纳和解读 |
| 密钥存储 | 浏览器 localStorage，仅随请求头发送 | 自用场景够用；不写服务端磁盘 |
| 思考模式 | 用户开关控制，默认关闭 | 用户要求可自定义；默认省 token、降延迟 |
| 数据持久化 | 本地 JSON 数据集 + 报告，无数据库；默认 `./data`，可自定义绝对路径 | 开源零依赖、易清理；复用省 token |

## 5. 用户流程

```text
打开应用
  → 粘贴 Steam 游戏链接 / AppID
  → 若本地已有匹配数据，显示“复用本地数据 / 复用上次分析”选项（默认复用）
  → 填 DeepSeek API Key（可选：测试连接、选模型、思考模式）
  → 配置抓取范围（基础 + 高级筛选 + 趋势范围）
  → 点击“预览命中数”（展示游戏、总评论、好评率、匹配数、预估页数/耗时；复用时不请求 Steam）
  → 点击“开始分析”
  → 观看阶段进度（读取本地/抓取 → 趋势聚合/读取 → 预处理 → AI 分块 → 合并 → 生成报告）
  → 查看报告（结论 / 趋势 / AI 归纳 / 高赞评论 / 方法与局限）
  → 自动保存数据集与报告到本地；导出 Markdown 或浏览器打印为 PDF
```

失败路径：链接无效、游戏不存在、无匹配评论、Steam 限流、Key 无效、AI 返回不可解析、用户取消。每种失败都有明确文案和可重试入口。

## 6. 功能需求

### 6.1 游戏解析

支持输入：

- `https://store.steampowered.com/app/570/Dota_2/`
- `https://steamcommunity.com/app/570`
- `570`
- 带查询参数、语言前缀、末尾斜杠的变体

规则：

- 只提取 AppID（正整数），**不抓取用户输入的任意 URL**。
- 同时请求 `appdetails` 获取名称、头图、开发商、发行商、类型、发行日期、价格、简介；失败时用 AppID 兜底，不阻塞主流程。
- 非 Steam 链接、非数字、0、负数、超过 32 位的数字一律报 `INVALID_URL`。

### 6.2 抓取配置

基础配置：

| 配置 | 选项 | 默认 |
| --- | --- | --- |
| 评论类型 | 全部 / 好评 / 差评 | 全部 |
| 排序 | 高赞优先 / 最新 / 最近更新 | 高赞优先 |
| 语言 | 全部 / 简中 / 英文 / 多选 | 简中 + 英文 |
| 时间范围 | 全部 / 最近 30 / 90 / 365 天 / 自定义起止日期 | 全部 |
| 购买来源 | 全部 / Steam 购买 / 非 Steam | 全部 |
| 数量上限 | 50 / 100 / 200 / 500 / 1000（可输入） | 200 |

高级筛选（客户端二次筛选，可能增加抓取量）：

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| 最低赞数 | 只保留 `votes_up >= N` | 0 |
| 最低/最高游玩时长 | 评论时游玩时长（小时），优先用 Steam 原生参数 | 不限 |
| 关键词包含 | 空格分隔，全部包含（不区分大小写） | 空 |
| 关键词排除 | 空格分隔，任一包含即排除 | 空 |
| 最短字数 | 评论正文清洗后的字符数 | 0 |
| 排除抢先体验 | 排除 `written_during_early_access=true` | 否 |
| 排除免费获得 | 排除 `received_for_free=true` | 否 |
| 排除离题/差评轰炸 | 使用 Steam `filter_offtopic_activity`，默认排除 | 是 |
| 使用 Steam 质量排序 | `use_review_quality`；关闭后按加权赞数排序 | 是 |

趋势配置：

| 配置 | 选项 | 默认 |
| --- | --- | --- |
| 趋势范围 | 最近 6 / 12 / 24 个月 / 全部（最多 36 个月） | 12 个月 |
| 趋势粒度 | 月（v1 固定） | 月 |

「全部」在 API 中以 `trend.months=36` 表示；UI 档位标注为「全部（最多 36 个月）」，不新增独立取值。

### 6.3 预览命中数

预览必须在**不抓取全量评论**的前提下完成：

- 调用一次官方聚合查询，`review_type=all`，`num_per_page=1`，带上语言、购买来源、离题过滤、日期范围、游玩时长等 Steam 侧参数。**实测 `num_per_page=0` 会按默认 20 条返回，不能用 0 取汇总；固定用 1。**
- 读取 `query_summary.total_positive`、`total_negative`、`total_reviews` 或 `total_matching`。
- 展示：游戏卡、总评论数、好评/差评数、好评率、Steam 评分描述、**Steam 侧匹配数**。
- 明确标注：最低赞数、关键词、最短字数、排除抢先体验/免费获得属于客户端筛选，预览数字不含这些条件。
- 预估：页数 = ceil(匹配数 / 100)；耗时 = 页数 × 0.4s + 趋势请求数 × 0.4s；AI 分块数按 token 估算。
- 若匹配数为 0，禁用“开始分析”，提示放宽筛选。

### 6.4 抓取与缓存

- 开始任务时先按 `reviewsHash` 查本地数据集；命中且未 `forceFetch` 时直接读取，跳过下面的 Steam 抓取（见 6.9）。
- 分页抓取，`num_per_page=100`，顺序请求，不并发。
- 默认按高赞优先抓取；趋势优先走官方聚合，**不预先抓取趋势样本**；仅当聚合失败时按 6.5 懒加载回退样本。
- 客户端筛选不满足时继续翻页，直到凑够数量、游标耗尽或达到安全上限（`maxPages = 30`）。
- 抓取上限：用户设置的数量 + 回退趋势样本（如有）；总请求数硬上限 60 页/次分析。
- 去重键：`recommendationid`；多语言多请求时合并去重。
- 每页间隔 350–500ms；429 时指数退避（1s/2s/4s，最多 3 次），优先遵守 `Retry-After`；仍失败则报 `STEAM_RATE_LIMITED`。
- 请求带清晰 User-Agent：`GReview/0.1 (local open-source tool; +<repo URL>)`。
- **短期请求缓存**：原始页按「端点 + AppID + 参数字典序」哈希写入 `server/.cache/steam/`，TTL 24h；`appdetails` TTL 7d。命中缓存不再请求 Steam。它只用于节流，不等于用户可见的本地数据集（见 6.9）。
- **本地数据集**：每次成功抓取后，把归一化评论与趋势聚合持久化到数据目录（默认 `./data`，可自定义）；下次同条件分析默认复用，见 6.9。
- 缓存/数据集只含公开评论数据，不含 API Key。

### 6.5 趋势数据（关键口径）

**趋势不使用 AI 样本的赞数排序结果。** 高赞样本偏老，直接聚合会误导。

- **优先读取本地 `trends/<trendHash>.json`**（见 6.9）；未命中才按下面的官方聚合查询。
- 每根柱子 = 一个自然月或用户选择的周期；数据来自官方聚合查询：
  - `review_type=all`，`num_per_page=1`；
  - `date_range_start` / `date_range_end` 取该月 00:00:00 到月末 23:59:59（Unix 秒）；
  - 带上与抓取一致的语言、购买来源、离题过滤；
  - 读取 `query_summary.total_positive` / `total_negative` / `total_reviews`。
- 如果官方接口对 `date_range` + `num_per_page=1` 不返回汇总，回退到 `day_range` 累计差分（30/60/90…天），仍失败则回退到趋势样本时间戳聚合，并在报告标注「样本估算」。
- 月度请求数：12 个月 = 12 次；24 个月 = 24 次；最多 36 次。请求间同样 350–500ms 间隔。
- 趋势的 `review_type` 始终为 all（否则好评率无意义）；用户的“好评/差评”筛选只作用于 AI 样本。
- **抓取时间范围只作用于 AI 样本；趋势范围独立**（默认 12 个月）。UI 必须把两者分开标注，避免用户以为趋势被抓取时间范围截断。
- 月份边界按服务器本地时区计算（默认 `Asia/Shanghai`，可用 `TZ` 覆盖）；报告展示时区。
- 官方聚合失败时，才懒加载趋势样本：按 `recent` 排序、受剩余页数预算约束，用于回退估算并标注 `sample_estimate`。
- 游戏发行日期晚于范围起点时，从发行月开始。
- 图表下方必须显示：数据源、覆盖区间、是否使用官方聚合、样本是否参与。

### 6.6 AI 分析

- 分析前先按 `analysisHash` 查本地报告；命中且未 `forceAnalyze` 时直接返回，不调用 AI（见 6.9）。
- 输入：用户配置的评论样本（默认高赞优先，最多 1000 条），每条包含：
  - `id`、语言、好评/差评、`votes_up`、评论时游玩时长、创建时间、正文（清洗后截断 1500 字符）。
- 不把作者昵称、SteamID、头像等个人信息发给 AI。
- 输出结构化 JSON（见 9.4），必须包含：
  - 核心吸引点（玩家为什么买账）
  - 主要劝退点（为什么差评/退款/弃坑）
  - 玩家预期落差（宣传/类型预期 vs 实际）
  - 版本/更新影响（若有明显时间线索）
  - 可行动建议（按优先级）
  - 每条主题的证据评论 ID 与原文引用
- 报告正文用中文；非中文引用保留原文，并附 AI 生成的中文翻译（`zh` 字段）。
- 结论必须区分“口碑”与“商业”，不得出现销量、收入、在线人数等推断。
- AI 不负责画图；图表由前端根据结构化数据渲染。

### 6.7 报告与导出

报告页按以下顺序：

1. **结论卡**：口碑标签（如“特别好评 / 近期下滑”）、一句话结论、2–4 段分析、置信度、局限性。
2. **口碑趋势**：月度评论量柱状图 + 好评率折线；覆盖区间与数据源说明。
3. **AI 归纳**：吸引点 / 劝退点 / 预期落差 / 更新影响四个分组；每条主题含提及数、摘要、证据原话（可展开）。
4. **KPI 卡**：全部时间好评率、总评论数、最近 30 天好评率、本次样本量。
5. **高赞评论 Top N**：原文、赞数、游玩时长、好评/差评、语言。
6. **可行动建议**：优先级 + 依据。
7. **方法与局限**：筛选条件、样本量、趋势来源、AI 模型、token 用量、采样偏差说明。

导出：

- **Markdown**：文本 + 表格 + 主题清单 + 引用；趋势用表格和一句趋势摘要表示，注明图表见应用/PDF。
- **打印/PDF**：浏览器 `window.print()`，打印样式隐藏配置区与进度区，保留报告全部内容；ECharts 画布可打印。
- **JSON**（可选但建议）：完整报告对象，便于复现和二次分析。

### 6.8 设置与密钥

- API Key 输入框：密码态、显示/隐藏、粘贴。
- “测试连接”：调用 DeepSeek `GET /models`，返回可用模型与延迟；失败给出明确错误。
- 模型下拉：从 `/models` 获取；默认 `deepseek-flash`；允许手输自定义模型名。
- **思考模式开关**：用户可自定义开启/关闭，默认关闭。开启后本次分析的所有 AI 调用启用 thinking；界面提示“更慢、消耗更多 token，可能更深入”。开关状态保存在本地，并写入报告方法论。
- Base URL：默认 `https://api.deepseek.com`；高级设置可改，用于兼容其他 OpenAI 协议服务。
- Key 保存在浏览器 `localStorage`；页面明确提示“仅保存在本机浏览器”；提供“清除 Key”。
- 后端只在单次任务内存中持有 Key，任务结束/取消后清空；不写日志、不写缓存、不写导出物。

### 6.9 本地数据存储与复用（省 token）

**目标**：抓取过的评论和趋势自动落盘；下次同条件分析默认复用，不重复请求 Steam；若模型/提示词/思考模式未变，直接复用上次 AI 报告，不重复消耗 token。

**目录**

默认 `./data/`（项目根，`.gitignore` 忽略）；可在“本地数据”设置改为任意绝对路径；`DATA_DIR` 环境变量可改默认值。UI 显示当前解析后的绝对路径，提供“使用默认”“复制路径”“打开文件夹（可选）”。

```text
data/
  <appid>/
    game.json                         # 游戏元数据
    reviews/<reviewsHash>/
      meta.json                       # 抓取条件、时间、端点、数量
      reviews.json                    # 归一化评论（不含作者个人信息）
    trends/<trendHash>.json           # 月度聚合、覆盖区间、数据源、抓取时间
    reports/<analysisHash>.json       # 完整 Report
    reports/<analysisHash>.md         # Markdown 快照
```

- `reviewsHash = sha256(appid + canonical(reviewFetchConfig) + canonical(clientFilters) + maxReviews)`
- `trendHash = sha256(appid + trendMonths + anchorMonth + canonical(language/purchase/off-topic filters))`
- `reviewsContentHash = sha256(reviews.json 规范化内容)`；`trendContentHash = sha256(trends/<trendHash>.json 规范化内容)`。
- `analysisHash = sha256(reviewsContentHash + trendContentHash + provider + model + baseUrlHost + promptVersion + thinking + includeTranslations)`
- `anchorMonth` 是当前 `YYYY-MM`；跨月后趋势 key 变化，避免长期返回过期趋势。
- 覆盖数据集或刷新趋势后内容哈希变化，旧报告不会误命中；内容完全相同时仍可复用。
- Top N 不进入 `analysisHash`：它是服务端从数据集重新取的结果，改 Top N 不触发 AI 重跑；复用报告时按当前 Top N 从数据集重新生成 `topReviews` 并覆盖。
- 哈希只取前 16 位十六进制，便于阅读；`meta.json` 保留完整配置。
- 写入：临时文件 + rename 原子替换；不完整/损坏的数据集在列表标记，不自动复用。

**自动保存**

- 每次成功抓取后自动写 `reviews/<hash>/` 与 `trends/<hash>.json`；每次成功分析后自动写 `reports/<hash>.json`。失败不写。
- 同一 `reviewsHash` 再次抓取：默认复用；用户点“重新抓取”才覆盖，覆盖前后 UI 显示抓取时间与数量。
- 同一 `trendHash`：默认复用；用户点“刷新趋势”才重新聚合。

**复用规则**

- 开始分析时，若存在匹配 `reviewsHash` 且 `reuseDataset=true`（默认）：
  - 跳过评论抓取；UI 显示“复用本地数据：N 条，抓取于 …”；
  - `dataSource: 'local_dataset'` 写入报告方法论。
- 趋势同理：匹配 `trendHash` 时跳过聚合，`trendSource: 'local_cache'`。
- 若同时存在匹配 `analysisHash` 的报告且 `reuseReport=true`（默认）：
  - 直接返回报告，不调用 AI；UI 显示“使用本地分析结果，本次未消耗 token”；
  - 提供“重新分析”按钮，传 `forceAnalyze=true` 强制调用 AI；
  - 返回报告副本：`methodology.analysisSource='local_report'`、`servedAt=now`，不改写磁盘原始报告；原始 `reportGeneratedAt` 保留。
- 改模型/Base URL/思考模式/翻译/提示词版本 → `analysisHash` 变化：只复用数据，重新跑 AI。
- 改抓取条件 → `reviewsHash` 变化：重新抓取（或提示存在相似数据集）；趋势若匹配仍可复用。
- 数据不自动过期；UI 显示“抓取于 N 天前”，由用户决定是否刷新。

**列表与清理**

- “本地数据”面板：游戏、评论数、趋势覆盖、抓取时间、报告数量、占用空间。
- 操作：查看报告、重新分析、重新抓取、删除该数据集（含报告）、清空全部（二次确认）。
- 删除只影响数据目录，不动代码/仓库。

**路径校验**

- 默认 `./data` 相对工程根目录解析（`projectRoot/data`），不是进程 cwd。
- 必须是绝对路径；不存在则创建；必须是目录且可写（写临时文件测试）。
- 规范化后拒绝包含 `..` 的路径；拒绝 `node_modules`、`.git`、`web/src`、`server/src` 等源码目录，避免误写。
- 数据目录可位于项目内或项目外；默认 `./data` 已被 `.gitignore`。
- 自定义路径保存在浏览器 localStorage；后端按请求参数使用，不落服务端配置。

**隐私**

- 不保存 API Key、Authorization 头、完整请求日志。
- 只保存公开评论、游戏元数据、聚合结果与报告；作者昵称/SteamID 不落盘。
- 数据集默认不提交 Git；README 说明数据目录位置与清理方式。

## 7. 数据源与接口细节

### 7.1 Steam 官方评论接口（首选）

```http
GET https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?input_json=<URL编码的JSON>
```

`input_json` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `appid` | number | 必填 |
| `filter` | number | `0` 高赞（默认）、`1` 最新、`2` 最近更新；高赞受 `day_range` 影响 |
| `languages` | string[] | Steam 语言代码数组；空数组=英文；`["all"]`=全部 |
| `day_range` | number | 仅高赞；默认 30，最大 365；**`0` 表示不限** |
| `cursor` | string | 首页 `"*"`，后续用返回值 |
| `review_type` | number | `0` 全部、`1` 好评、`2` 差评 |
| `purchase_type` | number | `0` Steam 购买（默认）、`1` 全部、`2` 非 Steam |
| `num_per_page` | number | 最大 100 |
| `filter_offtopic_activity` | boolean | 默认过滤离题；`false` 包含 |
| `display_language` | string | 评分描述语言，建议 `schinese` |
| `use_review_quality` | boolean | 高赞排序时是否启用 Steam 质量排序 |
| `date_range_start` / `date_range_end` | number | Unix 秒；两者同时设置才生效 |
| `date_range_exclude` | boolean | 排除该区间 |
| `playtime_min_hours` / `playtime_max_hours` | number | 评论时游玩时长（小时） |
| `primarily_steam_deck` | boolean | 仅 Steam Deck 主要玩家 |
| `hardware_os` 等 | string | v1 不使用 |

响应关键字段：

- `query_summary.total_positive` / `total_negative` / `total_reviews`（仅首页、`review_type=all` 时可靠）
- `total_matching`（匹配总数）
- `cursor`
- `reviews[]`（最多 100 条）
- `day_range_used`（实际窗口）

注意（2026-11-05 实测）：

- 响应外层是 `response` 对象（Steam Web API 包装），归一化时先取 `response`。
- 该接口**无需 API Key**；匿名请求限流更严，超限返回 HTTP 429，可能被缓存最多 10 分钟。
- 没有 `success` 字段；以 HTTP 状态判断。
- `query_summary` 的 `total_positive` / `total_negative` 只在 `review_type=all` 时可靠；`review_type=positive/negative` 时只有 `num_reviews`，用 `total_matching` 取数量，或从 all 查询推导。
- `num_per_page=0` 实测按默认 20 条返回，不是只返回 summary；预览/聚合固定用 `num_per_page=1`。
- 实测 `languages` 数组、`purchase_type=1`、`playtime_min_hours`、`filter_offtopic_activity`、`date_range_start/end` 均生效；单月聚合可直接拿到 `total_positive/total_negative/total_reviews`。
- 若接口返回 404/410/5xx 或结构不符合预期，进入回退。

### 7.2 回退接口

```http
GET https://store.steampowered.com/ajaxappreviews/<appid>?json=1&...
```

- 旧的 `store.steampowered.com/appreviews/<appid>` 实测已返回商店页 HTML，不再可用；当前可用的商店端点路径是 `/ajaxappreviews/<appid>`（2026-11-05 实测）。
- 字段与 7.1 基本同构，参数为字符串枚举；响应含 `success`。
- `filter=all|recent|updated`；`review_type=all|positive|negative`；`purchase_type=all|steam|non_steam_purchase`；`language` 支持逗号分隔；`day_range=0` 不限；`filter_offtopic_activity=0/1`；`num_per_page=100`；`cursor`。
- 日期区间用 `start_date` / `end_date` / `date_range_type=include`；实测单月聚合可返回 `total_positive/total_negative/total_reviews`。
- 失败/空页/坏游标都可能返回 `{"success":1,"reviews":[]}`，需要结合上下文区分。
- 回退只作为容错，不作为默认；报告“方法与局限”中记录实际使用的端点。

### 7.3 游戏元数据

```http
GET https://store.steampowered.com/api/appdetails?appids=<appid>&l=schinese&cc=cn
```

- 取 `name`、`header_image`、`short_description`、`developers`、`publishers`、`genres`、`release_date`、`price_overview`。
- 失败不影响主流程；用 AppID 和评论数据兜底。
- 缓存 7 天。

### 7.4 参数映射（内部 → Steam）

内部 `ScrapeFilters`：

```ts
type ReviewType = 'all' | 'positive' | 'negative';
type SortMode = 'helpful' | 'recent' | 'updated';
type PurchaseType = 'all' | 'steam' | 'non_steam';

interface ScrapeFilters {
  languages: string[];            // ['schinese','english'] 或 ['all']
  reviewType: ReviewType;
  sort: SortMode;
  purchaseType: PurchaseType;
  dateRange: { start?: number; end?: number } | null; // Unix 秒
  minPlaytimeHours?: number;
  maxPlaytimeHours?: number;
  excludeOffTopic: boolean;
  useReviewQuality: boolean;
}

interface ClientFilters {
  minVotes: number;
  minLength: number;
  includeKeywords: string[];
  excludeKeywords: string[];
  excludeEarlyAccess: boolean;
  excludeFree: boolean;
}
```

映射：

| 内部 | 官方 `input_json` | 回退查询串 |
| --- | --- | --- |
| `sort=helpful` | `filter:0` | `filter=all` |
| `sort=recent` | `filter:1` | `filter=recent` |
| `sort=updated` | `filter:2` | `filter=updated` |
| `reviewType` | `0/1/2` | `all/positive/negative` |
| `purchaseType` | `0/1/2`（注意 all=1） | `steam/all/non_steam_purchase` |
| `languages` | 数组；`["all"]` 表示全部 | 逗号分隔；`all` 表示全部 |
| `dateRange` | `date_range_start/end` | `start_date/end_date/date_range_type=include` |
| `minPlaytimeHours` | `playtime_min_hours` | `playtime_filter_min` |
| `maxPlaytimeHours` | `playtime_max_hours` | `playtime_filter_max` |
| `excludeOffTopic` | `filter_offtopic_activity: !excludeOffTopic` | `filter_offtopic_activity=0/1` |
| `useReviewQuality` | `use_review_quality` | `use_review_quality=0/1` |

高赞抓取固定 `day_range:0`（不限时间），避免默认 30 天窗口只取到近期评论。

### 7.5 数据清洗与归一化

- 响应归一化：官方响应先取 `response`，回退响应取根；统一为 `{ reviews, cursor, summary, matchingTotal, source }`。
- 评论正文：解码 HTML 实体；去除 Steam BBCode（`[b]`、`[i]`、`[u]`、`[h1]`、`[url=...]`、`[img]` 等）；压缩连续空白；保留换行；截断到 1500 字符（AI 输入）。
- `weighted_vote_score` 是字符串，转 number；缺失按 0。
- 游玩时长单位统一为分钟，报告展示为小时（1 位小数）。
- 时间戳统一 Unix 秒；报告按本地时区展示。
- 多语言请求合并后按 `recommendationid` 去重；同一 ID 保留字段更完整的一条。
- 无效/空正文评论可保留用于统计（好评率、时长），但不送入 AI；若样本因此不足，提示用户。

## 8. AI 分析设计

### 8.1 Provider 抽象

```ts
interface AIProvider {
  listModels(): Promise<string[]>;
  testConnection(): Promise<{ ok: boolean; latencyMs: number; models: string[] }>;
  chatJson<T>(req: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
    temperature?: number;
    thinking?: boolean;
    signal?: AbortSignal;
  }): Promise<{ data: T; usage: TokenUsage; raw: string }>;
}
```

v1 只实现 `DeepSeekProvider`；接口保留给未来 OpenAI/Anthropic/本地模型。

### 8.2 DeepSeek 接入

- Base URL 默认 `https://api.deepseek.com`；OpenAI 兼容 `POST /chat/completions`。
- 默认模型 `deepseek-flash`；模型列表优先从 `GET /models` 获取，失败时回退到 `['deepseek-flash','deepseek-v4-pro']`。2026-11 可用的公开模型为 `deepseek-flash` 与 `deepseek-v4-pro`。
- **思考模式由用户开关控制，默认关闭**：
  - 关闭：请求体加 `thinking: { type: 'disabled' }`（或 `reasoning_effort: 'none'`），避免结构化抽取产生额外输出与延迟；
  - 开启：请求体加 `thinking: { type: 'enabled' }`（或 `reasoning_effort: 'high'`），本次任务的所有 AI 调用生效；
  - 模型不支持该参数时忽略，不因此失败；开启时 UI 必须提示更慢/更贵，成本预估同步上调。
- 测试连接优先 `GET /models`；该端点不可用时，回退为一次 `max_tokens: 1` 的最小 chat 调用。
- 请求头：`Authorization: Bearer <key>`、`Content-Type: application/json`。
- JSON 模式：`response_format: { type: 'json_object' }`；提示词中必须出现 “json” 字样并给出结构示例。
- `max_tokens` 按阶段设置（map 4096，merge 4096，final 8192）；DeepSeek 当前模型输出上限很高，但仍要防止截断。
- 错误处理：
  - HTTP 401/403 → `INVALID_AI_KEY`
  - HTTP 429 → 指数退避（1s/2s/4s，最多 3 次）→ `AI_RATE_LIMITED`
  - 超时（默认 120s/请求）→ `AI_TIMEOUT`
  - JSON 不可解析或为空 → 一次修复重试（把解析错误和原输出回给模型，要求只输出合法 JSON）；仍失败 → `AI_INVALID_RESPONSE`
- 不使用流式；按分块/阶段更新进度即可。

### 8.3 分块与 map-reduce

1. **预处理**：清洗、去重、截断；估算 token（中文按 1 字≈1 token，英文按 4 字符≈1 token，保守再乘 1.1）。
2. **分组**：
   - 每条评论约 200–600 token；目标每块 ≤ 60000 token，块数 ≤ 8。
   - 若总 token ≤ 80000，可单次 holistic 调用（主题 + 结论 + 建议一次产出）。
   - 若超过，则 map（逐块抽取主题与证据）→ merge（合并主题、去重、按提及数与赞数排序）→ final（结论 + 建议）。
3. **map 提示词**要求：
   - 只依据给定评论，不补充外部知识；
   - 每个主题至少 1 个 `evidenceIds`；
   - 引用必须是评论原文的子串；
   - 输出严格 JSON；
   - 区分好评/差评/中性，不把玩笑或反讽当事实。
4. **merge**：输入各块主题摘要、关键词、证据 ID、计数；输出合并后的主题，合并语义相近项，保留证据 ID 并集；按 `mentions` 和 `votesUp` 加权排序；每个主题最多 5 条引用。
5. **final**：输入合并主题 + KPI + 趋势摘要；输出结论、置信度、局限、建议。不得引入新主题。
6. **进度**：map 每完成一块上报 `ai_map` 进度；merge/final 上报阶段；总进度按权重（抓取 20%、趋势 15%、预处理 5%、AI 55%、校验 5%）。

### 8.4 结构化输出 Schema

AI 的 map 输出：

```json
{
  "themes": [
    {
      "name": "战斗手感扎实",
      "category": "gameplay",
      "sentiment": "positive",
      "summary": "玩家普遍认可打击感与操作反馈",
      "evidenceIds": ["123", "456"],
      "keywords": ["打击感", "手感", "战斗"]
    }
  ],
  "playerSegments": ["魂系老玩家", "首次接触类魂的玩家"],
  "expectationMentions": [
    { "expectation": "以为是无双割草", "reality": "实际是高难度动作", "evidenceIds": ["789"] }
  ],
  "updateMentions": [
    { "change": "1.2 版本削弱了某武器", "reaction": "部分玩家不满", "evidenceIds": ["790"] }
  ]
}
```

AI 的 final 输出：

```json
{
  "conclusion": {
    "label": "特别好评 / 近期下滑",
    "headline": "核心战斗与美术获认可，但近期平衡性更新引发不满",
    "summary": "2-4 段中文分析……",
    "confidence": "high",
    "caveats": ["样本以高赞评论为主，可能低估长尾玩家"]
  },
  "themes": [
    {
      "id": "t1",
      "name": "战斗手感扎实",
      "category": "gameplay",
      "sentiment": "positive",
      "mentions": 42,
      "summary": "……",
      "evidenceIds": ["123", "456"],
      "quotes": [
        { "reviewId": "123", "original": "原文……", "zh": "中文翻译……", "votesUp": 88, "votedUp": true }
      ]
    }
  ],
  "expectationGaps": [],
  "updateImpact": [],
  "recommendations": [
    {
      "title": "优先修复 1.2 版本的平衡性问题",
      "detail": "……",
      "priority": "high",
      "evidenceIds": ["790"]
    }
  ]
}
```

`conclusion.label` / `confidence` 仅作 AI 建议；服务端按 9.3 规则重算并覆盖。服务端最终 `Report` 结构见 9.4；AI 输出只提供内容，KPI/趋势/样本信息由服务端计算后合并，**AI 不得改写数字**。

### 8.5 证据校验

对 AI 返回的每个主题和引用：

1. `evidenceIds` 必须存在于本次送入 AI 的样本集合；不存在的 ID 删除。
2. `quotes.original` 必须是对应评论正文的连续子串（规范化：去空白、统一标点、大小写不敏感后比较）；不匹配的引用删除。
3. 主题删除所有无效证据后若 `evidenceIds` 为空，删除该主题。
4. `quotes.reviewId` 必须属于该主题的 `evidenceIds`。
5. `mentions` 以服务端统计为准（同一主题在多少条评论中被提及无法精确计算时，用 AI 给的计数并标注“AI 估计”）；`votesUp` 以原始评论为准，不信 AI。
6. `quotes.zh` 是 AI 翻译，无法做原文子串校验；UI 与导出必须标注“AI 翻译”，并以原文为准。
7. 结论的 `label` / `confidence` 由服务端规则计算（见 9.3），AI 只负责解释；AI 文本与规则冲突时以服务端为准。
8. AI 文本中的数字必须与输入 KPI/趋势一致；服务端做数字一致性检查，不一致时用模板化摘要替换或要求重试。
9. 最终报告若所有主题都被删除，返回 `AI_INVALID_RESPONSE`，建议用户缩小样本或换模型重试。

### 8.6 成本与用量

- 分析前展示：预计输入 token、预计输出 token、分块数、预计费用（按 `server/src/ai/pricing.ts` 的公开价，标注“估算”）。
- 开启思考模式时，输出 token 预估需包含 reasoning tokens，按 1.5–2 倍保守上调，并在 UI 标注“深度思考会显著增加耗时与费用”。
- 分析后展示：实际 `usage.prompt_tokens` / `completion_tokens`。
- 分析结果持久化到数据目录的 `reports/<analysisHash>.json`（见 6.9），不设短 TTL；命中时直接返回，不调用 AI。键包含 reviews/trend 内容哈希、provider、model、baseUrlHost、promptVersion、thinking、includeTranslations；Top N 不进键。
- 费用表可配置；DeepSeek 当前公开价（2026-11）：
  - `deepseek-flash`：输入 $0.15/$0.30 per 1M（off-peak/peak），输出 $0.60/$1.20 per 1M。
  - `deepseek-v4-pro`：输入 $0.66/$1.32 per 1M，输出 $1.98/$3.96 per 1M。
  - 价格可能变化；代码中集中管理，UI 标注“估算”。

## 9. 报告设计

### 9.1 信息架构

```text
Header：GReview | 游戏名 | 导出 Markdown | 打印 | 重新分析
  - 复用标记：本地数据 / 本地报告 / 本次消耗 tokens
结论卡（最高优先级）
  - 口碑标签 + 一句话结论
  - AI 分析摘要
  - 置信度 / 局限
KPI 行
  - 全部好评率 | 总评论数 | 近 30 天好评率 | 本次样本量
口碑趋势（第二优先级）
  - 月度柱状图 + 好评率折线
  - 数据源 / 覆盖区间 / 采样说明
AI 归纳（第三优先级）
  - Tabs：吸引点 | 劝退点 | 预期落差 | 更新影响
  - 主题卡片：名称、摘要、提及数、证据引用（展开看原文）
可行动建议
高赞评论 Top N（表格，可展开；默认 10 条，最多 50 条）
方法与局限（折叠）
```

### 9.2 图表清单

| 图表 | 类型 | 数据 |
| --- | --- | --- |
| 口碑趋势 | 柱状（评论量）+ 折线（好评率），双轴 | 官方月度聚合 |
| 主题分布 | 横向条形 | AI 主题提及数，按正/负着色 |
| 游玩时长分布 | 直方图 | 样本 `playtime_at_review` 分桶 |
| 语言分布 | 环图 | 样本语言计数 |
| KPI | 数字卡 | 官方聚合 + 样本 |

图表必须：

- 有标题、单位、图例、空状态；
- 颜色对色盲友好，正/负不只靠红绿，配合图标/文字；
- 不因 0 数据报错；
- 打印时保持可读。

### 9.3 结论口径

- 口碑标签优先使用 Steam `review_score_desc`（`display_language=schinese`），例如“好评如潮 / 特别好评 / 好评 / 多半好评 / 褒贬不一 / 多半差评 / 差评 / 特别差评 / 差评如潮”。
- 趋势方向由服务端规则计算：最近 90 天好评率 vs 全部好评率，差值 ≥5 个百分点为“上升/下滑”，否则“持平”；AI 只负责解释，不负责改标签。
- 标签组合示例：“特别好评 · 近期下滑”“褒贬不一 · 近期回升”“好评如潮 · 持平”。
- AI 结论不得出现“销量”“收入”“在线人数”“商业成功”等判断；如需表达，用“口碑表现”。
- 置信度规则：
  - high：样本 ≥100 且趋势覆盖 ≥3 个月且有 ≥2 个月非零数据；
  - medium：样本 30–99 或覆盖 1–3 个月；
  - low：样本 <30 或覆盖 <1 个月。
- 局限性必须至少提到：高赞样本偏差、语言筛选、离题过滤、评论不代表全部玩家、无法推断销量。

### 9.4 报告 JSON 顶层结构

```ts
interface Report {
  version: '1.0';
  generatedAt: string; // ISO
  game: GameMeta;
  sample: {
    filters: ScrapeFilters & ClientFilters;
    fetched: number;
    matchedTotal: number;
    usedForAI: number;
    languages: string[];
    dateCoverage?: { start: number; end: number };
    sourceEndpoint: 'official' | 'storefront';
    tokenUsage?: { input: number; output: number; estimatedCostUsd?: number };
  };
  kpis: {
    allTime: { total: number; positive: number; negative: number; positiveRate: number; reviewScoreDesc: string };
    last30d: { total: number; positiveRate: number; reviewScoreDesc: string };
    last90d: { total: number; positiveRate: number; reviewScoreDesc: string };
    samplePositiveRate: number;
  };
  trend: {
    granularity: 'month';
    source: 'official_aggregate' | 'sample_estimate';
    points: Array<{ period: string; total: number; positive: number; negative: number; positiveRate: number }>;
    coverage: { start: string; end: string; note: string };
  };
  conclusion: {
    label: string;
    headline: string;
    summary: string;
    confidence: 'high' | 'medium' | 'low';
    caveats: string[];
  };
  ai: {
    appealPoints: Theme[];
    frictionPoints: Theme[];
    expectationGaps: Theme[];
    updateImpact: Theme[];
    recommendations: Recommendation[];
  };
  topReviews: Array<{ // 默认 10 条，最多 50 条
    reviewId: string;
    text: string;
    votesUp: number;
    votedUp: boolean;
    language: string;
    playtimeHours: number;
    createdAt: number;
  }>;
  methodology: {
    note: string;
    steamRequests: number;
    cacheHits: number;
    reviewsHash?: string;
    trendHash?: string;
    dataSource: 'fresh' | 'local_dataset';
    trendSource: 'official_aggregate' | 'local_cache' | 'sample_estimate';
    analysisSource: 'fresh' | 'local_report';
    dataDir: string;
    datasetFetchedAt?: string;
    reportGeneratedAt?: string;
    servedAt?: string;
    aiModel: string;
    thinkingEnabled: boolean;
    promptVersion: string;
    generatedBy: string;
  };
}
```

`Theme` 与 `Recommendation` 见 8.4；字段名在前后端保持一致，前端类型从共享 `types.ts` 导入（如可行）或各端复制并加契约测试。

## 10. 技术架构

### 10.1 目录结构

```text
D:/GReview
├─ docs/superpowers/specs/2026-11-05-greview-design.md
├─ web/                     # React + Vite + TypeScript 前端
│  ├─ src/
│  │  ├─ components/
│  │  ├─ charts/
│  │  ├─ pages/
│  │  ├─ hooks/
│  │  ├─ lib/               # API 客户端、格式化、导出
│  │  ├─ styles/
│  │  └─ types.ts
│  ├─ index.html
│  └─ package.json
├─ server/                  # Node + Express + TypeScript 后端
│  ├─ src/
│  │  ├─ routes/
│  │  ├─ steam/             # client、normalize、trend
│  │  ├─ ai/                # provider、deepseek、prompts、schema、validate
│  │  ├─ analysis/          # chunk、map-reduce、report
│  │  ├─ jobs/              # 内存任务、SSE
│  │  ├─ cache/             # 短期请求缓存
│  │  ├─ storage/           # 本地数据集/报告、路径校验
│  │  ├─ lib/               # 错误、日志、hash、rate-limiter
│  │  └─ index.ts
│  ├─ test/
│  ├─ test/fixtures/
│  └─ package.json
├─ data/                    # 本地数据集与报告（gitignored；可自定义位置）
├─ tools/gpt6-bridge.mjs    # 流水线设施，不动
├─ .claude/                 # 流水线设施，不动
├─ package.json             # npm workspaces + 根脚本
├─ .gitignore
├─ README.md
├─ LICENSE
└─ .github/workflows/ci.yml
```

根 `package.json`：

```json
{
  "private": true,
  "workspaces": ["web", "server"],
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm:dev -w server\" \"npm:dev -w web\"",
    "build": "npm run build -w web && npm run build -w server",
    "start": "npm run start -w server",
    "test": "npm run test -w server && npm run test -w web",
    "lint": "npm run lint -w server && npm run lint -w web"
  }
}
```

生产模式：`npm run build` 后，后端静态托管 `web/dist`，`npm start` 打开 `http://127.0.0.1:<PORT>`；SPA 路由回退到 `index.html`。开发模式：Vite `server.proxy` 把 `/api` 代理到 `http://127.0.0.1:53821`，避免跨域。根 `package.json` 声明 `engines.node >= 20`。

### 10.2 后端模块

| 模块 | 职责 |
| --- | --- |
| `steam/client.ts` | 官方接口 → 回退接口；参数映射；429 退避；缓存 |
| `steam/normalize.ts` | 两种响应的统一 `Review`/`SteamSummary` |
| `steam/trend.ts` | 月度聚合；日期分桶；回退口径 |
| `steam/appdetails.ts` | 元数据；缓存 |
| `ai/deepseek.ts` | OpenAI 兼容调用；JSON 模式；错误映射 |
| `ai/prompts.ts` | map/merge/final 提示词；版本号 |
| `ai/schema.ts` | Zod schema；解析与修复 |
| `ai/validate.ts` | 证据 ID/引用校验 |
| `analysis/pipeline.ts` | 预处理、分块、map-reduce、组装 Report |
| `jobs/store.ts` | 内存任务、取消、清理 |
| `jobs/sse.ts` | SSE 事件 |
| `cache/file.ts` | 原子写、TTL、哈希键（短期请求缓存） |
| `storage/paths.ts` | 数据目录解析、可写测试、源码目录黑名单 |
| `storage/dataset.ts` | 数据集哈希、读写、列表、删除 |
| `storage/report.ts` | 报告缓存键、读写、复用 |
| `routes/*` | HTTP 契约 |
| `lib/errors.ts` | 错误码与 HTTP 映射 |
| `lib/logger.ts` | 结构化日志；Key 脱敏 |
| `lib/rate-limit.ts` | 顺序请求 + 退避 |

### 10.3 前端模块

| 模块 | 职责 |
| --- | --- |
| `pages/App.tsx` | 整体布局与流程状态 |
| `components/ConfigPanel.tsx` | 游戏、AI、抓取、趋势配置 |
| `components/LocalDataPanel.tsx` | 数据目录、数据集列表、复用/删除 |
| `components/ReusePrompt.tsx` | 复用数据集/报告提示，重新抓取/分析 |
| `components/GamePreview.tsx` | 预览卡与预估 |
| `components/Progress.tsx` | 阶段进度、日志、取消 |
| `components/ReportView.tsx` | 报告主视图 |
| `components/ThemeCard.tsx` | 主题与证据引用 |
| `charts/TrendChart.tsx` | 双轴趋势图 |
| `charts/ThemeBar.tsx` / `PlaytimeHistogram.tsx` / `LanguageDonut.tsx` | 其他图 |
| `lib/api.ts` | fetch 封装、SSE |
| `lib/exportMarkdown.ts` | Markdown 导出 |
| `lib/format.ts` | 数字、百分比、时长、日期 |
| `styles/` | CSS 变量与打印样式 |

状态管理：React `useState`/`useReducer` 即可，不引入 Redux。配置表单用受控组件；分析状态用 reducer 管理阶段/日志/报告。

### 10.4 HTTP API 契约

所有接口同源，仅监听 `127.0.0.1`。错误响应统一：

```json
{ "error": { "code": "STEAM_RATE_LIMITED", "message": "Steam 请求过于频繁，请稍后重试", "detail": "optional" } }
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/game/resolve` | `{ url }` → `{ appid, game }` |
| `POST` | `/api/game/preview` | `{ appid, filters, clientFilters, trend }` → `PreviewResult` |
| `POST` | `/api/ai/test` | Header `X-DeepSeek-Key`；`{ baseUrl?, model? }` → `{ ok, latencyMs, models }` |
| `POST` | `/api/jobs` | 创建分析任务，返回 `{ jobId }`；Header 带 Key |
| `GET` | `/api/jobs/:id` | 任务状态快照 |
| `GET` | `/api/jobs/:id/stream` | SSE 事件流 |
| `POST` | `/api/jobs/:id/cancel` | 取消任务 |
| `GET` | `/api/jobs/:id/report` | 完成后取报告 JSON |
| `GET` | `/api/datasets?dataDir=...` | 列出本地数据集（游戏、评论数、抓取时间、报告数） |
| `GET` | `/api/datasets/:appid/:reviewsHash?dataDir=...` | 数据集元信息 |
| `GET` | `/api/reports/:appid/:analysisHash?dataDir=...` | 读取已保存报告 |
| `DELETE` | `/api/datasets/:appid/:reviewsHash?dataDir=...` | 删除数据集及其报告 |
| `POST` | `/api/data/validate` | `{ dataDir }` → 解析路径、创建目录、测试可写 |
| `POST` | `/api/data/clear` | `{ dataDir, confirm: true }` 清空全部本地数据 |
| `POST` | `/api/data/open` | `{ dataDir }` 在系统文件管理器中打开（可选） |
| `POST` | `/api/cache/clear` | `{ appid? }` 清理短期请求缓存 |
| `GET` | `/api/health` | `{ ok, version }` |

`POST /api/jobs` 请求体：

```ts
interface CreateJobRequest {
  appid: number;
  filters: ScrapeFilters;
  clientFilters: ClientFilters;
  trend: { months: number };
  ai: { baseUrl?: string; model: string; temperature?: number; thinking: boolean };
  options: { maxReviews: number; includeTranslations: boolean; topReviews: number };
  data: {
    dataDir?: string;          // 不传用 DATA_DIR / 默认 ./data
    reuseDataset?: boolean;    // 默认 true
    reuseReport?: boolean;     // 默认 true
    forceFetch?: boolean;      // true 时忽略本地评论数据集
    forceAnalyze?: boolean;    // true 时忽略本地报告
  };
}
```

Key 通过 `X-DeepSeek-Key` 头传递，不放入请求体，避免被通用日志打印。

SSE 事件：

```text
event: status
data: {"stage":"fetching_reviews","progress":12,"message":"已抓取 200/500 条","counts":{"fetched":200,"target":500}}

event: log
data: {"level":"info","message":"Steam 返回 100 条，cursor 前进"}

event: done
data: {"report":{...}}

event: error
data: {"code":"AI_INVALID_RESPONSE","message":"..."}

event: cancelled
data: {}
```

- SSE 每 15s 发送 keep-alive 注释；前端断线后可用 `GET /api/jobs/:id` 恢复状态，任务继续执行。
- 同时最多 2 个任务；完成/失败的任务保留 1 小时供取报告，之后清理。

### 10.5 错误码

| 码 | HTTP | 场景 |
| --- | --- | --- |
| `INVALID_URL` | 400 | 链接/AppID 无法解析 |
| `APP_NOT_FOUND` | 404 | Steam 无此游戏 |
| `NO_REVIEWS` | 422 | 筛选后无评论 |
| `STEAM_RATE_LIMITED` | 429 | Steam 429/限流 |
| `STEAM_UNAVAILABLE` | 502 | Steam 超时/5xx |
| `STEAM_ENDPOINT_CHANGED` | 502 | 两种端点结构都不符合预期 |
| `INVALID_AI_KEY` | 401 | DeepSeek 401/403 |
| `AI_RATE_LIMITED` | 429 | DeepSeek 429 |
| `AI_TIMEOUT` | 504 | AI 请求超时 |
| `AI_INVALID_RESPONSE` | 502 | JSON 无效/证据全被删除 |
| `AI_CONTEXT_TOO_LARGE` | 413 | 样本超出模型上下文 |
| `JOB_NOT_FOUND` | 404 | 任务不存在/已清理 |
| `JOB_LIMIT` | 429 | 同时运行任务过多 |
| `CANCELLED` | 409 | 用户取消 |
| `INTERNAL` | 500 | 未预期错误 |

### 10.6 配置与环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `53821` | 后端端口 |
| `HOST` | `127.0.0.1` | 不监听 0.0.0.0 |
| `CACHE_DIR` | `server/.cache` | 短期请求缓存目录 |
| `DATA_DIR` | `./data` | 本地数据集/报告默认目录；UI 可覆盖 |
| `LOG_LEVEL` | `info` | `debug/info/warn/error` |
| `STEAM_REQUEST_DELAY_MS` | `400` | 请求间隔 |
| `AI_TIMEOUT_MS` | `120000` | 单次 AI 超时 |
| `AI_MAX_CHUNKS` | `8` | 分块上限 |
| `MAX_PAGES_PER_JOB` | `60` | 抓取页数硬上限 |
| `TZ` | 系统时区 | 趋势月份边界；建议 `Asia/Shanghai` |

不提供 `DEEPSEEK_API_KEY` 环境变量作为默认路径；Key 必须由 UI 输入，避免开源仓库误配置。

## 11. UI/UX 要求

### 11.1 布局

- 桌面：左侧 360px 配置栏（可折叠），右侧报告画布（最大 1100px）。
- 窄屏：配置在上、报告在下；sticky 底部“开始分析”。
- 顶部：产品名、当前游戏、导出/打印/重新分析。
- 空状态：一句说明 + 示例链接 + “填入 Key”提示。

### 11.2 设计方向（Fable 细化）

- 面向分析工作，不做事销页；信息密度高、层级清楚。
- 暗色优先，专业数据工具气质；可加浅色。
- 起始 tokens（可调整）：
  - 背景 `#0B0F14`，面板 `#1A2332`（`#121821` 用作背景次色），边框 `#1F2937`
  - 主文本 `#E5E7EB`，次文本 `#94A3B8`
  - 强调 `#38BDF8`，正向 `#22C55E`，负向 `#F87171`（WCAG AA），警示 `#F59E0B`
  - 字体：系统 UI + `Noto Sans SC`；数字用 tabular numerals
  - 间距 4/8/12/16/24/32；圆角 8/12
- 实现与契约以 `#1A2332` 为面板、`#F87171` 为负向色；原 `#EF4444` 在面板上对比度 4.19:1，不满足 WCAG AA。
- 图表颜色与 UI tokens 同源；正/负不只靠红绿。

### 11.3 状态与交互

- 表单校验即时反馈；无效链接、空 Key 时禁用开始。
- AI 设置区提供“思考模式”开关，默认关闭；开启时显示耗时/费用提示；开关状态持久化，并写入报告方法论。
- “本地数据”设置：显示当前数据目录（默认 `./data`），可改为绝对路径；提供校验、使用默认、复制路径、打开文件夹（可选）。
- 开始分析前显示复用提示：本地评论数据集（N 条，抓取于…）与本地报告（生成于…）是否复用；默认复用，可一键“重新抓取/重新分析”。
- 复用报告时显示“本次未消耗 token”；复用数据集时显示“未请求 Steam”。
- “本地数据”面板列出已保存的游戏/数据集/报告，支持查看、删除、清空全部。
- “预览命中数”有 loading/成功/空结果/错误四种状态。
- 分析中：阶段列表 + 进度条 + 可折叠日志 + 取消；取消后保留已抓取缓存。
- 报告：主题卡可展开证据；引用显示原文与中文翻译；高赞表可分页/滚动。
- 错误：显示错误码与可操作建议（重试、换 Key、放宽筛选、清缓存）。
- 打印：隐藏配置/进度/按钮；报告分页合理；图表不截断。

### 11.4 可访问性

- 键盘可达；focus 可见；表单有 label。
- 对比度达到 WCAG AA。
- 进度用 `aria-live="polite"`。
- 尊重 `prefers-reduced-motion`。

## 12. 安全与隐私

- 服务只绑定 `127.0.0.1`；默认端口 `53821`，冲突时提示设置 `PORT`。
- **同源校验**：写操作（POST/PUT/DELETE）要求 `Origin` 为 `http://127.0.0.1:<PORT>` 或 `http://localhost:<PORT>`，否则 403；GET/SSE 允许无 Origin 的本地只读请求。这样既能支持本地 CLI 探测，也能防止恶意网页调用本地接口写文件或发起 Steam 请求。
- **数据目录校验**：绝对路径；不存在则创建并写临时文件测试可写；规范化后拒绝 `..` 与 `node_modules`、`.git`、`web/src`、`server/src` 等源码目录；数据集文件名只由 appid/hash 生成，不接受用户自定义文件名。
- “打开文件夹”接口（如实现）只接受已校验的数据目录，不执行任意命令。
- Key：仅在内存与浏览器 localStorage；请求头传输；日志统一脱敏（`sk-***`）；缓存/导出/报告不含 Key。
- 不收集遥测；除 Steam 与用户配置的 AI Base URL 外不发起外部请求。
- AI Base URL 校验 `http/https`；不允许 `file:`、`data:` 等协议。
- 只从用户输入中提取 AppID，不请求用户输入的任意 URL，避免 SSRF。
- React 默认转义；禁止 `dangerouslySetInnerHTML`；如必须渲染富文本，先做白名单清洗。
- 评论是公开 UGC；缓存仅本地；README 注明不得批量再发布、不得用于骚扰。
- 免责声明：非 Valve 官方产品，与 Valve 无关联；遵守 Steam 使用条款；限流与缓存是产品要求。

## 13. 测试与验收

### 13.1 自动化测试

后端（Vitest）：

- URL 解析：合法/非法/带参数/纯数字/超长。
- 参数映射：官方数字枚举、回退字符串枚举、`purchase_type all=1`、`day_range=0`。
- 分页：cursor 前进、空页终止、坏游标、最大页数。
- 清洗：BBCode、HTML 实体、空白、截断、去重。
- 趋势：月份分桶、跨年、闰月、无评论月、发行日期裁剪、回退口径。
- 分块：token 估算、块数上限、单块/多块分支。
- AI：JSON 解析、修复重试、Zod 校验、证据 ID/引用子串校验、删除无效主题；thinking 开关到请求体的映射。
- 报告：KPI/趋势/结论规则、Markdown 导出、JSON 导出。
- 错误映射：Steam 429/5xx、DeepSeek 401/429/超时/空 JSON。
- 任务：创建、进度、取消、清理、并发上限。
- 本地数据：数据集写入/读取、哈希稳定、评论/趋势独立复用、报告缓存命中、`forceFetch`/`forceAnalyze`、损坏数据集、路径校验、删除/清空。
- 同源校验：跨源 `Origin` 返回 403。

前端（Vitest + Testing Library，轻量）：

- 配置表单校验与禁用逻辑。
- 预览/错误/空状态渲染。
- 报告 fixture 渲染：结论、趋势、主题、引用。
- Markdown 导出函数（可放共享库）。

集成测试（mock）：

- 本地 mock Steam + mock DeepSeek，跑完整 job → SSE → report。
- 不依赖真实网络；fixtures 放 `server/test/fixtures/`。

### 13.2 手工冒烟（README 记录，不跑 CI）

- 用真实 AppID（如 570）和真实 DeepSeek Key，抓 20 条、12 个月趋势，确认报告与引用。
- 检查浏览器 Network：Key 不在 URL；后端日志无 Key。
- 打印预览检查图表。
- **验收环境要求**：真实 DeepSeek Key、可访问 Steam 与 DeepSeek 的网络。若验收机器没有 Key/网络，流水线只完成 mock 全链路；依赖真实 AI 的验收项（AI 全流程、真实引用、真实 401/429/空 JSON）标记为 `deferred`，由用户在本机按 README 执行，不得伪造通过。

### 13.3 验收清单

- [ ] `npm install` 在根目录成功。
- [ ] `npm run dev` 同时启动前后端；`npm run build` 成功；`npm test` 全绿。
- [ ] 解析链接、预览命中数、抓取、AI 分析、报告全流程可用。
- [ ] 趋势来自官方聚合；报告标注数据源与覆盖区间。
- [ ] 证据引用可在样本原文中找到；无编造引用。
- [ ] 取消任务生效；429/401/空 JSON 有清晰错误。
- [ ] 导出 Markdown 与打印 PDF 可用。
- [ ] 抓取后自动写入本地数据集；同条件再次分析默认复用，不请求 Steam。
- [ ] 同模型/同提示词/同 thinking 再次分析默认复用报告，不消耗 token；“重新分析”可强制调用。
- [ ] 数据目录可改绝对路径并通过校验；删除/清空生效。
- [ ] 跨源请求被拒绝。
- [ ] Key 不出现在日志、缓存、本地数据目录、导出物、仓库。
- [ ] 服务只监听 127.0.0.1。
- [ ] README 包含启动、配置、隐私、限流、免责声明。

### 13.4 流水线验收

- `greview-pipeline` 的后端监督必须 `approve`，前端验收必须 `accept`。
- 若流水线契约与本文冲突，以本文为准；冲突项记录在 `reports/acceptance-report.md`。
- 流水线不得删除本文、不得引入账号/数据库/桌面壳。

## 14. 开源与交付

- 许可证：MIT（建议；用户可改）。
- README：中文为主，附英文简介；功能、截图（后续）、快速开始、配置说明、隐私与密钥、本地数据目录与清理、限流与缓存、常见问题、免责声明。
- `.gitignore`：`node_modules/`、`dist/`、`.cache/`、`data/`、`.env`、`.greview/`、`reports/`（流水线产物）、`*.log`。
- CI：GitHub Actions，Node 20，`npm ci` → `npm test` → `npm run build`；Ubuntu + Windows 矩阵。
- 不提交任何 Key、Cookie、个人数据。
- 版本号从 `0.1.0` 开始。

## 15. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Steam 接口再次变更/废弃 | 官方接口 + storefront 回退 + 统一 normalize + fixtures；错误码提示更新 |
| Steam 匿名限流 429 | 350–500ms 间隔、指数退避、24h 缓存、预览只取聚合 |
| 高赞样本偏差 | 趋势用官方聚合；报告标注样本偏差与覆盖区间 |
| AI 编造引用 | 证据 ID 校验 + 原文子串校验 + 删除无效主题 |
| AI 输出非 JSON | JSON 模式 + “json”提示 + 修复重试 + Zod |
| Token 成本超预期 | 分析前估算、分块上限、样本上限、分析缓存、显示实际用量 |
| Key 泄漏 | 请求头、日志脱敏、不落盘、localStorage 提示、清除按钮 |
| 长任务卡住 | SSE 进度、超时、取消、任务清理 |
| 端口冲突 | `PORT` 环境变量；启动错误提示 |
| 本地数据损坏/误删 | 原子写、损坏标记不复用、删除二次确认；用户可备份 data 目录 |
| 自定义数据目录误写到源码 | 绝对路径 + 源码目录黑名单 + 同源校验 |
| 本地接口被网页滥用 | 同源校验 + 127.0.0.1 + 限流 |
| 开源用户滥用 | 本地绑定、限流、缓存、README 免责声明；不提供托管服务 |
| Windows 路径/脚本差异 | 使用 Node `path`、跨平台 npm 脚本；CI 覆盖 Windows |

## 16. 留给 builder 的决定

以下不改变产品行为，由实现者决定：

- CSS 方案（CSS Modules / 原生 CSS / Tailwind）与具体组件拆分。
- ECharts 封装方式（直接 `echarts.init` 或 `echarts-for-react`）。
- 提示词的具体措辞（必须满足 8.3 的约束与 8.4 的 schema）。
- fixtures 选择、mock 服务器实现细节。
- 日志格式、错误文案措辞、加载动画。
- 是否额外提供 JSON 导出（建议提供）。
- 测试文件组织与覆盖率目标（建议后端核心模块 ≥70%）。
- 浅色主题是否在 v1 提供。
- 思考模式开关的文案与位置（行为已定：用户可开关，默认关闭，作用于本次任务全部 AI 调用）。
- 趋势样本回退的具体懒加载实现（受剩余页数预算约束）。
- 报告 JSON 导出的按钮位置与命名。
- 本地数据面板的具体布局、打开文件夹的实现方式（可选）。
- 数据集覆盖策略（直接替换 vs 保留 `.bak`）。
- 清空全部数据的确认文案。

## 17. 用户确认结果

1. **验收环境**：用户确认本机有可用的 DeepSeek API Key，且可访问 Steam 与 DeepSeek；流水线完成后由实现方跑真实冒烟（20 条评论 + 12 个月趋势），验证 AI 全流程、真实引用与 401/429 错误。模型以 `/models` 实测为准；默认 `deepseek-flash`，若不可用改用列表中的可用模型并在报告标注。
2. 许可证：MIT。
3. 产品名：GReview。
4. 默认语言筛选：简中 + 英文。
5. 导出：Markdown + 浏览器打印 PDF。
6. 本地数据：抓取后自动保存；默认 `./data`，可自定义绝对路径；同条件默认复用数据集/报告以节省 token。
7. 版本管理：实现前 `git init` 并做初始提交；VS Code 已接入 Git/GitHub，后续可推送。

## 18. 附录：流水线执行说明

实现前先跑一次 **Phase 0 live probe**（不在 CI）：用真实 Steam 接口验证官方端点的 `response` 包装、`date_range` 月度聚合、游标分页，以及回退端点 `ajaxappreviews`；结果固化为 fixtures。该探测已于 2026-11-05 手动完成，实现时只需把结果写成测试夹具。

实现阶段使用仓库现有 `greview-pipeline`：

> 注意：Fable 与 GPT-6 通过 bridge 调用，不能使用文件工具。流水线会把 `specPath` 指向的设计文档作为 prompt 文件传给两个 bridge，因此 `requirement` 保留为一段简短指令即可，不需要把全文塞进参数。

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

流水线产物：

- `.greview/contract.json`、`.greview/contract.md`
- `reports/acceptance-report.md`
- 产品代码：`web/`、`server/`
- 根 `package.json`、README、LICENSE、CI

验收时以本文第 13.3 节为准。
