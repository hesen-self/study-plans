/**
 * 助手三层记忆 + 多轮意图分流：
 * L0 会话（前端上传）/ L1 画像（D1）/ L2 情景摘要（D1）
 */
import {
  chatJson,
  compactDraftForPrompt,
  FAST_MODEL,
  formatAnchorHint,
  type ChatTurn,
  type EnvWithSearch,
  type GraphDraft,
  type GraphDraftAnchor,
  type GraphDraftResult,
} from './agent.ts'
import { nextSnowflakeId } from './snowflake.ts'

export type AgentIntent = 'consult' | 'clarify' | 'revise' | 'build'

export type AgentSessionMemory = {
  pendingClarify?: { summary: string; options: string[]; createdAt: number } | null
  focusNodeIds?: string[]
  lastIntent?: Exclude<AgentIntent, 'build'>
  sessionPreferences?: string[]
}

export type AgentUserProfile = {
  preferences: string[]
  avoid: string[]
  style: string
  focus_domains: string[]
  level_bias: 'beginner' | 'balanced' | 'advanced' | ''
  notes: string
}

export type AgentEpisode = {
  id: string
  kind: string
  summary: string
  topic: string
  node_ids: string[]
  created_at?: string
}

export type TurnContext = {
  lastUser: string
  historyMessages: ChatTurn[]
  historyExcerpt: string
  draftSummary: string
  memoryBlock: string
  session: AgentSessionMemory
  profile: AgentUserProfile
  goal: string
  goalSummary: string
  episodes: AgentEpisode[]
  anchor: GraphDraftAnchor | null
}

const MAX_EPISODES_KEEP = 50
const MAX_PREFERENCES = 12

const REVISE_RE =
  /(删除|去掉|移除|加上|增加|添加|改成|改为|只要前置|再深一点|压缩到|精简|补充|挂接|重命名|换成|不要.*节点|加两个|加\s*\d)/
const CONSULT_RE =
  /(是什么|为什么|怎么学|如何学|合不合理|什么意思|讲讲|解释|区别|关系|适合吗|难不难|多久|路径.*合理)/
const CONFIRM_RE =
  /^(好|好的|可以|行|嗯|确认|就这样|按这个改|按此修改|选\s*[ABC1-3一二三]|选第一个|第一个|A\b|B\b|C\b)/i

export function emptyProfile(): AgentUserProfile {
  return {
    preferences: [],
    avoid: [],
    style: '',
    focus_domains: [],
    level_bias: '',
    notes: '',
  }
}

export function normalizeSessionMemory(raw: unknown): AgentSessionMemory {
  if (!raw || typeof raw !== 'object') return {}
  const m = raw as AgentSessionMemory
  const pending = m.pendingClarify
  let pendingClarify: AgentSessionMemory['pendingClarify'] = null
  if (pending && typeof pending === 'object' && typeof pending.summary === 'string') {
    pendingClarify = {
      summary: pending.summary.slice(0, 300),
      options: Array.isArray(pending.options)
        ? pending.options.map((o) => String(o).slice(0, 120)).filter(Boolean).slice(0, 5)
        : [],
      createdAt: Number(pending.createdAt) || Date.now(),
    }
  }
  const lastIntent =
    m.lastIntent === 'consult' || m.lastIntent === 'clarify' || m.lastIntent === 'revise'
      ? m.lastIntent
      : undefined
  return {
    pendingClarify,
    focusNodeIds: Array.isArray(m.focusNodeIds)
      ? m.focusNodeIds.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 3)
      : [],
    lastIntent,
    sessionPreferences: Array.isArray(m.sessionPreferences)
      ? m.sessionPreferences.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 5)
      : [],
  }
}

function parseProfileJson(raw: string | null | undefined): AgentUserProfile {
  const base = emptyProfile()
  if (!raw) return base
  try {
    const p = JSON.parse(raw) as Partial<AgentUserProfile>
    return {
      preferences: Array.isArray(p.preferences)
        ? p.preferences.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, MAX_PREFERENCES)
        : [],
      avoid: Array.isArray(p.avoid)
        ? p.avoid.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 8)
        : [],
      style: String(p.style ?? '').slice(0, 120),
      focus_domains: Array.isArray(p.focus_domains)
        ? p.focus_domains.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 8)
        : [],
      level_bias:
        p.level_bias === 'beginner' || p.level_bias === 'balanced' || p.level_bias === 'advanced'
          ? p.level_bias
          : '',
      notes: String(p.notes ?? '').slice(0, 300),
    }
  } catch {
    return base
  }
}

