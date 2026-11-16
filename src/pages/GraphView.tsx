import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Graph, GraphData, IElementEvent, IPointerEvent } from '@antv/g6'
import { api, DOMAIN_COLOR, Domain, Edge, Node } from '@/api'
import NodeDrawer from '@/components/NodeDrawer'
import NodeEditor from '@/components/NodeEditor'
import EdgeEditor from '@/components/EdgeEditor'
import AgentPanel from '@/components/AgentPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProgressBar } from '@/components/ui/progress-bar'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/ui/page-header'
import { Panel } from '@/components/ui/panel'

// 状态视觉：透明度 + 描边线型 + 光环三重编码，避免只靠颜色区分
const STATUS_OPACITY: Record<string, number> = { todo: 0.35, learning: 1, done: 1 }
const STATUS_LINE: Record<string, number> = { todo: 1, learning: 3, done: 2 }
const STATUS_DASH: Record<string, number[] | undefined> = { todo: [2, 2], learning: undefined, done: undefined }

const EDGE_LABEL: Record<string, string> = {
  prerequisite: '前置',
  related: '相关',
  extend: '扩展',
}

const STATUS_TEXT: Record<string, string> = {
  todo: '未开始',
  learning: '学习中',
  done: '已掌握',
}

// 标签可见性由 G6 的 auto-adapt-label 按空间占用实时决定（密集处隐藏、缩放后恢复）。
// 悬停/选中时强制点亮对应标签，避免被自动隐藏后无法识别节点。
function revealLabel(el: unknown): void {
  type LabelShape = {
    style?: { visibility?: string }
    forEach?: (cb: (n: { style?: { visibility?: string } }) => void) => void
  }
  const target = el as { getShape?: (name: string) => LabelShape | undefined }
  const label = target.getShape?.('label')
  if (!label) return
  if (typeof label.forEach === 'function') {
    label.forEach((n) => { if (n?.style) n.style.visibility = 'visible' })
  } else if (label.style) {
    label.style.visibility = 'visible'
  }
}

function nodeSizeOf(d: unknown): number {
  const rec = d as { level?: number; data?: { level?: number } } | null
  const level = rec?.level ?? rec?.data?.level ?? 1
  // 节点直径 + 标签占位留白，保证碰撞半径随节点大小自适应且标签不易重叠
  return 14 + level * 6 + 22
}

interface SemanticHit {
  id: string
  score: number
  node: Node | null
  preview: string
}

