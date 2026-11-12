# AGENTS.md

本项目的 Agent 协作规范。所有 Agent 必须遵守本文件定义的职能边界、skill 使用规则与代码检查流程。

---

## 一、Agent 角色与职能

| Agent | 职能 | 负责范围 | 使用 Skill |
|-------|------|----------|-----------|
| **ui-builder** | 前端 UI 开发 | `src/**/*.tsx`、`src/styles.css` | `ui-style` |
| **api-builder** | 后端接口开发 | `worker/index.ts`、`migrations/`、`seed/` | `api-design` |
| **code-reviewer** | 代码检查与增强 | 全部代码 | `eslint-check` |

### 职能边界

- **ui-builder**：只写 UI，不碰 worker / SQL。样式必须遵守第二节规则。
- **api-builder**：只写 Hono 路由、D1 迁移与种子数据，不写 React 组件。
- **code-reviewer**：只读 + 运行检查，不直接改业务代码；发现问题输出报告，由对应 builder 修复。

### 协作流程

1. 需求 → 拆分给 ui-builder / api-builder。
2. 各自完成后，code-reviewer 运行 `npm run lint`。
3. lint 报错归零后才允许提交。

---

## 二、Skill: ui-style（UI 样式规则）

### 组件优先级

1. 优先使用 `@/components/ui/` 下已有的 shadcn 组件。
2. 缺少组件时，先运行：
   ```bash
   npx shadcn@latest add <组件名>
   ```
3. 不要手写已存在 shadcn 组件的重复实现。

### 颜色（仅语义化 Token）

只允许使用语义化 Token 类：

- `bg-background` / `text-foreground`
- `text-muted-foreground`
- `border-border`
- `bg-primary` / `text-primary-foreground`

禁止：

- Tailwind 调色板类（`bg-blue-500`、`text-red-600` 等）
- 任意颜色值（`bg-[#1a1a1a]` 等）

### 间距

- 只使用 Tailwind 标准刻度：`p-4`、`gap-6`、`space-y-2` 等。
- 禁止任意值：`p-[13px]`、`gap-[7px]` 等。

### 字体层级

| 层级 | 类名 |
|------|------|
| 页面标题 | `text-2xl font-semibold tracking-tight` |
| 区块标题 | `text-lg font-medium` |
| 正文 | `text-sm` |
| 辅助文字 | `text-sm text-muted-foreground` |

### 交互状态

- 所有交互元素必须有 hover / focus / disabled 状态。
- 使用 shadcn 组件自带的 `variant`、`size` 属性控制样式。
- 禁止手写 `hover:bg-xxx` 等状态类覆盖组件变体。

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
