# AGENTS.md

本项目的 Agent 协作规范。所有 Agent 必须遵守本文件定义的职能边界、skill 使用规则与代码检查流程。

---

## 一、Agent 角色与职能

| Agent | 职能 | 负责范围 | 使用 Skill |
|-------|------|----------|-----------|
| **ui-builder** | 前端 UI 开发 | `src/**/*.tsx`、`src/globals.css`、`src/styles/**` | `ui-style` |
| **api-builder** | 后端接口开发 | `worker/index.ts`、`migrations/`、`seed/` | `api-design` |
| **code-reviewer** | 代码检查与增强 | 全部代码 | `eslint-check` |

### 职能边界

- **ui-builder**：只写 UI，不碰 worker / SQL。样式与版面必须遵守第二节「珍珠玻璃」规则。
- **api-builder**：只写 Hono 路由、D1 迁移与种子数据，不写 React 组件。
- **code-reviewer**：只读 + 运行检查，不直接改业务代码；发现问题输出报告，由对应 builder 修复。

### 协作流程

1. 需求 → 拆分给 ui-builder / api-builder。
2. 各自完成后，code-reviewer 运行 `npm run lint`。
3. lint 报错归零后才允许提交。

---

## 二、Skill: ui-style（珍珠玻璃 UI 统一规则）⚠️ 必读

本项目登录后控制台采用 **珍珠玻璃（Pearl Glass）** 视觉语言：冷灰绿舞台、深色厚边圆角外框、克制玻璃材质、蓝主操作 / 青柠状态点。技术栈仍是 **React + Tailwind + shadcn 语义 token**，外壳与材质用 CSS 变量 + `pearl-shell.css`，**禁止**另起一套暖奶油主题、扁平侧栏或仪表盘式散乱卡片堆叠。

### 2.1 文件与职责

| 路径 | 职责 |
|------|------|
| `src/globals.css` | shadcn HSL 语义色 + 珍珠玻璃令牌（`--stage` / `--frame` / `--ink*` / `--blue` / `--lime` 等） |
| `src/styles/pearl-shell.css` | 外壳、材质、侧栏、顶栏、`.page` / `.page-head` / `.panel` |
| `src/components/layout/AppShell.tsx` | `.stage` → `.app-frame` → Sidebar + Topbar + 内容区 |
| `src/components/layout/Sidebar.tsx` | 导航轨、分组、滑动 `nav-thumb` |
| `src/components/layout/Topbar.tsx` | 折叠、面包屑、用户菜单 |
| `src/components/ui/page-header.tsx` | 页头：大标题 + 说明 + 右侧操作 |
| `src/components/ui/panel.tsx` | 阅读面面板：`m-surface` + 可选标题/工具栏 |

- 登录态页面必须包在 `AppShell` 内；`App.tsx` 只保留鉴权与路由，**禁止**再内联一套侧栏。
- 未登录页（`LoginView`）在壳外；本规范不强制登录页做成神经网络舞台，但颜色仍用语义 token。

### 2.2 外壳版面（不可退回扁平侧栏）

结构固定为：

```
.stage                    // 灰绿舞台 + 8px 边距
  .app-frame              // 深色 10px 厚边、radius 38px
    aside.rail.m-rail     // 侧栏轨（--rail-w: 232px，折叠 76px）
    .workspace
      header.topbar       // 64px；内容滚动后 is-scrolled 凝结
      main.content
        .page             // 页内边距 26/28/40；窄屏 18/16/32
```

规则：

- **禁止**用 `flex h-screen` + 单列 `aside border-r` 替代珍珠玻璃外壳。
- 侧栏导航必须分组（如「学习」「管理」），选中态用滑动 `.nav-thumb.m-pill`，不要只靠 `bg-secondary`。
- 当前位置由顶栏面包屑承担；页头只写中文大标题，**不加**英文 eyebrow / `01 / 02` 编号。
- 窄屏（`≤820px`）：外框去边、侧栏改抽屉 + `.rail-scrim`；折叠偏好键 `study.railCollapsed`。
- 图谱等全幅画布高度使用 `.graph-canvas-h`（已扣 stage / frame / topbar / page 开销），禁止写死旧的 `100vh-110px`。

### 2.3 页面骨架（新页默认节奏）

业务页统一：

