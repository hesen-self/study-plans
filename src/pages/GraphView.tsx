import { useEffect, useMemo, useRef, useState } from 'react'
import { Graph } from '@antv/g6'
import { api, DOMAIN_COLOR, DOMAIN_LABEL, Node } from '../api'
import NodeDrawer from '../components/NodeDrawer'

const STATUS_OPACITY: Record<string, number> = { todo: 0.45, learning: 1, done: 1 }
const STATUS_LINE: Record<string, number> = { todo: 0, learning: 3, done: 1 }

export default function GraphView() {
  const ref = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<any[]>([])
  const [domainFilter, setDomainFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [semanticQ, setSemanticQ] = useState('')
  const [semanticRes, setSemanticRes] = useState<any[] | null>(null)

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

  useEffect(() => {
    if (!ref.current) return
    graphRef.current?.destroy()
    const graph = new Graph({
      container: ref.current,
      autoFit: 'view',
      data: {
        nodes: filtered.nodes.map((n) => ({
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
            labelPlacement: 'bottom',
            labelMaxWidth: 90,
          },
        })),
        edges: filtered.edges.map((e) => ({
          source: e.source,
          target: e.target,
          style: {
            stroke: e.type === 'prerequisite' ? '#888780' : '#D3D1C7',
            lineDash: e.type === 'prerequisite' ? undefined : [4, 4],
            endArrow: e.type === 'prerequisite',
          },
        })),
      },
      layout: {
        type: 'd3-force',
        link: { distance: 90 },
        manyBody: { strength: -180 },
        collide: { radius: 40 },
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
    })
    graph.on('node:click', (e: any) => setSelected(e.target.id))
    graph.render()
    graphRef.current = graph
    return () => graph.destroy()
  }, [filtered])

  const doSemanticSearch = async () => {
    if (!semanticQ.trim()) return
    try {
      const r = await api.semanticSearch(semanticQ.trim())
      setSemanticRes(r.results)
    } catch (e) {
      alert('语义搜索失败：需部署后连接 Vectorize + Workers AI（本地模拟环境不可用）')
      setSemanticRes(null)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <div className="toolbar">
        <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}>
          <option value="">全部领域</option>
          {Object.entries(DOMAIN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="todo">未开始</option>
          <option value="learning">学习中</option>
          <option value="done">已掌握</option>
        </select>
        <input placeholder="搜索知识点…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <input
          placeholder="语义搜索（AI）…" style={{ width: 200 }}
          value={semanticQ}
          onChange={(e) => setSemanticQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSemanticSearch()}
        />
        <button className="primary" onClick={doSemanticSearch}>语义搜索</button>
        <span className="legend" style={{ marginLeft: 'auto' }}>
          {Object.entries(DOMAIN_LABEL).map(([k, v]) => (
            <span key={k}><span className="dot" style={{ background: DOMAIN_COLOR[k] }} />{v}</span>
          ))}
        </span>
      </div>

      {semanticRes && (
        <div className="card search-results">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <b>语义搜索结果</b>
            <button onClick={() => setSemanticRes(null)}>关闭</button>
          </div>
          {semanticRes.length === 0 && <div style={{ color: 'var(--text-2)' }}>无匹配结果</div>}
          {semanticRes.map((r) => (
            <div key={r.id} className="item" onClick={() => { setSelected(r.id); setSemanticRes(null) }}>
              <span className="score">{(r.score * 100).toFixed(0)}%</span>
              <b>{r.node?.name ?? r.id}</b>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.preview.slice(0, 60)}</div>
            </div>
          ))}
        </div>
      )}

      <div ref={ref} className="graph-container" />

      {selected && (
        <NodeDrawer
          nodeId={selected}
          node={nodes.find((n) => n.id === selected) ?? null}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </div>
  )
}

function safeTags(t: string | null): string[] {
  try { return t ? JSON.parse(t) : [] } catch { return [] }
}