export async function loadLongTermMemory(
  db: D1Database,
  uid: string
): Promise<{ profile: AgentUserProfile; goalSummary: string; goal: string; episodes: AgentEpisode[] }> {
  const [memRow, userRow, epRows] = await Promise.all([
    db.prepare('SELECT profile_json, goal_summary FROM agent_user_memory WHERE user_id = ?')
      .bind(uid).first<{ profile_json: string; goal_summary: string }>(),
    db.prepare('SELECT goal FROM users WHERE id = ?').bind(uid).first<{ goal: string }>(),
    db.prepare(
      `SELECT id, kind, summary, topic, node_ids, created_at
       FROM agent_memory_episodes WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 20`
    ).bind(uid).all<{
      id: string
      kind: string
      summary: string
      topic: string
      node_ids: string
      created_at: string
    }>(),
  ])

  const episodes: AgentEpisode[] = (epRows.results ?? []).map((r) => {
    let node_ids: string[] = []
    try {
      const parsed = JSON.parse(r.node_ids || '[]') as unknown
      if (Array.isArray(parsed)) node_ids = parsed.map((x) => String(x)).slice(0, 12)
    } catch { /* ignore */ }
    return {
      id: r.id,
      kind: r.kind,
      summary: r.summary,
      topic: r.topic,
      node_ids,
      created_at: r.created_at,
    }
  })

  return {
    profile: parseProfileJson(memRow?.profile_json),
    goalSummary: (memRow?.goal_summary ?? '').trim(),
    goal: (userRow?.goal ?? '').trim(),
    episodes,
  }
}

export async function clearLongTermMemory(db: D1Database, uid: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM agent_user_memory WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM agent_memory_episodes WHERE user_id = ?').bind(uid),
  ])
}

export async function readMemoryForClient(
  db: D1Database,
  uid: string
): Promise<{ preferences: string[]; goal_summary: string; style: string; focus_domains: string[]; episode_count: number }> {
  const { profile, goalSummary, episodes } = await loadLongTermMemory(db, uid)
  const count = await db.prepare(
    'SELECT COUNT(*) AS c FROM agent_memory_episodes WHERE user_id = ?'
  ).bind(uid).first<{ c: number }>()
  return {
    preferences: profile.preferences,
    goal_summary: goalSummary,
    style: profile.style,
    focus_domains: profile.focus_domains,
    episode_count: count?.c ?? episodes.length,
  }
}

function scoreEpisode(ep: AgentEpisode, query: string, draftNames: string[]): number {
  const q = query.toLowerCase()
  let score = 0
  const topic = (ep.topic || '').toLowerCase()
  const summary = (ep.summary || '').toLowerCase()
  if (topic && q.includes(topic)) score += 5
  if (topic && topic.split(/\s+/).some((t) => t.length > 1 && q.includes(t))) score += 3
  for (const name of draftNames) {
    const n = name.toLowerCase()
    if (n && (summary.includes(n) || topic.includes(n))) score += 2
  }
  const tokens = q.split(/[\s,，、；;]+/).filter((t) => t.length >= 2).slice(0, 8)
  for (const t of tokens) {
    if (summary.includes(t) || topic.includes(t)) score += 1
  }
  if (ep.kind === 'revise' || ep.kind === 'build') score += 0.5
  return score
}

