import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie } from 'hono/cookie'
import {
  AVATAR_MAX_BYTES,
  buildAvatarKey,
  inspectAvatarUpload,
  isOwnedAvatarKey,
  publicAvatarUrl,
  requestLooksTooLarge,
  toClientAvatar,
} from './avatar.ts'
import { buildGraphDraft, classifyDomain, generateNodeLesson, generateNodeLessonStream, webSearch } from './agent.ts'
import { nextSnowflakeId } from './snowflake.ts'
import {
  COOKIE_NAME,
  checkOAuthState,
  clearSessionCookie,
  createOAuthState,
  createSession,
  destroySession,
  getSessionEmail,
  githubAuthorizeUrl,
  githubLogin,
  sendLoginCode,
  sessionCookie,
  verifyLoginCode,
  type AuthEnv,
} from './auth.ts'

type Bindings = AuthEnv & {
  DB: D1Database
  NOTES: R2Bucket
  STATS_KV: KVNamespace
  VECTORS: VectorizeIndex
  AI: Ai
  ASSETS: Fetcher
  // Tavily 联网搜索 API Key（通过 wrangler secret 注入，可选）
  TAVILY_API_KEY?: string
}

// 默认用户：本地开发（无 session）或存量数据归属
const DEFAULT_USER_ID = 'default'

const app = new Hono<{ Bindings: Bindings; Variables: { userId: string; email: string } }>()
app.use('/api/*', cors())

// ============ 身份中间件：session cookie → email → 雪花 user_id ============
// 应用层自建登录后，通过 httpOnly session cookie 识别用户邮箱，
// 再经 users 表把邮箱解析为雪花算法生成的唯一 user_id。
// 未登录（无 cookie）时回退 DEFAULT_USER_ID（仅本地开发调试用，线上会被前端守卫拦住）
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, COOKIE_NAME)
  const email = await getSessionEmail(c.env, token)
  if (!email) {
    c.set('userId', DEFAULT_USER_ID)
    c.set('email', '')
  } else {
    const uid = await resolveUserId(c.env.DB, email)
    c.set('userId', uid)
    c.set('email', email)
  }
  await next()
})

/**
 * 根据登录邮箱解析出唯一的雪花 user_id。
 * 首次登录（users 表无此邮箱）时生成雪花 id 并落库，实现「邮箱 → 唯一 id」映射。
 */
async function resolveUserId(db: D1Database, email: string): Promise<string> {
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
  if (existing) return existing.id
  const id = nextSnowflakeId()
  await db
    .prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)')
    .bind(id, email)
    .run()
  // 并发下可能被其他请求抢先插入，重新读取以保证返回已存在的那条
  const row = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
  return row?.id ?? id
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
  const r = await c.env.DB.prepare('SELECT * FROM roadmaps WHERE user_id = ? ORDER BY id').bind(uid).all()
  return c.json(r.results)
})

// 新建路线
app.post('/api/roadmaps', async (c) => {
  const uid = c.get('userId')
  const { id, name, description } = await c.req.json<{ id: string; name: string; description?: string }>()
  if (!id || !name) return c.json({ error: 'id 和 name 必填' }, 400)
  try {
    await c.env.DB.prepare('INSERT INTO roadmaps (id, user_id, name, description) VALUES (?,?,?,?)')
      .bind(id, uid, name, description ?? '').run()
    return c.json({ ok: true })
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      return c.json({ error: '路线 id 已存在' }, 409)
    }
    throw e
  }
})

