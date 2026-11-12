import { useEffect, useMemo, useRef, useState } from 'react'
import { Graph, GraphData, IElementEvent } from '@antv/g6'
import { api, DOMAIN_COLOR, DOMAIN_LABEL, Edge, Node } from '@/api'
import NodeDrawer from '@/components/NodeDrawer'
import NodeEditor from '@/components/NodeEditor'
import EdgeEditor from '@/components/EdgeEditor'
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
  const ref = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [domainFilter, setDomainFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [semanticQ, setSemanticQ] = useState('')
  const [semanticRes, setSemanticRes] = useState<SemanticHit[] | null>(null)
  const [showNodeEditor, setShowNodeEditor] = useState(false)
  const [editingNode, setEditingNode] = useState<Node | null>(null)
  const [showEdgeEditor, setShowEdgeEditor] = useState(false)

  const load = () => api.graph().then((d) => { setNodes(d.nodes); setEdges(d.edges) })
  useEffect(() => { load() }, [])

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
    nodes: ns.map((n) => ({
      id: n.id,
      data: { ...n, tags: safeTags(n.tags) },
      style: {
        fill: DOMAIN_COLOR[n.domain],
        fillOpacity: STATUS_OPACITY[n.status],
        stroke: n.status === 'learning' ? '#185FA5' : DOMAIN_COLOR[n.domain],
        lineWidth: STATUS_LINE[n.status],
        size: 14 + n.level * 6,
        labelText: n.name,
        labelFill: '#1c1b18',
        labelFontSize: 11,
        labelPlacement: 'bottom' as const,
        labelMaxWidth: 90,
      },
    })),
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

  // 初始化：仅创建一次 Graph 实例
  useEffect(() => {
    if (!ref.current) return
    const graph = new Graph({
      container: ref.current,
      autoFit: 'view',
      data: buildData([], []),
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
    graph.render()
    graphRef.current = graph
    return () => {
      if (graphRef.current === graph) {
        graphRef.current = null
        try { graph.destroy() } catch { /* 忽略销毁异常 */ }
      }
    }
  }, [])

  // 数据更新：复用实例，setData 增量刷新
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.setData(buildData(filtered.nodes, filtered.edges))
    graph.render()
  }, [filtered])

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
        <Select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} className="w-32">
          <option value="">全部领域</option>
          {Object.entries(DOMAIN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openNewNode}>新建节点</Button>
          <Button variant="outline" size="sm" onClick={() => setShowEdgeEditor(true)}>新建连线</Button>
          <Button variant="outline" size="sm" disabled={!selected} onClick={openEdit}>编辑</Button>
          <Button variant="destructive" size="sm" disabled={!selected} onClick={removeNode}>删除</Button>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {Object.entries(DOMAIN_LABEL).map(([k, v]) => (
            <span key={k} className="flex items-center">
              <span
                className="mr-1 inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: DOMAIN_COLOR[k] }}
              />
              {v}
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

      <div
        ref={ref}
        className="h-[calc(100vh-110px)] w-full rounded-lg border border-border bg-card"
      />

      {selected && (
        <NodeDrawer
          key={selected}
          nodeId={selected}
          node={nodes.find((n) => n.id === selected) ?? null}
          onClose={() => setSelected(null)}
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
