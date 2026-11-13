// AI 智能功能：联网搜索、一句话构建图谱、知识库教材生成
// 联网搜索使用 Tavily Search API（REST 调用），图谱构建/教材生成用 Workers AI 开源模型

export type WebSearchItem = { url: string; title: string; description?: string }

// 对话构建图谱时 LLM 返回的结构
export type GraphDraft = {
  nodes: { id: string; name: string; domain: string; level: number; tags: string[] }[]
  edges: { source: string; target: string; type: 'prerequisite' | 'related' | 'extend' }[]
}

// 多轮对话消息：会话历史由前端持有，后端保持无状态
export type ChatTurn = { role: 'user' | 'assistant'; content: string }
// 一轮对话的产物：修订后的完整草稿 + 给用户的自然语言说明
export type GraphDraftResult = { draft: GraphDraft; reply: string }

const MAX_DRAFT_NODES = 30
const MAX_DRAFT_EDGES = 100

// 领域清单（与 domains 表保持一致；此处为兜底默认，构建图谱时优先读 DB）
const DOMAINS = ['ai-ml', 'backend', 'frontend', 'data', 'devops', 'cs-basic', 'security', 'product'] as const

// 领域中文名映射（供提示词与分类兜底）
const DOMAIN_NAMES: Record<string, string> = {
  'ai-ml': 'AI / 机器学习',
  backend: '后端开发',
  frontend: '前端开发',
  data: '数据与数据库',
  devops: '工程与运维',
  'cs-basic': '计算机基础',
  security: '安全',
  product: '产品与软技能',
}

// 用于图谱构建/教材生成的主模型（Workers AI 开源模型）
export const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export type EnvWithSearch = {
  AI: Ai
  TAVILY_API_KEY?: string
}

// Tavily Search API 返回结果项
type TavilyResult = {
  url: string
  title: string
  content?: string
  score?: number
  raw_content?: string | null
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

// 调用聊天模型，返回文本
export async function chat(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens = 2000
): Promise<string> {
  const res = await env.AI.run(CHAT_MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
  }) as unknown
  // 兼容不同返回结构：对象 { response } 或直接字符串
  if (typeof res === 'string') return res
  if (res && typeof res === 'object' && typeof (res as { response?: unknown }).response === 'string') {
    return (res as { response: string }).response
  }
  return ''
}

/**
 * 调用聊天模型，返回流式纯文本（ReadableStream<Uint8Array>）。
 * Workers AI 的 stream: true 返回的是 SSE 字节流（data: {"response":"..."}），
 * 这里解析并转换为纯文本增量输出，供上层直接累积。
 */