// 更新路线（改名/描述）
app.patch('/api/roadmaps/:id', async (c) => {
  const uid = c.get('userId')
  const id = c.req.param('id')
  const { name, description } = await c.req.json<{ name?: string; description?: string }>()
  const fields: string[] = []
  const values: unknown[] = []
  if (name !== undefined) { fields.push('name = ?'); values.push(name) }
  if (description !== undefined) { fields.push('description = ?'); values.push(description) }
  if (!fields.length) return c.json({ error: 'no fields' }, 400)
  values.push(id, uid)
  await c.env.DB.prepare(`UPDATE roadmaps SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values).run()
  return c.json({ ok: true })
})

// 删除路线（级联删除步骤）
app.delete('/api/roadmaps/:id', async (c) => {
  const uid = c.get('userId')
  const id = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM roadmap_steps WHERE roadmap_id = ? AND user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM roadmaps WHERE id = ? AND user_id = ?').bind(id, uid),
  ])
  return c.json({ ok: true })
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

// ============ 领域管理（全局，不分用户）============
app.get('/api/domains', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM domains ORDER BY sort, id').all()
  return c.json(r.results)
})

app.post('/api/domains', async (c) => {
  const { id, name, color, sort } = await c.req.json<{ id: string; name: string; color: string; sort?: number }>()
  if (!id || !name || !color) return c.json({ error: 'id、name、color 必填' }, 400)
  try {
    await c.env.DB.prepare('INSERT INTO domains (id, name, color, sort) VALUES (?,?,?,?)')
      .bind(id, name, color, sort ?? 0).run()
    return c.json({ ok: true })
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) {
      return c.json({ error: '领域 id 已存在' }, 409)
    }
    throw e
  }
})

app.patch('/api/domains/:id', async (c) => {
  const id = c.req.param('id')
  const { name, color, sort } = await c.req.json<{ name?: string; color?: string; sort?: number }>()
  const fields: string[] = []
  const values: unknown[] = []
  if (name !== undefined) { fields.push('name = ?'); values.push(name) }
  if (color !== undefined) { fields.push('color = ?'); values.push(color) }
  if (sort !== undefined) { fields.push('sort = ?'); values.push(sort) }
  if (!fields.length) return c.json({ error: 'no fields' }, 400)
  values.push(id)
  await c.env.DB.prepare(`UPDATE domains SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ ok: true })
})

app.delete('/api/domains/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(id).run()
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

// ============ 认证（邮箱验证码 + GitHub OAuth）============
// 回调地址：GitHub OAuth App 需配置 Authorization callback URL 指向此路径
function githubRedirectUri(c: { req: { url: string } }): string {
  const url = new URL(c.req.url)
  return `${url.origin}/api/auth/github/callback`
}

// 发送登录验证码
app.post('/api/auth/send-code', async (c) => {
  const { email } = await c.req.json<{ email: string }>()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return c.json({ ok: false, error: '请输入有效的邮箱地址' }, 400)
  }
  const err = await sendLoginCode(c.env, email.trim())
  if (err) return c.json({ ok: false, error: err }, 400)
  return c.json({ ok: true })
})

// 校验验证码并签发 session
app.post('/api/auth/verify', async (c) => {
  const { email, code } = await c.req.json<{ email: string; code: string }>()
  if (!email || !code) return c.json({ ok: false, error: '参数缺失' }, 400)
  const err = await verifyLoginCode(c.env, email.trim(), String(code))
  if (err) return c.json({ ok: false, error: err }, 400)
  const token = await createSession(c.env, email.trim())
  c.header('Set-Cookie', sessionCookie(token))
  return c.json({ ok: true, email: email.trim() })
})

// GitHub OAuth 登录入口：302 跳转 GitHub 授权页
app.get('/api/auth/github', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: 'GitHub 登录未配置' }, 503)
  }
  const state = await createOAuthState(c.env)
  const url = githubAuthorizeUrl(c.env, githubRedirectUri(c), state)
  return c.redirect(url, 302)
})

// GitHub OAuth 回调：换取用户 → 签发 session → 跳回首页
app.get('/api/auth/github/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.redirect('/?auth=error', 302)

  const stateOk = await checkOAuthState(c.env, state)
  if (!stateOk) return c.redirect('/?auth=error', 302)

  const email = await githubLogin(c.env, code, githubRedirectUri(c))
  if (!email) return c.redirect('/?auth=error', 302)

  const token = await createSession(c.env, email)
  c.header('Set-Cookie', sessionCookie(token))
  return c.redirect('/?auth=success', 302)
})

// 当前登录状态
app.get('/api/auth/me', async (c) => {
  const uid = c.get('userId')
  const email = c.get('email')
  const authenticated = uid !== DEFAULT_USER_ID
  return c.json({ authenticated, user_id: uid, email })
})

// 退出登录
app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, COOKIE_NAME)
  await destroySession(c.env, token)
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

// ============ 个人资料 ============
app.get('/api/me', async (c) => {
  const uid = c.get('userId')
  const email = c.get('email')
  return c.json({ user_id: uid, email })
})

app.get('/api/profile', async (c) => {
  const uid = c.get('userId')
  const email = c.get('email')
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<UserRow>()
  if (!row) return c.json({ user_id: uid, email, avatar: '' })
  return c.json({ ...toClientProfile(row), avatar: toClientAvatar(row.avatar, row.updated_at) })
})