export function selectRelevantEpisodes(
  episodes: AgentEpisode[],
  query: string,
  draft: GraphDraft | null,
  limit = 3
): AgentEpisode[] {
  const names = (draft?.nodes ?? []).map((n) => n.name)
  return [...episodes]
    .map((ep) => ({ ep, score: scoreEpisode(ep, query, names) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.ep)
}

function formatProfileBlock(
  profile: AgentUserProfile,
  goal: string,
  goalSummary: string,
  session: AgentSessionMemory
): string {
  const lines: string[] = []
  const prefs = [
    ...profile.preferences,
    ...(session.sessionPreferences ?? []),
  ].filter(Boolean)
  const uniq = [...new Set(prefs)].slice(0, MAX_PREFERENCES)
  if (uniq.length) lines.push(`偏好：${uniq.join('；')}`)
  if (profile.avoid.length) lines.push(`避免：${profile.avoid.join('；')}`)
  if (profile.style) lines.push(`风格：${profile.style}`)
  if (profile.focus_domains.length) lines.push(`关注领域：${profile.focus_domains.join('、')}`)
  if (profile.level_bias) lines.push(`难度倾向：${profile.level_bias}`)
  if (profile.notes) lines.push(`备注：${profile.notes}`)
  const g = goalSummary || goal
  if (g) lines.push(`学习目标：${g}`)
  if (session.pendingClarify?.summary) {
    lines.push(`待确认提案：${session.pendingClarify.summary}`)
    if (session.pendingClarify.options?.length) {
      lines.push(`待确认选项：${session.pendingClarify.options.join(' / ')}`)
    }
  }
  return lines.length ? lines.join('\n') : '（暂无长期偏好）'
}

export function buildTurnContext(opts: {
  messages: ChatTurn[]
  draft: GraphDraft | null
  session: AgentSessionMemory
  profile: AgentUserProfile
  goal: string
  goalSummary: string
  episodes: AgentEpisode[]
  anchor: GraphDraftAnchor | null
}): TurnContext {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? ''
  const historyMessages = opts.messages
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 400) }))
  const historyExcerpt = historyMessages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n')
  const relevant = selectRelevantEpisodes(opts.episodes, lastUser, opts.draft, 3)
  const epBlock = relevant.length
    ? relevant.map((e, i) => `${i + 1}. [${e.kind}] ${e.summary}`).join('\n')
    : ''
  const memoryBlock = [
    '【用户长期偏好】',
    formatProfileBlock(opts.profile, opts.goal, opts.goalSummary, opts.session),
    epBlock ? `【相关历史情景】\n${epBlock}` : '',
  ].filter(Boolean).join('\n')

  return {
    lastUser,
    historyMessages,
    historyExcerpt,
    draftSummary: opts.draft ? compactDraftForPrompt(opts.draft) : '',
    memoryBlock,
    session: opts.session,
    profile: opts.profile,
    goal: opts.goal,
    goalSummary: opts.goalSummary,
    episodes: relevant,
    anchor: opts.anchor,
  }
}

export function looksLikeConfirm(text: string, session: AgentSessionMemory): boolean {
  if (!session.pendingClarify?.summary) return false
  const t = text.trim()
  if (!t) return false
  if (CONFIRM_RE.test(t)) return true
  const opts = session.pendingClarify.options ?? []
  return opts.some((o) => o && (t === o || t.includes(o.slice(0, 12))))
}

const SOFT_REVISE_RE = /(能不能|可不可以|要不要|是不是该|要不要考虑).{0,12}(加|改|删|去|补|深|压缩)/

export function heuristicIntent(text: string): AgentIntent | null {
  const t = text.trim()
  if (!t) return null
  if (REVISE_RE.test(t) && !SOFT_REVISE_RE.test(t)) return 'revise'
  if (SOFT_REVISE_RE.test(t)) return null // 交给模型判 clarify
  if (CONSULT_RE.test(t)) return 'consult'
  if (/[？?]$/.test(t) && !/(加|改|删|去|补|压缩|深)/.test(t)) return 'consult'
  return null
}

export async function classifyAgentTurn(
  env: EnvWithSearch,
  ctx: TurnContext
): Promise<AgentIntent> {
  const heur = heuristicIntent(ctx.lastUser)
  if (heur) return heur

  const prompt = `判断用户对学习图谱助手的意图，只输出 JSON：{"intent":"consult"|"clarify"|"revise"}
- consult：提问、讲解、咨询，不要改草稿
- clarify：意向模糊，需确认后再改（如「能不能加点实战？」）
- revise：明确要求改草稿（增删改节点/边/难度等）

【长期偏好摘要】
${ctx.memoryBlock}

【最近对话】
${ctx.historyExcerpt || '（无）'}

【用户最新一句】
${ctx.lastUser.slice(0, 500)}`

  const parsed = await chatJson(env, [
    { role: 'system', content: '只输出合法 JSON 对象。' },
    { role: 'user', content: prompt },
  ], 200, FAST_MODEL) as { intent?: string } | null

  const intent = parsed?.intent
  if (intent === 'consult' || intent === 'clarify' || intent === 'revise') return intent
  return 'clarify'
}

function matchFocusNodes(draft: GraphDraft, text: string): string[] {
  const hits: string[] = []
  for (const n of draft.nodes) {
    if (n.name && text.includes(n.name)) hits.push(n.id)
  }
  return hits.slice(0, 3)
}

