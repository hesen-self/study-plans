import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { api, Checkin, DOMAIN_COLOR, DOMAIN_LABEL, Node } from '../api'

export default function StatsView() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [nodeId, setNodeId] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')

  const heatmapRef = useRef<HTMLDivElement>(null)
  const pieRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const reload = () => {
    api.summary().then(setSummary)
    api.heatmap().then(renderHeatmap)
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)
    api.checkins(yearAgo).then(setCheckins)
  }

  useEffect(() => {
    api.graph().then((g) => setNodes(g.nodes))
    reload()
  }, [])

  useEffect(() => {
    if (!summary) return
    if (pieRef.current) {
      const chart = echarts.init(pieRef.current)
      chart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} 分钟 ({d}%)' },
        series: [{
          type: 'pie',
          radius: ['40%', '70%'],
          data: summary.byDomain.map((d: any) => ({
            name: DOMAIN_LABEL[d.domain] ?? d.domain,
            value: d.minutes,
            itemStyle: { color: DOMAIN_COLOR[d.domain] },
          })),
          label: { fontSize: 12 },
        }],
      })
      return () => chart.dispose()
    }
  }, [summary])

  useEffect(() => {
    if (!summary || !barRef.current) return
    const chart = echarts.init(barRef.current)
    chart.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: summary.byWeek.map((w: any) => w.week), axisLabel: { fontSize: 11 } },
      yAxis: { type: 'value', name: '分钟' },
      series: [{ type: 'bar', data: summary.byWeek.map((w: any) => w.minutes), itemStyle: { color: '#378ADD', borderRadius: [4, 4, 0, 0] } }],
      grid: { left: 50, right: 16, top: 30, bottom: 30 },
    })
    return () => chart.dispose()
  }, [summary])

  const renderHeatmap = (data: { date: string; minutes: number }[]) => {
    if (!heatmapRef.current) return
    const chart = echarts.init(heatmapRef.current)
    const today = new Date().toISOString().slice(0, 10)
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)
    chart.setOption({
      tooltip: { formatter: (p: any) => `${p.data[0]}：${p.data[1]} 分钟` },
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
      <div className="stat-grid">
        <div className="stat-card"><div className="num">{summary?.streak ?? 0} 天</div><div className="label">连续打卡</div></div>
        <div className="stat-card"><div className="num">{hours} h</div><div className="label">累计学习时长</div></div>
        <div className="stat-card"><div className="num">{summary?.total.count ?? 0} 次</div><div className="label">打卡次数</div></div>
        <div className="stat-card">
          <div className="num">{nodes.filter((n) => n.status === 'done').length}/{nodes.length}</div>
          <div className="label">已掌握知识点</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>今日打卡</h3>
        <div className="checkin-form">
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value="">选择知识点…</option>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          <input type="number" min={5} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 90 }} />
          <span>分钟</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <button className="primary" onClick={submit} disabled={!nodeId}>打卡</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>打卡热力图（近一年）</h3>
        <div ref={heatmapRef} style={{ width: '100%', height: 220 }} />
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>领域时间分布</h3>
          <div ref={pieRef} className="chart" />
        </div>
        <div className="card" style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>近 12 周学习时长</h3>
          <div ref={barRef} className="chart" />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>最近打卡记录</h3>
        <table className="checkins">
          <thead><tr><th>日期</th><th>知识点</th><th>时长</th><th>备注</th><th /></tr></thead>
          <tbody>
            {checkins.slice(0, 20).map((c) => (
              <tr key={c.id}>
                <td>{c.date}</td>
                <td>{c.node_name}</td>
                <td>{c.minutes} 分钟</td>
                <td>{c.note}</td>
                <td><button className="danger" onClick={() => removeCheckin(c.id)}>删</button></td>
              </tr>
            ))}
            {!checkins.length && <tr><td colSpan={5} style={{ color: 'var(--text-2)' }}>暂无打卡记录，开始第一次打卡吧</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
