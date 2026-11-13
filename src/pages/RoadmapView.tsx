import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api, DOMAIN_LABEL, Node, Roadmap, RoadmapStep, STATUS_LABEL,
} from '@/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ProgressBar } from '@/components/ui/progress-bar'

const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '高级' }
const NEXT_STATUS: Record<Node['status'], Node['status']> = {
  todo: 'learning', learning: 'done', done: 'todo',
}
const STATUS_ACTION: Record<Node['status'], string> = {
  todo: '开始', learning: '完成', done: '重开',
}
// 只用项目已有的 Badge 变体表达三态，不引入 success/info 等新颜色变量
const STATUS_VARIANT: Record<Node['status'], 'default' | 'secondary' | 'outline'> = {
  done: 'default', learning: 'secondary', todo: 'outline',
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(0, 4) : []
  } catch {
    return []
  }
}

interface Segment {
  level: number
  items: { step: RoadmapStep; index: number }[]
}

interface UndoState {
  nodeId: string
  name: string
  status: Node['status']
  progress: number
  roadmapId: string
}

// 折叠状态按路线隔离用的空集合（模块级常量，避免每次渲染新建）
const EMPTY_COLLAPSED = new Set<string>()

export default function RoadmapView() {
  const [roadmaps, setRoadmaps] = useState<Roadmap[]>([])
  const [currentId, setCurrentId] = useState('')
  const [current, setCurrent] = useState<Roadmap | null>(null)
  const [allNodes, setAllNodes] = useState<Node[]>([])
  // 累计学习时长改用 /api/checkins 全量聚合：summary.byNode 仅 top20 且缓存 24h，会漏掉多数步骤
  const [minutesByNode, setMinutesByNode] = useState<Map<string, number>>(new Map())
  const [addNodeId, setAddNodeId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [undo, setUndo] = useState<UndoState | null>(null)

  // 路线管理弹窗
  const [showEditor, setShowEditor] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [rmName, setRmName] = useState('')
  const [rmDesc, setRmDesc] = useState('')
  const [rmSaving, setRmSaving] = useState(false)

  // 拖拽排序 / 阶段折叠
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  // 折叠状态按路线 id 隔离，切换路线或重排后不会错位
  const [collapsedByRoadmap, setCollapsedByRoadmap] = useState<Record<string, Set<string>>>({})

  // 保存队列：连续拖放不再被静默丢弃，按最后一次意图串行落库
  const savingRef = useRef(false)
  const pendingRef = useRef<{ id: string; steps: RoadmapStep[] } | null>(null)
  const activeIdRef = useRef('')
  // 只清除保存动作自己产生的错误，避免抹掉首屏/详情加载失败等仍然有效的提示
  const saveErrorRef = useRef(false)

  // 首屏：三个来源各自降级，任一失败都不阻塞路线页
  useEffect(() => {
    let alive = true
    void Promise.all([
      api.roadmaps().catch(() => { if (alive) setError((prev) => prev || '路线列表加载失败'); return null }),
      api.graph().catch(() => { if (alive) setError((prev) => prev || '知识点列表加载失败'); return null }),
      api.checkins().catch(() => {
        if (alive) setError((prev) => prev || '打卡记录加载失败')
        return null
      }),
    ]).then(([rs, g, cs]) => {
      if (!alive) return
      if (rs) {
        setRoadmaps(rs)
        setCurrentId((prev) => prev || (rs[0]?.id ?? ''))
      }
      if (g) setAllNodes(g.nodes)
      if (cs) {
        const m = new Map<string, number>()
        for (const c of cs) m.set(c.node_id, (m.get(c.node_id) ?? 0) + c.minutes)
        setMinutesByNode(m)
      }
      setLoading(false)
    })
    return () => { alive = false }
  }, [])

  useEffect(() => { activeIdRef.current = currentId }, [currentId])

  // 切换路线时不显示旧数据（activeRoadmap 用 id 匹配做派生判定）
  useEffect(() => {
    if (!currentId) return
    let alive = true
    api.roadmap(currentId)
      .then((r) => { if (alive) setCurrent(r) })
      .catch(() => {
        if (!alive) return
        setError('路线详情加载失败')
        setCurrent(null)
        setCurrentId('')
        setNotice('')
        setUndo(null)
      })
    return () => { alive = false }
  }, [currentId])

  const loadRoadmaps = useCallback(() => {
    api.roadmaps()
      .then((rs) => {
        setRoadmaps(rs)
        setCurrentId((prev) => (prev && rs.some((r) => r.id === prev) ? prev : (rs[0]?.id ?? '')))
        setNotice('')
        setUndo(null)
      })
      .catch(() => setError('路线列表加载失败'))
  }, [])

  const activeRoadmap = currentId && current?.id === currentId ? current : null
  const switching = Boolean(currentId) && current?.id !== currentId
  const steps = useMemo(() => activeRoadmap?.steps ?? [], [activeRoadmap])

  const collapsedSegments = collapsedByRoadmap[currentId] ?? EMPTY_COLLAPSED
  const segmentKey = (seg: Segment) => `${seg.level}:${seg.items[0]?.step.id ?? ''}`

  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = []
    steps.forEach((step, index) => {
      // 按 level 连续段分组：不改变数组顺序，拖拽索引仍是全局 seq 下标
      const level = LEVEL_LABEL[step.level] ? step.level : 1
      const last = out[out.length - 1]
      if (last && last.level === level) last.items.push({ step, index })
      else out.push({ level, items: [{ step, index }] })
    })
    return out
  }, [steps])

  const doneCount = steps.filter((s) => s.status === 'done').length
  const currentLearning = steps.find((s) => s.status === 'learning')
  const totalMinutes = steps.reduce((acc, s) => acc + (minutesByNode.get(s.id) ?? 0), 0)
  const inRoadmap = new Set(steps.map((s) => s.id))

  // ===== 保存：乐观更新 + 串行队列 =====
  const flush = useCallback(async () => {
    if (savingRef.current) return
    savingRef.current = true
    try {
      while (pendingRef.current) {
        const job = pendingRef.current
        pendingRef.current = null
        try {
          await api.saveSteps(job.id, job.steps.map((s, i) => ({ node_id: s.id, seq: i + 1 })))
          const fresh = await api.roadmap(job.id)
          if (activeIdRef.current === job.id) setCurrent(fresh)
          if (saveErrorRef.current) {
            saveErrorRef.current = false
            setError('')
          }
        } catch (e) {
          saveErrorRef.current = true
          setError(e instanceof Error ? e.message : '保存路线失败')
          // 回滚到服务端真实顺序，避免乐观结果与实际不一致
          try {
            const fresh = await api.roadmap(job.id)
            if (activeIdRef.current === job.id) setCurrent(fresh)
          } catch { /* 回滚失败时保留乐观结果，错误已提示 */ }
        }
      }
    } finally {
      savingRef.current = false
    }
  }, [])

  const save = (newSteps: RoadmapStep[]) => {
    // 详情未就绪时禁止写入：PUT 会先清空整条路线步骤，用空 steps 保存会破坏数据
    if (!currentId || !activeRoadmap || current?.id !== currentId) return
    pendingRef.current = { id: currentId, steps: newSteps }
    setCurrent((prev) => (prev && prev.id === currentId ? { ...prev, steps: newSteps } : prev))
    void flush()
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
      // 指示线画在目标上方；向下拖时移除项会让目标前移一位，需相应回退插入点
      const insertAt = target > dragIdx ? target - 1 : target
      arr.splice(insertAt, 0, moved)
      save(arr)
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  const add = () => {
    if (!activeRoadmap || !addNodeId || inRoadmap.has(addNodeId)) return
    const n = allNodes.find((x) => x.id === addNodeId)
    if (!n) return
    save([...steps, { ...n, seq: steps.length + 1 }])
    setAddNodeId('')
  }

  // ===== 状态可逆：todo → learning → done → todo，并支持撤销 =====
  const cycleStatus = async (s: RoadmapStep) => {
    const id = currentId
    if (!activeRoadmap || !id) return
    const to = NEXT_STATUS[s.status]
    // 非完成状态若保留 >=100 的 progress，服务端下次打卡会立刻把 status 顶回 done。
    // progress 表示掌握度而非累计时长，归零不会丢失 checkins 里的学习记录。
    const patch: Partial<Node> = to === 'done'
      ? { status: to, progress: 100 }
      : s.progress >= 100
        ? { status: to, progress: 0 }
        : { status: to }
    setError('')
    try {
      await api.updateNode(s.id, patch)
      // 请求飞行中已切换路线：不要把旧路线的提示写到新页面
      if (activeIdRef.current !== id) return
      setUndo({ nodeId: s.id, name: s.name, status: s.status, progress: s.progress, roadmapId: id })
      setNotice(`「${s.name}」已设为${STATUS_LABEL[to]}`)
      const fresh = await api.roadmap(id)
      if (activeIdRef.current === id) setCurrent(fresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新节点状态失败')
    }
  }

  const undoChange = async () => {
    if (!undo) return
    const id = undo.roadmapId
    setError('')
    try {
      await api.updateNode(undo.nodeId, { status: undo.status, progress: undo.progress })
      if (activeIdRef.current !== id) return
      const fresh = await api.roadmap(id)
      if (activeIdRef.current === id) setCurrent(fresh)
      setNotice(`已撤销「${undo.name}」的状态变更`)
      setUndo(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销失败')
    }
  }

  const toggleSegment = (key: string) => {
    const id = currentId
    if (!id) return
    setCollapsedByRoadmap((prev) => {
      const next = new Set(prev[id] ?? [])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...prev, [id]: next }
    })
  }

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
    setError('')
    try {
      if (editingId) {
        await api.updateRoadmap(editingId, { name: rmName.trim(), description: rmDesc.trim() })
      } else {
        const id = rmName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        await api.createRoadmap({ id: id || `rm-${Date.now()}`, name: rmName.trim(), description: rmDesc.trim() })
      }
      setShowEditor(false)
      loadRoadmaps()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存路线失败')
    } finally {
      setRmSaving(false)
    }
  }

  const deleteRoadmap = async (r: Roadmap) => {
    if (!confirm(`确认删除学习路线「${r.name}」？`)) return
    setError('')
    try {
      await api.deleteRoadmap(r.id)
      if (currentId === r.id) setCurrentId('')
      loadRoadmaps()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除路线失败')
    }
  }

  const renderStep = (s: RoadmapStep, index: number, showConnector: boolean, tags: string[]) => (
    <div
      key={s.id}
      role="listitem"
      tabIndex={0}
      aria-label={`第 ${index + 1} 步 ${s.name}，${STATUS_LABEL[s.status]}，按 Alt 加上下方向键可调整顺序`}
      draggable
      onDragStart={() => setDragIdx(index)}
      onDragOver={(e) => { e.preventDefault(); setOverIdx(index) }}
      onDragLeave={() => setOverIdx(null)}
      onDrop={(e) => { e.preventDefault(); dropAt(index) }}
      onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          move(index, e.key === 'ArrowUp' ? -1 : 1)
        }
      }}
      className={cn(
        'cursor-grab rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        dragIdx === index && 'opacity-50'
      )}
    >
      {showConnector && <div className="ml-[7px] h-6 w-0.5 bg-border" />}
      {overIdx === index && dragIdx !== index && <div className="mb-1 h-0.5 bg-primary" />}
      <div className="flex items-center gap-3">
        <div
          role="img"
          aria-label={STATUS_LABEL[s.status]}
          className="h-4 w-4 shrink-0 rounded-full border-2 border-border"
          style={{
            backgroundColor: s.status === 'done' ? '#1D9E75' : s.status === 'learning' ? '#185FA5' : undefined,
            borderColor: s.status === 'done' ? '#1D9E75' : s.status === 'learning' ? '#185FA5' : undefined,
          }}
        />
        <div
          className={cn(
            'flex-1 rounded-lg border border-border bg-card px-4 py-2.5',
            s.status === 'done' && 'border-primary'
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/knowledge?node=${encodeURIComponent(s.id)}`}
                title="打开该知识点的教材"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {index + 1}. {s.name}
              </Link>
              <Badge variant={STATUS_VARIANT[s.status]}>{STATUS_LABEL[s.status]}</Badge>
              <Badge variant="outline">{DOMAIN_LABEL[s.domain] ?? s.domain}</Badge>
            </div>
            {/* 阻断从按钮开始的拖拽，避免点按钮误触 */}
            <div className="flex gap-1" draggable={false} onDragStart={(e) => e.preventDefault()}>
              <Button variant="outline" size="sm" onClick={() => cycleStatus(s)} title="循环切换 未开始 / 学习中 / 已掌握">
                {STATUS_ACTION[s.status]}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移一步">↑</Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => move(index, 1)}
                disabled={index === steps.length - 1}
                aria-label="下移一步"
              >
                ↓
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove(index)}>移出</Button>
            </div>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>Lv{s.level}</span>
            {tags.length > 0 && <span>· {tags.map((t) => `#${t}`).join(' ')}</span>}
            <span>· 已学 {minutesByNode.get(s.id) ?? 0} 分钟</span>
            <Link
              to={`/graph?node=${encodeURIComponent(s.id)}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              在图谱中查看
            </Link>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <ProgressBar value={s.progress} ariaLabel={`${s.name} 学习进度`} className="flex-1" />
            <span className="text-sm text-muted-foreground">{s.progress}%</span>
          </div>
        </div>
      </div>
    </div>
  )

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>

  return (
    <div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {notice && (
        <p className="mb-3 text-sm text-muted-foreground">
          {notice}
          {undo && undo.roadmapId === currentId && (
            <button
              type="button"
              onClick={undoChange}
              className="ml-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              撤销
            </button>
          )}
          <button
            type="button"
            onClick={() => { setNotice(''); setUndo(null) }}
            className="ml-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            关闭
          </button>
        </p>
      )}

      {/* 操作区：只放路线切换与管理动作 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={currentId}
          onChange={(e) => { setCurrentId(e.target.value); setNotice(''); setUndo(null) }}
          className="w-56"
        >
          {roadmaps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
        <Button variant="outline" size="sm" onClick={openCreate}>新建路线</Button>
        {activeRoadmap && (
          <>
            <Button variant="outline" size="sm" onClick={() => openEdit(activeRoadmap)}>编辑</Button>
            <Button variant="ghost" size="sm" onClick={() => deleteRoadmap(activeRoadmap)}>删除</Button>
          </>
        )}
      </div>

      {activeRoadmap && (
        <>
          {/* 概览卡：沿用 StatsView 的 rounded-lg border border-border bg-card p-4 */}
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-medium">{activeRoadmap.name}</h2>
              <span className="text-sm text-muted-foreground">已完成 {doneCount}/{steps.length} 步</span>
            </div>
            {activeRoadmap.description && (
              <p className="mt-1 text-sm text-muted-foreground">{activeRoadmap.description}</p>
            )}
            <div className="mt-3">
              <ProgressBar
                value={steps.length ? Math.round(doneCount / steps.length * 100) : 0}
                label="整体进度"
                hint={`${doneCount} / ${steps.length} 步`}
                ariaLabel="路线整体完成进度"
              />
            </div>
            {currentLearning && (
              <p className="mt-2 text-sm text-muted-foreground">
                当前进行中：<span className="text-primary">{currentLearning.name}</span>
              </p>
            )}
          </div>

          {/* 指标卡：与 StatsView 同一套字号与卡片写法 */}
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-3.5">
              <div className="text-2xl font-semibold">{doneCount}/{steps.length}</div>
              <div className="text-sm text-muted-foreground">已完成步骤</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3.5">
              <div className="text-2xl font-semibold">{steps.length - doneCount}</div>
              <div className="text-sm text-muted-foreground">剩余步骤</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3.5">
              <div className="text-2xl font-semibold">{totalMinutes} 分钟</div>
              <div className="text-sm text-muted-foreground">本路线累计学习</div>
            </div>
          </div>
        </>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={addNodeId} onChange={(e) => setAddNodeId(e.target.value)} className="w-64" disabled={!activeRoadmap}>
          <option value="">选择要加入路线的知识点…</option>
          {allNodes.filter((n) => !inRoadmap.has(n.id)).map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </Select>
        <Button onClick={add} disabled={!addNodeId || !activeRoadmap}>加入路线</Button>
        <span className="text-sm text-muted-foreground">拖拽卡片排序，或选中卡片后按 Alt + ↑ / ↓</span>
      </div>

      {switching && <p className="mb-3 text-sm text-muted-foreground">路线加载中…</p>}

      {!switching && steps.length === 0 && (
        <div className="max-w-[640px] rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            {activeRoadmap
              ? '这条路线还没有步骤。从上方选择知识点加入，或前往知识图谱创建节点。'
              : '还没有学习路线，点击「新建路线」开始。'}
          </p>
        </div>
      )}

      <div className="max-w-[640px]">
        {segments.map((seg) => {
          const key = segmentKey(seg)
          const collapsed = collapsedSegments.has(key)
          return (
            <section key={key} className="mb-4">
              <div className="mb-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggleSegment(key)}
                  aria-expanded={!collapsed}
                  className="text-lg font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {LEVEL_LABEL[seg.level]} · {seg.items.length} 步
                </button>
                <div className="h-px flex-1 bg-border" />
                <span className="text-sm text-muted-foreground">
                  {collapsed ? '点击展开' : '点击折叠'}
                </span>
              </div>
              {!collapsed && (
                <div role="list" className="flex flex-col">
                  {seg.items.map((item, itemIdx) =>
                    renderStep(item.step, item.index, itemIdx > 0, parseTags(item.step.tags))
                  )}
                </div>
              )}
            </section>
          )
        })}
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
