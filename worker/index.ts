import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  AVATAR_MAX_BYTES,
  buildAvatarKey,
  inspectAvatarUpload,
  isOwnedAvatarKey,
  publicAvatarUrl,
  requestLooksTooLarge,
  toClientAvatar,
} from './avatar.ts'

type Bindings = {
  DB: D1Database
  NOTES: R2Bucket
  STATS_KV: KVNamespace
  VECTORS: VectorizeIndex
  AI: Ai
  ASSETS: Fetcher
}

// 默认用户：本地开发（无 Access 头）或存量数据归属
const DEFAULT_USER_ID = 'default'

const app = new Hono<{ Bindings: Bindings; Variables: { userId: string } }>()
app.use('/api/*', cors())

// ============ 身份中间件：Access JWT → user_id ============
// Cloudflare Access 保护全站时会注入 Cf-Access-Jwt-Assertion（JWT，含 email）
// 本地开发无该头则回退 DEFAULT_USER_ID
app.use('/api/*', async (c, next) => {
  const userId = extractUserId(c.req.header('cf-access-jwt-assertion'))
  c.set('userId', userId)
  await next()
})

function extractUserId(jwt: string | undefined): string {
  if (!jwt) return DEFAULT_USER_ID
  try {
    // 仅解 payload（不验签，签名已由 Access 边缘校验）
    const payload = jwt.split('.')[1]
    if (!payload) return DEFAULT_USER_ID
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: string
    }
    return decoded.email || DEFAULT_USER_ID
  } catch {
    return DEFAULT_USER_ID
  }
}

// ============ 图谱 ============
app.get('/api/graph', async (c) => {
  const uid = c.get('userId')
  // 懒初始化：新用户首次访问且自身无数据时，复制 default 的模板图谱
  await ensureUserGraph(c.env.DB, uid)
  const [nodes, edges] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM nodes WHERE user_id = ?').bind(uid).all(),
    c.env.DB.prepare('SELECT * FROM edges WHERE user_id = ?').bind(uid).all(),
  ])
  return c.json({ nodes: nodes.results, edges: edges.results })
})

// 新用户首次访问时复制 default 用户的模板图谱（节点 + 边 + 路线）
async function ensureUserGraph(db: D1Database, uid: string): Promise<void> {
  if (uid === DEFAULT_USER_ID) return
  const existing = await db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE user_id = ?').bind(uid).first<{ c: number }>()
  if (existing && existing.c > 0) return

  const tplNodes = await db.prepare('SELECT id, name, domain, level, status, progress, tags FROM nodes WHERE user_id = ?')
    .bind(DEFAULT_USER_ID).all()
  if (!tplNodes.results.length) return

  const stmts: D1PreparedStatement[] = []
  for (const n of tplNodes.results as { id: string; name: string; domain: string; level: number; status: string; progress: number; tags: string }[]) {
    stmts.push(db.prepare(
      'INSERT OR IGNORE INTO nodes (id, user_id, name, domain, level, status, progress, tags) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(n.id, uid, n.name, n.domain, n.level, n.status, n.progress, n.tags))
  }
  // 复制边
  const tplEdges = await db.prepare('SELECT source, target, type FROM edges WHERE user_id = ?').bind(DEFAULT_USER_ID).all()
  for (const e of tplEdges.results as { source: string; target: string; type: string }[]) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO edges (user_id, source, target, type) VALUES (?,?,?,?)')
      .bind(uid, e.source, e.target, e.type))
  }
  // 复制路线
  const tplRoadmaps = await db.prepare('SELECT id, name, description FROM roadmaps WHERE user_id = ?').bind(DEFAULT_USER_ID).all()
  const tplSteps = await db.prepare('SELECT roadmap_id, node_id, seq FROM roadmap_steps WHERE user_id = ?').bind(DEFAULT_USER_ID).all()
  for (const r of tplRoadmaps.results as { id: string; name: string; description: string }[]) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO roadmaps (id, user_id, name, description) VALUES (?,?,?,?)')
      .bind(r.id, uid, r.name, r.description))
  }
  for (const s of tplSteps.results as { roadmap_id: string; node_id: string; seq: number }[]) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO roadmap_steps (roadmap_id, user_id, node_id, seq) VALUES (?,?,?,?)')
      .bind(s.roadmap_id, uid, s.node_id, s.seq))
  }
  await db.batch(stmts)
}

