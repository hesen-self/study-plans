import { useEffect, useRef } from 'react'
import { Graph, GraphData } from '@antv/g6'
import { DOMAIN_COLOR, GraphDraft } from '@/api'

/**
 * AI 图谱草稿预览（只读）。
 * 遵循 AGENTS.md：草稿变化 = 节点集合替换，必须销毁并重建 Graph 实例，
 * 禁止用 setData 做增量更新，否则 d3-force 会节点堆叠或抛 Node not found。
 */
export default function GraphDraftPreview({ draft }: { draft: GraphDraft }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || !draft.nodes.length) return
    const ids = new Set(draft.nodes.map((n) => n.id))
    const data: GraphData = {
      nodes: draft.nodes.map((n) => ({
        id: n.id,
        style: {
          fill: DOMAIN_COLOR[n.domain] ?? '#888780',
          size: 12 + n.level * 5,
          labelText: n.name,
          labelFill: '#1c1b18',
          labelFontSize: 10,
          labelPlacement: 'bottom' as const,
          labelMaxWidth: 80,
        },
      })),
      edges: draft.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
        .map((e, i) => ({
          id: `draft-edge-${i}`,
          source: e.source,
          target: e.target,
          style: {
            stroke: e.type === 'prerequisite' ? '#888780' : '#D3D1C7',
            lineDash: e.type === 'prerequisite' ? undefined : [4, 4],
            endArrow: e.type === 'prerequisite',
          },
        })),
    }

    const graph = new Graph({
      container: ref.current,
      autoFit: 'view',
      data,
      layout: {
        type: 'd3-force',
        link: { distance: 70 },
        manyBody: { strength: -160 },
        collide: { radius: 30 },
      },
      behaviors: ['drag-canvas', 'zoom-canvas'],
    })
    // render 返回 Promise；多轮修订时 cleanup 可能先销毁实例，捕获异步拒绝避免 unhandled rejection
    void Promise.resolve(graph.render()).catch(() => { /* 实例已销毁，忽略 */ })
    return () => {
      try { graph.destroy() } catch { /* 忽略销毁异常 */ }
    }
  }, [draft])

  return (
    <div className="space-y-2">
      <div ref={ref} className="h-60 w-full rounded-md border border-border bg-background" />
      <p className="text-xs text-muted-foreground">
        预览仅展示本次待新建的节点与连线，确认后才会写入知识图谱。
      </p>
    </div>
  )
}
