export interface Node {
  id: string
  name: string
  domain: 'ai-general' | 'java-ai' | 'frontend' | 'cs-basic'
  level: number
  status: 'todo' | 'learning' | 'done'
  progress: number
  tags: string
  created_at?: string
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

export const DOMAIN_LABEL: Record<string, string> = {
  'ai-general': 'AI 通用',
  'java-ai': 'Java + AI',
  frontend: '前端/Web',
  'cs-basic': '计算机基础',
}

export const DOMAIN_COLOR: Record<string, string> = {
  'ai-general': '#7F77DD',
  'java-ai': '#D85A30',
  frontend: '#378ADD',
  'cs-basic': '#1D9E75',
}

export const STATUS_LABEL: Record<string, string> = {
  todo: '未开始',
  learning: '学习中',
  done: '已掌握',
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json() as Promise<T>
}

export const api = {
  graph: () => req<{ nodes: Node[]; edges: Edge[] }>('/api/graph'),
  createNode: (n: Partial<Node>) => req('/api/nodes', { method: 'POST', body: JSON.stringify(n) }),
  updateNode: (id: string, patch: Partial<Node>) =>
    req(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteNode: (id: string) => req(`/api/nodes/${id}`, { method: 'DELETE' }),
  createEdge: (e: Partial<Edge>) => req('/api/edges', { method: 'POST', body: JSON.stringify(e) }),
  deleteEdge: (id: number) => req(`/api/edges/${id}`, { method: 'DELETE' }),

  roadmaps: () => req<Roadmap[]>('/api/roadmaps'),
  roadmap: (id: string) => req<Roadmap>(`/api/roadmaps/${id}`),
  saveSteps: (id: string, steps: { node_id: string; seq: number }[]) =>
    req(`/api/roadmaps/${id}/steps`, { method: 'PUT', body: JSON.stringify(steps) }),

  checkins: (from?: string, to?: string) =>
    req<Checkin[]>(`/api/checkins?from=${from ?? ''}&to=${to ?? ''}`),
  addCheckin: (b: { node_id: string; date: string; minutes: number; note?: string }) =>
    req('/api/checkins', { method: 'POST', body: JSON.stringify(b) }),
  deleteCheckin: (id: number) => req(`/api/checkins/${id}`, { method: 'DELETE' }),

  heatmap: () => req<{ date: string; minutes: number; count: number }[]>('/api/stats/heatmap'),
  summary: () =>
    req<{
      total: { minutes: number; count: number }
      byDomain: { domain: string; minutes: number }[]
      byWeek: { week: string; minutes: number }[]
      byNode: { id: string; name: string; minutes: number }[]
      streak: number
    }>('/api/stats/summary'),

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
}
