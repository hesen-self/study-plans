// AI 智能功能：联网搜索、一句话构建图谱、知识库教材生成
// 联网搜索使用 Tavily Search API（REST 调用），图谱构建/教材生成用 Workers AI 开源模型

export type WebSearchItem = { url: string; title: string; description?: string }

export type DomainInfo = { id: string; name: string }

/** 领域兜底清单（与 migrations/0009 初始 8 类一致；运行时优先用用户 domains） */
export const DEFAULT_DOMAIN_LIST: DomainInfo[] = [
  { id: 'ai-ml', name: 'AI / 机器学习' },
  { id: 'backend', name: '后端开发' },
  { id: 'frontend', name: '前端开发' },
  { id: 'data', name: '数据与数据库' },
  { id: 'devops', name: '工程与运维' },
  { id: 'cs-basic', name: '计算机基础' },
  { id: 'security', name: '安全' },
  { id: 'product', name: '产品与软技能' },
]

// 对话构建图谱时 LLM 返回的结构
export type GraphDraft = {
  nodes: { id: string; name: string; domain: string; level: number; tags: string[] }[]
  edges: { source: string; target: string; type: 'prerequisite' | 'related' | 'extend' }[]
}

// 多轮对话消息：会话历史由前端持有，后端保持无状态
export type ChatTurn = { role: 'user' | 'assistant'; content: string }

/** 前端传入的图谱锚定：扩展 / 找资料时作为硬约束 */
export type GraphDraftAnchor = {
  nodeId: string
  nodeName: string
  domain?: string
  mode?: 'build' | 'extend' | 'research'
}

// 一轮对话的产物：修订后的完整草稿 + 给用户的自然语言说明
export type GraphDraftResult = {
  draft: GraphDraft
  reply: string
  sources?: WebSearchItem[]
  searchConfigured?: boolean
  intent?: 'consult' | 'clarify' | 'revise' | 'build'
  suggestions?: string[]
}

/** 修订时由上层注入的对话/记忆上下文（避免循环依赖，不用完整 TurnContext 类型） */
export type ReviseTurnHints = {
  historyExcerpt?: string
  memoryBlock?: string
  /** 确认 pendingClarify 时合成的强制指令 */
  forcedInstruction?: string
}

/** 局部修订操作（优先于整图重写） */
export type DraftOp =
  | { op: 'add_node'; node: GraphDraft['nodes'][number] }
  | { op: 'remove_node'; id: string }
  | { op: 'update_node'; id: string; patch: Partial<GraphDraft['nodes'][number]> }
  | { op: 'add_edge'; edge: GraphDraft['edges'][number] }
  | { op: 'remove_edge'; source: string; target: string }

export type SanitizeMeta = {
  draft: GraphDraft
  remaps: { from: string; to: string }[]
}

const MAX_DRAFT_NODES = 30
const MAX_DRAFT_EDGES = 100
const DRAFT_CACHE_TTL = 600 // 10 分钟

// 主模型：建图 / 教材；快模型：领域分类等短任务
export const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
// 非 -fast 的 3.1-8b 已于 2026-05-30 废弃（错误码 5028）
export const FAST_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'

export type EnvWithSearch = {
  AI: Ai
  TAVILY_API_KEY?: string
  STATS_KV?: KVNamespace
}

// Tavily Search API 返回结果项
type TavilyResult = {
  url: string
  title: string
  content?: string
  score?: number
  raw_content?: string | null
}

export function isSearchConfigured(env: EnvWithSearch): boolean {
  return !!env.TAVILY_API_KEY?.trim()
}

/** 非 product 领域视为技术类（需 demo 代码）；自定义领域默认也要代码 */
export function isTechDomain(domain: string): boolean {
  return domain !== 'product'
}

function domainIds(domains: DomainInfo[]): string[] {
  return domains.map((d) => d.id)
}

function fallbackDomainId(domains: DomainInfo[]): string {
  return domains.find((d) => d.id === 'cs-basic')?.id ?? domains[0]?.id ?? 'cs-basic'
}

function formatDomainPrompt(domains: DomainInfo[]): string {
  return domains.map((d) => `   - ${d.id}（${d.name}）`).join('\n')
}

/**
 * 调用 Tavily Search API（REST）。
 * 使用 secret TAVILY_API_KEY；未配置时返回空数组。
 */
export async function webSearch(env: EnvWithSearch, query: string, limit = 5): Promise<WebSearchItem[]> {
  const q = query.trim().slice(0, 400)
  if (!q) return []

  if (!env.TAVILY_API_KEY) {
    console.error('webSearch: TAVILY_API_KEY not configured')
    return []
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: q,
        search_depth: 'basic',
        include_answer: false,
        max_results: Math.min(Math.max(limit, 1), 10),
      }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('webSearch Tavily failed', res.status, errText.slice(0, 300))
      return []
    }
    const data = (await res.json()) as { results?: TavilyResult[] }
    return (data.results ?? []).map((it) => ({
      url: it.url,
      title: it.title,
      description: it.content ?? '',
    }))
  } catch (e) {
    console.error('webSearch Tavily error', e)
    return []
  }
}