export default function GraphView() {
  const [searchParams] = useSearchParams()
  const ref = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  // 保存 render() 的 Promise：视口聚焦必须等元素控制器就绪后再执行
  const renderPromiseRef = useRef<Promise<void> | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [domains, setDomains] = useState<Domain[]>([])
  const [domainFilter, setDomainFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  // 关键词输入与生效值分离：输入去抖 300ms，避免每敲一个字都销毁重建整图
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic'>('keyword')
  const [legendOpen, setLegendOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph')
  const [selected, setSelected] = useState<string | null>(null)
  const [semanticQ, setSemanticQ] = useState('')
  const [semanticRes, setSemanticRes] = useState<SemanticHit[] | null>(null)
  const [showNodeEditor, setShowNodeEditor] = useState(false)
  const [editingNode, setEditingNode] = useState<Node | null>(null)
  const [showEdgeEditor, setShowEdgeEditor] = useState(false)
  const [showAgent, setShowAgent] = useState(false)
  // URL 定位与视口聚焦：首次失败可重试；用户主动关闭抽屉后不再弹回；聚焦只做一次
  const urlLocatedRef = useRef(false)
  const drawerDismissedRef = useRef(false)
  const urlFocusRef = useRef<string | null>(null)
  const urlFocusDoneRef = useRef(false)
  // 节点坐标记忆：重建实例时继承上一次的位置，避免筛选切换后整图跳位
  const posRef = useRef<Map<string, [number, number]>>(new Map())

  const load = useCallback(() => {
    // 只在「尚未成功定位」且「用户没主动关掉抽屉」时读 URL；
    // 首次请求失败不置位，后续 load 会自动补做定位
    const target = !urlLocatedRef.current && !drawerDismissedRef.current
      ? searchParams.get('node')
      : null
    return api.graph()
      .then((d) => {
        setNodes(d.nodes)
        setEdges(d.edges)
        if (target && d.nodes.some((n) => n.id === target)) {
          urlLocatedRef.current = true
          urlFocusRef.current = target
          setSelected(target)
        }
      })
      .catch(() => { /* 加载失败保留现有图谱，避免 unhandled rejection */ })
  }, [searchParams])
  useEffect(() => { void load() }, [load])

  // 加载领域清单（图例与过滤选项用）
  useEffect(() => {
    api.domains().then(setDomains).catch(() => setDomains([]))
  }, [])

  // 关键词去抖：停止逐字重建图实例
  useEffect(() => {
    const t = setTimeout(() => setKeyword(keywordInput.trim()), 300)
    return () => clearTimeout(t)
  }, [keywordInput])

  // 领域颜色映射：优先 domains 表，回退静态默认值
  const domainColorMap = useMemo(() => {
    const m = new Map<string, string>(Object.entries(DOMAIN_COLOR))
    for (const d of domains) m.set(d.id, d.color)
    return m
  }, [domains])

  // 语义化颜色 Token：与 globals.css 的 CSS 变量保持一致，避免硬编码色值
  const tokens = useMemo(() => {
    const cs = getComputedStyle(document.documentElement)
    const v = (name: string) => cs.getPropertyValue(name).trim()
    return {
      fg: `hsl(${v('--foreground')})`,
      muted: `hsl(${v('--muted-foreground')})`,
      primary: `hsl(${v('--primary')})`,
      border: `hsl(${v('--border')})`,
      card: `hsl(${v('--card')})`,
    }
  }, [])

  const filtered = useMemo(() => {
    // 语义模式下不套用关键词过滤，避免双条件打架
    const kw = searchMode === 'keyword' ? keyword.trim().toLowerCase() : ''
    const ns = nodes.filter((n) =>
      (!domainFilter || n.domain === domainFilter) &&
      (!statusFilter || n.status === statusFilter) &&
      (!kw || n.name.toLowerCase().includes(kw) || n.id.includes(kw))
    )
    const ids = new Set(ns.map((n) => n.id))
    return { nodes: ns, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }, [nodes, edges, domainFilter, statusFilter, keyword, searchMode])

  const buildData = useCallback((ns: Node[], es: Edge[]): GraphData => {
    // 孤立节点（无任何连线）不继承坐标：它们没有连线约束，
    // 继承一个被推远的位置会让偏移逐轮放大
    const connected = new Set<string>()
    for (const e of es) {
      connected.add(e.source)
      connected.add(e.target)
    }
    return {
      nodes: ns.map((n) => {
        const color = domainColorMap.get(n.domain) ?? '#888780'
        const prev = connected.has(n.id) ? posRef.current.get(n.id) : undefined
        return {
          id: n.id,
          // level 冗余到顶层，供 d3-force 的 nodeSize 回调读取
          level: n.level,
          // 继承上次布局坐标，避免筛选切换后整图重排
          ...(prev ? { x: prev[0], y: prev[1] } : {}),
          data: { ...n, tags: safeTags(n.tags) },
          style: {
            fill: color,
            fillOpacity: STATUS_OPACITY[n.status],
            stroke: n.status === 'learning' ? tokens.primary : color,
            lineWidth: STATUS_LINE[n.status],
            lineDash: STATUS_DASH[n.status],
            size: 14 + n.level * 6,
            // 已掌握节点加光环，形成颜色之外的第二重编码
          halo: n.status === 'done',
          haloStrokeWidth: 6,
          haloStrokeColor: color,
          haloOpacity: 0.22,
          labelText: n.name,
          labelFill: tokens.fg,
          labelFontSize: 11,
          labelPlacement: 'bottom' as const,
          labelMaxWidth: 90,
          },
        }
      }),
      edges: es.map((e) => {
        const isPrereq = e.type === 'prerequisite'
        return {
          id: String(e.id),
          source: e.source,
          target: e.target,
          data: { type: e.type },
          style: {
            // 前置=实线箭头，相关=长虚线，扩展=点线
            stroke: isPrereq ? tokens.muted : tokens.border,
            lineDash: isPrereq ? undefined : e.type === 'related' ? [4, 4] : [1, 3],
            endArrow: isPrereq,
          },
        }
      }),
    }
  }, [domainColorMap, tokens])

  // 创建/重建 Graph 实例：数据或领域颜色变化时，销毁旧实例并按最新数据重建，
  // 避免 G6 setData 增量 diff 在筛选切换时抛 "Node not found" 或节点堆叠
  useEffect(() => {
    if (!ref.current) return
    // 坐标记忆表在 effect 内取一次引用，供 buildData 与 cleanup 共用
    const posMap = posRef.current
    // 兜底过滤：边只保留两端节点都存在的，防止 orphan edge
    const data = buildData(filtered.nodes, filtered.edges)
    const validIds = new Set((data.nodes ?? []).map((n) => n.id))
    data.edges = (data.edges ?? []).filter(
      (e) => validIds.has(e.source) && validIds.has(e.target)
    )

    const graph = new Graph({
      container: ref.current,
      autoFit: 'view',
      data,
      layout: {
        type: 'd3-force',
        // 碰撞半径由 nodeSize 自适应（不再写死 40），间距留给标签
        nodeSize: nodeSizeOf,
        nodeSpacing: 8,
        // 前置关系拉近，其余关系放宽，语义在空间上可分辨
        linkDistance: (edge) => (edge.data?.type === 'prerequisite' ? 70 : 110),
        // 斥力不宜过大：节点本就靠碰撞半径撑开，过强会把图撑得过散
        manyBody: { strength: -100 },
        // 更快收敛，减少布局动画持续时间
        alpha: 0.9,
        alphaDecay: 0.08,
      },
      node: {
        state: {
          // 选中态：主色描边 + 光环，并补出标签
          selected: (d) => ({
            lineWidth: 3,
            stroke: tokens.primary,
            halo: true,
            haloStrokeWidth: 8,
            haloStrokeColor: tokens.primary,
            haloOpacity: 0.18,
            labelText: (d.data as Node | undefined)?.name ?? '',
          }),
          // 悬停激活态：补出标签，便于识别小节点
          active: (d) => ({
            lineWidth: 3,
            labelText: (d.data as Node | undefined)?.name ?? '',
          }),
          // 未激活态：淡化非相关元素（保留轮廓，不完全消失）
          inactive: { fillOpacity: 0.18 },
        },
      },
      edge: {
        state: {
          active: (d) => ({
            lineWidth: 2,
            labelText: EDGE_LABEL[(d.data as { type?: string } | undefined)?.type ?? ''] ?? '',
            labelFontSize: 11,
            labelFill: tokens.muted,
            labelBackground: true,
            labelBackgroundFill: tokens.card,
            labelBackgroundRadius: 4,
          }),
          selected: { lineWidth: 2, stroke: tokens.primary },
          inactive: { strokeOpacity: 0.12 },
        },
      },
      behaviors: [
        'drag-canvas',
        'zoom-canvas',
        'drag-element',
        // 悬停高亮一阶邻居，其余元素淡化；同时点亮被悬停节点的标签
        {
          type: 'hover-activate',
          degree: 1,
          state: 'active',
          inactiveState: 'inactive',
          onHover: (e: IPointerEvent) => revealLabel(e.target),
        },
        // 点击选中（与打开抽屉的 node:click 并存）
        { type: 'click-select', multiple: false, state: 'selected' },
        // 按住 Shift 点击聚焦到视图中心，避免与普通点击冲突
        { type: 'focus-element', trigger: 'shift' },
        // 标签按空间占用自适应：密集处自动隐藏、缩放或平移后自动恢复
        { type: 'auto-adapt-label', padding: 6 },
      ],
    })
    graph.on('node:click', (e: IElementEvent) => {
      const id = (e.target as { id?: string }).id
      // 被自动隐藏的标签在选中时强制点亮，保证节点始终可识别
      revealLabel(e.target)
      if (id) setSelected(id)
    })
    // 单次调用 render；只把 Promise 存下来供视口聚焦等待，不链式调用 layout/draw
    const rendering = graph.render()
    void rendering.catch(() => { /* 实例被快速销毁时忽略 render 失败 */ })
    renderPromiseRef.current = rendering
    graphRef.current = graph    // d3-force 是逐帧动画式收敛，autoFit 在收敛前执行会按早期位置计算视口，
    // 导致节点散开后视野失准。这里轮询节点包围盒，连续两次一致即视为布局已稳定，再适配视口。
    let fitTimer: number | undefined
    let lastBox = ''
    let attempts = 0
    const fitWhenSettled = () => {
      if (graphRef.current !== graph) return
      attempts += 1
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const n of filtered.nodes) {
        try {
          const p = graph.getElementPosition(n.id)
          if (!p) continue
          minX = Math.min(minX, p[0])
          maxX = Math.max(maxX, p[0])
          minY = Math.min(minY, p[1])
          maxY = Math.max(maxY, p[1])
        } catch { /* 元素尚未就绪时跳过 */ }
      }
      if (!Number.isFinite(minX)) {
        // 元素还没就绪（容器可能尚未完成布局），继续等待而不是放弃
        if (attempts < 80) fitTimer = window.setTimeout(fitWhenSettled, 250)
        return
      }
      const box = `${minX.toFixed(0)}:${maxX.toFixed(0)}:${minY.toFixed(0)}:${maxY.toFixed(0)}`
      if (box === lastBox) {
        // 布局已稳定：适配视口并留出边距（URL 定位场景由 focusElement 接管）
        if (!urlFocusDoneRef.current) {
          void graph.fitView()
            .then(() => graph.zoomBy(0.92))
            .catch(() => { /* 实例已销毁时忽略 */ })
        }
        return
      }
      lastBox = box
      if (attempts < 80) fitTimer = window.setTimeout(fitWhenSettled, 250)
    }
    fitTimer = window.setTimeout(fitWhenSettled, 300)
    return () => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      // 采集坐标供下一次重建继承（逐节点容错，单个失败不影响其余）
      for (const n of filtered.nodes) {
        try {
          const p = graph.getElementPosition(n.id)
          if (p) posMap.set(n.id, [p[0], p[1]])
        } catch { /* 元素已不存在时跳过 */ }
      }
      graphRef.current = null
      renderPromiseRef.current = null
      try { graph.destroy() } catch { /* 忽略销毁异常 */ }
    }
  }, [filtered, buildData, viewMode, tokens])

  // 视口聚焦只操作已建成的实例：不触碰 render/layout 链路，也不改回 setData
  // （AGENTS.md 第五节：筛选切换必须销毁重建，额外布局调用会产生竞态报错）
  useEffect(() => {
    // 只对 URL 定位的节点聚焦一次：用户点选的节点本就在视口内，
    // 筛选切换时重复聚焦会覆盖 autoFit 的全图视图
    if (!selected || urlFocusDoneRef.current || selected !== urlFocusRef.current) return
    const graph = graphRef.current
    const rendered = renderPromiseRef.current
    if (!graph || !rendered) return
    urlFocusDoneRef.current = true
    // 等 render 完成后元素控制器才就绪，否则 focusElement 会静默失效
    void rendered
      .then(() => graph.focusElement(selected))
      .catch(() => { /* 元素被筛选隐藏或实例已销毁时忽略 */ })
  }, [selected, filtered])

  const doSemanticSearch = async () => {
    if (!semanticQ.trim()) return
    try {
      const r = await api.semanticSearch(semanticQ.trim())
      setSemanticRes(r.results)
    } catch {
      alert('语义搜索失败：需部署后连接 Vectorize + Workers AI（本地模拟环境不可用）')
      setSemanticRes(null)
    }
  }

  const selectedNode = nodes.find((n) => n.id === selected) ?? null

  const removeNode = async () => {
    if (!selected) return
    if (!confirm(`确认删除节点「${selectedNode?.name ?? selected}」及其关联边、路线、打卡、资源、笔记？`)) return
    await api.deleteNode(selected)
    setSelected(null)
    load()
  }

  const openEdit = () => {
    if (!selectedNode) return
    setEditingNode(selectedNode)
    setShowNodeEditor(true)
  }

  const openNewNode = () => {
    setEditingNode(null)
    setShowNodeEditor(true)
  }

  const zoomBy = (ratio: number) => { void graphRef.current?.zoomBy(ratio) }
  const fitView = () => { void graphRef.current?.fitView() }
  const focusSelected = () => {
    if (selected) void graphRef.current?.focusElement(selected)
  }

  const switchSearchMode = (mode: 'keyword' | 'semantic') => {
    setSearchMode(mode)
    setSemanticRes(null)
  }

  return (
    <div className="relative stack">
      <PageHeader title="知识图谱" desc="筛选、搜索并编辑知识点与依赖关系。">
        <Button onClick={openNewNode}>新建节点</Button>
        <Button variant="outline" onClick={() => setShowEdgeEditor(true)}>新建连线</Button>
        <Button variant="secondary" onClick={() => setShowAgent((v) => !v)}>AI 助手</Button>
        <Button
          variant="outline"
          onClick={() => setViewMode((v) => (v === 'graph' ? 'list' : 'graph'))}
        >
          {viewMode === 'graph' ? '列表视图' : '图谱视图'}
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} className="w-36">
          <option value="">全部领域</option>
          {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-32">
          <option value="">全部状态</option>
          <option value="todo">未开始</option>
          <option value="learning">学习中</option>
          <option value="done">已掌握</option>
        </Select>

        <div className="flex min-w-[240px] flex-1 items-center gap-1 rounded-md border border-border bg-card p-1">
          <div className="flex shrink-0 rounded-md bg-secondary p-0.5" role="group" aria-label="搜索模式">
            <Button
              type="button"
              size="sm"
              variant={searchMode === 'keyword' ? 'default' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => switchSearchMode('keyword')}
            >
              关键词
            </Button>
            <Button
              type="button"
              size="sm"
              variant={searchMode === 'semantic' ? 'default' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => switchSearchMode('semantic')}
            >
              语义
            </Button>
          </div>
          <Input
            placeholder={searchMode === 'keyword' ? '搜索知识点…' : '语义搜索（AI）…'}
            value={searchMode === 'keyword' ? keywordInput : semanticQ}
            onChange={(e) => {
              if (searchMode === 'keyword') setKeywordInput(e.target.value)
              else setSemanticQ(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchMode === 'semantic') void doSemanticSearch()
            }}
            className="h-8 min-w-0 flex-1 border-0 shadow-none focus-visible:ring-0"
            aria-label={searchMode === 'keyword' ? '关键词搜索' : '语义搜索'}
          />
          {searchMode === 'semantic' && (
            <Button type="button" size="sm" className="h-7 shrink-0" onClick={() => void doSemanticSearch()}>
              搜索
            </Button>
          )}
        </div>

        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={legendOpen}
            onClick={() => setLegendOpen((v) => !v)}
          >
            图例
          </Button>
          {legendOpen && (
            <div className="absolute right-0 top-full z-[6] mt-1 min-w-[140px] rounded-lg border border-border bg-card p-3 shadow-sm">
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                {domains.map((d) => (
                  <span key={d.id} className="flex items-center">
                    <span
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: d.color }}
                    />
                    {d.name}
                  </span>
                ))}
                {domains.length === 0 && <span>暂无领域</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      {semanticRes && (
        <div className="absolute left-8 top-36 z-[5] w-[360px] max-h-80 overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-sm">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-sm font-medium">语义搜索结果</span>
            <Button variant="ghost" size="sm" onClick={() => setSemanticRes(null)}>关闭</Button>
          </div>
          {semanticRes.length === 0 && (
            <div className="px-2 py-1 text-sm text-muted-foreground">无匹配结果</div>
          )}
          {semanticRes.map((r) => (
            <button
              key={r.id}
              className="block w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary"
              onClick={() => { setSelected(r.id); setSemanticRes(null) }}
            >
              <span className="float-right text-xs text-muted-foreground">
                {(r.score * 100).toFixed(0)}%
              </span>
              <span className="text-sm font-medium">{r.node?.name ?? r.id}</span>
              <div className="text-xs text-muted-foreground">{r.preview.slice(0, 60)}</div>
            </button>
          ))}
        </div>
      )}

      {showAgent && (
        <div className="fixed inset-0 z-10 bg-black/25" onClick={() => setShowAgent(false)} />
      )}

      <Panel flush className="relative overflow-hidden">
        {viewMode === 'graph' ? (
          <div
            ref={ref}
            className="graph-canvas-h w-full"
          />
        ) : (
          <div className="graph-canvas-h w-full overflow-auto">
            {filtered.nodes.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">没有匹配的节点，试试放宽筛选条件。</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">知识节点列表，可点击名称查看详情</caption>
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">名称</th>
                    <th scope="col" className="px-3 py-2 font-medium">领域</th>
                    <th scope="col" className="px-3 py-2 font-medium">等级</th>
                    <th scope="col" className="px-3 py-2 font-medium">状态</th>
                    <th scope="col" className="px-3 py-2 font-medium">进度</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.nodes.map((n) => (
                    <tr key={n.id} className="border-b border-border last:border-0 hover:bg-secondary">
                      <td className="px-3 py-2">
                        <button
                          className="rounded-sm text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setSelected(n.id)}
                        >
                          {n.name}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: domainColorMap.get(n.domain) ?? '#888780' }}
                          />
                          {domains.find((d) => d.id === n.domain)?.name ?? n.domain}
                        </span>
                      </td>
                      <td className="px-3 py-2">Lv{n.level}</td>
                      <td className="px-3 py-2">
                        <Badge variant={n.status === 'done' ? 'default' : 'outline'}>
                          {STATUS_TEXT[n.status] ?? n.status}
                        </Badge>
                      </td>
                      <td className="w-40 px-3 py-2">
                        <ProgressBar value={n.progress} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {viewMode === 'graph' && (
          <div className="absolute right-3 top-3 z-[5] flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm">
            <Button variant="ghost" size="sm" onClick={() => zoomBy(1 / 1.2)} aria-label="缩小">−</Button>
            <Button variant="ghost" size="sm" onClick={() => zoomBy(1.2)} aria-label="放大">+</Button>
            <Button variant="ghost" size="sm" onClick={fitView}>适应画布</Button>
            <Button variant="ghost" size="sm" disabled={!selected} onClick={focusSelected}>聚焦选中</Button>
          </div>
        )}
      </Panel>

      {showAgent && (
        <div className="fixed inset-y-0 right-0 z-[12] flex w-[min(920px,94vw)] flex-col border-l border-border bg-card shadow-lg">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-lg font-medium">AI 助手</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowAgent(false)}>关闭</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <AgentPanel
              onBuilt={load}
              nodes={nodes}
              domains={domains}
              selectedNode={selectedNode}
            />
          </div>
        </div>
      )}

      {selected && !showAgent && (
        <NodeDrawer
          key={selected}
          nodeId={selected}
          node={nodes.find((n) => n.id === selected) ?? null}
          onClose={() => { drawerDismissedRef.current = true; setSelected(null) }}
          onChanged={load}
          onEdit={openEdit}
          onDelete={() => void removeNode()}
        />
      )}

      {showNodeEditor && (
        <NodeEditor
          node={editingNode}
          onClose={() => { setShowNodeEditor(false); setEditingNode(null) }}
          onSaved={() => { setShowNodeEditor(false); setEditingNode(null); load() }}
        />
      )}

      {showEdgeEditor && (
        <EdgeEditor
          nodes={nodes}
          onClose={() => { setShowEdgeEditor(false) }}
          onSaved={() => { setShowEdgeEditor(false); load() }}
        />
      )}
    </div>
  )
}

function safeTags(t: string | null): string[] {
  try { return t ? JSON.parse(t) : [] } catch { return [] }
}