export async function consultDraft(
  env: EnvWithSearch,
  draft: GraphDraft,
  ctx: TurnContext
): Promise<GraphDraftResult & { intent: 'consult'; memory: AgentSessionMemory; suggestions: string[] }> {
  const msgs: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        '你是学习路线顾问。根据当前图谱草稿回答用户问题，不要修改图谱。用简洁中文；末尾可提示如何改图。只输出 JSON：{"reply":"...","suggestions":["..."]}',
    },
    {
      role: 'user',
      content: `${ctx.memoryBlock}
${formatAnchorHint(ctx.anchor)}
【当前草稿】
${ctx.draftSummary}

请回答用户问题。suggestions 给 0～3 条可点短句（继续提问或转为改图）。`,
    },
    ...ctx.historyMessages.map((m) => ({ role: m.role, content: m.content })),
  ]

  const parsed = await chatJson(env, msgs, 1200, FAST_MODEL) as {
    reply?: unknown
    suggestions?: unknown
  } | null

  const reply = String(parsed?.reply ?? '').trim().slice(0, 1200)
    || '这是当前草稿里的相关说明。若要改图，请直接说怎么改。'
  const suggestions = Array.isArray(parsed?.suggestions)
    ? parsed!.suggestions!.map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, 3)
    : ['按这个思路改草稿', '再讲讲依赖关系']

  const focus = matchFocusNodes(draft, ctx.lastUser)
  const memory: AgentSessionMemory = {
    ...ctx.session,
    pendingClarify: null,
    lastIntent: 'consult',
    focusNodeIds: focus.length ? focus : ctx.session.focusNodeIds,
  }

  return {
    draft,
    reply,
    intent: 'consult',
    suggestions,
    memory,
    searchConfigured: true,
  }
}

export async function clarifyDraft(
  env: EnvWithSearch,
  draft: GraphDraft,
  ctx: TurnContext
): Promise<GraphDraftResult & { intent: 'clarify'; memory: AgentSessionMemory; suggestions: string[] }> {
  const msgs: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        '你是学习路线顾问。用户意图不够明确：复述你的理解，并给出 2～3 个明确选项供确认。不要修改图谱。只输出 JSON：{"reply":"...","suggestions":["选项A","选项B"]}',
    },
    {
      role: 'user',
      content: `${ctx.memoryBlock}
${formatAnchorHint(ctx.anchor)}
【当前草稿】
${ctx.draftSummary}

【用户原话】
${ctx.lastUser}

请澄清并给出可执行选项（suggestions 即选项文案）。`,
    },
  ]

  const parsed = await chatJson(env, msgs, 1000, FAST_MODEL) as {
    reply?: unknown
    suggestions?: unknown
  } | null

  const suggestions = Array.isArray(parsed?.suggestions)
    ? parsed!.suggestions!.map((s) => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 3)
    : ['加深实战节点', '保持现状', '先讲解某个节点']
  const reply = String(parsed?.reply ?? '').trim().slice(0, 1200)
    || `我理解你可能想调整路线。你可以选：${suggestions.join('；')}`

  const memory: AgentSessionMemory = {
    ...ctx.session,
    lastIntent: 'clarify',
    pendingClarify: {
      summary: reply.slice(0, 300),
      options: suggestions,
      createdAt: Date.now(),
    },
  }

  return {
    draft,
    reply,
    intent: 'clarify',
    suggestions,
    memory,
    searchConfigured: true,
  }
}

function mergeUnique(a: string[], b: string[], max: number): string[] {
  return [...new Set([...a, ...b].map((x) => x.trim()).filter(Boolean))].slice(0, max)
}

export async function mergeProfilePatch(
  db: D1Database,
  uid: string,
  current: AgentUserProfile,
  goalSummary: string,
  patch: Partial<AgentUserProfile> & { goal_summary?: string }
): Promise<void> {
  const next: AgentUserProfile = {
    preferences: mergeUnique(current.preferences, patch.preferences ?? [], MAX_PREFERENCES),
    avoid: mergeUnique(current.avoid, patch.avoid ?? [], 8),
    style: (patch.style ?? current.style).slice(0, 120),
    focus_domains: mergeUnique(current.focus_domains, patch.focus_domains ?? [], 8),
    level_bias: patch.level_bias || current.level_bias || '',
    notes: (patch.notes ?? current.notes).slice(0, 300),
  }
  const gs = (patch.goal_summary ?? goalSummary).slice(0, 200)
  await db.prepare(
    `INSERT INTO agent_user_memory (user_id, profile_json, goal_summary, updated_at)
     VALUES (?, ?, ?, datetime('now', '+8 hours'))
     ON CONFLICT(user_id) DO UPDATE SET
       profile_json = excluded.profile_json,
       goal_summary = excluded.goal_summary,
       updated_at = datetime('now', '+8 hours')`
  ).bind(uid, JSON.stringify(next), gs).run()
}