export async function chatStream(
  env: EnvWithSearch,
  messages: { role: string; content: string }[],
  maxTokens = 2000
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res = (await env.AI.run(CHAT_MODEL, {
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
    // 解析 SSE 增量，输出纯文本（跨 chunk 维护残行 buffer）
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

// 从 LLM 文本中稳健地提取 JSON（去掉 ```json 围栏等）
function extractJson(text: string): unknown | null {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    // 尝试修复常见问题：尾逗号、未闭合引号等（简单兜底）
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

// 把 LLM 生成的节点 id 规范化（去非法字符，保证唯一、语义化）
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * 把任意来源（LLM 输出或客户端回传）的草稿规范化为可安全落库的结构。
 * 客户端回传的 draft 一律视为不可信：限制规模、枚举白名单、过滤自环与 orphan edge；
 * 与已有节点 id 冲突时自动重命名并同步 remap 边的端点，避免 INSERT OR IGNORE 静默丢节点。
 */
export function sanitizeGraphDraft(raw: unknown, existingIds: Set<string> = new Set()): GraphDraft {
  const input = (raw ?? {}) as { nodes?: unknown; edges?: unknown }
  const rawNodes = Array.isArray(input.nodes) ? input.nodes.slice(0, MAX_DRAFT_NODES) : []
  const rawEdges = Array.isArray(input.edges) ? input.edges.slice(0, MAX_DRAFT_EDGES) : []

  const used = new Set(existingIds)
  const idMap = new Map<string, string>()
  const seenOriginal = new Set<string>()
  const nodes: GraphDraft['nodes'] = []

  rawNodes.forEach((item, i) => {
    const n = (item ?? {}) as Record<string, unknown>
    const name = String(n.name ?? '').trim().slice(0, 60)
    if (!name) return
    const originalId = String(n.id ?? '').trim()
    // 模型偶发重复 id 时，第二个节点改用名称生成独立 id，避免产生无法被边引用的孤岛
    const duplicated = !!originalId && seenOriginal.has(originalId)
    let base = slugify((duplicated ? '' : originalId) || name)
    if (!base) base = `node-${i + 1}`
    if (originalId) seenOriginal.add(originalId)
    let id = base
    let suffix = 2
    while (used.has(id)) id = `${base}-${suffix++}`
    used.add(id)
    // 边可能引用 LLM 原始 id、规范化后的 id 或上一轮清洗后的最终 id，三者都建立映射
    for (const key of [originalId, base, id]) {
      if (key && !idMap.has(key)) idMap.set(key, id)
    }
    const level = Number(n.level)
    const domain = String(n.domain ?? '')
    nodes.push({
      id,
      name,
      domain: DOMAINS.includes(domain as (typeof DOMAINS)[number]) ? domain : 'cs-basic',
      level: [1, 2, 3].includes(level) ? level : 1,
      tags: Array.isArray(n.tags)
        ? n.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
        : [],
    })
  })

  const newIds = new Set(nodes.map((n) => n.id))
  // 端点只允许引用本次草稿节点，与前端预览图口径完全一致：
  // 不引用已有节点 id，避免「预览不可见但落库生效」的幽灵连线。
  const remap = (raw: string): string => {
    const mapped = idMap.get(raw)
    if (mapped) return mapped
    if (newIds.has(raw)) return raw
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
  return { nodes, edges }
}

/**
 * 根据一句话主题，联网搜索并生成知识图谱草稿（不落库）。
 * existingNames 用于提示模型避开用户图谱里已有的知识点。
 */
export async function buildGraphDraft(
  env: EnvWithSearch,
  topic: string,
  existingNames: string[] = []
): Promise<GraphDraft> {
  const searchHits = await webSearch(env, topic, 5)
  const searchText = searchHits
    .slice(0, 5)
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.description ?? ''}`)
    .join('\n')

  const existingHint = existingNames.length
    ? `\n用户图谱中已有的知识点（请避免重复；若确需深化，请使用更具体的名称）：\n${existingNames.slice(0, 80).map((n) => `- ${n}`).join('\n')}\n`
    : ''

  const prompt = `你是一名学习路线规划专家。请根据主题「${topic}」构建一份待用户确认的知识图谱草稿。

${searchText ? `以下是联网搜索到的相关背景信息，供你参考：\n${searchText}\n` : ''}
${existingHint}
要求：
1. 拆解出 6~12 个核心知识点作为节点，覆盖从入门到进阶的完整学习路径。
2. 每个节点包含：id（英文或拼音 slug）、name（中文名）、domain（领域，从下面清单选最匹配的一个）、level（1入门/2进阶/3高级）、tags（标签数组，用于二级细分，可含具体技术如 java、llm、spring）。
3. 领域清单（只能选其一）：
${Object.entries(DOMAIN_NAMES).map(([k, v]) => `   - ${k}（${v}）`).join('\n')}
4. 节点之间用边连接，表示学习依赖关系：prerequisite（前置）、related（相关）、extend（扩展）。
5. 边要有明确的前置依赖链，形成合理的学习顺序；边的端点必须是本次 nodes 里的 id。
6. 注意：领域是学科粗分类，交叉方向用 tags 表达（如「Java 做 AI」应归 backend 或 ai-ml，并用 tags 标注 java + llm，不要发明新领域）。

只输出 JSON，不要任何解释，格式如下：
{"nodes":[{"id":"...","name":"...","domain":"...","level":1,"tags":["..."]}],"edges":[{"source":"...","target":"...","type":"prerequisite"}]}`

  const raw = await chat(env, [{ role: 'user', content: prompt }], 4000)
  const draft = sanitizeGraphDraft(extractJson(raw))
  if (!draft.nodes.length) throw new Error('模型未能生成有效的图谱结构')
  return draft
}

/**
 * 多轮对话修订：基于当前草稿 + 完整对话历史，按用户最新意见产出「完整的新草稿」。
 * 不做联网搜索（修订阶段依赖对话上下文即可），失败时上层保留原草稿。
 */
export async function reviseGraphDraft(
  env: EnvWithSearch,
  draft: GraphDraft,
  messages: ChatTurn[],
  existingNames: string[] = []
): Promise<GraphDraftResult> {
  const history = messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 1200)}`)
    .join('\n')
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  const prompt = `你是学习路线规划专家，正在与用户共同敲定一份知识图谱草稿。

【当前草稿（JSON）】
${JSON.stringify(draft)}

【用户图谱已有知识点（避免重复）】
${existingNames.length ? existingNames.slice(0, 80).join('、') : '（无）'}

【对话记录】
${history}

请根据用户最新意见「${lastUser.slice(0, 1000)}」修订草稿。要求：
1. 输出「完整的新草稿」，不是增量 diff；保留用户未提及的合理部分，只按意见增删改节点或连线。
2. 节点 6~20 个，字段为 id / name / domain / level / tags；domain 只能是 ${DOMAINS.join(' / ')} 之一。
3. 边表示学习依赖（prerequisite / related / extend），端点必须是本次 nodes 里的 id，不要引用已有节点 id。
4. reply 用一句中文简述本次改动，不要 markdown、不要复述 JSON。
5. 只输出 JSON，格式：{"reply":"...","nodes":[...],"edges":[...]}`

  const raw = await chat(env, [
    { role: 'system', content: '你是学习路线规划专家，只输出严格合法的 JSON，不要任何解释文字。' },
    { role: 'user', content: prompt },
  ], 4000)
  const parsed = extractJson(raw) as { reply?: unknown; nodes?: unknown; edges?: unknown } | null
  if (!parsed) throw new Error('模型未能生成有效的修订草稿，请换一种说法再试')

  const next = sanitizeGraphDraft({ nodes: parsed.nodes, edges: parsed.edges })
  if (!next.nodes.length) throw new Error('修订后的草稿为空，请重新描述你的需求')
  const reply = String(parsed.reply ?? '').trim().slice(0, 300) || '已按你的建议更新图谱草稿'
  return { draft: next, reply }
}

/**
 * 根据单个节点的知识点，联网查询并总结为教材小节。
 * 技术类会附带简单 demo 关键代码。
 * @param detailed 是否「重新构建」的细致模式：更多搜索、更深内容、更长篇幅
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

  const isTech = ['java-ai', 'frontend', 'cs-basic'].includes(node.domain)
  const prompt = buildLessonPrompt(node, detailed, isTech, searchText)

  const raw = await chat(env, [{ role: 'user', content: prompt }], detailed ? 5000 : 3000)

  // 解析三个分隔标记
  const titleMatch = raw.match(/【标题】\s*([\s\S]*?)【正文】/)
  const contentMatch = raw.match(/【正文】\s*([\s\S]*?)【代码】/)
  const codeMatch = raw.match(/【代码】\s*([\s\S]*)$/)

  const title = (titleMatch?.[1] ?? node.name).trim()
  const content = (contentMatch?.[1] ?? '').trim()
  const code = (codeMatch?.[1] ?? '').trim()

  if (!content) {
    console.error('generateNodeLesson parse failed, raw:', JSON.stringify(raw).slice(0, 600))
    throw new Error('教材生成失败')
  }

  return {
    title: title || node.name,
    content,
    code,
    source_urls: sourceUrls,
  }
}

function buildLessonPrompt(
  node: { name: string; domain: string; level: number },
  detailed: boolean,
  isTech: boolean,
  searchText: string
): string {
  const prompt = `你是资深技术讲师，请针对知识点「${node.name}」（领域：${node.domain}，难度：${node.level === 1 ? '入门' : node.level === 2 ? '进阶' : '高级'}）编写一份${detailed ? '详尽深入的' : ''}教材小节。

${searchText ? `联网搜索到的参考资料：\n${searchText}\n` : ''}

要求：
1. 用中文，通俗易懂，结构清晰（可用标题、列表）。
2. 正文内容：核心概念、原理、要点、常见误区，${node.level === 1 ? '面向零基础，循序渐进' : '面向有一定基础的读者，突出重点难点'}。
${detailed ? '3. 这是「重新构建」模式，请比常规版本更深入细致：补充背景与演进、关键原理剖析、实践建议、常见问题与排查思路、进阶延伸，尽量覆盖全面。\n' : ''}
${detailed ? '' : '3. '}${isTech ? '这是技术类知识点，请在代码部分提供一段简单的 demo 关键代码（要能体现核心用法，附简要注释）。' : '这是非技术类知识点，代码部分留空。'}
${detailed && isTech ? '此外，请在代码部分提供更完整的示例（可含多个关键片段，覆盖主要用法与典型场景）。' : ''}

请严格按以下格式输出（三个部分之间用这三个标记分隔，标记独占一行）：

【标题】
<这里写教材标题>

【正文】
<这里写教材正文，markdown 格式>

【代码】
<${isTech ? '这里写 demo 代码，如果不需要代码则留空' : '留空'}>`
  return prompt
}

/**
 * 流式生成教材：返回一个 ReadableStream，逐 token 产出教材文本。
 * 前端以 SSE 方式接收并实时渲染。
 * 与 generateNodeLesson 相同的 prompt，但用 stream: true 增量输出。
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

  const isTech = ['java-ai', 'frontend', 'cs-basic'].includes(node.domain)
  const prompt = buildLessonPrompt(node, detailed, isTech, searchText)

  const rawStream = await chatStream(env, [{ role: 'user', content: prompt }], detailed ? 5000 : 3000)
  if (!rawStream) return null
  return { stream: rawStream, sourceUrls }
}

/**
 * 根据节点名称 + 标签，由 LLM 判断其所属领域。
 * 返回领域 id（限定在 DOMAINS 清单内），失败回退 'cs-basic'。
 */
export async function classifyDomain(
  env: EnvWithSearch,
  name: string,
  tags: string[]
): Promise<string> {
  const prompt = `请判断下面这个知识点属于哪个领域。

知识点名称：${name}
标签：${tags.length ? tags.join('、') : '（无）'}

领域清单（只能选其一）：
${Object.entries(DOMAIN_NAMES).map(([k, v]) => `- ${k}：${v}`).join('\n')}

只输出一个领域 id（如 ai-ml、backend），不要任何解释。`

  try {
    const raw = await chat(env, [{ role: 'user', content: prompt }], 50)
    const cleaned = raw.trim().toLowerCase()
    const matched = DOMAINS.find((d) => cleaned.includes(d))
    return matched ?? 'cs-basic'
  } catch {
    return 'cs-basic'
  }
}