```tsx
<div className="stack">
  <PageHeader title="中文标题" desc="一句说明">
    {/* 可选：主操作 / 筛选 */}
  </PageHeader>
  <Panel title="区块名" meta="可选元信息" tools={/* 可选工具 */}>
    {/* 内容 */}
  </Panel>
</div>
```

| 场景 | 用法 |
|------|------|
| 列表 / 表单 / 统计区块 | `Panel`（`m-surface`） |
| 指标小卡 | `Panel flush` + 内边距内容 |
| 图谱画布 | `Panel flush` + `.graph-canvas-h` |
| 多区块纵向间距 | 外层 `stack`（gap 16） |

- **禁止**新页再用裸 `h1.text-2xl` + `rounded-lg border bg-card` 手写页头/卡片，除非在壳外的登录页。
- 改已有页时优先迁到 `PageHeader` / `Panel`，不要平行维护两套版面。

### 2.4 组件优先级

1. 优先使用 `@/components/ui/` 下已有组件（含 `PageHeader`、`Panel`、Button、Input 等）。
2. 缺少 shadcn 原子组件时，先运行：
   ```bash
   npx shadcn@latest add <组件名>
   ```
3. 不要手写已存在组件的重复实现。
4. 外壳 / 材质类（`.stage`、`.m-pill`、`.m-surface` 等）只放在 `pearl-shell.css`，页面用 class，不复制阴影/渐变配方。

### 2.5 颜色与令牌

页面与组件只引用语义 token / 珍珠变量，不手写调色板：

| 用途 | 用法 |
|------|------|
| 页面底 / 正文 | `bg-background` / `text-foreground`（映射 canvas / ink） |
| 次级文字 | `text-muted-foreground` 或 `var(--ink-muted)` |
| 主操作 / 选中 | `bg-primary` / `text-primary`（蓝 `#236de9`） |
| 边框 | `border-border` 或 `var(--line-strong)` |
| 阅读面 | `Panel` / `.m-surface`（不要叠多层自定义阴影） |
| 正常 / 能力点缀 | `var(--lime)`（仅状态点、section-label 前置点等） |
| 危险 | `text-destructive` / `var(--red-text)` |

禁止：

- Tailwind 调色板类（`bg-blue-500`、`text-red-600` 等）
- 任意颜色值（`bg-[#1a1a1a]` 等），**例外**：领域色等业务数据驱动的 `style={{ backgroundColor: domain.color }}`
- 重新引入暖奶油背景（旧 `--background: 40 33% 97%`）或紫色霓虹主题

改主题时只改 `globals.css` 令牌；勿在业务组件里硬编码色值覆盖壳层。

### 2.6 间距与圆角

- Tailwind 标准刻度：`p-4`、`gap-6`、`space-y-2` 等；禁止 `p-[13px]`、`gap-[7px]`。
- 壳层尺寸用 CSS 变量：`--rail-w`、`--topbar-h`、`--r-xs`…`--r-xl`；不要在 JSX 里写 `w-[180px]` 侧栏。
- 面板圆角用 `.panel`（`--r-lg`），不要另写 `rounded-xl` 一套。

### 2.7 字体层级

| 层级 | 用法 |
|------|------|
| 页面标题 | `PageHeader` → `.page-title`（约 28px / 740） |
| 面板 / 区块标题 | `Panel` 的 `title` → `.section-label`（青柠前置点） |
| 正文 | `text-sm` |
| 辅助 / 元信息 | `text-sm text-muted-foreground` 或 `.panel-meta` / `.page-desc` |
| 等宽 | 仅数字、编码、领域 id、时间 |

### 2.8 交互状态

- 所有交互元素必须有 hover / focus / disabled 状态。
- 使用 shadcn 组件自带的 `variant`、`size` 属性控制样式。
- 禁止手写 `hover:bg-xxx` 等状态类覆盖组件变体；壳层按钮用 `.shell-icon-btn` / `.nav-item` 既有状态。

### 2.9 明确不做（避免范围膨胀）

除非需求单独立项，否则 **不要**往本项目塞：

- Vue / GSAP / ⌘K 命令面板 / 外观密度对话框
- 仪器化读数层、神经网络登录、看板/矩阵等 scaffold 重型版式

借的是壳层构图、材质与 `PageHeader`→`Panel` 节奏，不是整库搬迁。

---

