import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  NOTES: R2Bucket
  STATS_KV: KVNamespace
  VECTORS: VectorizeIndex
  AI: Ai
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors())

// ============ 图谱 ============
app.get('/api/graph', async (c) => {
  const [nodes, edges] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM nodes').all(),
    c.env.DB.prepare('SELECT * FROM edges').all(),
  ])
  return c.json({ nodes: nodes.results, edges: edges.results })
})

app.post('/api/nodes', async (c) => {
  const n = await c.req.json()
  await c.env.DB.prepare(
    'INSERT INTO nodes (id, name, domain, level, status, progress, tags) VALUES (?,?,?,?,?,?,?)'
  ).bind(n.id, n.name, n.domain, n.level ?? 1, n.status ?? 'todo', n.progress ?? 0, JSON.stringify(n.tags ?? [])).run()
  return c.json({ ok: true })
})

app.patch('/api/nodes/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const values: unknown[] = []
  for (const key of ['name', 'domain', 'level', 'status', 'progress']) {
    if (body[key] !== undefined) { fields.push(`${key} = ?`); values.push(body[key]) }
  }
  if (body.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(body.tags)) }
  if (!fields.length) return c.json({ ok: false, error: 'no fields' }, 400)
  values.push(id)
  await c.env.DB.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ ok: true })
})

app.delete('/api/nodes/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(id).run()
  await c.env.NOTES.delete(`notes/${id}.md`)
  return c.json({ ok: true })
})

app.post('/api/edges', async (c) => {
  const e = await c.req.json()
  const r = await c.env.DB.prepare('INSERT INTO edges (source, target, type) VALUES (?,?,?)')
    .bind(e.source, e.target, e.type ?? 'related').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.delete('/api/edges/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM edges WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ============ 学习路线 ============
app.get('/api/roadmaps', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM roadmaps').all()
  return c.json(r.results)
})

app.get('/api/roadmaps/:id', async (c) => {
  const roadmap = await c.env.DB.prepare('SELECT * FROM roadmaps WHERE id = ?').bind(c.req.param('id')).first()
  if (!roadmap) return c.json({ error: 'not found' }, 404)
  const steps = await c.env.DB.prepare(
    `SELECT s.seq, n.* FROM roadmap_steps s JOIN nodes n ON n.id = s.node_id
     WHERE s.roadmap_id = ? ORDER BY s.seq`
  ).bind(c.req.param('id')).all()
  return c.json({ ...roadmap, steps: steps.results })
})

// 整体替换路线步骤 [{node_id, seq}]
app.put('/api/roadmaps/:id/steps', async (c) => {
  const id = c.req.param('id')
  const steps: { node_id: string; seq: number }[] = await c.req.json()
  const stmts = [c.env.DB.prepare('DELETE FROM roadmap_steps WHERE roadmap_id = ?').bind(id)]
  for (const s of steps) {
    stmts.push(c.env.DB.prepare('INSERT INTO roadmap_steps (roadmap_id, node_id, seq) VALUES (?,?,?)').bind(id, s.node_id, s.seq))
  }
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

// ============ 打卡 ============
app.get('/api/checkins', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01'
  const to = c.req.query('to') ?? '2999-12-31'
  const r = await c.env.DB.prepare(
    `SELECT c.*, n.name AS node_name, n.domain FROM checkins c
     JOIN nodes n ON n.id = c.node_id
     WHERE c.date BETWEEN ? AND ? ORDER BY c.date DESC, c.id DESC`
  ).bind(from, to).all()
  return c.json(r.results)
})

app.post('/api/checkins', async (c) => {
  const b = await c.req.json()
  await c.env.DB.prepare('INSERT INTO checkins (node_id, date, minutes, note) VALUES (?,?,?,?)')
    .bind(b.node_id, b.date, b.minutes, b.note ?? '').run()
  // 统计缓存失效
  await bustStatsCache(c.env.STATS_KV)
  return c.json({ ok: true })
})

app.delete('/api/checkins/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM checkins WHERE id = ?').bind(c.req.param('id')).run()
  await bustStatsCache(c.env.STATS_KV)
  return c.json({ ok: true })
})

async function bustStatsCache(kv: KVNamespace) {
  await Promise.all([kv.delete('stats:heatmap'), kv.delete('stats:summary')])
}

// ============ 统计（KV 缓存）============
app.get('/api/stats/heatmap', async (c) => {
  const cached = await c.env.STATS_KV.get('stats:heatmap', 'json')
  if (cached) return c.json(cached)
  const r = await c.env.DB.prepare(
    'SELECT date, SUM(minutes) AS minutes, COUNT(*) AS count FROM checkins GROUP BY date'
  ).all()
  const data = r.results
  await c.env.STATS_KV.put('stats:heatmap', JSON.stringify(data), { expirationTtl: 86400 })
  return c.json(data)
})

app.get('/api/stats/summary', async (c) => {
  const cached = await c.env.STATS_KV.get('stats:summary', 'json')
  if (cached) return c.json(cached)

  const total = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(minutes),0) AS minutes, COUNT(*) AS count FROM checkins'
  ).first()
  const byDomain = await c.env.DB.prepare(
    `SELECT n.domain, COALESCE(SUM(c.minutes),0) AS minutes FROM checkins c
     JOIN nodes n ON n.id = c.node_id GROUP BY n.domain`
  ).all()
  const byWeek = await c.env.DB.prepare(
    `SELECT strftime('%Y-W%W', date) AS week, SUM(minutes) AS minutes
     FROM checkins GROUP BY week ORDER BY week DESC LIMIT 12`
  ).all()
  const byNode = await c.env.DB.prepare(
    `SELECT n.id, n.name, SUM(c.minutes) AS minutes FROM checkins c
     JOIN nodes n ON n.id = c.node_id GROUP BY n.id ORDER BY minutes DESC LIMIT 20`
  ).all()
  const dates = await c.env.DB.prepare('SELECT DISTINCT date FROM checkins ORDER BY date DESC').all()

  const data = {
    total,
    byDomain: byDomain.results,
    byWeek: byWeek.results.reverse(),
    byNode: byNode.results,
    streak: calcStreak((dates.results as { date: string }[]).map((d) => d.date)),
  }
  await c.env.STATS_KV.put('stats:summary', JSON.stringify(data), { expirationTtl: 86400 })
  return c.json(data)
})