app.put('/api/profile', async (c) => {
  const uid = c.get('userId')
  const b = await c.req.json()
  // 头像只能通过 /api/profile/avatar 上传更新，忽略客户端传入的 avatar，避免覆盖内部 object key
  const fields = ['nickname', 'bio', 'goal', 'phone', 'location', 'website']
  const data = Object.fromEntries(fields.map((f) => [f, typeof b[f] === 'string' ? b[f] : '']))
  await c.env.DB.prepare(
    `UPDATE users SET
       nickname = ?, bio = ?, goal = ?, phone = ?, location = ?, website = ?,
       updated_at = datetime('now', '+8 hours')
     WHERE id = ?`
  ).bind(
    data.nickname, data.bio, data.goal, data.phone, data.location, data.website, uid
  ).run()
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<UserRow>()
  return c.json({ ok: true, avatar: toClientAvatar(row?.avatar, row?.updated_at) })
})

type UserRow = {
  id: string
  email: string
  nickname: string
  avatar: string
  bio: string
  goal: string
  phone: string
  location: string
  website: string
  created_at?: string
  updated_at?: string
}

// users 表行 → 前端 Profile 契约（user_id = users.id，email = 登录邮箱）
function toClientProfile(row: UserRow) {
  return {
    user_id: row.id,
    email: row.email,
    nickname: row.nickname,
    bio: row.bio,
    goal: row.goal,
    phone: row.phone,
    location: row.location,
    website: row.website,
    updated_at: row.updated_at,
  }
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
  const existing = await c.env.DB.prepare('SELECT avatar FROM users WHERE id = ?')
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
    `UPDATE users SET avatar = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?`
  ).bind(key, uid).run()

  if (previousKey && isOwnedAvatarKey(previousKey, uid) && previousKey !== key) {
    await c.env.NOTES.delete(previousKey)
  }

  const row = await c.env.DB.prepare('SELECT avatar, updated_at FROM users WHERE id = ?')
    .bind(uid).first<{ avatar: string; updated_at: string }>()
  return c.json({ avatar: publicAvatarUrl(row?.updated_at) })
})