/** 主题拆 2~3 个子查询并去重合并 */
export async function webSearchTopic(env: EnvWithSearch, topic: string): Promise<WebSearchItem[]> {
  if (!isSearchConfigured(env)) return []
  const t = topic.trim().slice(0, 200)
  const queries = [
    `${t} 学习路线 入门`,
    `${t} 技术栈 主流框架`,
    `${t} 常见问题 踩坑`,
  ]
  const batches = await Promise.all(queries.map((q) => webSearch(env, q, 3)))
  const seen = new Set<string>()
  const out: WebSearchItem[] = []
  for (const hit of batches.flat()) {
    const key = hit.url.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= 8) break
  }
  return out
}

function unwrapAiResponse(res: unknown): string {
  if (typeof res === 'string') return res
  if (!res || typeof res !== 'object') return ''
  const r = (res as { response?: unknown }).response
  if (typeof r === 'string') return r
  // JSON Mode 可能直接返回对象
  if (r && typeof r === 'object') {
    try { return JSON.stringify(r) } catch { return '' }
  }
  return ''
}

// 调用聊天模型，返回文本
export async function chat(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens = 2000,
  model: string = CHAT_MODEL
): Promise<string> {
  // Workers AI 模型 id 随账号可用列表变化，此处按字符串传入
  const res = await env.AI.run(model as '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
  }) as unknown
  return unwrapAiResponse(res)
}

/**
 * 强制 JSON 对象输出（Workers AI JSON Mode）。
 * 失败时回退到普通 chat + extractJson。
 */
export async function chatJson(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens = 2000,
  model: string = CHAT_MODEL
): Promise<unknown | null> {
  try {
    const res = await env.AI.run(model as '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages,
      max_tokens: maxTokens,
      temperature: 0.15,
      response_format: { type: 'json_object' },
    }) as unknown
    if (res && typeof res === 'object') {
      const r = (res as { response?: unknown }).response
      if (r && typeof r === 'object') return r
      if (typeof r === 'string') {
        const parsed = extractJson(r)
        if (parsed) return parsed
      }
    }
    if (typeof res === 'string') return extractJson(res)
  } catch (e) {
    console.error('chatJson JSON Mode failed, fallback to text', e)
  }
  const raw = await chat(env, messages, maxTokens, model)
  return extractJson(raw)
}

/**
 * 调用聊天模型，返回流式纯文本（ReadableStream<Uint8Array>）。
 */
function enqueueSseResponseLine(
  line: string,
  enc: TextEncoder,
  controller: TransformStreamDefaultController<Uint8Array>
) {
  const t = line.trim()
  if (!t.startsWith('data:')) return
  const payload = t.slice(5).trim()
  if (!payload || payload === '[DONE]') return
  try {
    const parsed = JSON.parse(payload) as { response?: string }
    if (typeof parsed.response === 'string' && parsed.response) {
      controller.enqueue(enc.encode(parsed.response))
    }
  } catch {
    // 忽略无法解析的行
  }
}

export async function chatStream(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens = 2000,
  model: string = CHAT_MODEL
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res = (await env.AI.run(model as '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: true,
    })) as unknown

    const raw: ReadableStream<Uint8Array> | null =
      res instanceof ReadableStream
        ? (res as ReadableStream<Uint8Array>)
        : res && typeof res === 'object' && 'pipeThrough' in (res as object)
          ? (res as ReadableStream<Uint8Array>)
          : null
    if (!raw) return null

    const enc = new TextEncoder()
    const dec = new TextDecoder()
    let buffer = ''
    return raw.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += dec.decode(chunk, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) enqueueSseResponseLine(line, enc, controller)
        },
        // 末帧常无换行，不 flush 会丢掉最后一段 token → 整段 JSON/正文残缺
        flush(controller) {
          buffer += dec.decode()
          if (buffer.trim()) enqueueSseResponseLine(buffer, enc, controller)
          buffer = ''
        },
      })
    )
  } catch (e) {
    console.error('chatStream failed', e)
    return null
  }
}

/** SSE 行：data: {...}\n\n */
export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** 补全截断 JSON：闭合未结束字符串与括号 */
export function repairTruncatedJson(s: string): string {
  let inString = false
  let escape = false
  const stack: string[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if ((ch === '}' || ch === ']') && stack.length && stack[stack.length - 1] === ch) {
      stack.pop()
    }
  }
  let out = s
  if (inString) out += '"'
  out = out.replace(/,\s*$/, '')
  // 裸 key 后截断：`"foo":` → 补 null
  if (/:\s*$/.test(out)) out += 'null'
  while (stack.length) out += stack.pop()
  return out
}

