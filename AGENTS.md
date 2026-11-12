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