## 三、Skill: api-design（后端规则）

- 框架：Hono + Cloudflare Workers + D1。
- 路由集中在 `worker/index.ts`，按资源分组注释。
- 表结构变更必须新增 `migrations/xxxx_描述.sql`，禁止修改已执行的迁移文件。
- 示例数据写入 `seed/seed.sql`。

---

## 四、Skill: eslint-check（代码增强检查）

- 配置文件：`eslint.config.js`（flat config）。
- 命令：
  - 检查：`npm run lint`
  - 自动修复：`npm run lint:fix`
- 规则集：
  - ESLint 推荐规则 + TypeScript 推荐规则
  - `react-hooks`：Hooks 依赖与调用顺序强制检查
  - `react-refresh`：组件文件只允许导出组件
- 通过标准：`npm run lint` 0 error；warning 需说明理由。

---

## 五、图谱渲染规范（G6 v5 + d3-force）⚠️ 必读

`src/pages/GraphView.tsx` 使用 `@antv/g6` v5 的 `d3-force` 力导向布局。**筛选（领域/状态/关键词）切换 = 节点集合替换**，这里是已踩过多次的坑，禁止退回增量更新写法。

### 已踩过的坑（2026-11-12，连续 3 轮）

| # | 写法 | 后果 |
|---|------|------|
| 1 | `setData(data)` + `render()` 复用实例 | 切换筛选后**节点全部堆叠在一点**，标签糊成一团（d3-force 对替换后的新节点不重新迭代） |
| 2 | `setData(data)` + `layout().then(() => render())` | `Uncaught Error: Node not found for id: project-practice`（元素未建立就跑布局） |
| 3 | `setData(data)` + `render().then(layout).then(draw)` | 同样报 `Node not found for id: maven-gradle`（render 自带布局，再叠加 layout/draw 产生异步竞态） |

### 唯一正确做法：数据变化时销毁并重建 Graph 实例

```ts
useEffect(() => {
  if (!ref.current) return
  const data = buildData(filtered.nodes, filtered.edges)
  // 兜底：边只保留两端节点都在集合内的，防 orphan edge
  const validIds = new Set((data.nodes ?? []).map((n) => n.id))
  data.edges = (data.edges ?? []).filter(
    (e) => validIds.has(e.source) && validIds.has(e.target)
  )

  const graph = new Graph({
    container: ref.current,
    autoFit: 'view',
    data,                         // 直接把全量数据传入，不用 setData
    layout: { type: 'd3-force', link: { distance: 90 }, manyBody: { strength: -180 }, collide: { radius: 40 } },
    behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
  })
  graph.on('node:click', (e: IElementEvent) => {
    const id = (e.target as { id?: string }).id
    if (id) setSelected(id)
  })
  graph.render()
  graphRef.current = graph
  return () => {
    graphRef.current = null
    try { graph.destroy() } catch { /* 忽略销毁异常 */ }
  }
  // 依赖 filtered + domainColorMap；buildData 用 eslint-disable 抑制
}, [filtered, domainColorMap])
```

要点：
- **禁止**用 `graph.setData()` 做筛选切换，`render()` 内部已含布局，额外调 `layout()`/`draw()` 会竞态报错。
- 依赖数组必须含 `domainColorMap`（领域清单异步加载后要重建刷新颜色）。
- `graph.render()` 返回 Promise，但**不要**链式再调布局；保持单次调用。
- 数据量小（~70 节点），重建成本可忽略，可靠性优先于保留缩放/平移状态。

### 排查 `Node not found for id: xxx`

**先确认不是数据问题**，再动前端。查 orphan edges（边引用了不存在的节点）：

```bash
npx wrangler d1 execute study-plans --remote --command \
"SELECT e.id, e.source, e.target FROM edges e WHERE e.user_id='<uid>' AND (NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=e.source AND n.user_id=e.user_id) OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=e.target AND n.user_id=e.user_id));"
```

- 结果为空 → 数据一致，**问题 100% 在前端 G6 diff/布局时序**，按上面「重建实例」修。
- 结果非空 → 才是数据脏，需清理 orphan edges（注意 `default` 用户历史上残留过 55 条边但 0 节点）。
- 线上节点归属真实用户雪花 id（如 `396228104483246080`），不是 `default`；写 UPDATE 时别默认按 `user_id='default'` 过滤。
