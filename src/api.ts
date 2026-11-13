export interface Node {
  id: string
  name: string
  domain: string
  level: number
  status: 'todo' | 'learning' | 'done'
  progress: number
  tags: string
  created_at?: string
}

// 领域定义（可配置，服务端 domains 表为准；此处为兜底默认值）
export interface Domain {
  id: string
  name: string
  color: string
  sort: number
}

export interface Edge {
  id: number
  source: string
  target: string
  type: 'prerequisite' | 'related' | 'extend'
}

export interface RoadmapStep extends Node {
  seq: number
}

export interface Roadmap {
  id: string
  name: string
  description: string
  steps?: RoadmapStep[]
}

export interface Checkin {
  id: number
  node_id: string
  node_name?: string
  domain?: string
  date: string
  minutes: number
  note: string
}

export interface Resource {
  id: number
  node_id: string
  title: string
  url: string
  kind: 'doc' | 'video' | 'repo' | 'article'
}

// AI 助手多轮对话构建图谱：草稿只在前端流转，用户确认后才落库
export interface GraphDraftNode {
  id: string
  name: string
  domain: string
  level: number
  tags: string[]
}
export interface GraphDraftEdge {
  source: string
  target: string
  type: 'prerequisite' | 'related' | 'extend'
}
export interface GraphDraft {
  nodes: GraphDraftNode[]
  edges: GraphDraftEdge[]
}
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface Profile {
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

export interface KnowledgeDoc {
  id: number
  user_id: string
  node_id: string
  title: string
  content: string
  code: string
  source_urls: string | null
  domain: string
  seq: number
  is_edited?: number
  created_at?: string
  updated_at?: string
}

export interface Goals {
  daily: number
  weekly: number
}

export interface KnowledgeJob {
  id: string
  user_id: string
  status: 'running' | 'paused' | 'completed' | 'cancelled'
  detailed: number
  total: number
  completed: number
  failed: number
  current_node: string
  created_at?: string
  updated_at?: string
}

export interface KnowledgeJobItem {
  job_id: string
  node_id: string
  seq: number
  status: 'pending' | 'done' | 'failed' | 'skipped'
  error: string
}


/** 领域文案/颜色兜底（运行时优先用 /api/domains 已加载列表） */
export const DOMAIN_LABEL: Record<string, string> = {
  'ai-ml': 'AI / 机器学习',
  backend: '后端开发',
  frontend: '前端开发',
  data: '数据与数据库',
  devops: '工程与运维',
  'cs-basic': '计算机基础',
  security: '安全',
  product: '产品与软技能',
}

export const DOMAIN_COLOR: Record<string, string> = {
  'ai-ml': '#7F77DD',
  backend: '#D85A30',
  frontend: '#378ADD',
  data: '#D4A017',
  devops: '#1D9E75',
  'cs-basic': '#17A2B8',
  security: '#C0392B',
  product: '#7F8C8D',
}

export function domainLabelOf(id: string, domains?: Domain[]): string {
  return domains?.find((d) => d.id === id)?.name ?? DOMAIN_LABEL[id] ?? id
}

export function domainColorOf(id: string, domains?: Domain[]): string {
  return domains?.find((d) => d.id === id)?.color ?? DOMAIN_COLOR[id] ?? '#888780'
}

export interface WebSearchHit {
  url: string
  title: string
  description?: string
}

export interface DraftConflicts {
  willCreate: { id: string; name: string }[]
  remapped: { from: string; to: string }[]
  nameSimilar: { draftId: string; draftName: string; existingId: string; existingName: string }[]
}

export interface GraphDraftResponse {
  draft: GraphDraft
  reply: string
  sources?: WebSearchHit[]
  searchConfigured?: boolean
  conflicts?: DraftConflicts
  remaps?: { from: string; to: string }[]
}

export const STATUS_LABEL: Record<string, string> = {
  todo: '未开始',
  learning: '学习中',
  done: '已掌握',
}

export interface Summary {
  total: { minutes: number; count: number }
  byDomain: { domain: string; minutes: number }[]
  byWeek: { week: string; minutes: number }[]
  byNode: { id: string; name: string; minutes: number }[]
  streak: number
}

export interface HeatmapCell {
  date: string
  minutes: number
  count: number
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!r.ok) {
    let message = `${r.status} ${r.statusText}`
    try {
      const data = (await r.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // 非 JSON 错误响应，保留 status
    }
    // 会话过期统一广播，App 监听后切回登录页
    if (r.status === 401) window.dispatchEvent(new Event('app:unauthorized'))
    throw new Error(message)
  }
  return r.json() as Promise<T>
}

export const api = {
  graph: () => req<{ nodes: Node[]; edges: Edge[] }>('/api/graph'),
  createNode: (n: Partial<Node>) => req('/api/nodes', { method: 'POST', body: JSON.stringify(n) }),
  updateNode: (id: string, patch: Partial<Node>) =>
    req(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteNode: (id: string) => req(`/api/nodes/${id}`, { method: 'DELETE' }),
  createEdge: (e: Partial<Edge>) => req('/api/edges', { method: 'POST', body: JSON.stringify(e) }),
  updateEdge: (id: number, type: Edge['type']) =>
    req(`/api/edges/${id}`, { method: 'PATCH', body: JSON.stringify({ type }) }),
  deleteEdge: (id: number) => req(`/api/edges/${id}`, { method: 'DELETE' }),

  // 领域管理
  domains: () => req<Domain[]>('/api/domains'),
  createDomain: (d: Omit<Domain, 'sort'> & { sort?: number }) =>
    req('/api/domains', { method: 'POST', body: JSON.stringify(d) }),
  updateDomain: (id: string, patch: Partial<Omit<Domain, 'id'>>) =>
    req(`/api/domains/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDomain: (id: string) => req(`/api/domains/${id}`, { method: 'DELETE' }),

  // AI 识别领域（手动创建节点时自动归类）
  classifyDomain: (name: string, tags: string[]) =>
    req<{ domain: string }>('/api/agent/classify-domain', {
      method: 'POST',
      body: JSON.stringify({ name, tags }),
    }),

  roadmaps: () => req<Roadmap[]>('/api/roadmaps'),
  roadmap: (id: string) => req<Roadmap>(`/api/roadmaps/${id}`),
  createRoadmap: (r: { id: string; name: string; description?: string }) =>
    req('/api/roadmaps', { method: 'POST', body: JSON.stringify(r) }),
  updateRoadmap: (id: string, patch: { name?: string; description?: string }) =>
    req(`/api/roadmaps/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteRoadmap: (id: string) => req(`/api/roadmaps/${id}`, { method: 'DELETE' }),
  saveSteps: (id: string, steps: { node_id: string; seq: number }[]) =>
    req(`/api/roadmaps/${id}/steps`, { method: 'PUT', body: JSON.stringify(steps) }),

  checkins: (from?: string, to?: string, nodeId?: string) =>
    req<Checkin[]>(
      `/api/checkins?from=${from ?? ''}&to=${to ?? ''}${nodeId ? `&node_id=${encodeURIComponent(nodeId)}` : ''}`
    ),
  addCheckin: (b: { node_id: string; date: string; minutes: number; note?: string }) =>
    req<{ ok: boolean; progress: number }>('/api/checkins', { method: 'POST', body: JSON.stringify(b) }),
  deleteCheckin: (id: number) => req(`/api/checkins/${id}`, { method: 'DELETE' }),
  goals: () => req<Goals>('/api/goals'),
  saveGoals: (g: Partial<Goals>) =>
    req<{ ok: boolean; daily: number; weekly: number }>('/api/goals', {
      method: 'PUT', body: JSON.stringify(g),
    }),

  heatmap: () => req<HeatmapCell[]>('/api/stats/heatmap'),
  summary: () => req<Summary>('/api/stats/summary'),

  note: (nodeId: string) => req<{ content: string }>(`/api/notes/${nodeId}`),
  saveNote: (nodeId: string, content: string) =>
    req(`/api/notes/${nodeId}`, { method: 'PUT', body: JSON.stringify({ content }) }),

  resources: (nodeId: string) => req<Resource[]>(`/api/resources?node_id=${nodeId}`),
  addResource: (r: Omit<Resource, 'id'>) => req('/api/resources', { method: 'POST', body: JSON.stringify(r) }),
  deleteResource: (id: number) => req(`/api/resources/${id}`, { method: 'DELETE' }),

  semanticSearch: (query: string) =>
    req<{ results: { id: string; score: number; node: Node | null; preview: string }[] }>(
      '/api/search/semantic',
      { method: 'POST', body: JSON.stringify({ query }) }
    ),

  // 联网搜索
  webSearch: (query: string, limit = 5) =>
    req<{ results: WebSearchHit[]; configured: boolean }>(
      '/api/search/web',
      { method: 'POST', body: JSON.stringify({ query, limit }) }
    ),

  // 多轮对话生成 / 修订图谱草稿（JSON，不落库）
  graphDraft: (body: { messages: ChatTurn[]; draft?: GraphDraft | null; skipCache?: boolean }) =>
    req<GraphDraftResponse>('/api/agent/graph-draft', {
      method: 'POST', body: JSON.stringify(body),
    }),

  /** SSE 建图：phase → result / error；支持 AbortSignal */
  graphDraftStream: async (
    body: { messages: ChatTurn[]; draft?: GraphDraft | null; skipCache?: boolean },
    handlers: {
      onPhase?: (phase: 'searching' | 'generating') => void
      onResult?: (r: GraphDraftResponse) => void
      onError?: (error: string) => void
    },
    signal?: AbortSignal
  ) => {
    const r = await fetch('/api/agent/graph-draft?stream=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    })
    if (r.status === 401) window.dispatchEvent(new Event('app:unauthorized'))
    if (!r.ok) {
      let message = `${r.status} ${r.statusText}`
      try {
        const data = (await r.json()) as { error?: string }
        if (data.error) message = data.error
      } catch { /* keep */ }
      throw new Error(message)
    }
    const reader = r.body?.getReader()
    if (!reader) throw new Error('浏览器不支持流式响应')
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        try {
          const data = JSON.parse(line.slice(5).trim()) as {
            type?: string
            phase?: 'searching' | 'generating'
            error?: string
          } & GraphDraftResponse
          if (data.type === 'phase' && data.phase) handlers.onPhase?.(data.phase)
          else if (data.type === 'result') handlers.onResult?.(data)
          else if (data.type === 'error') handlers.onError?.(data.error ?? '生成失败')
        } catch { /* ignore bad event */ }
      }
    }
  },

  // 确认预览后正式新建；linkExisting 时按名称挂接到已有节点
  applyGraphDraft: (draft: GraphDraft, opts?: { linkExisting?: boolean }) =>
    req<{ ok: boolean; nodes: number; edges: number; linked?: number; conflicts?: DraftConflicts }>(
      '/api/agent/build-graph',
      { method: 'POST', body: JSON.stringify({ draft, linkExisting: !!opts?.linkExisting }) }
    ),

  draftToRoadmap: (draft: GraphDraft, name?: string) =>
    req<{ ok: boolean; id: string; name: string; steps: number }>('/api/agent/draft-to-roadmap', {
      method: 'POST', body: JSON.stringify({ draft, name }),
    }),

  // 知识库教材
  knowledge: () => req<KnowledgeDoc[]>('/api/knowledge'),
  knowledgeNodes: () =>
    req<{ id: string; name: string; domain: string; level: number; parent_ids: string[] }[]>(
      '/api/knowledge/nodes'
    ),
  generateKnowledgeNode: (node_id: string, seq: number, detailed = false) =>
    req<{ ok: boolean; node_id: string; title: string }>('/api/knowledge/generate-node', {
      method: 'POST',
      body: JSON.stringify({ node_id, seq, detailed }),
    }),
  // 流式生成教材：返回 SSE 响应体，供前端逐块读取
  streamGenerateKnowledgeNode: (node_id: string, seq: number, detailed = false) =>
    fetch('/api/knowledge/stream-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id, seq, detailed }),
    }).then((r) => {
      if (r.status === 401) window.dispatchEvent(new Event('app:unauthorized'))
      return r
    }),
  clearKnowledge: () => req<{ ok: boolean }>('/api/knowledge', { method: 'DELETE' }),
  // 人工编辑教材（置 is_edited，批处理任务不再覆盖）
  updateKnowledgeDoc: (node_id: string, patch: { title?: string; content?: string; code?: string }) =>
    req<{ ok: boolean }>(`/api/knowledge/${encodeURIComponent(node_id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
  // 服务端批处理任务：关页面不中断，可取消 / 断点续跑
  startKnowledgeJob: (opts: { rebuild?: boolean; detailed?: boolean }) =>
    req<{ ok: boolean; job: KnowledgeJob | null; reused?: boolean; error?: string }>('/api/knowledge/jobs', {
      method: 'POST', body: JSON.stringify(opts),
    }),
  activeKnowledgeJob: () => req<{ job: KnowledgeJob | null }>('/api/knowledge/jobs/active'),
  knowledgeJob: (id: string) =>
    req<{ job: KnowledgeJob; items: KnowledgeJobItem[] }>(`/api/knowledge/jobs/${encodeURIComponent(id)}`),
  cancelKnowledgeJob: (id: string) =>
    req<{ ok: boolean }>(`/api/knowledge/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  resumeKnowledgeJob: (id: string) =>
    req<{ ok: boolean; job: KnowledgeJob | null }>(`/api/knowledge/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),

  profile: () => req<Profile>('/api/profile'),
  saveProfile: (p: Partial<Profile>) => {
    const body = {
      nickname: p.nickname,
      bio: p.bio,
      goal: p.goal,
      email: p.email,
      phone: p.phone,
      location: p.location,
      website: p.website,
    }
    return req<{ ok: true; avatar: string }>('/api/profile', { method: 'PUT', body: JSON.stringify(body) })
  },
  uploadAvatar: async (file: File): Promise<{ avatar: string }> => {
    const body = new FormData()
    body.append('file', file)
    const r = await fetch('/api/profile/avatar', { method: 'POST', body })
    if (!r.ok) {
      let message = `${r.status} ${r.statusText}`
      try {
        const data = (await r.json()) as { error?: string }
        if (data.error) message = data.error
      } catch {
        // keep status text
      }
      throw new Error(message)
    }
    return r.json() as Promise<{ avatar: string }>
  },

  // 认证（应用层自建登录）
  authMe: () =>
    req<{ authenticated: boolean; user_id: string; email: string; nickname?: string }>('/api/auth/me'),
  sendCode: (email: string) =>
    req<{ ok: boolean }>('/api/auth/send-code', { method: 'POST', body: JSON.stringify({ email }) }),
  verifyCode: (email: string, code: string) =>
    req<{ ok: boolean; email: string }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
}
