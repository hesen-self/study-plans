# Study Plans · 个人技术学习知识图谱系统

一个面向个人技术提升的知识图谱管理与学习打卡系统。以「知识图谱」为核心，将待学知识点组织成可视化关系网，配套学习路线、知识库、打卡统计、笔记资源与个人资料管理，帮助你体系化地追踪技术成长。

> 部署于 Cloudflare，单 Worker 同域托管 SPA + API，应用层自建登录（邮箱验证码 / GitHub OAuth）+ session cookie 实现多用户隔离。

---

## 功能特性

| 模块 | 说明 |
|------|------|
| 知识图谱 | 8 类可配置领域的知识点可视化，力导向图布局，支持增删改查、领域着色、状态/等级样式 |
| 节点管理 | 新建 / 编辑 / 删除节点与连线，字段含名称、领域、等级、标签；删除节点自动级联清理关联数据 |
| AI 助手 | 多轮对话构建图谱：先给出 G6 预览草稿，可反复提修改意见，确认后才正式新建；联网搜索结果可一键收藏为资源 |
| 学习路线 | 预置 / 自定义路线；概览卡与指标卡、按难度阶段分组、拖拽 / Alt+↑↓ 排序、状态循环切换与撤销、步骤进度条与累计学习时长、一键跳转教材与图谱定位 |
| 知识库 | 按节点生成 / 编辑教材，支持流式单节点生成与服务端批量任务（可取消、断点续跑） |
| 领域管理 | 领域清单可增删改；共享模板 + 每用户覆盖，图谱按领域着色 |
| 打卡统计 | 日历热力图、领域饼图、周时长柱状图、连续打卡天数；KV 缓存聚合结果 |
| 笔记资源 | 每个知识点 Markdown 笔记（marked 渲染）+ 资源链接（文档/视频/仓库/文章） |
| 语义搜索 | 基于 Workers AI（bge-m3）+ Vectorize 的笔记向量检索（P6） |
| 个人资料 | 昵称、头像（R2）、简介、目标、联系方式等信息维护 |
| 多用户隔离 | 基于登录邮箱的独立数据隔离，新用户自动初始化模板图谱 |

---

## 技术栈

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui 风格组件
- **可视化**：AntV G6（知识图谱）+ ECharts（统计图表）
- **后端**：Hono（Cloudflare Workers）
- **数据存储**：
  - D1（SQLite）— 主存储
  - R2 — 笔记 Markdown 与头像文件
  - KV — 统计聚合缓存 + 登录 session / 验证码
  - Vectorize — 笔记向量索引（语义搜索）
- **AI**：Workers AI（`@cf/baai/bge-m3` embedding；知识库 / Agent 对话另用生成模型）
- **鉴权**：应用层自建登录（邮箱验证码 + GitHub OAuth）+ httpOnly session cookie

---

## 架构

```
┌─────────────┐   单 Worker 同域托管
│   Browser    │ ─────────────────────────────┐
└─────────────┘                               │
        │ session cookie（邮箱验证码 / GitHub） │
        ▼                                      ▼
┌──────────────────────────────────────────────────┐
│        Cloudflare Worker（Hono）                  │
│  ├─ /api/*  REST 接口                             │
│  └─ ASSETS  SPA 静态资源 + 回退                    │
└──────┬─────────┬─────────┬──────────┬─────────────┘
       │         │         │          │
      D1         R2        KV     Vectorize + AI
   (主存储)  (笔记/头像) (统计+会话)  (语义搜索)
```

- **单 Worker**：`wrangler.toml` 通过 `[assets]` 绑定 `dist` 目录，Worker 同域托管前端与 API，session cookie（`HttpOnly` + `SameSite=Lax`）覆盖全站。部署请用 `npm run build` + `npx wrangler deploy`（`deploy:web` 为历史 Pages 脚本，勿与当前同域方案混用）。
- **数据隔离**：业务表带独立 `user_id` 字段；`nodes` / `roadmaps` / `domains` 等为复合主键 `(user_id, id)`，`edges` / `checkins` / `resources` 等为自增 id + `user_id` 列。查询/写入全链路按 `user_id` 过滤。

---

## 目录结构

