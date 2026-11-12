import { useEffect, useState } from 'react'
import { api, Node, Roadmap, RoadmapStep, STATUS_LABEL } from '@/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

export default function RoadmapView() {
  const [roadmaps, setRoadmaps] = useState<Roadmap[]>([])
  const [currentId, setCurrentId] = useState('')
  const [current, setCurrent] = useState<Roadmap | null>(null)
  const [allNodes, setAllNodes] = useState<Node[]>([])
  const [addNodeId, setAddNodeId] = useState('')

  useEffect(() => {
    api.roadmaps().then((rs) => {
      setRoadmaps(rs)
      if (rs.length) setCurrentId(rs[0].id)
    })
    api.graph().then((g) => setAllNodes(g.nodes))
  }, [])

  useEffect(() => {
    if (currentId) api.roadmap(currentId).then(setCurrent)
  }, [currentId])

  const steps = current?.steps ?? []
  const inRoadmap = new Set(steps.map((s) => s.id))
  const currentLearning = steps.find((s) => s.status === 'learning')

  const save = (newSteps: RoadmapStep[]) => {
    const payload = newSteps.map((s, i) => ({ node_id: s.id, seq: i + 1 }))
    api.saveSteps(currentId, payload).then(() => api.roadmap(currentId).then(setCurrent))
  }

  const move = (idx: number, dir: -1 | 1) => {
    const arr = [...steps]
    const j = idx + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
    save(arr)
  }

  const remove = (idx: number) => save(steps.filter((_, i) => i !== idx))

  const add = () => {
    if (!addNodeId || inRoadmap.has(addNodeId)) return
    const n = allNodes.find((x) => x.id === addNodeId)
    if (!n) return
    save([...steps, { ...n, seq: steps.length + 1 }])
    setAddNodeId('')
  }

  const markDone = async (s: RoadmapStep) => {
    await api.updateNode(s.id, { status: 'done', progress: 100 })
    api.roadmap(currentId).then(setCurrent)
  }

  const doneCount = steps.filter((s) => s.status === 'done').length

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={currentId} onChange={(e) => setCurrentId(e.target.value)} className="w-56">
          {roadmaps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
        <span className="text-sm text-muted-foreground">{current?.description}</span>
        <span className="ml-auto text-sm text-muted-foreground">
          进度 {doneCount}/{steps.length}
          {currentLearning && (
            <span className="ml-2 text-primary">当前：{currentLearning.name}</span>
          )}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={addNodeId} onChange={(e) => setAddNodeId(e.target.value)} className="w-64">
          <option value="">选择要加入路线的知识点…</option>
          {allNodes.filter((n) => !inRoadmap.has(n.id)).map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </Select>
        <Button onClick={add} disabled={!addNodeId}>加入路线</Button>
      </div>

      <div className="flex max-w-[640px] flex-col">
        {steps.map((s, i) => (
          <div key={s.id}>
            {i > 0 && <div className="ml-[7px] h-6 w-0.5 bg-border" />}
            <div className="flex items-center gap-3">
              <div
                className="h-4 w-4 shrink-0 rounded-full border-2"
                style={{
                  backgroundColor: s.status === 'done' ? '#1D9E75' : s.status === 'learning' ? '#185FA5' : undefined,
                  borderColor: s.status === 'done' ? '#1D9E75' : s.status === 'learning' ? '#185FA5' : undefined,
                }}
              />
              <div
                className={cn(
                  'flex flex-1 items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5',
                  s.status === 'done' && 'border-primary bg-secondary',
                  s.status === 'learning' && 'bg-secondary'
                )}
              >
                <div>
                  <span className="text-sm font-medium">{i + 1}. {s.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {STATUS_LABEL[s.status]} · {s.progress}%
                  </span>
                </div>
                <div className="flex gap-1">
                  {s.status !== 'done' && (
                    <Button variant="outline" size="sm" onClick={() => markDone(s)}>完成</Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => move(i, 1)}
                    disabled={i === steps.length - 1}
                  >
                    ↓
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(i)}>移出</Button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
