import { useEffect, useState } from 'react'
import { api, Node, Roadmap, RoadmapStep, STATUS_LABEL } from '../api'

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
      <div className="toolbar">
        <select value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
          {roadmaps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <span style={{ color: 'var(--text-2)' }}>{current?.description}</span>
        <span style={{ marginLeft: 'auto' }}>
          进度 {doneCount}/{steps.length}
          {currentLearning && <span style={{ color: 'var(--accent)' }}>　当前：{currentLearning.name}</span>}
        </span>
      </div>

      <div className="toolbar">
        <select value={addNodeId} onChange={(e) => setAddNodeId(e.target.value)}>
          <option value="">选择要加入路线的知识点…</option>
          {allNodes.filter((n) => !inRoadmap.has(n.id)).map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </select>
        <button className="primary" onClick={add} disabled={!addNodeId}>加入路线</button>
      </div>

      <div className="roadmap-flow">
        {steps.map((s, i) => (
          <div key={s.id}>
            {i > 0 && <div className="step-line" />}
            <div className="step-card">
              <div
                className="step-dot"
                style={{
                  background: s.status === 'done' ? '#1D9E75' : s.status === 'learning' ? '#185FA5' : undefined,
                  borderColor: s.status === 'done' ? '#1D9E75' : s.status === 'learning' ? '#185FA5' : undefined,
                }}
              />
              <div className={`step-body ${s.status}`}>
                <div>
                  <b>{i + 1}. {s.name}</b>
                  <span style={{ color: 'var(--text-2)', fontSize: 12, marginLeft: 8 }}>
                    {STATUS_LABEL[s.status]} · {s.progress}%
                  </span>
                </div>
                <div className="step-actions">
                  {s.status !== 'done' && <button onClick={() => markDone(s)}>完成</button>}
                  <button onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
                  <button className="danger" onClick={() => remove(i)}>移出</button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