```
study-plans/
├── src/                     # 前端源码
│   ├── App.tsx              # 路由 + 侧边栏导航 + 登录态
│   ├── api.ts               # API 封装与类型定义
│   ├── components/          # AgentPanel、NodeDrawer、NodeEditor、EdgeEditor、ui/*
│   ├── pages/               # GraphView、RoadmapView、KnowledgeView、StatsView、
│   │                        # DomainView、ProfileView、LoginView
│   ├── globals.css          # 语义化颜色 Token
│   └── lib/                 # utils、sanitize、date
├── worker/                  # Hono API
│   ├── index.ts             # 路由、身份中间件、全链路隔离
│   ├── auth.ts              # 邮箱验证码 + GitHub OAuth + session
│   ├── agent.ts             # 图谱草稿 / 联网搜索等 Agent 逻辑
│   ├── avatar.ts            # 头像上传校验
│   └── snowflake.ts         # 用户雪花 id
├── migrations/              # D1 迁移（按序号执行）
├── seed/seed.sql            # 48 节点 + 边 + 路线（写入 default 模板用户）
├── tests/                   # 纯函数 / 集成测试
├── private/                 # 内部文档（不提交）
├── wrangler.toml            # Cloudflare 配置
├── eslint.config.js         # ESLint flat config
└── AGENTS.md                # Agent 协作规范
```

---

## 快速开始

### 环境要求

- Node.js 18+
- Cloudflare 账号（部署时需要）

### 本地开发

```bash
npm install

# 按序执行全部迁移（含 0010），再导入种子数据
npm run db:migrate
npm run db:seed

# 同时启动 Worker（:8787）与前端（:5173）
npm run dev
```

访问 http://localhost:5173 ，用邮箱验证码或 GitHub OAuth 登录。
未登录请求除 `/api/auth/*` 外一律返回 401；如需匿名调试（映射到 `default` 用户），在 `.dev.vars` 写入 `ALLOW_ANONYMOUS=true` 或用 `wrangler dev --var ALLOW_ANONYMOUS:true` 启动，**线上不要设置该变量**。
跨域访问可在 `ALLOWED_ORIGINS` 中显式列举外部来源（不支持 `*`；同源与 `localhost` / `127.0.0.1` 回环地址默认放行，以适配 Vite 代理）。

