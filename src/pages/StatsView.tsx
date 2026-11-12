import { useCallback, useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { api, Checkin, DOMAIN_COLOR, DOMAIN_LABEL, HeatmapCell, Node, Summary } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

export default function StatsView() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [nodeId, setNodeId] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')

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

  function renderHeatmap(data: HeatmapCell[]) {
    if (!heatmapRef.current) return
    const chart = echarts.getInstanceByDom(heatmapRef.current) ?? echarts.init(heatmapRef.current)
    const today = new Date().toISOString().slice(0, 10)
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)
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
        range: [yearAgo, today],
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

  const reload = useCallback(() => {
    api.summary().then(setSummary)
    api.heatmap().then(renderHeatmap)
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)
    api.checkins(yearAgo).then(setCheckins)
  }, [])

  useEffect(() => {
    api.graph().then((g) => setNodes(g.nodes))
    reload()
  }, [reload])

  useEffect(() => {
    if (!summary) return
    if (pieRef.current) {
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
      return undefined
    }
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
    return undefined
  }, [summary])

  const submit = async () => {
    if (!nodeId || minutes <= 0) return
    await api.addCheckin({ node_id: nodeId, date, minutes, note })
    setNote('')
    reload()
  }

  const removeCheckin = async (id: number) => {
    await api.deleteCheckin(id)
    reload()
  }

  const hours = summary ? (summary.total.minutes / 60).toFixed(1) : '0'

  return (
    <div>
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
            type="number"
            min={5}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">分钟</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <Input
            placeholder="备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-w-[140px] flex-1"
          />
          <Button onClick={submit} disabled={!nodeId}>打卡</Button>
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
        <h3 className="text-lg font-medium">最近打卡记录</h3>
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
            {checkins.slice(0, 20).map((c) => (
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
                <td colSpan={5} className="p-2 text-muted-foreground">暂无打卡记录，开始第一次打卡吧</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
