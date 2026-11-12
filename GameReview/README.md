# GReview

GReview 是一个**本地运行、自用、开源**的 Steam 评论分析工具。粘贴 Steam 游戏链接、填入你自己的 DeepSeek API Key，它会把高赞评论抓下来，用官方聚合数据画出真实口碑趋势，再用 AI 归纳出玩家为什么买账、为什么劝退，并生成一份可导出的报告。

它不判断游戏的商业成败（拿不到销量），只判断**口碑表现**。

> English summary: GReview is a local-first, open-source Steam review analyzer. Bring your own DeepSeek API key; it fetches configurable review samples, builds a bias-free reputation trend from Steam's official aggregates, and generates an evidence-backed report with charts. No account, no server, no telemetry. MIT licensed.

## 功能

- **灵活的抓取配置**：好评/差评、高赞/最新/最近更新、语言多选、时间范围、购买来源、数量上限，以及最低赞数、游玩时长、关键词、最短字数、排除抢先体验/免费获得等二次筛选。
- **抓取前预览**：展示游戏、总评论数、好评率、当前条件命中数、预估页数/耗时/AI 费用；不会盲抓。
- **真实口碑趋势**：按月调用 Steam 官方聚合，不拿高赞样本冒充时间趋势；报告标注数据源与覆盖区间。
- **AI 归纳**：核心吸引点、劝退点、玩家预期落差、版本/更新影响、可行动建议；每条主题附证据原话，并在服务端校验评论 ID 与引用是否真实存在。
- **报告优先**：结论 → 口碑趋势 → AI 归纳；另有 KPI、高赞评论、方法与局限。
- **导出**：Markdown 下载；浏览器打印/另存为 PDF。
- **本地数据复用**：抓取结果、趋势和报告自动保存；同条件再次分析默认复用，**不重复抓取、不重复消耗 token**。
- **密钥安全**：DeepSeek Key 只存浏览器 `localStorage`，通过请求头发送，服务端只在任务内存中持有，结束/取消即清除。

## 快速开始

要求：Node.js **20 或更高**。

```bash
npm install
npm run dev
```

开发模式会同时启动后端和 Vite 前端：

- 前端：<http://127.0.0.1:5173>
- 后端：<http://127.0.0.1:53821>

生产模式：

```bash
npm run build
npm start
```

然后打开 <http://127.0.0.1:53821>。

## Windows 一键启动

