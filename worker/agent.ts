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
// 一轮对话的产物：修订后的完整草稿 + 给用户的自然语言说明
export type GraphDraftResult = {
  draft: GraphDraft
  reply: string
  sources?: WebSearchItem[]
  searchConfigured?: boolean
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
export const FAST_MODEL = '@cf/meta/llama-3.1-8b-instruct'

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
  if (typeof res === 'string') return res
  if (res && typeof res === 'object' && typeof (res as { response?: unknown }).response === 'string') {
    return (res as { response: string }).response
  }
  return ''
}

/**
 * 调用聊天模型，返回流式纯文本（ReadableStream<Uint8Array>）。
 */
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
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const payload = t.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const parsed = JSON.parse(payload) as { response?: string }
              if (typeof parsed.response === 'string' && parsed.response) {
                controller.enqueue(enc.encode(parsed.response))
              }
            } catch {
              // 忽略无法解析的行
            }
          }
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

// 从 LLM 文本中稳健地提取 JSON（去掉 ```json 围栏等）
export function extractJson(text: string): unknown | null {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    try {
      const fixed = candidate
        .replace(/,\s*}/g, '}')
        .replace(/,\s*\]/g, ']')
      return JSON.parse(fixed)
    } catch {
      return null
    }
  }
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

function draftCacheKey(uid: string, topic: string): string {
  const t = topic.trim().toLowerCase().slice(0, 120)
  return `agent:draft:${uid}:${t}`
}