function calcStreak(datesDesc: string[]): number {
  if (!datesDesc.length) return 0
  const set = new Set(datesDesc)
  const today = new Date()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  // 今天没打卡则从昨天起算
  let cursor = new Date(today)
  if (!set.has(fmt(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (set.has(fmt(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

// ============ 笔记（R2）============
app.get('/api/notes/:nodeId', async (c) => {
  const obj = await c.env.NOTES.get(`notes/${c.req.param('nodeId')}.md`)
  if (!obj) return c.json({ content: '' })
  return c.json({ content: await obj.text() })
})

app.put('/api/notes/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId')
  const { content } = await c.req.json<{ content: string }>()
  await c.env.NOTES.put(`notes/${nodeId}.md`, content ?? '', {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  })
  // P6：异步生成 embedding 写入 Vectorize
  if (content && c.env.AI && c.env.VECTORS) {
    c.executionCtx.waitUntil(indexNote(c.env, nodeId, content))
  }
  return c.json({ ok: true })
})

async function indexNote(env: Bindings, nodeId: string, content: string) {
  try {
    const node = await env.DB.prepare('SELECT name FROM nodes WHERE id = ?').bind(nodeId).first<{ name: string }>()
    const text = `${node?.name ?? nodeId}\n${content}`.slice(0, 2000)
    const res = await env.AI.run('@cf/baai/bge-m3', { text: [text] }) as { data: number[][] }
    await env.VECTORS.upsert([{
      id: nodeId,
      values: res.data[0],
      metadata: { name: node?.name ?? nodeId, preview: content.slice(0, 300) },
    }])
  } catch (e) {
    console.error('indexNote failed', e)
  }
}

// ============ 资源 ============
app.get('/api/resources', async (c) => {
  const nodeId = c.req.query('node_id')
  const stmt = nodeId
    ? c.env.DB.prepare('SELECT * FROM resources WHERE node_id = ?').bind(nodeId)
    : c.env.DB.prepare('SELECT * FROM resources')
  const r = await stmt.all()
  return c.json(r.results)
})

app.post('/api/resources', async (c) => {
  const b = await c.req.json()
  const r = await c.env.DB.prepare('INSERT INTO resources (node_id, title, url, kind) VALUES (?,?,?,?)')
    .bind(b.node_id, b.title, b.url, b.kind ?? 'doc').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.delete('/api/resources/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ============ P6 语义搜索 ============
app.post('/api/search/semantic', async (c) => {
  const { query } = await c.req.json<{ query: string }>()
  if (!query) return c.json({ results: [] })
  const res = await c.env.AI.run('@cf/baai/bge-m3', { text: [query] }) as { data: number[][] }
  const matches = await c.env.VECTORS.query(res.data[0], { topK: 8, returnMetadata: 'all' })
  const ids = matches.matches.map((m) => m.id)
  if (!ids.length) return c.json({ results: [] })
  const placeholders = ids.map(() => '?').join(',')
  const nodes = await c.env.DB.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).bind(...ids).all()
  const nodeMap = new Map((nodes.results as { id: string }[]).map((n) => [n.id, n]))
  return c.json({
    results: matches.matches.map((m) => ({
      id: m.id,
      score: m.score,
      node: nodeMap.get(m.id) ?? null,
      preview: (m.metadata as { preview?: string })?.preview ?? '',
    })),
  })
})

// 非匹配路由（/api 之外的页面路径）→ 回退到静态资源，SPA 由 not_found_handling 处理
app.get('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status === 404 && c.req.header('accept')?.includes('text/html')) {
    const index = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)))
    return new Response(index.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  return res
})

export default app
