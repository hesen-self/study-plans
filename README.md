# Study Plans · 个人技术学习知识图谱系统

一个面向个人技术提升的知识图谱管理与学习打卡系统。以「知识图谱」为核心，将待学知识点组织成可视化关系网，配套学习路线、打卡统计、笔记资源与个人资料管理，帮助你体系化地追踪技术成长。

> 部署于 Cloudflare，单 Worker 同域托管 SPA + API，通过 Cloudflare Access 实现多用户登录与数据隔离。

---

## 功能特性

| 模块 | 说明 |
|------|------|
| 知识图谱 | 四大领域（AI 通用 / Java+AI / 前端Web / 计算机基础）知识点可视化，力导向图布局，支持增删改查、领域着色、状态/等级样式 |
| 节点管理 | 新建 / 编辑 / 删除节点与连线，字段含名称、领域、等级、标签；删除节点自动级联清理关联数据 |
| 学习路线 | 预置 / 自定义路线，步骤排序、整体替换，可视化步骤流 |
| 打卡统计 | 日历热力图、领域饼图、周时长柱状图、连续打卡天数；KV 缓存聚合结果 |
| 笔记资源 | 每个知识点 Markdown 笔记（marked 渲染）+ 资源链接（文档/视频/仓库/文章） |
| 语义搜索 | 基于 Workers AI（bge-m3）+ Vectorize 的笔记向量检索（P6） |
| 个人资料 | 昵称、头像、简介、目标、联系方式等信息维护 |
| 多用户隔离 | 基于登录邮箱的独立数据隔离，新用户自动初始化模板图谱 |

---

## 技术栈

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui 风格组件
- **可视化**：AntV G6（知识图谱）+ ECharts（统计图表）
- **后端**：Hono（Cloudflare Workers）
- **数据存储**：
  - D1（SQLite）— 主存储
  - R2 — 笔记 Markdown 文件
  - KV — 统计聚合缓存
  - Vectorize — 笔记向量索引（语义搜索）
- **AI**：Workers AI（`@cf/baai/bge-m3` embedding）
- **鉴权**：Cloudflare Access（登录 + 用户身份注入）

---

## 架构

```
┌─────────────┐   单 Worker 同域托管
│   Browser    │ ─────────────────────────────┐
└─────────────┘                               │
        │ Cloudflare Access（登录 + 注入 email）│
        ▼                                      ▼
┌──────────────────────────────────────────────────┐
│        Cloudflare Worker（Hono）                  │
│  ├─ /api/*  REST 接口                             │
│  └─ ASSETS  SPA 静态资源 + 回退                    │
└──────┬─────────┬─────────┬──────────┬─────────────┘
       │         │         │          │
      D1         R2        KV     Vectorize + AI
   (主存储)   (笔记md)  (统计缓存)  (语义搜索)
```

- **单 Worker**：`wrangler.toml` 通过 `[assets]` 绑定 `dist` 目录，Worker 同域托管前端与 API，便于 Access 统一保护全站（含 `/api`）。
- **数据隔离**：所有业务表带独立 `user_id` 字段，主键为复合主键 `(user_id, id)`，查询/写入全链路按 `user_id` 过滤。

---

## 目录结构

```
study-plans/
├── src/                     # 前端源码
│   ├── App.tsx              # 路由 + 侧边栏导航
│   ├── api.ts               # API 封装与类型定义
│   ├── components/          # 组件（NodeDrawer、NodeEditor、EdgeEditor、ui/*）
│   ├── pages/               # 页面（GraphView、RoadmapView、StatsView、ProfileView）
│   ├── globals.css          # 语义化颜色 Token
│   └── lib/utils.ts         # cn 工具
├── worker/index.ts          # Hono API（含身份中间件 + 全链路隔离）
├── migrations/              # D1 迁移（按序号执行）
├── seed/seed.sql            # 48 节点 + 边 + 路线种子数据
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

# 初始化本地 D1 并导入种子数据
npm run db:init
npm run db:seed

# 同时启动 Worker（:8787）与前端（:5173）
npm run dev
```