// 从 LLM 文本中稳健地提取 JSON（去掉 ```json 围栏等）
export function extractJson(text: string): unknown | null {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  if (start === -1) return null
  const end = cleaned.lastIndexOf('}')
  const candidates = [
    end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start),
  ]
  // 若没有闭合 }，仍尝试修复截断体
  if (end <= start) candidates.push(cleaned.slice(start))

  for (const candidate of candidates) {
    const variants = [
      candidate,
      candidate.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']'),
      repairTruncatedJson(candidate.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']')),
    ]
    for (const v of variants) {
      try {
        return JSON.parse(v)
      } catch {
        /* try next */
      }
    }
  }
  return null
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s\-_/·.]+/g, '')
}

/**
 * 把任意来源的草稿规范化为可安全落库的结构。
 * allowedDomains 来自当前用户领域清单，与 prompt 白名单同源。
 */
export function sanitizeGraphDraft(
  raw: unknown,
  existingIds: Set<string> = new Set(),
  allowedDomains: string[] = domainIds(DEFAULT_DOMAIN_LIST),
  fallbackDomain: string = 'cs-basic'
): GraphDraft {
  return sanitizeGraphDraftWithMeta(raw, existingIds, allowedDomains, fallbackDomain).draft
}

export function sanitizeGraphDraftWithMeta(
  raw: unknown,
  existingIds: Set<string> = new Set(),
  allowedDomains: string[] = domainIds(DEFAULT_DOMAIN_LIST),
  fallbackDomain: string = 'cs-basic'
): SanitizeMeta {
  const allowed = new Set(allowedDomains.length ? allowedDomains : domainIds(DEFAULT_DOMAIN_LIST))
  const fb = allowed.has(fallbackDomain) ? fallbackDomain : [...allowed][0] ?? 'cs-basic'
  const input = (raw ?? {}) as { nodes?: unknown; edges?: unknown }
  const rawNodes = Array.isArray(input.nodes) ? input.nodes.slice(0, MAX_DRAFT_NODES) : []
  const rawEdges = Array.isArray(input.edges) ? input.edges.slice(0, MAX_DRAFT_EDGES) : []

  const used = new Set(existingIds)
  const idMap = new Map<string, string>()
  const remaps: { from: string; to: string }[] = []
  const seenOriginal = new Set<string>()
  const nodes: GraphDraft['nodes'] = []

  rawNodes.forEach((item, i) => {
    const n = (item ?? {}) as Record<string, unknown>
    const name = String(n.name ?? '').trim().slice(0, 60)
    if (!name) return
    const originalId = String(n.id ?? '').trim()
    const duplicated = !!originalId && seenOriginal.has(originalId)
    let base = slugify((duplicated ? '' : originalId) || name)
    if (!base) base = `node-${i + 1}`
    if (originalId) seenOriginal.add(originalId)
    let id = base
    let suffix = 2
    while (used.has(id)) id = `${base}-${suffix++}`
    used.add(id)
    if (originalId && originalId !== id) remaps.push({ from: originalId, to: id })
    else if (!originalId && base !== id) remaps.push({ from: base, to: id })
    for (const key of [originalId, base, id]) {
      if (key && !idMap.has(key)) idMap.set(key, id)
    }
    const level = Number(n.level)
    const domain = String(n.domain ?? '')
    nodes.push({
      id,
      name,
      domain: allowed.has(domain) ? domain : fb,
      level: [1, 2, 3].includes(level) ? level : 1,
      tags: Array.isArray(n.tags)
        ? n.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
        : [],
    })
  })

  const newIds = new Set(nodes.map((n) => n.id))
  const remap = (rawId: string): string => {
    const mapped = idMap.get(rawId)
    if (mapped) return mapped
    if (newIds.has(rawId)) return rawId
    // 允许边挂接到已有节点（扩展锚定 / 落库时保留桥接边）
    if (existingIds.has(rawId)) return rawId
    return ''
  }
  const seen = new Set<string>()
  const edges: GraphDraft['edges'] = []
  for (const item of rawEdges) {
    const e = (item ?? {}) as Record<string, unknown>
    const source = remap(String(e.source ?? '').trim())
    const target = remap(String(e.target ?? '').trim())
    if (!source || !target || source === target) continue
    const key = `${source}|${target}`
    if (seen.has(key)) continue
    seen.add(key)
    const t = String(e.type ?? '')
    edges.push({
      source,
      target,
      type: (['prerequisite', 'related', 'extend'].includes(t) ? t : 'related') as GraphDraft['edges'][number]['type'],
    })
  }
  return { draft: { nodes, edges }, remaps }
}