export async function insertEpisode(
  db: D1Database,
  uid: string,
  ep: { kind: string; summary: string; topic: string; node_ids: string[] }
): Promise<void> {
  const id = nextSnowflakeId()
  await db.prepare(
    `INSERT INTO agent_memory_episodes (id, user_id, kind, summary, topic, node_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))`
  ).bind(
    id,
    uid,
    ep.kind.slice(0, 20),
    ep.summary.slice(0, 300),
    ep.topic.slice(0, 120),
    JSON.stringify(ep.node_ids.slice(0, 12))
  ).run()

  const countRow = await db.prepare(
    'SELECT COUNT(*) AS c FROM agent_memory_episodes WHERE user_id = ?'
  ).bind(uid).first<{ c: number }>()
  const excess = (countRow?.c ?? 0) - MAX_EPISODES_KEEP
  if (excess > 0) {
    const old = await db.prepare(
      `SELECT id FROM agent_memory_episodes WHERE user_id = ?
       ORDER BY created_at ASC LIMIT ?`
    ).bind(uid, excess).all<{ id: string }>()
    const oldIds = (old.results ?? []).map((r) => r.id)
    if (oldIds.length) {
      await db.batch(
        oldIds.map((oid) =>
          db.prepare('DELETE FROM agent_memory_episodes WHERE id = ? AND user_id = ?').bind(oid, uid)
        )
      )
    }
  }
}

/** 回合结束后异步蒸馏 L1/L2；失败静默 */
export async function distillAfterTurn(
  env: EnvWithSearch & { DB: D1Database },
  uid: string,
  opts: {
    intent: AgentIntent
    lastUser: string
    reply: string
    draft: GraphDraft
    profile: AgentUserProfile
    goalSummary: string
    session: AgentSessionMemory
  }
): Promise<void> {
  try {
    const distillPrompt = `从本轮学习图谱对话蒸馏长期记忆。只输出 JSON：
{"preferences":[],"avoid":[],"style":"","focus_domains":[],"level_bias":"","goal_summary":"","episode_summary":"","topic":""}
规则：preferences/avoid 各最多 2 条短中文；无新信息则空数组；episode_summary ≤80 字概括本轮结论；topic 短主题。

意图：${opts.intent}
用户：${opts.lastUser.slice(0, 400)}
助手：${opts.reply.slice(0, 400)}
草稿节点：${opts.draft.nodes.slice(0, 12).map((n) => n.name).join('、')}`

    const parsed = await chatJson(env, [
      { role: 'system', content: '只输出合法 JSON。' },
      { role: 'user', content: distillPrompt },
    ], 500, FAST_MODEL) as {
      preferences?: unknown
      avoid?: unknown
      style?: unknown
      focus_domains?: unknown
      level_bias?: unknown
      goal_summary?: unknown
      episode_summary?: unknown
      topic?: unknown
    } | null

    const prefs = Array.isArray(parsed?.preferences)
      ? parsed!.preferences!.map((x) => String(x).trim()).filter(Boolean).slice(0, 2)
      : []
    const sessionPrefs = opts.session.sessionPreferences ?? []
    const patch: Partial<AgentUserProfile> & { goal_summary?: string } = {
      preferences: [...prefs, ...sessionPrefs].slice(0, 2),
      avoid: Array.isArray(parsed?.avoid)
        ? parsed!.avoid!.map((x) => String(x).trim()).filter(Boolean).slice(0, 2)
        : [],
      style: String(parsed?.style ?? '').trim().slice(0, 120),
      focus_domains: Array.isArray(parsed?.focus_domains)
        ? parsed!.focus_domains!.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
        : [],
      level_bias:
        parsed?.level_bias === 'beginner' || parsed?.level_bias === 'balanced' || parsed?.level_bias === 'advanced'
          ? parsed.level_bias
          : undefined,
      goal_summary: String(parsed?.goal_summary ?? '').trim().slice(0, 200) || undefined,
    }

    if (
      opts.intent === 'revise' || opts.intent === 'build' ||
      prefs.length || sessionPrefs.length || patch.style || patch.goal_summary
    ) {
      await mergeProfilePatch(env.DB, uid, opts.profile, opts.goalSummary, patch)
    }

    const episodeSummary = String(parsed?.episode_summary ?? '').trim()
      || `${opts.intent}: ${opts.lastUser.slice(0, 60)}`
    await insertEpisode(env.DB, uid, {
      kind: opts.intent,
      summary: episodeSummary.slice(0, 300),
      topic: String(parsed?.topic ?? opts.lastUser.slice(0, 40)).slice(0, 120),
      node_ids: opts.draft.nodes.slice(0, 8).map((n) => n.id),
    })
  } catch (e) {
    console.error('distillAfterTurn failed', e)
  }
}