访问 http://localhost:5173 。本地开发无 Cloudflare Access 头，默认使用 `default` 用户身份。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动 Worker + 前端（热更新） |
| `npm run dev:worker` | 仅启动 Worker |
| `npm run dev:web` | 仅启动前端 |
| `npm run build` | TypeScript 编译 + Vite 构建 |
| `npm run lint` | ESLint 检查（0 error 标准） |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm run db:init` | 初始化本地 D1（0001 迁移） |
| `npm run db:seed` | 导入种子数据 |

---

## 数据模型

### 表结构

| 表 | 主键 | 说明 |
|----|------|------|
| `nodes` | `(user_id, id)` | 知识节点（名称、领域、等级、状态、进度、标签） |
| `edges` | 自增 id | 节点关系（source/target/type：前置/相关/扩展） |
| `roadmaps` | `(user_id, id)` | 学习路线 |
| `roadmap_steps` | `(roadmap_id, user_id, node_id)` | 路线步骤 |
| `checkins` | 自增 id | 打卡记录（日期、分钟数、备注） |
| `resources` | 自增 id | 资源链接 |
| `profile` | `user_id` | 个人资料 |

### 迁移顺序

迁移文件必须按序执行（本地 `db:init` 仅跑 `0001`，后续需手动执行）：

```bash
npx wrangler d1 execute study-plans --local --file=migrations/0002_profile.sql
npx wrangler d1 execute study-plans --local --file=migrations/0003_multiuser.sql
npx wrangler d1 execute study-plans --local --file=migrations/0004_multiuser_v2.sql
```

> 线上执行时将 `--local` 替换为 `--remote`。

---

## 多用户数据隔离

- **身份来源**：Cloudflare Access 保护全站，会在请求头注入 `Cf-Access-Jwt-Assertion`（JWT）。Worker 身份中间件解 JWT 的 `email` 作为 `user_id`；本地开发无该头时回退 `default`。
- **隔离机制**：纯独立 `user_id` 字段隔离（不使用 id 前缀拼接）。`nodes` / `roadmaps` 采用复合主键 `(user_id, id)`，不同用户可创建同名节点/路线而互不冲突。
- **存储介质隔离**：R2 笔记 key 为 `notes/{user_id}/{nodeId}.md`；KV 缓存 key 带 `:{user_id}` 后缀；Vectorize 向量通过 `metadata.userId` 过滤。
- **新用户初始化**：首次访问图谱时，若自身无数据，自动复制 `default` 用户的模板图谱（节点 + 边 + 路线）。

---

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/graph` | 获取图谱（节点 + 边，含懒初始化） |
| POST | `/api/nodes` | 新建节点 |
| PATCH | `/api/nodes/:id` | 更新节点 |
| DELETE | `/api/nodes/:id` | 删除节点（级联清理） |
| POST | `/api/edges` | 新建连线 |
| DELETE | `/api/edges/:id` | 删除连线 |
| GET | `/api/roadmaps` | 路线列表 |
| GET | `/api/roadmaps/:id` | 路线详情（含步骤） |
| PUT | `/api/roadmaps/:id/steps` | 替换路线步骤 |
| GET/POST | `/api/checkins` | 打卡查询 / 新增 |
| DELETE | `/api/checkins/:id` | 删除打卡 |
| GET/PUT | `/api/notes/:nodeId` | 笔记读取 / 保存 |
| GET/POST | `/api/resources` | 资源查询 / 新增 |
| DELETE | `/api/resources/:id` | 删除资源 |
| GET | `/api/stats/heatmap` | 打卡热力图数据 |
| GET | `/api/stats/summary` | 统计汇总 |
| GET/PUT | `/api/profile` | 个人资料读取 / 保存 |
| GET | `/api/me` | 当前用户身份 |
| POST | `/api/search/semantic` | 语义搜索 |

所有 `/api/*` 接口均按当前登录用户（`user_id`）做数据隔离。

---

## 部署

### 前置准备

1. 创建 Cloudflare API Token（权限需覆盖 Workers Scripts / D1 / R2 / KV / Vectorize / Pages / Access）。
2. 将 Token 与 Account ID 写入 `.cf-token`（已 gitignore）：

```
<API_TOKEN>
<ACCOUNT_ID>
```

3. 在 `wrangler.toml` 中回填 D1 数据库、KV、R2、Vectorize 等资源 ID（首次用 `wrangler d1 create` 等命令创建后回填）。

### 部署步骤

```bash
# 设置环境变量
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=<account_id>

# 线上执行迁移（按序）
npx wrangler d1 execute study-plans --remote --file=migrations/0002_profile.sql
npx wrangler d1 execute study-plans --remote --file=migrations/0003_multiuser.sql
npx wrangler d1 execute study-plans --remote --file=migrations/0004_multiuser_v2.sql

# 构建并部署（单 Worker 同域托管前端 + API）
npm run build
npx wrangler deploy
```

### Cloudflare Access（登录鉴权）

部署后通过 Cloudflare Access 保护站点，策略允许指定邮箱访问。Access 登录后自动注入用户身份，实现多用户数据隔离。

> 注意：自定义登录页模板（OTP 页面）需 Zero Trust 付费版，免费套餐使用默认登录页。

---

## 代码规范

见 `AGENTS.md`。要点：

- 前端 UI 使用 shadcn 组件 + 语义化颜色 Token（`bg-background` / `text-muted-foreground` 等），禁止 Tailwind 调色板类与任意色值。
- 后端遵循 Hono + D1，路由集中在 `worker/index.ts`。
- 表结构变更需新增迁移文件，禁止修改已执行的迁移。
- 提交前 `npm run lint` 需 0 error。

---

## License

[MIT](LICENSE)
