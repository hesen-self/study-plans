# 学习提升系统 · 规划方案

> 版本 v0.2（Cloudflare 全栈版，待确认）| 用途：个人技术提升学习的知识图谱
> 确认后进入实现阶段

## 1. 定位与目标

- 个人技术学习的知识图谱系统，覆盖四大领域：**AI 通用、Java + AI、前端/Web、计算机基础**
- 核心回答三个问题：学什么（图谱/路线）、学到哪了（进度/打卡）、学了什么（笔记/资源）
- 云端部署，天然支持多端访问（PC/手机浏览器）

## 2. 技术选型（Cloudflare 全栈）

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vite + React + TypeScript，Cloudflare Pages 托管 | 生态成熟；Pages 免费托管 + 全球 CDN |
| 图谱可视化 | AntV G6 | 专注图关系展示，交互强（缩放/拖拽/聚焦） |
| 图表统计 | ECharts | 打卡热力图、进度统计 |
| 后端 | Cloudflare Workers + Hono | 与 Pages 同域部署，免 CORS；Hono 轻量、TypeScript 友好 |
| 鉴权 | Cloudflare Access | 个人白名单（邮箱 OTP），免费 ≤50 用户，免自建登录 |
| 开发工具 | wrangler（本地模拟 D1/R2/KV） | 本地开发与线上一致 |

### 2.1 Cloudflare 组件选型

| 组件 | 选用 | 用途 | 理由 |
|---|---|---|---|
| **D1**（SQLite） | ✅ 主存储 | 节点/边/路线/打卡/资源等结构化数据 | 关系型查询（按领域筛选、统计聚合）刚需；免费额度充足 |
| **R2** | ✅ 选用 | Markdown 笔记、资源附件（PDF/截图） | 对象存储适合大文本/文件；免出口流量费 |
| **Workers KV** | ✅ 轻用 | 统计聚合结果缓存（热力图/周月报表）、全局配置 | 高频读场景，避免每次重算聚合 SQL |
| **Vectorize** | ⭕ P6 引入 | 笔记/知识点 embedding 向量库 | 支撑语义搜索「找相关知识点」，契合 RAG 学习方向 |
| **Workers AI** | ⭕ P6 引入 | 生成 embedding（bge-m3）；可选：笔记摘要、学习建议 | 与 Vectorize 同生态，免外部 API Key |
| **AI Gateway** | ⭕ 可选 | 若接入第三方 LLM（DeepSeek/OpenAI）做学习助手时统一网关、缓存、限流 | 只用 Workers AI 则不需要 |
| **Hyperdrive (MySQL)** | ❌ 不选用 | — | 面向已有外部 MySQL 的加速场景；本项目无遗留库，D1 完全覆盖 |

**成本**：以上均在 Cloudflare 免费额度内，个人使用零成本。

## 3. 目录结构

```
study-plans/
├── PLAN.md                      # 本规划
├── package.json
├── wrangler.toml                # Workers + D1/R2/KV 绑定配置
├── migrations/                  # D1 数据库迁移（SQL）
│   └── 0001_init.sql
├── seed/                        # 种子数据（四领域图谱骨架）
│   └── seed.sql
├── worker/                      # Workers API（Hono）
│   ├── index.ts                 # 路由入口
│   └── routes/                  # graph / roadmap / checkin / note
└── src/                         # React 前端（Pages 部署）
    ├── pages/
    │   ├── GraphView.tsx        # 知识图谱主页
    │   ├── RoadmapView.tsx      # 学习路线
    │   ├── StatsView.tsx        # 打卡统计
    │   └── NodeDetail.tsx       # 节点详情/笔记
    └── components/
```

## 4. 数据模型（D1）

```sql
-- 知识点节点
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,            -- 'spring-ai'
  name TEXT NOT NULL,
  domain TEXT NOT NULL,           -- ai-general | java-ai | frontend | cs-basic
  level INTEGER DEFAULT 1,        -- 1入门 2进阶 3高级
  status TEXT DEFAULT 'todo',     -- todo | learning | done
  progress INTEGER DEFAULT 0,     -- 0-100
  tags TEXT,                      -- JSON array
  created_at TEXT DEFAULT (datetime('now'))
);

-- 关系边
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT REFERENCES nodes(id),
  target TEXT REFERENCES nodes(id),
  type TEXT DEFAULT 'related'     -- prerequisite前置 | related相关 | extend扩展
);

-- 学习路线（含有序步骤）
CREATE TABLE roadmaps (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT);
CREATE TABLE roadmap_steps (
  roadmap_id TEXT REFERENCES roadmaps(id),
  node_id TEXT REFERENCES nodes(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (roadmap_id, node_id)
);

-- 打卡记录
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT REFERENCES nodes(id),
  date TEXT NOT NULL,             -- '2026-11-12'
  minutes INTEGER NOT NULL,
  note TEXT
);

-- 资源链接
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT REFERENCES nodes(id),
  title TEXT, url TEXT,
  kind TEXT                       -- doc | video | repo | article
);
```

