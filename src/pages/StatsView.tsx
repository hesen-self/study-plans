import { useCallback, useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { api, Checkin, DOMAIN_COLOR, DOMAIN_LABEL, Goals, HeatmapCell, Node, Summary } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ProgressBar } from '@/components/ui/progress-bar'
import { cnMonth, cnShift, cnToday, monthRange, weekRange } from '@/lib/date'
import { downloadText, toCsvCell } from '@/lib/utils'

function renderHeatmap(dom: HTMLDivElement, data: HeatmapCell[]) {
  const chart = echarts.getInstanceByDom(dom) ?? echarts.init(dom)
  chart.setOption({
    tooltip: { formatter: (p: { data: [string, number] }) => `${p.data[0]}：${p.data[1]} 分钟` },
    visualMap: {
      min: 0,
      max: Math.max(120, ...data.map((d) => d.minutes)),
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      inRange: { color: ['#F1EFE8', '#9FE1CB', '#1D9E75', '#085041'] },
      text: ['多', '少'],
    },
    calendar: {
      top: 30, left: 60, right: 20,
      // 一律用北京时间日期，避免 UTC 导致 00:00~08:00 归到前一天
      range: [cnShift(-365), cnToday()],
      cellSize: ['auto', 14],
      splitLine: { show: false },
      itemStyle: { borderColor: '#fff' },
      dayLabel: { fontSize: 10 },
      monthLabel: { fontSize: 11 },
      yearLabel: { show: false },
    },
    series: {
      type: 'heatmap',
      coordinateSystem: 'calendar',
      data: data.map((d) => [d.date, d.minutes]),
    },
  })
}

function GoalBar({ label, actual, target }: { label: string; actual: number; target: number }) {
  return (
    <div className="min-w-[180px] flex-1">
      <ProgressBar
        value={target > 0 ? Math.min(100, Math.round(actual / target * 100)) : 0}
        label={label}
        hint={`${actual} / ${target || '未设置'} 分钟`}
        ariaLabel={`${label}学习目标完成度`}
      />
    </div>
  )
}