app.post('/api/nodes', async (c) => {
  const uid = c.get('userId')
  const n = await c.req.json()
  try {
    await c.env.DB.prepare(
      'INSERT INTO nodes (id, user_id, name, domain, level, status, progress, tags) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(n.id, uid, n.name, n.domain, n.level ?? 1, n.status ?? 'todo', n.progress ?? 0, JSON.stringify(n.tags ?? [])).run()
  } catch (e) {
    // 主键冲突（同用户重复 id）
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      return c.json({ ok: false, error: '节点 id 已存在' }, 409)
    }
    throw e
  }
  return c.json({ ok: true })
})

app.patch('/api/nodes/:id', async (c) => {
  const uid = c.get('userId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const values: unknown[] = []
  for (const key of ['name', 'domain', 'level', 'status', 'progress']) {
    if (body[key] !== undefined) { fields.push(`${key} = ?`); values.push(body[key]) }
  }
  if (body.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(body.tags)) }
  if (!fields.length) return c.json({ ok: false, error: 'no fields' }, 400)
  values.push(id, uid)
  await c.env.DB.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values).run()
  return c.json({ ok: true })
})

app.delete('/api/nodes/:id', async (c) => {
  const uid = c.get('userId')
  const id = c.req.param('id')
  // 级联删除关联边（D1 外键级联不可靠，显式清理，均限定当前用户）
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM edges WHERE (source = ? OR target = ?) AND user_id = ?').bind(id, id, uid),
    c.env.DB.prepare('DELETE FROM roadmap_steps WHERE node_id = ? AND user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM checkins WHERE node_id = ? AND user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM resources WHERE node_id = ? AND user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM nodes WHERE id = ? AND user_id = ?').bind(id, uid),
  ])
  await c.env.NOTES.delete(noteKey(uid, id))
  return c.json({ ok: true })
})