从 [Releases](https://github.com/KTkeng/GReview/releases/latest) 下载 `GReview-v0.1.3-windows.zip`，解压后双击 `start-greview.bat`。

- 首次运行会自动检查 Node.js 20+/npm、安装依赖，并打开浏览器。
- 之后双击会直接启动；如果 GReview 已在运行，只会打开浏览器。
- 不需要手动执行 npm 命令，也不需要把 API Key 写进文件。
- 如果未安装 Node.js，脚本会打开官方下载页面。

## 使用流程

1. 粘贴 Steam 商店链接、社区链接或直接输入 AppID。
2. 填入自己的 DeepSeek API Key，点击“测试连接”选择模型（默认 `deepseek-flash`）。
3. 配置抓取范围与趋势范围，点击“预览命中数”。
4. 点击“开始分析”，等待抓取 → 趋势聚合 → AI 分析 → 报告。
5. 查看报告，导出 Markdown 或打印为 PDF。
6. 下次同条件分析时，勾选复用本地数据集/报告即可节省时间和 token。

## DeepSeek API Key

- 从 [DeepSeek 开放平台](https://platform.deepseek.com/) 获取 API Key。
- Key 只保存在本机浏览器 `localStorage`；请求通过 `X-DeepSeek-Key` 头发送。
- 服务端不把 Key 写入日志、缓存、数据集、报告或导出物；任务结束/取消后清除内存引用。
- 默认 Base URL 为 `https://api.deepseek.com`，高级设置可改为兼容 OpenAI 协议的服务。
- “思考模式”开关默认关闭；开启后更慢、消耗更多 token，可能更深入。

## 本地数据与复用

默认数据目录是项目根下的 `./data/`（已加入 `.gitignore`），可在界面中改为任意绝对路径。

```text
data/
  <appid>/
    game.json
    reviews/<reviewsHash>/
      meta.json
      reviews.json
    trends/<trendHash>.json
    reports/<analysisHash>.json
    reports/<analysisHash>.md
```

- 抓取后自动保存评论与趋势；分析后自动保存报告。
- 同条件默认复用本地数据集和报告；界面会显示“复用本地数据 / 未请求 Steam / 本次未消耗 token”。
- “重新抓取”“重新分析”会强制刷新对应部分。
- 数据目录会校验绝对路径、可写性，并拒绝 `node_modules`、`.git`、源码目录等危险位置。
- 删除/清空数据只影响数据目录，不影响代码。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动后端（tsx watch）与前端（Vite） |
| `npm run build` | 构建前端与后端 |
| `npm start` | 启动生产后端并托管前端静态文件 |
| `npm test` | 运行后端与前端测试 |
| `npm run lint` | TypeScript 类型检查（含测试源码） |
| `npm run test -w server` | 只跑后端测试 |
| `npm run test -w web` | 只跑前端测试 |

## 数据源与限流

- 评论优先使用 Steam 官方 `IUserReviewsService/GetAppReviews`；失败时回退到商店的 `ajaxappreviews` 端点。
- 官方接口无需 Steam API Key；匿名请求有速率限制，超限返回 429。
- 请求按 350–500ms 间隔顺序发出，429 指数退避；原始响应短期缓存，减少重复请求。
- 趋势使用按月 `date_range` 聚合，与高赞样本解耦，避免采样偏差。

## 隐私与安全

- 服务只监听 `127.0.0.1`，不对外网开放。
- 写操作要求同源 `Origin`；缺少或跨源返回 403。
- 不收集遥测；除 Steam 与用户配置的 AI Base URL 外不发起外部请求。
- 不保存作者昵称、SteamID、头像等个人信息；只保存公开评论、游戏元数据、聚合结果与报告。
- Steam 评论是公开 UGC；请遵守 Valve/Steam 使用条款，不要批量再发布或用于骚扰。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 链接无效 / 找不到游戏 | 使用 `store.steampowered.com/app/<appid>`、`steamcommunity.com/app/<appid>` 或纯数字 AppID |
| 预览匹配数为 0 | 放宽语言、时间、购买来源或客户端筛选 |
| Steam 429 | 稍后重试；本地数据复用可避免重复请求 |
| DeepSeek 401/403 | Key 无效或无权限；重新输入并测试连接 |
| DeepSeek 429 | 降低样本量/分块，稍后重试 |
| 思考模式分析失败或超时 | 思考内容与正文共享输出预算，程序会自动提高 `max_tokens` 并延长超时；若仍失败，缩小样本量或关闭深度思考 |
| 端口冲突 | 设置 `PORT` 环境变量后重试 |
| 想清理数据 | 在“本地数据”面板删除单个数据集或清空全部；也可直接删除数据目录 |

## 项目结构

```text
GameReview/
  web/        React + Vite + TypeScript 前端
  server/     Node + Express + TypeScript 后端
  data/       本地数据集与报告（运行时生成，gitignored）
  docs/       验收状态与已知问题
```

软件源码全部位于本目录。

- 验收与已知问题：[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)

## 开发与验收

- 自动化测试：后端 235 项 + 前端 72 项（当前版本；Windows 上有 1 项符号链接测试按平台显式跳过）。
- 真实网络冒烟（Steam + 真实 DeepSeek Key）需要使用者在本机执行；自动化测试不依赖真实网络。

## 反馈与问题上报

发现 bug 或有建议，请发邮件到 **ktkengtu@163.com**。请附上游戏 AppID、错误码/错误详情、是否使用真实 DeepSeek Key；**不要发送 API Key**。

## License

MIT。见 [../LICENSE](../LICENSE)。

## 免责声明

GReview 不是 Valve 官方产品，与 Valve 无关联。Steam 评论是玩家公开内容；请遵守 Steam 使用条款与当地法律，合理控制请求频率。报告中的“口碑表现”不代表销量、收入或商业成败。
