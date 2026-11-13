import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Graph, GraphData, IElementEvent } from '@antv/g6'
import { api, DOMAIN_COLOR, Domain, Edge, Node } from '@/api'
import NodeDrawer from '@/components/NodeDrawer'
import NodeEditor from '@/components/NodeEditor'
import EdgeEditor from '@/components/EdgeEditor'
import AgentPanel from '@/components/AgentPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const STATUS_OPACITY: Record<string, number> = { todo: 0.45, learning: 1, done: 1 }
const STATUS_LINE: Record<string, number> = { todo: 0, learning: 3, done: 1 }

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
  const [keyword, setKeyword] = useState('')
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

  // 领域颜色映射：优先 domains 表，回退静态默认值
  const domainColorMap = useMemo(() => {
    const m = new Map<string, string>(Object.entries(DOMAIN_COLOR))
    for (const d of domains) m.set(d.id, d.color)
    return m
  }, [domains])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const ns = nodes.filter((n) =>
      (!domainFilter || n.domain === domainFilter) &&
      (!statusFilter || n.status === statusFilter) &&
      (!kw || n.name.toLowerCase().includes(kw) || n.id.includes(kw))
    )
    const ids = new Set(ns.map((n) => n.id))
    return { nodes: ns, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }, [nodes, edges, domainFilter, statusFilter, keyword])

  const buildData = (ns: Node[], es: Edge[]): GraphData => ({
    nodes: ns.map((n) => {
      const color = domainColorMap.get(n.domain) ?? '#888780'
      return {
        id: n.id,
        data: { ...n, tags: safeTags(n.tags) },
        style: {
          fill: color,
          fillOpacity: STATUS_OPACITY[n.status],
          stroke: n.status === 'learning' ? '#185FA5' : color,
          lineWidth: STATUS_LINE[n.status],
          size: 14 + n.level * 6,
          labelText: n.name,
          labelFill: '#1c1b18',
          labelFontSize: 11,
          labelPlacement: 'bottom' as const,
          labelMaxWidth: 90,
        },
      }
    }),
    edges: es.map((e) => ({
      source: e.source,
      target: e.target,
      style: {
        stroke: e.type === 'prerequisite' ? '#888780' : '#D3D1C7',
        lineDash: e.type === 'prerequisite' ? undefined : [4, 4],
        endArrow: e.type === 'prerequisite',
      },
    })),
  })

  // 创建/重建 Graph 实例：数据或领域颜色变化时，销毁旧实例并按最新数据重建，
  // 避免 G6 setData 增量 diff 在筛选切换时抛 "Node not found" 或节点堆叠
  useEffect(() => {
    if (!ref.current) return
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
        link: { distance: 90 },
        manyBody: { strength: -180 },
        collide: { radius: 40 },
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
    })
    graph.on('node:click', (e: IElementEvent) => {
      const id = (e.target as { id?: string }).id
      if (id) setSelected(id)
    })
    // 单次调用 render；只把 Promise 存下来供视口聚焦等待，不链式调用 layout/draw
    const rendering = graph.render()
    void rendering.catch(() => { /* 实例被快速销毁时忽略 render 失败 */ })
    renderPromiseRef.current = rendering
    graphRef.current = graph
    return () => {
      graphRef.current = null
      renderPromiseRef.current = null
      try { graph.destroy() } catch { /* 忽略销毁异常 */ }
    }
    // 每次数据或领域颜色变化时重建，确保布局正确
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, domainColorMap])

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

  return (
    <div className="relative">
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
        <Input
          placeholder="搜索知识点…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="w-44"
        />
        <Input
          placeholder="语义搜索（AI）…"
          value={semanticQ}
          onChange={(e) => setSemanticQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSemanticSearch()}
          className="w-52"
        />
        <Button onClick={doSemanticSearch}>语义搜索</Button>
        <Button variant="secondary" onClick={() => setShowAgent((v) => !v)}>AI 助手</Button>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openNewNode}>新建节点</Button>
          <Button variant="outline" size="sm" onClick={() => setShowEdgeEditor(true)}>新建连线</Button>
          <Button variant="outline" size="sm" disabled={!selected} onClick={openEdit}>编辑</Button>
          <Button variant="destructive" size="sm" disabled={!selected} onClick={removeNode}>删除</Button>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {domains.map((d) => (
            <span key={d.id} className="flex items-center">
              <span
                className="mr-1 inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: d.color }}
              />
              {d.name}
            </span>
          ))}
        </div>
      </div>

      {semanticRes && (
        <div className="absolute left-[220px] top-16 z-[5] w-[360px] max-h-80 overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-sm">
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

      <div
        ref={ref}
        className="h-[calc(100vh-110px)] w-full rounded-lg border border-border bg-card"
      />

      {showAgent && (
        <div className="fixed inset-y-0 right-0 z-[11] w-[400px] max-w-[90vw] overflow-y-auto border-l border-border bg-card p-5 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-medium">AI 助手</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowAgent(false)}>关闭</Button>
          </div>
          <AgentPanel onBuilt={load} nodes={nodes} domains={domains} />
        </div>
      )}

      {selected && (
        <NodeDrawer
          key={selected}
          nodeId={selected}
          node={nodes.find((n) => n.id === selected) ?? null}
          onClose={() => { drawerDismissedRef.current = true; setSelected(null) }}
          onChanged={load}
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
          onClose={() => setShowEdgeEditor(false)}
          onSaved={() => { setShowEdgeEditor(false); load() }}
        />
      )}
    </div>
  )
}

function safeTags(t: string | null): string[] {
  try { return t ? JSON.parse(t) : [] } catch { return [] }
}
