// AI 智能功能：联网搜索、一句话构建图谱、知识库教材生成
// 联网搜索使用 Tavily Search API（REST 调用），图谱构建/教材生成用 Workers AI 开源模型

export type WebSearchItem = { url: string; title: string; description?: string }

// 对话构建图谱时 LLM 返回的结构
export type GraphDraft = {
  nodes: { id: string; name: string; domain: string; level: number; tags: string[] }[]
  edges: { source: string; target: string; type: 'prerequisite' | 'related' | 'extend' }[]
}

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
 * 根据一句话主题，分析拆解并联网搜索，生成知识图谱草稿。
 * 流程：LLM 拆解主题 → 对核心主题联网搜索补充 → LLM 生成结构化节点/边。
 */
export async function buildGraphDraft(env: EnvWithSearch, topic: string): Promise<GraphDraft> {
  const searchHits = await webSearch(env, topic, 5)
  const searchText = searchHits
    .slice(0, 5)
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.description ?? ''}`)
    .join('\n')

  const prompt = `你是一名学习路线规划专家。请根据主题「${topic}」构建一个知识图谱。

${searchText ? `以下是联网搜索到的相关背景信息，供你参考：\n${searchText}\n` : ''}

要求：
1. 拆解出 6~12 个核心知识点作为节点，覆盖从入门到进阶的完整学习路径。
2. 每个节点包含：id（英文或拼音 slug）、name（中文名）、domain（领域，从下面清单选最匹配的一个）、level（1入门/2进阶/3高级）、tags（标签数组，用于二级细分，可含具体技术如 java、llm、spring）。
3. 领域清单（只能选其一）：
${Object.entries(DOMAIN_NAMES).map(([k, v]) => `   - ${k}（${v}）`).join('\n')}
4. 节点之间用边连接，表示学习依赖关系：prerequisite（前置）、related（相关）、extend（扩展）。
5. 边要有明确的前置依赖链，形成合理的学习顺序。
6. 注意：领域是学科粗分类，交叉方向用 tags 表达（如「Java 做 AI」应归 backend 或 ai-ml，并用 tags 标注 java + llm，不要发明新领域）。

只输出 JSON，不要任何解释，格式如下：
{"nodes":[{"id":"...","name":"...","domain":"...","level":1,"tags":["..."]}],"edges":[{"source":"...","target":"...","type":"prerequisite"}]}`

  const raw = await chat(env, [{ role: 'user', content: prompt }], 4000)
  const parsed = extractJson(raw) as GraphDraft | null
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('模型未能生成有效的图谱结构')
  }

  // 规范化节点
  const seen = new Set<string>()
  const nodes = parsed.nodes
    .filter((n) => n && n.name)
    .map((n) => {
      let id = slugify(n.id || n.name)
      if (!id) id = 'node-' + Math.random().toString(36).slice(2, 8)
      // 去重
      let uniqueId = id
      let i = 1
      while (seen.has(uniqueId)) uniqueId = `${id}-${++i}`
      seen.add(uniqueId)
      return {
        id: uniqueId,
        name: n.name,
        domain: (DOMAINS.includes(n.domain as (typeof DOMAINS)[number]) ? n.domain : 'cs-basic'),
        level: [1, 2, 3].includes(n.level) ? n.level : 1,
        tags: Array.isArray(n.tags) ? n.tags.map(String).slice(0, 8) : [],
      }
    })

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = parsed.edges
    .filter((e) => e && nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: (['prerequisite', 'related', 'extend'].includes(e.type) ? e.type : 'related') as GraphDraft['edges'][number]['type'],
    }))

  return { nodes, edges }
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
