import { useEffect, useRef, useState } from 'react'
import { api, Node, Roadmap, RoadmapStep, STATUS_LABEL } from '@/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

export default function RoadmapView() {
  const [roadmaps, setRoadmaps] = useState<Roadmap[]>([])
  const [currentId, setCurrentId] = useState('')
  const [current, setCurrent] = useState<Roadmap | null>(null)
  const [allNodes, setAllNodes] = useState<Node[]>([])
  const [addNodeId, setAddNodeId] = useState('')
  // 管理状态：新建/编辑路线弹窗
  const [showEditor, setShowEditor] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [rmName, setRmName] = useState('')
  const [rmDesc, setRmDesc] = useState('')
  const [rmSaving, setRmSaving] = useState(false)
  // 拖拽排序
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [error, setError] = useState('')
  // 保存锁：避免连续拖放并发 PUT 互相覆盖
  const savingRef = useRef(false)

  const loadRoadmaps = () => {
    api.roadmaps().then((rs) => {
      setRoadmaps(rs)
      if (!currentId && rs.length) setCurrentId(rs[0].id)
      else if (currentId && !rs.some((r) => r.id === currentId) && rs.length) setCurrentId(rs[0].id)
    })
  }

  useEffect(() => {
    loadRoadmaps()
    api.graph().then((g) => setAllNodes(g.nodes))
    // 仅在挂载时加载一次，loadRoadmaps 为稳定函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (currentId) api.roadmap(currentId).then(setCurrent)
  }, [currentId])

  const steps = current?.steps ?? []
  const inRoadmap = new Set(steps.map((s) => s.id))
  const currentLearning = steps.find((s) => s.status === 'learning')

  const save = (newSteps: RoadmapStep[]) => {
    if (savingRef.current || !currentId) return
    savingRef.current = true
    setError('')
    const payload = newSteps.map((s, i) => ({ node_id: s.id, seq: i + 1 }))
    api.saveSteps(currentId, payload)
      .then(() => api.roadmap(currentId))
      .then(setCurrent)
      .catch((e) => setError(e instanceof Error ? e.message : '保存路线失败'))
      .finally(() => { savingRef.current = false })
  }

  const move = (idx: number, dir: -1 | 1) => {
    const arr = [...steps]
    const j = idx + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
    save(arr)
  }

  const remove = (idx: number) => save(steps.filter((_, i) => i !== idx))

  const dropAt = (target: number) => {
    if (dragIdx !== null && dragIdx !== target) {
      const arr = [...steps]
      const [moved] = arr.splice(dragIdx, 1)
      arr.splice(target, 0, moved)
      save(arr)
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  const add = () => {
    if (!addNodeId || inRoadmap.has(addNodeId)) return
    const n = allNodes.find((x) => x.id === addNodeId)
    if (!n) return
    save([...steps, { ...n, seq: steps.length + 1 }])
    setAddNodeId('')
  }

  const markDone = async (s: RoadmapStep) => {
    setError('')
    try {
      await api.updateNode(s.id, { status: 'done', progress: 100 })
      setCurrent(await api.roadmap(currentId))
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新节点状态失败')
    }
  }

  const doneCount = steps.filter((s) => s.status === 'done').length

  // ===== 路线管理 =====
  const openCreate = () => {
    setEditingId(null)
    setRmName('')
    setRmDesc('')
    setShowEditor(true)
  }

  const openEdit = (r: Roadmap) => {
    setEditingId(r.id)
    setRmName(r.name)
    setRmDesc(r.description ?? '')
    setShowEditor(true)
  }

  const submitRoadmap = async () => {
    if (!rmName.trim()) return
    setRmSaving(true)
    try {
      if (editingId) {
        await api.updateRoadmap(editingId, { name: rmName.trim(), description: rmDesc.trim() })
      } else {
        const id = rmName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        await api.createRoadmap({ id: id || `rm-${Date.now()}`, name: rmName.trim(), description: rmDesc.trim() })
      }
      setShowEditor(false)
      loadRoadmaps()
    } finally {
      setRmSaving(false)
    }
  }

  const deleteRoadmap = async (r: Roadmap) => {
    if (!confirm(`确认删除学习路线「${r.name}」？`)) return
    await api.deleteRoadmap(r.id)
    if (currentId === r.id) setCurrentId('')
    loadRoadmaps()
  }

  return (
    <div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={currentId} onChange={(e) => setCurrentId(e.target.value)} className="w-56">
          {roadmaps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
        <Button variant="outline" size="sm" onClick={openCreate}>新建路线</Button>
        {current && (
          <>
            <Button variant="outline" size="sm" onClick={() => openEdit(current)}>编辑</Button>
            <Button variant="ghost" size="sm" onClick={() => deleteRoadmap(current)}>删除</Button>
          </>
        )}
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
        <span className="text-xs text-muted-foreground">步骤支持拖拽排序，也可用 ↑ ↓ 微调</span>
      </div>

      <div className="flex max-w-[640px] flex-col">
        {steps.map((s, i) => (
          <div
            key={s.id}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => { e.preventDefault(); setOverIdx(i) }}
            onDragLeave={() => setOverIdx(null)}
            onDrop={(e) => { e.preventDefault(); dropAt(i) }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
            className={cn(
              'cursor-grab rounded-md transition-colors',
              dragIdx === i && 'opacity-50',
              overIdx === i && dragIdx !== i && 'bg-secondary'
            )}
          >
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

      {showEditor && (
        <>
          <div className="fixed inset-0 z-20 bg-black/25" onClick={() => setShowEditor(false)} />
          <div className="fixed left-1/2 top-1/2 z-[21] w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-lg">
            <h2 className="text-2xl font-semibold tracking-tight">{editingId ? '编辑路线' : '新建路线'}</h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">名称</label>
                <Input value={rmName} onChange={(e) => setRmName(e.target.value)} placeholder="路线名称" />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">描述</label>
                <Input value={rmDesc} onChange={(e) => setRmDesc(e.target.value)} placeholder="路线描述（可选）" />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowEditor(false)}>取消</Button>
              <Button onClick={submitRoadmap} disabled={rmSaving || !rmName.trim()}>
                {rmSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