app.post('/api/edges', async (c) => {
  const uid = c.get('userId')
  const e = await c.req.json()
  const r = await c.env.DB.prepare('INSERT INTO edges (user_id, source, target, type) VALUES (?,?,?,?)')
    .bind(uid, e.source, e.target, e.type ?? 'related').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.delete('/api/edges/:id', async (c) => {
  const uid = c.get('userId')
  await c.env.DB.prepare('DELETE FROM edges WHERE id = ? AND user_id = ?').bind(c.req.param('id'), uid).run()
  return c.json({ ok: true })
})

// ============ 学习路线 ============
app.get('/api/roadmaps', async (c) => {
  const uid = c.get('userId')
  const r = await c.env.DB.prepare('SELECT * FROM roadmaps WHERE user_id = ?').bind(uid).all()
  return c.json(r.results)
})

app.get('/api/roadmaps/:id', async (c) => {
  const uid = c.get('userId')
  const roadmap = await c.env.DB.prepare('SELECT * FROM roadmaps WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), uid).first()
  if (!roadmap) return c.json({ error: 'not found' }, 404)
  const steps = await c.env.DB.prepare(
    `SELECT s.seq, n.* FROM roadmap_steps s JOIN nodes n ON n.id = s.node_id AND n.user_id = s.user_id
     WHERE s.roadmap_id = ? AND s.user_id = ? ORDER BY s.seq`
  ).bind(c.req.param('id'), uid).all()
  return c.json({ ...roadmap, steps: steps.results })
})

// 整体替换路线步骤 [{node_id, seq}]
app.put('/api/roadmaps/:id/steps', async (c) => {
  const uid = c.get('userId')
  const id = c.req.param('id')
  const steps: { node_id: string; seq: number }[] = await c.req.json()
  const stmts = [c.env.DB.prepare('DELETE FROM roadmap_steps WHERE roadmap_id = ? AND user_id = ?').bind(id, uid)]
  for (const s of steps) {
    stmts.push(c.env.DB.prepare('INSERT INTO roadmap_steps (roadmap_id, user_id, node_id, seq) VALUES (?,?,?,?)').bind(id, uid, s.node_id, s.seq))
  }
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

// ============ 打卡 ============
app.get('/api/checkins', async (c) => {
  const uid = c.get('userId')
  const from = c.req.query('from') ?? '1970-01-01'
  const to = c.req.query('to') ?? '2999-12-31'
  const r = await c.env.DB.prepare(
    `SELECT c.*, n.name AS node_name, n.domain FROM checkins c
     JOIN nodes n ON n.id = c.node_id AND n.user_id = c.user_id
     WHERE c.user_id = ? AND c.date BETWEEN ? AND ? ORDER BY c.date DESC, c.id DESC`
  ).bind(uid, from, to).all()
  return c.json(r.results)
})

app.post('/api/checkins', async (c) => {
  const uid = c.get('userId')
  const b = await c.req.json()
  await c.env.DB.prepare('INSERT INTO checkins (user_id, node_id, date, minutes, note) VALUES (?,?,?,?,?)')
    .bind(uid, b.node_id, b.date, b.minutes, b.note ?? '').run()
  await bustStatsCache(c.env.STATS_KV, uid)
  return c.json({ ok: true })
})

app.delete('/api/checkins/:id', async (c) => {
  const uid = c.get('userId')
  await c.env.DB.prepare('DELETE FROM checkins WHERE id = ? AND user_id = ?').bind(c.req.param('id'), uid).run()
  await bustStatsCache(c.env.STATS_KV, uid)
  return c.json({ ok: true })
})

// ============ 个人资料 ============
app.get('/api/me', async (c) => {
  const uid = c.get('userId')
  return c.json({ user_id: uid, email: uid === DEFAULT_USER_ID ? '' : uid })
})

app.get('/api/profile', async (c) => {
  const uid = c.get('userId')
  const row = await c.env.DB.prepare('SELECT * FROM profile WHERE user_id = ?').bind(uid).first<ProfileRow>()
  if (!row) return c.json({ user_id: uid, email: uid === DEFAULT_USER_ID ? '' : uid, avatar: '' })
  return c.json({ ...row, avatar: toClientAvatar(row.avatar, row.updated_at) })
})

app.put('/api/profile', async (c) => {
  const uid = c.get('userId')
  const b = await c.req.json()
  // 头像只能通过 /api/profile/avatar 上传更新，忽略客户端传入的 avatar，避免覆盖内部 object key
  const fields = ['nickname', 'bio', 'goal', 'email', 'phone', 'location', 'website']
  const data = Object.fromEntries(fields.map((f) => [f, typeof b[f] === 'string' ? b[f] : '']))
  await c.env.DB.prepare(
    `INSERT INTO profile (user_id, nickname, avatar, bio, goal, email, phone, location, website)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       nickname = excluded.nickname, bio = excluded.bio,
       goal = excluded.goal, email = excluded.email, phone = excluded.phone,
       location = excluded.location, website = excluded.website,
       updated_at = datetime('now')`
  ).bind(
    uid, data.nickname, '', data.bio, data.goal,
    data.email, data.phone, data.location, data.website
  ).run()
  const row = await c.env.DB.prepare('SELECT * FROM profile WHERE user_id = ?').bind(uid).first<ProfileRow>()
  return c.json({ ok: true, avatar: toClientAvatar(row?.avatar, row?.updated_at) })
})

type ProfileRow = {
  user_id: string
  nickname: string
  avatar: string
  bio: string
  goal: string
  email: string
  phone: string
  location: string
  website: string
  updated_at?: string
}

async function readAvatarUpload(c: { req: { header: (name: string) => string | undefined; formData: () => Promise<FormData>; arrayBuffer: () => Promise<ArrayBuffer> } }): Promise<
  | { ok: true; bytes: Uint8Array; declaredType: string }
  | { ok: false; status: 400 | 413 | 415; error: string }
> {
  if (requestLooksTooLarge(c.req.header('content-length'))) {
    return { ok: false, status: 413, error: '文件过大，最大 5MB' }
  }
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const form = await c.req.formData()
    const file = form.get('file') ?? form.get('avatar')
    if (!(file instanceof File)) {
      return { ok: false, status: 400, error: '请选择要上传的图片' }
    }
    if (file.size > AVATAR_MAX_BYTES) {
      return { ok: false, status: 413, error: '文件过大，最大 5MB' }
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { ok: true, bytes, declaredType: file.type }
  }
  const declaredType = contentType.split(';')[0].trim()
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  return { ok: true, bytes, declaredType }
}

// 头像：写入已声明的 NOTES 桶（key 前缀 avatars/{user}/），读取走授权接口，不接受客户端指定 object key
app.post('/api/profile/avatar', async (c) => {
  const uid = c.get('userId')
  const uploaded = await readAvatarUpload(c)
  if (!uploaded.ok) return c.json({ error: uploaded.error }, uploaded.status)

  const inspected = inspectAvatarUpload({ bytes: uploaded.bytes, declaredType: uploaded.declaredType })
  if (!inspected.ok) return c.json({ error: inspected.error }, inspected.status)

  const key = buildAvatarKey(uid, inspected.ext)
  const existing = await c.env.DB.prepare('SELECT avatar FROM profile WHERE user_id = ?')
    .bind(uid).first<{ avatar: string }>()
  const previousKey = existing?.avatar ?? ''

  await c.env.NOTES.put(key, uploaded.bytes, {
    httpMetadata: {
      contentType: inspected.contentType,
      contentDisposition: 'inline',
      cacheControl: 'private, max-age=3600',
    },
    customMetadata: { userId: uid },
  })

  await c.env.DB.prepare(
    `INSERT INTO profile (user_id, avatar, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       avatar = excluded.avatar,
       updated_at = datetime('now')`
  ).bind(uid, key).run()

  if (previousKey && isOwnedAvatarKey(previousKey, uid) && previousKey !== key) {
    await c.env.NOTES.delete(previousKey)
  }

  const row = await c.env.DB.prepare('SELECT avatar, updated_at FROM profile WHERE user_id = ?')
    .bind(uid).first<{ avatar: string; updated_at: string }>()
  return c.json({ avatar: publicAvatarUrl(row?.updated_at) })
})

app.get('/api/profile/avatar', async (c) => {
  const uid = c.get('userId')
  const row = await c.env.DB.prepare('SELECT avatar FROM profile WHERE user_id = ?')
    .bind(uid).first<{ avatar: string }>()
  const key = row?.avatar ?? ''
  // 只使用当前用户资料中的服务端 key，忽略查询参数中的任何 object key
  if (!isOwnedAvatarKey(key, uid)) return c.json({ error: '未找到头像' }, 404)

  const object = await c.env.NOTES.get(key)
  if (!object) return c.json({ error: '未找到头像' }, 404)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('Cache-Control', 'private, max-age=3600')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Disposition', 'inline')
  return new Response(object.body, { status: 200, headers })
})

async function bustStatsCache(kv: KVNamespace, uid: string) {
  await Promise.all([kv.delete(`stats:heatmap:${uid}`), kv.delete(`stats:summary:${uid}`)])
}

// ============ 统计（KV 缓存，按用户隔离）============
app.get('/api/stats/heatmap', async (c) => {
  const uid = c.get('userId')
  const cached = await c.env.STATS_KV.get(`stats:heatmap:${uid}`, 'json')
  if (cached) return c.json(cached)
  const r = await c.env.DB.prepare(
    'SELECT date, SUM(minutes) AS minutes, COUNT(*) AS count FROM checkins WHERE user_id = ? GROUP BY date'
  ).bind(uid).all()
  const data = r.results
  await c.env.STATS_KV.put(`stats:heatmap:${uid}`, JSON.stringify(data), { expirationTtl: 86400 })
  return c.json(data)
})

app.get('/api/stats/summary', async (c) => {
  const uid = c.get('userId')
  const cached = await c.env.STATS_KV.get(`stats:summary:${uid}`, 'json')
  if (cached) return c.json(cached)

  const total = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(minutes),0) AS minutes, COUNT(*) AS count FROM checkins WHERE user_id = ?'
  ).bind(uid).first()
  const byDomain = await c.env.DB.prepare(
    `SELECT n.domain, COALESCE(SUM(c.minutes),0) AS minutes FROM checkins c
     JOIN nodes n ON n.id = c.node_id AND n.user_id = c.user_id WHERE c.user_id = ? GROUP BY n.domain`
  ).bind(uid).all()
  const byWeek = await c.env.DB.prepare(
    `SELECT strftime('%Y-W%W', date) AS week, SUM(minutes) AS minutes
     FROM checkins WHERE user_id = ? GROUP BY week ORDER BY week DESC LIMIT 12`
  ).bind(uid).all()
  const byNode = await c.env.DB.prepare(
    `SELECT n.id, n.name, SUM(c.minutes) AS minutes FROM checkins c
     JOIN nodes n ON n.id = c.node_id AND n.user_id = c.user_id WHERE c.user_id = ? GROUP BY n.id ORDER BY minutes DESC LIMIT 20`
  ).bind(uid).all()
  const dates = await c.env.DB.prepare('SELECT DISTINCT date FROM checkins WHERE user_id = ? ORDER BY date DESC').bind(uid).all()

  const data = {
    total,
    byDomain: byDomain.results,
    byWeek: byWeek.results.reverse(),
    byNode: byNode.results,
    streak: calcStreak((dates.results as { date: string }[]).map((d) => d.date)),
  }
  await c.env.STATS_KV.put(`stats:summary:${uid}`, JSON.stringify(data), { expirationTtl: 86400 })
  return c.json(data)
})

function calcStreak(datesDesc: string[]): number {
  if (!datesDesc.length) return 0
  const set = new Set(datesDesc)
  const today = new Date()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const cursor = new Date(today)
  if (!set.has(fmt(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (set.has(fmt(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

// ============ 笔记（R2，key 含 uid 目录做物理隔离）============
function noteKey(uid: string, nodeId: string): string {
  return `notes/${uid}/${nodeId}.md`
}

app.get('/api/notes/:nodeId', async (c) => {
  const uid = c.get('userId')
  const obj = await c.env.NOTES.get(noteKey(uid, c.req.param('nodeId')))
  if (!obj) return c.json({ content: '' })
  return c.json({ content: await obj.text() })
})

app.put('/api/notes/:nodeId', async (c) => {
  const uid = c.get('userId')
  const nodeId = c.req.param('nodeId')
  const { content } = await c.req.json<{ content: string }>()
  await c.env.NOTES.put(noteKey(uid, nodeId), content ?? '', {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  })
  if (content && c.env.AI && c.env.VECTORS) {
    c.executionCtx.waitUntil(indexNote(c.env, uid, nodeId, content))
  }
  return c.json({ ok: true })
})

async function indexNote(env: Bindings, uid: string, nodeId: string, content: string) {
  try {
    const node = await env.DB.prepare('SELECT name FROM nodes WHERE id = ? AND user_id = ?')
      .bind(nodeId, uid).first<{ name: string }>()
    const text = `${node?.name ?? nodeId}\n${content}`.slice(0, 2000)
    const res = await env.AI.run('@cf/baai/bge-m3', { text: [text] }) as { data: number[][] }
    // 向量 id 用 uid:nodeId 保证全局唯一，metadata 存 userId 供过滤
    await env.VECTORS.upsert([{
      id: `${uid}:${nodeId}`,
      values: res.data[0],
      metadata: { userId: uid, nodeId, name: node?.name ?? nodeId, preview: content.slice(0, 300) },
    }])
  } catch (e) {
    console.error('indexNote failed', e)
  }
}

// ============ 资源 ============
app.get('/api/resources', async (c) => {
  const uid = c.get('userId')
  const nodeId = c.req.query('node_id')
  const stmt = nodeId
    ? c.env.DB.prepare('SELECT * FROM resources WHERE user_id = ? AND node_id = ?').bind(uid, nodeId)
    : c.env.DB.prepare('SELECT * FROM resources WHERE user_id = ?').bind(uid)
  const r = await stmt.all()
  return c.json(r.results)
})

app.post('/api/resources', async (c) => {
  const uid = c.get('userId')
  const b = await c.req.json()
  const r = await c.env.DB.prepare('INSERT INTO resources (user_id, node_id, title, url, kind) VALUES (?,?,?,?,?)')
    .bind(uid, b.node_id, b.title, b.url, b.kind ?? 'doc').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.delete('/api/resources/:id', async (c) => {
  const uid = c.get('userId')
  await c.env.DB.prepare('DELETE FROM resources WHERE id = ? AND user_id = ?').bind(c.req.param('id'), uid).run()
  return c.json({ ok: true })
})

// ============ P6 语义搜索（按用户过滤）============
app.post('/api/search/semantic', async (c) => {
  const uid = c.get('userId')
  const { query } = await c.req.json<{ query: string }>()
  if (!query) return c.json({ results: [] })
  const res = await c.env.AI.run('@cf/baai/bge-m3', { text: [query] }) as { data: number[][] }
  const matches = await c.env.VECTORS.query(res.data[0], {
    topK: 8,
    returnMetadata: 'all',
    filter: { userId: uid },
  })
  const nodeIds = matches.matches.map((m) => (m.metadata as { nodeId?: string })?.nodeId ?? (m.id as string))
  if (!nodeIds.length) return c.json({ results: [] })
  const placeholders = nodeIds.map(() => '?').join(',')
  const nodes = await c.env.DB.prepare(
    `SELECT * FROM nodes WHERE id IN (${placeholders}) AND user_id = ?`
  ).bind(...nodeIds, uid).all()
  const nodeMap = new Map((nodes.results as { id: string }[]).map((n) => [n.id, n]))
  return c.json({
    results: matches.matches.map((m, i) => ({
      id: nodeIds[i],
      score: m.score,
      node: nodeMap.get(nodeIds[i]) ?? null,
      preview: (m.metadata as { preview?: string })?.preview ?? '',
    })),
  })
})

// 非匹配路由 → 静态资源 + SPA 回退
app.get('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status === 404 && c.req.header('accept')?.includes('text/html')) {
    const index = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)))
    return new Response(index.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  return res
})

export default app