export default function StatsView() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([])
  const [nodeId, setNodeId] = useState('')
  const [nodeFilter, setNodeFilter] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [date, setDate] = useState(cnToday)
  const [note, setNote] = useState('')
  const [month, setMonth] = useState(cnMonth)
  const [goals, setGoals] = useState<Goals>({ daily: 0, weekly: 0 })
  const [draft, setDraft] = useState<Goals>({ daily: 0, weekly: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const heatmapRef = useRef<HTMLDivElement>(null)
  const pieRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // 组件卸载时统一销毁 ECharts 实例，避免内存泄漏
  useEffect(() => {
    const doms = [heatmapRef.current, pieRef.current, barRef.current]
    return () => {
      doms.forEach((dom) => {
        if (!dom) return
        const instance = echarts.getInstanceByDom(dom)
        if (instance) instance.dispose()
      })
    }
  }, [])

  useEffect(() => {
    api.graph().then((g) => setNodes(g.nodes)).catch(() => setError('加载知识点失败'))
    api.goals().then((g) => { setGoals(g); setDraft(g) }).catch(() => setError('加载学习目标失败'))
  }, [])

  const reload = useCallback(async () => {
    try {
      const { from, to } = monthRange(month)
      const [s, h, list] = await Promise.all([
        api.summary(),
        api.heatmap(),
        api.checkins(from, to, nodeFilter || undefined),
      ])
      setSummary(s)
      setHeatmap(h)
      if (heatmapRef.current) renderHeatmap(heatmapRef.current, h)
      setCheckins(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载统计数据失败')
    }
  }, [month, nodeFilter])

  useEffect(() => {
    // reload 内部全部为异步请求，setState 发生在 await 之后，非同步级联渲染
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  useEffect(() => {
    if (!summary || !pieRef.current) return
    const chart = echarts.getInstanceByDom(pieRef.current) ?? echarts.init(pieRef.current)
    chart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} 分钟 ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        data: summary.byDomain.map((d) => ({
          name: DOMAIN_LABEL[d.domain] ?? d.domain,
          value: d.minutes,
          itemStyle: { color: DOMAIN_COLOR[d.domain] },
        })),
        label: { fontSize: 12 },
      }],
    })
  }, [summary])

  useEffect(() => {
    if (!summary || !barRef.current) return
    const chart = echarts.getInstanceByDom(barRef.current) ?? echarts.init(barRef.current)
    chart.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: summary.byWeek.map((w) => w.week), axisLabel: { fontSize: 11 } },
      yAxis: { type: 'value', name: '分钟' },
      series: [{ type: 'bar', data: summary.byWeek.map((w) => w.minutes), itemStyle: { color: '#378ADD', borderRadius: [4, 4, 0, 0] } }],
      grid: { left: 50, right: 16, top: 30, bottom: 30 },
    })
  }, [summary])

  const submit = async () => {
    if (!nodeId || minutes <= 0) return
    setBusy(true)
    setError('')
    try {
      await api.addCheckin({ node_id: nodeId, date, minutes, note })
      setNote('')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '打卡失败')
    } finally {
      setBusy(false)
    }
  }

  const removeCheckin = async (id: number) => {
    setError('')
    try {
      await api.deleteCheckin(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除打卡失败')
    }
  }

  const saveGoals = async () => {
    setError('')
    try {
      const r = await api.saveGoals({ daily: Number(draft.daily) || 0, weekly: Number(draft.weekly) || 0 })
      const next = { daily: r.daily, weekly: r.weekly }
      setGoals(next)
      setDraft(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存目标失败')
    }
  }

  const exportCsv = () => {
    const header = ['日期', '知识点', '领域', '时长(分钟)', '备注']
    const rows = checkins.map((c) => [
      c.date, c.node_name ?? '', DOMAIN_LABEL[c.domain ?? ''] ?? c.domain ?? '',
      c.minutes, c.note ?? '',
    ])
    const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(toCsvCell).join(',')).join('\r\n')
    downloadText(`checkins-${month}.csv`, csv, 'text/csv;charset=utf-8')
  }

  const todayMinutes = heatmap.find((h) => h.date === cnToday())?.minutes ?? 0
  const week = weekRange()
  const weekMinutes = heatmap
    .filter((h) => h.date >= week.from && h.date <= week.to)
    .reduce((sum, h) => sum + h.minutes, 0)
  const hours = summary ? (summary.total.minutes / 60).toFixed(1) : '0'

  return (
    <div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-2xl font-semibold">{summary?.streak ?? 0} 天</div>
          <div className="text-sm text-muted-foreground">连续打卡</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-2xl font-semibold">{hours} h</div>
          <div className="text-sm text-muted-foreground">累计学习时长</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-2xl font-semibold">{summary?.total.count ?? 0} 次</div>
          <div className="text-sm text-muted-foreground">打卡次数</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-2xl font-semibold">
            {nodes.filter((n) => n.status === 'done').length}/{nodes.length}
          </div>
          <div className="text-sm text-muted-foreground">已掌握知识点</div>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-lg font-medium">今日打卡</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)} className="w-52">
            <option value="">选择知识点…</option>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </Select>
          <Input
            type="number" min={5} step={5} value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-24"
            aria-label="学习时长（分钟）"
          />
          <span className="text-sm text-muted-foreground">分钟</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <Input
            placeholder="备注（可选）" value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-w-[140px] flex-1"
          />
          <Button onClick={submit} disabled={!nodeId || busy}>{busy ? '提交中…' : '打卡'}</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          打卡会按该知识点累计时长自动推进学习进度与路线步骤状态（每 120 分钟视为掌握）。
        </p>
      </div>

      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-medium">学习目标</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number" min={0} step={10} value={draft.daily}
              onChange={(e) => setDraft({ ...draft, daily: Number(e.target.value) })}
              className="w-24" aria-label="每日目标分钟"
            />
            <span className="text-xs text-muted-foreground">分钟/日</span>
            <Input
              type="number" min={0} step={30} value={draft.weekly}
              onChange={(e) => setDraft({ ...draft, weekly: Number(e.target.value) })}
              className="w-24" aria-label="每周目标分钟"
            />
            <span className="text-xs text-muted-foreground">分钟/周</span>
            <Button variant="outline" size="sm" onClick={saveGoals}>保存目标</Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-6">
          <GoalBar label="今日" actual={todayMinutes} target={goals.daily} />
          <GoalBar label="本周" actual={weekMinutes} target={goals.weekly} />
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-lg font-medium">打卡热力图（近一年）</h3>
        <div ref={heatmapRef} className="h-[220px] w-full" />
      </div>

      <div className="mb-4 flex flex-wrap gap-4">
        <div className="min-w-[320px] flex-1 rounded-lg border border-border bg-card p-4">
          <h3 className="text-lg font-medium">领域时间分布</h3>
          <div ref={pieRef} className="h-[260px] w-full" />
        </div>
        <div className="min-w-[320px] flex-1 rounded-lg border border-border bg-card p-4">
          <h3 className="text-lg font-medium">近 12 周学习时长</h3>
          <div ref={barRef} className="h-[260px] w-full" />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-medium">打卡记录</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="month" value={month}
              onChange={(e) => setMonth(e.target.value || cnMonth())}
              className="w-40" aria-label="筛选月份"
            />
            <Select value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)} className="w-48">
              <option value="">全部知识点</option>
              {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </Select>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!checkins.length}>
              导出 CSV
            </Button>
          </div>
        </div>
        <table className="mt-2 w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b border-border p-2 text-left">日期</th>
              <th className="border-b border-border p-2 text-left">知识点</th>
              <th className="border-b border-border p-2 text-left">时长</th>
              <th className="border-b border-border p-2 text-left">备注</th>
              <th className="border-b border-border p-2" />
            </tr>
          </thead>
          <tbody>
            {checkins.map((c) => (
              <tr key={c.id}>
                <td className="border-b border-border p-2">{c.date}</td>
                <td className="border-b border-border p-2">{c.node_name}</td>
                <td className="border-b border-border p-2">{c.minutes} 分钟</td>
                <td className="border-b border-border p-2">{c.note}</td>
                <td className="border-b border-border p-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => removeCheckin(c.id)}>删</Button>
                </td>
              </tr>
            ))}
            {!checkins.length && (
              <tr>
                <td colSpan={5} className="p-2 text-muted-foreground">该筛选条件下暂无打卡记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