/** 将局部 ops 应用到草稿后，再 sanitize */
export function applyDraftOps(
  draft: GraphDraft,
  ops: DraftOp[],
  existingIds: Set<string> = new Set(),
  allowedDomains: string[] = domainIds(DEFAULT_DOMAIN_LIST),
  fallbackDomain = 'cs-basic'
): GraphDraft {
  let nodes = [...draft.nodes]
  let edges = [...draft.edges]
  for (const op of ops.slice(0, 40)) {
    if (!op || typeof op !== 'object') continue
    if (op.op === 'add_node' && op.node) {
      nodes.push(op.node as GraphDraft['nodes'][number])
    } else if (op.op === 'remove_node' && op.id) {
      nodes = nodes.filter((n) => n.id !== op.id)
      edges = edges.filter((e) => e.source !== op.id && e.target !== op.id)
    } else if (op.op === 'update_node' && op.id && op.patch) {
      nodes = nodes.map((n) => (n.id === op.id ? { ...n, ...op.patch, id: n.id } : n))
    } else if (op.op === 'add_edge' && op.edge) {
      edges.push(op.edge as GraphDraft['edges'][number])
    } else if (op.op === 'remove_edge' && op.source && op.target) {
      edges = edges.filter((e) => !(e.source === op.source && e.target === op.target))
    }
  }
  return sanitizeGraphDraft({ nodes, edges }, existingIds, allowedDomains, fallbackDomain)
}

/** 名称相近的已有节点 → related 挂接边建议 */
export function suggestLinksToExisting(
  draft: GraphDraft,
  existing: { id: string; name: string }[]
): GraphDraft['edges'] {
  const links: GraphDraft['edges'] = []
  const seen = new Set<string>()
  for (const n of draft.nodes) {
    const nn = normalizeName(n.name)
    if (!nn) continue
    for (const ex of existing) {
      const en = normalizeName(ex.name)
      if (!en) continue
      const similar = nn === en || nn.includes(en) || en.includes(nn)
      if (!similar) continue
      const key = `${ex.id}|${n.id}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ source: ex.id, target: n.id, type: 'related' })
      break
    }
  }
  return links.slice(0, 20)
}

/** 确认前冲突预览：重命名、名称相似 */
export function previewDraftConflicts(
  draft: GraphDraft,
  existing: { id: string; name: string }[],
  remaps: { from: string; to: string }[] = []
): {
  willCreate: { id: string; name: string }[]
  remapped: { from: string; to: string }[]
  nameSimilar: { draftId: string; draftName: string; existingId: string; existingName: string }[]
} {
  const existingIds = new Set(existing.map((e) => e.id))
  const nameSimilar: {
    draftId: string
    draftName: string
    existingId: string
    existingName: string
  }[] = []
  for (const n of draft.nodes) {
    const nn = normalizeName(n.name)
    for (const ex of existing) {
      const en = normalizeName(ex.name)
      if (!nn || !en) continue
      if (nn === en || (nn.length > 2 && (nn.includes(en) || en.includes(nn)))) {
        nameSimilar.push({
          draftId: n.id,
          draftName: n.name,
          existingId: ex.id,
          existingName: ex.name,
        })
        break
      }
    }
  }
  return {
    willCreate: draft.nodes.filter((n) => !existingIds.has(n.id)).map((n) => ({ id: n.id, name: n.name })),
    remapped: remaps.filter((r) => r.from !== r.to),
    nameSimilar,
  }
}

/** 按 prerequisite 拓扑序生成路线步骤 */
export function draftToRoadmapSteps(draft: GraphDraft): { node_id: string; seq: number }[] {
  const ids = draft.nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) {
    adj.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of draft.edges) {
    if (e.type !== 'prerequisite') continue
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const cur = queue.shift()!
    order.push(cur)
    for (const next of adj.get(cur) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  const ordered = new Set(order)
  for (const id of ids) if (!ordered.has(id)) order.push(id)
  return order.map((node_id, i) => ({ node_id, seq: i + 1 }))
}

function draftCacheKey(uid: string, topic: string, anchorId?: string): string {
  const t = topic.trim().toLowerCase().slice(0, 120)
  const a = (anchorId ?? '').trim().slice(0, 64)
  return a ? `agent:draft:${uid}:${a}:${t}` : `agent:draft:${uid}:${t}`
}

export function formatAnchorHint(anchor?: GraphDraftAnchor | null): string {
  if (!anchor?.nodeId || !anchor.nodeName) return ''
  const domainLine = anchor.domain ? `\n- 锚定领域：${anchor.domain}` : ''
  if (anchor.mode === 'extend') {
    return `
【硬约束 · 扩展已有节点】
- 用户已选中节点：id=\`${anchor.nodeId}\`，名称「${anchor.nodeName}」${domainLine}
- 本次草稿是该节点的下游扩展，不要重复生成同名节点
- 至少一个新节点通过 extend 或 prerequisite 边与「概念锚点」关联；可用 id=\`${anchor.nodeId}\` 作为边的一端（即使它不在 nodes 列表里，确认落库时会挂接）
- 新节点 domain 优先与锚定领域一致（除非主题明显跨领域）
`
  }
  return `
【上下文锚定】
- 用户当前关注节点：id=\`${anchor.nodeId}\`，名称「${anchor.nodeName}」${domainLine}
- 规划时尽量围绕该节点补齐前置 / 后续知识点
`
}

async function chatJsonWithRetry(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens: number,
  model: string = CHAT_MODEL
): Promise<unknown | null> {
  // 优先 JSON Mode（修订/建图对结构敏感）
  const first = await chatJson(env, messages, maxTokens, model)
  if (first) return first

  const raw = await chat(env, messages, maxTokens, model)
  const parsed = extractJson(raw)
  if (parsed) return parsed
  if (!raw.trim()) {
    console.error('chatJsonWithRetry: empty model response')
    return null
  }
  const retryMsgs = [
    ...messages,
    { role: 'assistant', content: raw.slice(0, 2000) },
    {
      role: 'user',
      content: '上一次输出不是合法 JSON。请只输出严格合法的 JSON 对象，不要 markdown 围栏，不要解释。',
    },
  ]
  // 重试仍走 JSON Mode
  const retry = await chatJson(env, retryMsgs, maxTokens, model)
  if (retry) return retry
  const retryRaw = await chat(env, retryMsgs, maxTokens, model)
  return extractJson(retryRaw)
}

/** 压缩草稿进 prompt，降低多轮修订时输出截断概率 */
export function compactDraftForPrompt(draft: GraphDraft): string {
  const nodes = draft.nodes.slice(0, MAX_DRAFT_NODES).map((n) => ({
    id: n.id,
    name: n.name,
    domain: n.domain,
    level: n.level,
    tags: (n.tags ?? []).slice(0, 4),
  }))
  const edges = draft.edges.slice(0, MAX_DRAFT_EDGES).map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type,
  }))
  return JSON.stringify({ nodes, edges })
}