种子 SQL 未显式写 `user_id`，依赖表默认值落入 `default` 模板用户，供新用户首次访问图谱时复制。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动 Worker + 前端（热更新） |
| `npm run dev:worker` | 仅启动 Worker |
| `npm run dev:web` | 仅启动前端 |
| `npm run build` | TypeScript 编译 + Vite 构建 |
| `npm run lint` | ESLint 检查（0 error 标准） |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm test` | 图谱草稿规范化纯函数测试 |
| `npm run db:init` | 仅初始化 0001（遗留命令，新环境请用 `db:migrate`） |
| `npm run db:seed` | 导入种子数据（default 模板） |
| `npm run db:migrate` | 按序应用全部本地 D1 迁移 |
| `npm run db:migrate:remote` | 按序应用全部线上 D1 迁移 |

---

## 数据模型

### 表结构

| 表 | 主键 | 说明 |
|----|------|------|
| `nodes` | `(user_id, id)` | 知识节点（名称、领域、等级、状态、进度、标签） |
| `edges` | 自增 id（含 `user_id`） | 节点关系（source/target/type：前置/相关/扩展） |
| `roadmaps` | `(user_id, id)` | 学习路线 |
| `roadmap_steps` | `(roadmap_id, user_id, node_id)` | 路线步骤 |
| `checkins` | 自增 id（含 `user_id`） | 打卡记录（日期、分钟数、备注） |
| `resources` | 自增 id（含 `user_id`） | 资源链接 |
| `users` | `id` | 账号（雪花 id + 登录邮箱 + 昵称/头像等资料；原 `profile` 表已合并后删除） |
| `domains` | `(user_id, id)` | 领域清单（共享模板 + 每用户覆盖） |
| `user_meta` | `user_id` | 图谱初始化标记 + 每日/每周学习目标 |
| `knowledge_docs` | 自增 id | 节点教材（`is_edited` 标记人工编辑） |
| `knowledge_jobs` / `knowledge_job_items` | `id` / `(job_id, node_id)` | 知识库批处理任务与逐节点进度 |

### 迁移顺序

`npm run db:migrate` 会按文件名顺序自动应用 `migrations/*.sql`，无需逐条手工执行。

> **部署顺序**：`0010_hardening.sql` 新增的表/列（`user_meta`、`knowledge_jobs`、`knowledge_docs.is_edited`、`domains.user_id`）被核心接口强依赖。必须先执行 `npm run db:migrate:remote`，再 `wrangler deploy`，否则 `/api/graph`、`/api/goals`、`/api/domains` 会 500。
> 早期用 `db:init` 手工建过的本地库没有迁移记录，建议清掉本地 `.wrangler/state` 后重新 `db:migrate`。

---

## 多用户数据隔离

- **身份来源**：应用层自建登录（邮箱验证码 / GitHub OAuth）签发 httpOnly session cookie，Worker 中间件解析出邮箱，再经 `users` 表映射为雪花 `user_id`。除认证接口外，未登录一律 401。
- **隔离机制**：纯独立 `user_id` 字段隔离（不使用 id 前缀拼接）。`nodes` / `roadmaps` / `domains` 采用复合主键 `(user_id, id)`，不同用户可创建同名节点/路线而互不冲突。
- **存储介质隔离**：R2 笔记 key 为 `notes/{user_id}/{nodeId}.md`，头像 key 为 `avatars/{user_id}/…`；KV 缓存 key 带 `:{user_id}` 后缀，session 前缀 `auth:session:`；Vectorize 向量通过 `metadata.userId` 过滤。
- **新用户初始化**：首次访问图谱且 `user_meta.graph_seeded = 0` 时复制 `default` 模板图谱（节点 + 边 + 路线，自动过滤 orphan edge）并置标记；用户主动删空图谱后不会回填。

---

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/graph` | 获取图谱（节点 + 边，含懒初始化） |
| POST | `/api/nodes` | 新建节点 |
| PATCH | `/api/nodes/:id` | 更新节点 |
| DELETE | `/api/nodes/:id` | 删除节点（级联清理） |
| POST | `/api/edges` | 新建连线（校验端点存在/归属/自环/重复） |
| PATCH | `/api/edges/:id` | 修改连线类型 |
| DELETE | `/api/edges/:id` | 删除连线 |
| GET/POST | `/api/domains` | 领域列表 / 新建 |
| PATCH/DELETE | `/api/domains/:id` | 更新 / 删除领域 |
| GET | `/api/roadmaps` | 路线列表 |
| POST | `/api/roadmaps` | 新建路线 |
| GET | `/api/roadmaps/:id` | 路线详情（含步骤） |
| PATCH | `/api/roadmaps/:id` | 更新路线 |
| DELETE | `/api/roadmaps/:id` | 删除路线 |
| PUT | `/api/roadmaps/:id/steps` | 替换路线步骤 |
| GET/POST | `/api/checkins` | 打卡查询 / 新增（自动推进节点进度） |
| DELETE | `/api/checkins/:id` | 删除打卡 |
| GET/PUT | `/api/goals` | 每日 / 每周学习目标 |
| GET/PUT | `/api/notes/:nodeId` | 笔记读取 / 保存（保存时异步写入向量索引） |
| GET/POST | `/api/resources` | 资源查询 / 新增 |
| DELETE | `/api/resources/:id` | 删除资源 |
| GET | `/api/stats/heatmap` | 打卡热力图数据 |
| GET | `/api/stats/summary` | 统计汇总 |
| GET/PUT | `/api/profile` | 个人资料读取 / 保存 |
| GET/POST | `/api/profile/avatar` | 头像读取 / 上传（R2） |
| GET | `/api/me` | 当前用户身份 |
| POST | `/api/search/semantic` | 语义搜索 |
| POST | `/api/search/web` | 联网搜索（返回 `configured` 表示是否配置 Tavily） |
| POST | `/api/agent/graph-draft?stream=1` | SSE 建图（`phase` → `result`/`error`）；JSON 模式仍可用 |
| POST | `/api/agent/draft-to-roadmap` | 按 prerequisite 拓扑从草稿生成学习路线（节点需已落库） |
| GET | `/api/knowledge` | 知识库文档列表 |
| GET | `/api/knowledge/nodes` | 可生成教材的节点列表 |
| POST | `/api/knowledge/generate-node` | 单节点生成教材 |
| POST | `/api/knowledge/stream-generate` | 流式生成教材 |
| DELETE | `/api/knowledge` | 清空知识库 |
| POST | `/api/knowledge/jobs` | 创建服务端批量生成任务 |
| GET | `/api/knowledge/jobs/active` · `/:id` | 恢复任务 / 查询进度 |
| POST | `/api/knowledge/jobs/:id/cancel` · `/resume` | 取消 / 断点续跑 |
| PATCH | `/api/knowledge/:nodeId` | 人工编辑教材（置 `is_edited`） |
| POST | `/api/agent/classify-domain` | 主题领域分类 |
| POST | `/api/agent/graph-draft` | 多轮对话生成 / 修订图谱预览草稿（**不落库**） |
| POST | `/api/agent/build-graph` | 确认预览后正式新建；可选 `linkExisting` 按名称挂接到已有节点 |
| POST | `/api/auth/send-code` | 发送邮箱验证码 |
| POST | `/api/auth/verify` | 校验验证码并签发 session |
| GET | `/api/auth/github` · `/callback` | GitHub OAuth 入口 / 回调 |
| GET | `/api/auth/me` | 登录态（含 `nickname`，侧栏优先显示昵称、未设置回退邮箱） |
| POST | `/api/auth/logout` | 登出并清除 session |

`/api/agent/graph-draft` 为无状态接口：前端持有 `messages`（最近 12 轮）与当前 `draft` 并回传；首轮联网搜索 + 拆解主题，后续按用户意见产出**完整的新草稿**（不是增量 diff）。草稿只存在于浏览器 `sessionStorage`，关闭面板再打开可继续对话；只有点击「确认新建」才会写库，且服务端会重新执行规模限制、枚举白名单、id 冲突重命名（同步 remap 边）、自环 / orphan edge 过滤。

所有 `/api/*` 接口均按当前登录用户（`user_id`）做数据隔离；除 `/api/auth/*` 外未登录返回 401。

---

## 部署

### 前置准备

1. 创建 Cloudflare API Token（权限需覆盖 Workers Scripts / D1 / R2 / KV / Vectorize / AI）。
2. 将 Token 与 Account ID 写入 `.cf-token`（已 gitignore）：

```
<API_TOKEN>
<ACCOUNT_ID>
```

3. 在 `wrangler.toml` 中回填 D1 数据库、KV、R2、Vectorize 等资源 ID（首次用 `wrangler d1 create` 等命令创建后回填）。
4. 配置密钥：`SMTP_PASS`（163 授权码）、`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（GitHub OAuth App 回调指向 `/api/auth/github/callback`）。

### 部署步骤

```bash
# 设置环境变量
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=<account_id>

# 先按序应用全部线上迁移，再部署 Worker（顺序不可颠倒）
npm run db:migrate:remote

# 构建并部署（单 Worker 同域托管前端 + API）
npm run build
npx wrangler deploy
```

### 应用层登录（鉴权）

站点使用应用层自建登录：邮箱验证码（163 SMTP）+ GitHub OAuth，会话通过 httpOnly cookie 存于 `STATS_KV`。除 `/api/auth/*` 外，未登录请求一律 401；线上勿设置 `ALLOW_ANONYMOUS`，额外跨域来源用 `ALLOWED_ORIGINS` 显式列举（不支持 `*`）。

### 可观测性（Workers Logs + 链路追踪）

`wrangler.toml` 已开启平台侧可观测性，无需额外 SDK：

| 配置 | 值 | 作用 |
| --- | --- | --- |
| `[observability.logs] enabled` | `true` | 采集 invocation logs、`console.*`、未捕获异常 |
| `[observability.logs] invocation_logs` | `true` | 记录每次调用的 Request / Response 元数据 |
| `[observability.traces] enabled` | `true` | 自动埋点出站 fetch、KV / R2 / Durable Object 绑定调用、RPC、handler 生命周期 |
| `head_sampling_rate` | `1`（100%） | 日志与追踪各自独立采样，流量上升后调小即可 |

- **查看**：Cloudflare Dashboard → Workers & Pages → `study-plans-api` → **Observability**（Logs / Traces）；实时日志用 `npx wrangler tail`。
- **结构化日志**：`worker/index.ts` 首个中间件输出 `kind: api_request`（`method` / `path` / `status` / `duration_ms` / `user_id` / `cf_ray` / `failed`），可在 Workers Logs 按字段检索；不记录 body、cookie、邮箱与验证码。
- **保留与计费**：日志与追踪均保留 7 天；2026-12-01 起纳入 Cloudflare Observability 按量计费，低流量项目用采样率控制成本。
- **版本要求**：`traces` 需 Wrangler 4.x，本项目为 `4.161.0`（配套 `@cloudflare/workers-types` 5.x）。

---

## 代码规范

见 `AGENTS.md`。要点：

- 前端 UI 使用 shadcn 组件 + 语义化颜色 Token（`bg-background` / `text-muted-foreground` 等），禁止 Tailwind 调色板类与任意色值。
- 后端遵循 Hono + D1，路由集中在 `worker/index.ts`，认证与 Agent 等拆分到同目录模块。
- 表结构变更需新增迁移文件，禁止修改已执行的迁移。
- 提交前 `npm run lint` 需 0 error。
- `npm test` 跑纯函数测试（图谱草稿规范化）；`npm run test:avatar` 为历史集成测试，依赖 Cloudflare runtime 的 `cloudflare:sockets` 与旧版 Access 头，Node 下不可直接运行。

---

## License

[Apache 2.0](LICENSE)