app.get('/api/profile/avatar', async (c) => {
  const uid = c.get('userId')
  const row = await c.env.DB.prepare('SELECT avatar FROM users WHERE id = ?')
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

// ============ 联网搜索 ============
app.post('/api/search/web', async (c) => {
  const { query, limit } = await c.req.json<{ query: string; limit?: number }>()
  if (!query?.trim()) return c.json({ results: [] })
  const items = await webSearch(c.env, query, limit ?? 5)
  return c.json({ results: items })
})

// ============ 智能对话构建图谱 ============
// AI 识别领域：手动创建节点时自动归类
app.post('/api/agent/classify-domain', async (c) => {
  const { name, tags } = await c.req.json<{ name: string; tags?: string[] }>()
  if (!name?.trim()) return c.json({ error: '请输入知识点名称' }, 400)
  const domain = await classifyDomain(c.env, name.trim(), tags ?? [])
  return c.json({ domain })
})

app.post('/api/agent/build-graph', async (c) => {
  const uid = c.get('userId')
  const { topic } = await c.req.json<{ topic: string }>()
  if (!topic?.trim()) return c.json({ error: '请输入主题' }, 400)

  try {
    const draft = await buildGraphDraft(c.env, topic.trim())
    if (!draft.nodes.length) return c.json({ error: '未生成任何节点' }, 500)

    // 写入节点（忽略已存在的 id，避免主键冲突）
    const nodeStmts = draft.nodes.map((n) =>
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO nodes (id, user_id, name, domain, level, status, progress, tags) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(n.id, uid, n.name, n.domain, n.level, 'todo', 0, JSON.stringify(n.tags))
    )
    await c.env.DB.batch(nodeStmts)

    // 写入边（去重，避免重复边）
    const existingEdges = await c.env.DB.prepare('SELECT source, target FROM edges WHERE user_id = ?').bind(uid).all()
    const edgeSet = new Set((existingEdges.results as { source: string; target: string }[]).map((e) => `${e.source}|${e.target}`))
    const edgeStmts = draft.edges
      .filter((e) => !edgeSet.has(`${e.source}|${e.target}`))
      .map((e) =>
        c.env.DB.prepare('INSERT INTO edges (user_id, source, target, type) VALUES (?,?,?,?)')
          .bind(uid, e.source, e.target, e.type)
      )
    if (edgeStmts.length) await c.env.DB.batch(edgeStmts)

    return c.json({ ok: true, nodes: draft.nodes.length, edges: edgeStmts.length })
  } catch (e) {
    console.error('build-graph failed', e)
    return c.json({ error: e instanceof Error ? e.message : '构建图谱失败' }, 500)
  }
})

// ============ 知识库教材生成 ============
// 按拓扑序返回用户图谱节点（依赖前置者在前）
async function topoOrderNodes(db: D1Database, uid: string) {
  const nodes = await db.prepare('SELECT * FROM nodes WHERE user_id = ?').bind(uid).all()
  const edges = await db.prepare('SELECT * FROM edges WHERE user_id = ?').bind(uid).all()
  const nodeList = nodes.results as { id: string; name: string; domain: string; level: number }[]
  const nodeMap = new Map(nodeList.map((n) => [n.id, n]))

  // 构建邻接与入度
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const n of nodeList) { adj.set(n.id, []); indeg.set(n.id, 0) }
  for (const e of edges.results as { source: string; target: string }[]) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  // 拓扑排序（Kahn）
  const queue = nodeList.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length) {
    const cur = queue.shift()!
    order.push(cur)
    for (const next of adj.get(cur) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  // 有环则把剩余节点按原顺序追加
  const orderedIds = new Set(order)
  for (const n of nodeList) if (!orderedIds.has(n.id)) order.push(n.id)
  return order.map((id) => nodeMap.get(id)!).filter(Boolean)
}

// 获取当前用户已生成的知识库
app.get('/api/knowledge', async (c) => {
  const uid = c.get('userId')
  const r = await c.env.DB.prepare('SELECT * FROM knowledge_docs WHERE user_id = ? ORDER BY seq, id').bind(uid).all()
  return c.json(r.results)
})

// 生成单个节点的教材（供前端逐节点调用，展示进度）
app.post('/api/knowledge/generate-node', async (c) => {
  const uid = c.get('userId')
  const { node_id, seq, detailed } = await c.req.json<{ node_id: string; seq: number; detailed?: boolean }>()
  const node = await c.env.DB.prepare('SELECT id, name, domain, level FROM nodes WHERE id = ? AND user_id = ?')
    .bind(node_id, uid).first<{ id: string; name: string; domain: string; level: number }>()
  if (!node) return c.json({ error: '节点不存在' }, 404)

  try {
    const lesson = await generateNodeLesson(c.env, node, detailed === true)
    await c.env.DB.prepare(
      `INSERT INTO knowledge_docs (user_id, node_id, title, content, code, source_urls, domain, seq)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, node_id) DO UPDATE SET
         title = excluded.title, content = excluded.content, code = excluded.code,
         source_urls = excluded.source_urls, domain = excluded.domain, seq = excluded.seq,
         updated_at = datetime('now', '+8 hours')`
    ).bind(
      uid, node.id, lesson.title, lesson.content, lesson.code,
      JSON.stringify(lesson.source_urls), node.domain, seq
    ).run()
    return c.json({ ok: true, node_id: node.id, title: lesson.title })
  } catch (e) {
    console.error(`generate lesson failed for ${node_id}`, e)
    return c.json({ ok: false, node_id, error: e instanceof Error ? e.message : '生成失败' }, 500)
  }
})

// 流式生成单个节点的教材（SSE）：逐 token 推送标题/正文/代码，结束后落库
app.post('/api/knowledge/stream-generate', async (c) => {
  const uid = c.get('userId')
  const { node_id, seq, detailed } = await c.req.json<{ node_id: string; seq: number; detailed?: boolean }>()
  const node = await c.env.DB.prepare('SELECT id, name, domain, level FROM nodes WHERE id = ? AND user_id = ?')
    .bind(node_id, uid).first<{ id: string; name: string; domain: string; level: number }>()
  if (!node) return c.json({ error: '节点不存在' }, 404)

  const result = await generateNodeLessonStream(c.env, node, detailed === true)
  if (!result) {
    return c.json({ error: '流式生成不可用，请稍后重试' }, 500)
  }

  const { stream, sourceUrls } = result

  // 累积的完整文本，用于落库
  let acc = ''
  let finished = false

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
      }
      const reader = stream.getReader()
      // 增量解析游标（闭包内，隔离每个请求）
      let prevTitleLen = 0
      let prevContentLen = 0
      let prevCodeLen = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          acc += new TextDecoder().decode(value)
          // 实时解析三段边界，推送增量
          const parsed = parseStreamingLesson(acc, prevTitleLen, prevContentLen, prevCodeLen)
          prevTitleLen = parsed.titleLen
          prevContentLen = parsed.contentLen
          prevCodeLen = parsed.codeLen
          if (parsed.titleDelta) send({ type: 'title', value: parsed.titleDelta })
          if (parsed.contentDelta) send({ type: 'content', value: parsed.contentDelta })
          if (parsed.codeDelta) send({ type: 'code', value: parsed.codeDelta })
        }

        // 流结束，解析最终完整结构并落库
        const final = parseLessonFull(acc, node.name)
        finished = true
        if (final.content) {
          try {
            await c.env.DB.prepare(
              `INSERT INTO knowledge_docs (user_id, node_id, title, content, code, source_urls, domain, seq)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id, node_id) DO UPDATE SET
                 title = excluded.title, content = excluded.content, code = excluded.code,
                 source_urls = excluded.source_urls, domain = excluded.domain, seq = excluded.seq,
                 updated_at = datetime('now', '+8 hours')`
            ).bind(
              uid, node.id, final.title, final.content, final.code,
              JSON.stringify(sourceUrls), node.domain, seq
            ).run()
            send({ type: 'done', title: final.title, node_id: node.id })
          } catch (e) {
            console.error(`stream generate save failed for ${node_id}`, e)
            send({ type: 'error', message: '教材已生成但保存失败' })
          }
        } else {
          send({ type: 'error', message: '教材生成失败' })
        }
      } catch (e) {
        console.error('stream generate failed', e)
        if (!finished) send({ type: 'error', message: e instanceof Error ? e.message : '生成失败' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(sse, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// 增量解析：从累积文本中识别「标题/正文/代码」三段，返回各段的增量
// 通过传入上次已推送的边界长度，只推新增部分
function parseStreamingLesson(
  acc: string,
  prevTitleLen: number,
  prevContentLen: number,
  prevCodeLen: number
): { titleDelta: string; contentDelta: string; codeDelta: string; titleLen: number; contentLen: number; codeLen: number } {
  // 定位三个标记
  const titleStart = acc.indexOf('【标题】')
  const contentStart = acc.indexOf('【正文】')
  const codeStart = acc.indexOf('【代码】')

  let title = ''
  let content = ''
  let code = ''

  if (titleStart !== -1) {
    const end = contentStart !== -1 ? contentStart : acc.length
    if (end > titleStart + 4) title = acc.slice(titleStart + 4, end)
  }
  if (contentStart !== -1) {
    const end = codeStart !== -1 ? codeStart : acc.length
    if (end > contentStart + 4) content = acc.slice(contentStart + 4, end)
  }
  if (codeStart !== -1 && acc.length > codeStart + 4) {
    code = acc.slice(codeStart + 4)
  }

  const titleDelta = title.slice(prevTitleLen)
  const contentDelta = content.slice(prevContentLen)
  const codeDelta = code.slice(prevCodeLen)

  return {
    titleDelta,
    contentDelta,
    codeDelta,
    titleLen: title.length,
    contentLen: content.length,
    codeLen: code.length,
  }
}

// 最终完整解析（复用 generateNodeLesson 的解析逻辑）
function parseLessonFull(raw: string, fallbackName: string): { title: string; content: string; code: string } {
  const titleMatch = raw.match(/【标题】\s*([\s\S]*?)【正文】/)
  const contentMatch = raw.match(/【正文】\s*([\s\S]*?)【代码】/)
  const codeMatch = raw.match(/【代码】\s*([\s\S]*)$/)
  const title = (titleMatch?.[1] ?? fallbackName).trim()
  const content = (contentMatch?.[1] ?? '').trim()
  const code = (codeMatch?.[1] ?? '').trim()
  return { title: title || fallbackName, content, code }
}

// 获取拓扑序节点列表（供前端逐节点生成时使用）
// 额外返回每个节点的前置依赖（prerequisite 边）parent_ids，供前端构建可折叠目录树
app.get('/api/knowledge/nodes', async (c) => {
  const uid = c.get('userId')
  const nodes = await topoOrderNodes(c.env.DB, uid)
  const edges = await c.env.DB.prepare('SELECT source, target, type FROM edges WHERE user_id = ?').bind(uid).all()
  const parents = new Map<string, string[]>()
  for (const e of edges.results as { source: string; target: string; type: string }[]) {
    if (e.type !== 'prerequisite') continue
    if (!parents.has(e.target)) parents.set(e.target, [])
    parents.get(e.target)!.push(e.source)
  }
  return c.json(
    nodes.map((n) => ({
      id: n.id,
      name: n.name,
      domain: n.domain,
      level: n.level,
      parent_ids: parents.get(n.id) ?? [],
    }))
  )
})

// 清空当前用户知识库
app.delete('/api/knowledge', async (c) => {
  const uid = c.get('userId')
  await c.env.DB.prepare('DELETE FROM knowledge_docs WHERE user_id = ?').bind(uid).run()
  return c.json({ ok: true })
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