- **笔记**：R2 对象 `notes/<nodeId>.md`，与节点一对一
- **缓存**：KV 键 `stats:heatmap:<year>`、`stats:weekly` 等，打卡写入时失效重建

## 5. 功能设计（4 个页面）

### 5.1 知识图谱（主页）
- 力导向图展示全部知识点，按领域着色（AI 通用/Java AI/前端/计基）
- 节点样式区分状态：未学（灰）、学习中（描边高亮）、已掌握（实心）
- 交互：缩放、拖拽、按领域/状态筛选、搜索定位
- 点击节点 → 右侧抽屉显示详情（进度条、笔记、资源链接、关联节点）

### 5.2 学习路线
- 预置路线：如「Java AI 进阶路线」Java 基础 → Spring → Spring AI → RAG → Agent
- 路线节点显示完成状态，当前学习节点高亮
- 支持自定义调整顺序（增删节点）

### 5.3 打卡统计
- 日历热力图（GitHub 风格），连续打卡天数
- 按周/月统计学习时长、各领域时间分布饼图（聚合结果走 KV 缓存）
- 每个节点累计投入时长

### 5.4 笔记与资源
- 每个知识点对应一个 Markdown 笔记（R2），页内编辑保存
- 资源链接列表（文档/视频/仓库）
- 笔记支持双向回链到图谱节点

### 5.5（P6 可选）语义搜索与 AI 助手
- 笔记/节点描述 → Workers AI 生成 embedding → Vectorize
- 语义搜索：输入问题，召回相关知识点与笔记片段
- 若接入第三方 LLM 生成学习建议 → 经 AI Gateway 统一管理与缓存

## 6. 初始知识图谱种子数据

实现时预置四大领域骨架（约 40-60 个节点 + 依赖边），含：
- **Java + AI**：Java 基础 → Spring Boot → Spring AI / LangChain4j → RAG / 向量库 / Embedding → Agent
- **AI 通用**：大模型原理、Prompt 工程、微调、Agent、具身智能（关注向）
- **前端/Web**：JS/TS → React → 工程化（本系统本身就是练手项目）
- **计算机基础**：数据结构、网络、操作系统、数据库

## 7. 实施阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| P1 | 脚手架（Vite+Workers+Hono）+ D1 迁移 + 种子数据 | `wrangler dev` 可跑通 API |
| P2 | 知识图谱页（G6 力导向图 + 详情抽屉） | 核心可用（MVP） |
| P3 | 笔记/资源管理（R2 + resources 表） | 数据闭环 |
| P4 | 学习路线页 | 路线可视化 |
| P5 | 打卡统计页（ECharts + KV 缓存） | 完整系统 |
| P6 | 语义搜索（Vectorize + Workers AI），可选 AI 助手 | 智能化增强 |

建议先交付 P1+P2 作为 MVP 试用，再迭代其余。

## 8. 部署方案

1. `wrangler d1 create` / `r2 bucket create` / `kv namespace create` → 写入 `wrangler.toml` 绑定
2. `wrangler deploy` 发布 Workers API；`wrangler pages deploy dist` 发布前端
3. Cloudflare Access 配置应用白名单（仅本人邮箱）
4. 可选：绑定自定义域名

## 9. 待确认事项

1. **组件选型**：D1 + R2 + KV（P1-P5），Vectorize + Workers AI 留到 P6 —— 是否同意？
2. **鉴权**：Cloudflare Access 邮箱白名单，还是暂不做鉴权（仅自己用、链接不公开）？
3. **前置条件**：需要你的 Cloudflare 账号（API Token 或本地 `wrangler login`）才能实际部署；本地开发可先用 wrangler 模拟环境，无需账号
4. **节奏**：先做 MVP（P1+P2）看效果，还是 P1→P5 全量做？