async function chatJsonWithRetry(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens: number,
  model: string = CHAT_MODEL
): Promise<unknown | null> {
  const raw = await chat(env, messages, maxTokens, model)
  const parsed = extractJson(raw)
  if (parsed) return parsed
  const retryMsgs = [
    ...messages,
    { role: 'assistant', content: raw.slice(0, 2000) },
    {
      role: 'user',
      content: '上一次输出不是合法 JSON。请只输出严格合法的 JSON 对象，不要 markdown 围栏，不要解释。',
    },
  ]
  const retryRaw = await chat(env, retryMsgs, maxTokens, model)
  return extractJson(retryRaw)
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
  } = {}
): Promise<GraphDraftResult> {
  const domainList = domains.length ? domains : DEFAULT_DOMAIN_LIST
  const allowed = domainIds(domainList)
  const fb = fallbackDomainId(domainList)
  const configured = isSearchConfigured(env)

  if (opts.uid && env.STATS_KV && !opts.skipCache) {
    try {
      const cached = await env.STATS_KV.get(draftCacheKey(opts.uid, topic), 'json') as GraphDraftResult | null
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
  const searchHits = await webSearchTopic(env, topic)
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

  const prompt = `你是一名学习路线规划专家。请根据主题「${topic}」构建一份待用户确认的知识图谱草稿。
${offlineHint}
${searchText ? `以下是联网搜索到的相关背景信息，供你参考：\n${searchText}\n` : ''}
${existingHint}
要求：
1. 拆解出 6~12 个核心知识点作为节点，覆盖从入门到进阶的完整学习路径。
2. 每个节点包含：id（英文或拼音 slug）、name（中文名）、domain（领域，从下面清单选最匹配的一个）、level（1入门/2进阶/3高级）、tags（标签数组）。
3. 领域清单（只能选其一）：
${formatDomainPrompt(domainList)}
4. 节点之间用边连接：prerequisite（前置）、related（相关）、extend（扩展）。
5. 必须至少有一条完整的 prerequisite 依赖链（覆盖半数以上节点），不要全是 related。
6. 边的端点必须是本次 nodes 里的 id。
7. 领域是学科粗分类，交叉方向用 tags 表达，不要发明新领域。

只输出 JSON，不要任何解释，格式如下：
{"nodes":[{"id":"...","name":"...","domain":"...","level":1,"tags":["..."]}],"edges":[{"source":"...","target":"...","type":"prerequisite"}]}`

  const parsed = await chatJsonWithRetry(env, [{ role: 'user', content: prompt }], 4000, CHAT_MODEL)
  const draft = sanitizeGraphDraft(parsed, new Set(), allowed, fb)
  if (!draft.nodes.length) throw new Error('模型未能生成有效的图谱结构')

  const result: GraphDraftResult = {
    draft,
    reply: `已生成 ${draft.nodes.length} 个知识点、${draft.edges.length} 条依赖关系。先看看预览，不满意就直接告诉我怎么改。`,
    sources: searchHits,
    searchConfigured: configured,
  }

  if (opts.uid && env.STATS_KV) {
    try {
      await env.STATS_KV.put(draftCacheKey(opts.uid, topic), JSON.stringify(result), {
        expirationTtl: DRAFT_CACHE_TTL,
      })
    } catch {
      // ignore
    }
  }
  return result
}

function summarizeIntent(messages: ChatTurn[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const prev = messages
    .filter((m) => m.role === 'user')
    .slice(-3, -1)
    .map((m) => m.content.slice(0, 80))
  return [
    prev.length ? `此前用户诉求摘要：${prev.join('；')}` : '',
    `最新意见：${lastUser.slice(0, 1000)}`,
  ].filter(Boolean).join('\n')
}

/**
 * 多轮对话修订：优先产出 ops 局部合并；失败则回退整图重写。
 */
export async function reviseGraphDraft(
  env: EnvWithSearch,
  draft: GraphDraft,
  messages: ChatTurn[],
  existingNames: string[] = [],
  domains: DomainInfo[] = DEFAULT_DOMAIN_LIST
): Promise<GraphDraftResult> {
  const domainList = domains.length ? domains : DEFAULT_DOMAIN_LIST
  const allowed = domainIds(domainList)
  const fb = fallbackDomainId(domainList)
  const intent = summarizeIntent(messages)
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  const prompt = `你是学习路线规划专家，正在与用户共同敲定一份知识图谱草稿。

【当前草稿（JSON）】
${JSON.stringify(draft)}

【用户图谱已有知识点（避免重复）】
${existingNames.length ? existingNames.slice(0, 80).join('、') : '（无）'}

【变更意图】
${intent}

请按用户最新意见修订。优先输出局部操作 ops（add_node / remove_node / update_node / add_edge / remove_edge）；
若改动过大也可直接给完整 nodes + edges。
要求：
1. domain 只能是：${allowed.join(' / ')}
2. 边类型：prerequisite / related / extend；端点必须是草稿节点 id
3. reply 用一句中文简述本次改动
4. 只输出 JSON，格式之一：
{"reply":"...","ops":[{"op":"add_node","node":{...}}]}
或
{"reply":"...","nodes":[...],"edges":[...]}`

  const parsed = await chatJsonWithRetry(env, [
    { role: 'system', content: '你是学习路线规划专家，只输出严格合法的 JSON，不要任何解释文字。' },
    { role: 'user', content: prompt },
  ], 4000, CHAT_MODEL) as {
    reply?: unknown
    ops?: unknown
    nodes?: unknown
    edges?: unknown
  } | null

  if (!parsed) throw new Error('模型未能生成有效的修订草稿，请换一种说法再试')

  let next: GraphDraft
  if (Array.isArray(parsed.ops) && parsed.ops.length) {
    next = applyDraftOps(draft, parsed.ops as DraftOp[], new Set(), allowed, fb)
  } else if (parsed.nodes) {
    next = sanitizeGraphDraft({ nodes: parsed.nodes, edges: parsed.edges }, new Set(), allowed, fb)
  } else {
    throw new Error('修订结果缺少 ops 或 nodes，请重新描述你的需求')
  }
  if (!next.nodes.length) throw new Error('修订后的草稿为空，请重新描述你的需求')
  const reply = String(parsed.reply ?? '').trim().slice(0, 300)
    || `已按「${lastUser.slice(0, 40)}」更新图谱草稿`
  return { draft: next, reply, searchConfigured: isSearchConfigured(env) }
}

function parseLessonPayload(
  raw: string,
  nodeName: string
): { title: string; content: string; code: string } | null {
  const json = extractJson(raw) as { title?: unknown; content?: unknown; code?: unknown } | null
  if (json && (json.content || json.title)) {
    const content = String(json.content ?? '').trim()
    if (!content) return null
    return {
      title: String(json.title ?? nodeName).trim() || nodeName,
      content,
      code: String(json.code ?? '').trim(),
    }
  }
  // 兼容旧分隔标记格式
  const titleMatch = raw.match(/【标题】\s*([\s\S]*?)【正文】/)
  const contentMatch = raw.match(/【正文】\s*([\s\S]*?)【代码】/)
  const codeMatch = raw.match(/【代码】\s*([\s\S]*)$/)
  const content = (contentMatch?.[1] ?? '').trim()
  if (!content) return null
  return {
    title: (titleMatch?.[1] ?? nodeName).trim() || nodeName,
    content,
    code: (codeMatch?.[1] ?? '').trim(),
  }
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
      { role: 'user', content: '请改为只输出 JSON：{"title":"...","content":"markdown","code":"..."}' },
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
${detailed ? '' : '3. '}${isTech ? '这是技术类知识点，请在 code 中提供简单 demo 代码（附注释）。' : '这是非技术类知识点，code 留空字符串。'}
${detailed && isTech ? 'code 可含多个关键片段，覆盖主要用法。' : ''}

只输出 JSON（不要 markdown 围栏）：
{"title":"教材标题","content":"正文 markdown","code":"${isTech ? 'demo 代码或空字符串' : ''}"}`
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