function parseRevisePayload(
  parsed: unknown,
  draft: GraphDraft,
  keepIds: Set<string>,
  allowed: string[],
  fb: string
): GraphDraft | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as { ops?: unknown; nodes?: unknown; edges?: unknown }
  if (Array.isArray(p.ops) && p.ops.length) {
    const next = applyDraftOps(draft, p.ops as DraftOp[], keepIds, allowed, fb)
    return next.nodes.length ? next : null
  }
  if (p.nodes) {
    const next = sanitizeGraphDraft({ nodes: p.nodes, edges: p.edges }, keepIds, allowed, fb)
    return next.nodes.length ? next : null
  }
  return null
}

/**
 * 根据一句话主题，联网搜索并生成知识图谱草稿（不落库）。
 */
export async function buildGraphDraft(
  env: EnvWithSearch,
  topic: string,
  existingNames: string[] = [],
  domains: DomainInfo[] = DEFAULT_DOMAIN_LIST,
  opts: {
    uid?: string
    skipCache?: boolean
    onPhase?: (phase: 'searching' | 'generating') => void
    anchor?: GraphDraftAnchor | null
    memoryBlock?: string
  } = {}
): Promise<GraphDraftResult> {
  const domainList = domains.length ? domains : DEFAULT_DOMAIN_LIST
  const allowed = domainIds(domainList)
  const fb = fallbackDomainId(domainList)
  const configured = isSearchConfigured(env)
  const anchor = opts.anchor?.nodeId && opts.anchor.nodeName ? opts.anchor : null
  const isExtend = anchor?.mode === 'extend'
  const cacheTopic = anchor ? `${anchor.nodeId}|${topic}` : topic

  if (opts.uid && env.STATS_KV && !opts.skipCache) {
    try {
      const cached = await env.STATS_KV.get(
        draftCacheKey(opts.uid, topic, anchor?.nodeId),
        'json'
      ) as GraphDraftResult | null
      if (cached?.draft?.nodes?.length) {
        return {
          ...cached,
          draft: sanitizeGraphDraft(cached.draft, new Set(), allowed, fb),
          searchConfigured: configured,
        }
      }
    } catch {
      // 缓存失败不影响主流程
    }
  }

  opts.onPhase?.('searching')
  const searchHits = await webSearchTopic(env, cacheTopic)
  opts.onPhase?.('generating')
  const searchText = searchHits
    .slice(0, 8)
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.description ?? ''}\n   ${it.url}`)
    .join('\n')

  const existingHint = existingNames.length
    ? `\n用户图谱中已有的知识点（请避免重复；若确需深化，请使用更具体的名称）：\n${existingNames.slice(0, 80).map((n) => `- ${n}`).join('\n')}\n`
    : ''

  const offlineHint = configured
    ? ''
    : '\n注意：当前未配置联网搜索，请基于通用知识规划，并在内容上偏保守。\n'

  const nodeCountHint = isExtend
    ? '拆解出 4~8 个紧贴锚定节点的下游知识点'
    : '拆解出 6~12 个核心知识点作为节点，覆盖从入门到进阶的完整学习路径'

  const edgeHint = isExtend
    ? `节点之间用边连接：prerequisite / related / extend。至少一半新节点应通过边连接到锚定节点 id=\`${anchor!.nodeId}\`（允许边的一端是该已有 id）。`
    : '节点之间用边连接：prerequisite（前置）、related（相关）、extend（扩展）。必须至少有一条完整的 prerequisite 依赖链（覆盖半数以上节点），不要全是 related。边的端点必须是本次 nodes 里的 id。'

  const memoryHint = opts.memoryBlock?.trim()
    ? `\n${opts.memoryBlock.trim()}\n请在规划时遵守上述长期偏好。\n`
    : ''

  const prompt = `你是一名学习路线规划专家。请根据主题「${topic}」构建一份待用户确认的知识图谱草稿。
${offlineHint}
${formatAnchorHint(anchor)}
${memoryHint}
${searchText ? `以下是联网搜索到的相关背景信息，供你参考：\n${searchText}\n` : ''}
${existingHint}
要求：
1. ${nodeCountHint}。
2. 每个节点包含：id（英文或拼音 slug）、name（中文名）、domain（领域，从下面清单选最匹配的一个）、level（1入门/2进阶/3高级）、tags（标签数组）。
3. 领域清单（只能选其一）：
${formatDomainPrompt(domainList)}
4. ${edgeHint}
5. 领域是学科粗分类，交叉方向用 tags 表达，不要发明新领域。
${isExtend ? `6. 不要把锚定节点「${anchor!.nodeName}」再次放进 nodes；只输出新增节点。` : ''}

只输出 JSON，不要任何解释，格式如下：
{"nodes":[{"id":"...","name":"...","domain":"...","level":1,"tags":["..."]}],"edges":[{"source":"...","target":"...","type":"prerequisite"}]}`

  const parsed = await chatJsonWithRetry(env, [{ role: 'user', content: prompt }], 4000, CHAT_MODEL)
  // 扩展模式允许边挂到锚定已有节点 id
  const keepIds = isExtend && anchor ? new Set([anchor.nodeId]) : new Set<string>()
  const draft = sanitizeGraphDraft(parsed, keepIds, allowed, fb)
  if (!draft.nodes.length) throw new Error('模型未能生成有效的图谱结构')

  const result: GraphDraftResult = {
    draft,
    reply: isExtend && anchor
      ? `已围绕「${anchor.nodeName}」生成 ${draft.nodes.length} 个扩展知识点、${draft.edges.length} 条关系。先预览，再告诉我怎么改。`
      : `已生成 ${draft.nodes.length} 个知识点、${draft.edges.length} 条依赖关系。先看看预览，不满意就直接告诉我怎么改。`,
    sources: searchHits,
    searchConfigured: configured,
    intent: 'build',
  }

  if (opts.uid && env.STATS_KV) {
    try {
      await env.STATS_KV.put(draftCacheKey(opts.uid, topic, anchor?.nodeId), JSON.stringify(result), {
        expirationTtl: DRAFT_CACHE_TTL,
      })
    } catch {
      // ignore
    }
  }
  return result
}

/**
 * 多轮对话修订：优先产出 ops 局部合并；失败则回退整图重写。
 * hints 注入长期偏好与对话摘录，替代旧的 summarizeIntent 薄摘要。
 */
export async function reviseGraphDraft(
  env: EnvWithSearch,
  draft: GraphDraft,
  messages: ChatTurn[],
  existingNames: string[] = [],
  domains: DomainInfo[] = DEFAULT_DOMAIN_LIST,
  anchor?: GraphDraftAnchor | null,
  hints?: ReviseTurnHints | null
): Promise<GraphDraftResult> {
  const domainList = domains.length ? domains : DEFAULT_DOMAIN_LIST
  const allowed = domainIds(domainList)
  const fb = fallbackDomainId(domainList)
  const lastUser = hints?.forcedInstruction?.trim()
    || [...messages].reverse().find((m) => m.role === 'user')?.content
    || ''
  const historyExcerpt = hints?.historyExcerpt?.trim()
    || messages.slice(-6).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 200)}`).join('\n')
  const memoryBlock = hints?.memoryBlock?.trim() || ''
  const keepIds = anchor?.mode === 'extend' && anchor.nodeId
    ? new Set([anchor.nodeId])
    : new Set<string>()
  const draftJson = compactDraftForPrompt(draft)
  const namesHint = existingNames.length
    ? existingNames.slice(0, 40).join('、')
    : '（无）'
  const edgeHint = keepIds.size
    ? `；允许挂接到锚定已有节点 id=\`${anchor!.nodeId}\``
    : ''

  const system = '你是学习路线规划专家。只输出一个 JSON 对象，不要 markdown，不要解释。'
  const contextBlock = [
    memoryBlock,
    historyExcerpt ? `【最近对话摘录】\n${historyExcerpt}` : '',
    `【最新改稿指令】\n${lastUser.slice(0, 1000)}`,
  ].filter(Boolean).join('\n\n')

  // 第一轮：优先局部 ops（输出短，不易截断）
  const opsPrompt = `按用户意见修订知识图谱草稿。优先输出局部 ops；改动很大时再给完整 nodes+edges。

【当前草稿】
${draftJson}

【已有知识点（避免重复）】${namesHint}
${formatAnchorHint(anchor)}
${contextBlock}

要求：
1. domain 只能是：${allowed.join(' / ')}
2. 边类型：prerequisite / related / extend；端点优先草稿节点 id${edgeHint}
3. 遵守用户长期偏好与会话偏好
4. reply 一句中文简述改动
5. JSON 二选一：
{"reply":"...","ops":[{"op":"add_node","node":{"id":"...","name":"...","domain":"...","level":1,"tags":[]}}]}
{"reply":"...","nodes":[...],"edges":[{"source":"...","target":"...","type":"prerequisite"}]}`

  let parsed = await chatJsonWithRetry(env, [
    { role: 'system', content: system },
    { role: 'user', content: opsPrompt },
  ], 3500, CHAT_MODEL) as { reply?: unknown } | null

  let next = parseRevisePayload(parsed, draft, keepIds, allowed, fb)

  // 回退：强制整图重写（仍用压缩草稿）
  if (!next) {
    console.error('reviseGraphDraft: ops/parse failed, fallback to full rewrite', {
      hasParsed: !!parsed,
      instruction: lastUser.slice(0, 120),
    })
    const rewritePrompt = `用户要求修改学习图谱。请输出修订后的完整图谱 JSON（不要 ops）。

【当前草稿】
${draftJson}

${contextBlock}
${formatAnchorHint(anchor)}

要求：
1. 保留仍合理的节点，按意见增删改
2. domain 只能是：${allowed.join(' / ')}
3. 边类型 prerequisite/related/extend；端点须有效${edgeHint}
4. 遵守用户长期偏好
5. 输出：{"reply":"一句中文","nodes":[{"id":"...","name":"...","domain":"...","level":1,"tags":[]}],"edges":[{"source":"...","target":"...","type":"prerequisite"}]}`

    parsed = await chatJsonWithRetry(env, [
      { role: 'system', content: system },
      { role: 'user', content: rewritePrompt },
    ], 4000, CHAT_MODEL) as { reply?: unknown } | null
    next = parseRevisePayload(parsed, draft, keepIds, allowed, fb)
  }

  if (!next) {
    throw new Error('模型未能生成有效的修订草稿，请换一种说法再试')
  }
  const reply = String((parsed as { reply?: unknown } | null)?.reply ?? '').trim().slice(0, 300)
    || `已按「${lastUser.slice(0, 40)}」更新图谱草稿`
  return {
    draft: next,
    reply,
    searchConfigured: isSearchConfigured(env),
    intent: 'revise',
  }
}

/** 从不完整 / 非法 JSON 中尽量抽出字符串字段（模型常在 content 里写裸换行） */
export function extractPartialJsonString(acc: string, field: string): string {
  const key = `"${field}"`
  const keyIdx = acc.indexOf(key)
  if (keyIdx === -1) return ''
  const afterKey = acc.slice(keyIdx + key.length)
  const colon = afterKey.match(/^\s*:\s*/)
  if (!colon) return ''
  let i = colon[0].length
  if (afterKey[i] !== '"') return ''
  i += 1
  let out = ''
  while (i < afterKey.length) {
    const ch = afterKey[i]
    if (ch === '\\' && i + 1 < afterKey.length) {
      const next = afterKey[i + 1]
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === '"' || next === '\\' || next === '/') out += next
      else out += next
      i += 2
      continue
    }
    if (ch === '"') break
    out += ch
    i += 1
  }
  return out
}

function parseLessonMarkers(
  raw: string,
  nodeName: string
): { title: string; content: string; code: string } | null {
  const titleStart = raw.indexOf('【标题】')
  const contentStart = raw.indexOf('【正文】')
  const codeStart = raw.indexOf('【代码】')
  if (contentStart === -1) return null
  const title =
    titleStart !== -1 && titleStart < contentStart
      ? raw.slice(titleStart + 4, contentStart).trim()
      : nodeName
  const content = raw
    .slice(contentStart + 4, codeStart > contentStart ? codeStart : undefined)
    .trim()
  if (!content) return null
  const code = codeStart !== -1 ? raw.slice(codeStart + 4).trim() : ''
  return { title: title || nodeName, content, code }
}

/** 解析教材 LLM 输出：标记格式优先，其次合法 JSON，再兜底残缺 JSON 字段 */
export function parseLessonPayload(
  raw: string,
  nodeName: string
): { title: string; content: string; code: string } | null {
  const byMarker = parseLessonMarkers(raw, nodeName)
  if (byMarker) return byMarker

  const json = extractJson(raw) as { title?: unknown; content?: unknown; code?: unknown } | null
  if (json && (json.content || json.title)) {
    const content = String(json.content ?? '').trim()
    if (content) {
      return {
        title: String(json.title ?? nodeName).trim() || nodeName,
        content,
        code: String(json.code ?? '').trim(),
      }
    }
  }

  // JSON.parse 失败（裸换行 / 截断）时仍尽量抽出字段
  const content = extractPartialJsonString(raw, 'content').trim()
  if (!content) return null
  const title = extractPartialJsonString(raw, 'title').trim() || nodeName
  const code = extractPartialJsonString(raw, 'code').trim()
  return { title, content, code }
}

/**
 * 根据单个节点的知识点，联网查询并总结为教材小节。
 */
export async function generateNodeLesson(
  env: EnvWithSearch,
  node: { name: string; domain: string; level: number },
  detailed = false
): Promise<{ title: string; content: string; code: string; source_urls: string[] }> {
  const hits = await webSearch(env, node.name, detailed ? 6 : 4)
  const searchText = hits
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.description ?? ''}\n   来源: ${it.url}`)
    .join('\n')
  const sourceUrls = hits.map((it) => it.url)

  const isTech = isTechDomain(node.domain)
  const prompt = buildLessonPrompt(node, detailed, isTech, searchText)

  const raw = await chat(env, [{ role: 'user', content: prompt }], detailed ? 5000 : 3000, CHAT_MODEL)
  const first = parseLessonPayload(raw, node.name)
  let parsed = first
  if (!parsed) {
    const retry = await chat(env, [
      { role: 'user', content: prompt },
      { role: 'assistant', content: raw.slice(0, 1500) },
      {
        role: 'user',
        content:
          '请改为只输出标记格式（不要 JSON、不要围栏）：\n【标题】\n标题\n【正文】\n正文 markdown\n【代码】\n代码或留空',
      },
    ], detailed ? 5000 : 3000, CHAT_MODEL)
    parsed = parseLessonPayload(retry, node.name)
  }
  if (!parsed) {
    console.error('generateNodeLesson parse failed, raw:', JSON.stringify(raw).slice(0, 600))
    throw new Error('教材生成失败')
  }

  return { ...parsed, source_urls: sourceUrls }
}

function buildLessonPrompt(
  node: { name: string; domain: string; level: number },
  detailed: boolean,
  isTech: boolean,
  searchText: string
): string {
  return `你是资深技术讲师，请针对知识点「${node.name}」（领域：${node.domain}，难度：${node.level === 1 ? '入门' : node.level === 2 ? '进阶' : '高级'}）编写一份${detailed ? '详尽深入的' : ''}教材小节。

${searchText ? `联网搜索到的参考资料：\n${searchText}\n` : ''}

要求：
1. 用中文，通俗易懂，结构清晰（可用标题、列表）。
2. 正文内容：核心概念、原理、要点、常见误区，${node.level === 1 ? '面向零基础，循序渐进' : '面向有一定基础的读者，突出重点难点'}。
${detailed ? '3. 这是「重新构建」模式，请比常规版本更深入细致：补充背景与演进、关键原理剖析、实践建议、常见问题与排查思路、进阶延伸。\n' : ''}
${detailed ? '' : '3. '}${isTech ? '这是技术类知识点，请在【代码】中提供简单 demo 代码（附注释）。' : '这是非技术类知识点，【代码】段留空即可。'}
${detailed && isTech ? '代码段可含多个关键片段，覆盖主要用法。' : ''}

只输出以下标记格式（不要 JSON、不要其它说明、不要用 markdown 代码围栏包住整篇）：
【标题】
教材标题
【正文】
正文 markdown
【代码】
${isTech ? 'demo 代码；没有则留空' : '（留空）'}`
}

/**
 * 流式生成教材：返回纯文本流；前端可累积后 parse，或实时展示。
 */
export async function generateNodeLessonStream(
  env: EnvWithSearch,
  node: { name: string; domain: string; level: number },
  detailed = false
): Promise<{ stream: ReadableStream<Uint8Array>; sourceUrls: string[] } | null> {
  const hits = await webSearch(env, node.name, detailed ? 6 : 4)
  const searchText = hits
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.description ?? ''}\n   来源: ${it.url}`)
    .join('\n')
  const sourceUrls = hits.map((it) => it.url)

  const isTech = isTechDomain(node.domain)
  const prompt = buildLessonPrompt(node, detailed, isTech, searchText)

  const rawStream = await chatStream(env, [{ role: 'user', content: prompt }], detailed ? 5000 : 3000, CHAT_MODEL)
  if (!rawStream) return null
  return { stream: rawStream, sourceUrls }
}

/**
 * 根据节点名称 + 标签，由 LLM 判断其所属领域。
 */
export async function classifyDomain(
  env: EnvWithSearch,
  name: string,
  tags: string[],
  domains: DomainInfo[] = DEFAULT_DOMAIN_LIST
): Promise<string> {
  const domainList = domains.length ? domains : DEFAULT_DOMAIN_LIST
  const allowed = domainIds(domainList)
  const fb = fallbackDomainId(domainList)
  const prompt = `请判断下面这个知识点属于哪个领域。

知识点名称：${name}
标签：${tags.length ? tags.join('、') : '（无）'}

领域清单（只能选其一）：
${domainList.map((d) => `- ${d.id}：${d.name}`).join('\n')}

只输出一个领域 id，不要任何解释。`

  try {
    const raw = await chat(env, [{ role: 'user', content: prompt }], 50, FAST_MODEL)
    const cleaned = raw.trim().toLowerCase()
    const matched = allowed.find((d) => cleaned === d || cleaned.includes(d))
    return matched ?? fb
  } catch {
    return fb
  }
}
