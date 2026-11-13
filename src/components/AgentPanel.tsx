import { useState } from 'react'
import { api, ChatTurn, DOMAIN_LABEL, GraphDraft, Node } from '@/api'
import { safeHttpUrl } from '@/lib/sanitize'
import GraphDraftPreview from '@/components/GraphDraftPreview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

interface Props {
  onBuilt: () => void
  nodes: Node[]
}

type WebHit = { url: string; title: string; description?: string }
type Session = { messages: ChatTurn[]; draft: GraphDraft | null }

const SESSION_KEY = 'study-plans:graph-agent-session'
const MAX_TURNS = 12

// sessionStorage 可能被篡改或写入半截数据，逐字段校验，避免畸形 draft 让面板白屏
function validDraft(d: unknown): d is GraphDraft {
  if (!d || typeof d !== 'object') return false
  const x = d as GraphDraft
  if (!Array.isArray(x.nodes) || !Array.isArray(x.edges)) return false
  const nodesOk = x.nodes.every((n) =>
    !!n && typeof n.id === 'string' && typeof n.name === 'string' &&
    typeof n.domain === 'string' && typeof n.level === 'number' && Number.isFinite(n.level) && Array.isArray(n.tags)
  )
  const edgesOk = x.edges.every((e) =>
    !!e && typeof e.source === 'string' && typeof e.target === 'string' && typeof e.type === 'string'
  )
  return nodesOk && edgesOk
}

function readSession(): Session {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return { messages: [], draft: null }
    const parsed = JSON.parse(raw) as Session
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [], draft: null }
    const messages = parsed.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS)
    return { messages, draft: validDraft(parsed.draft) ? parsed.draft : null }
  } catch {
    return { messages: [], draft: null }
  }
}

export default function AgentPanel({ onBuilt, nodes }: Props) {
  const [mode, setMode] = useState<'search' | 'build'>('build')
  const [session, setSession] = useState<Session>(readSession)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 联网搜索（保留原有能力）
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<WebHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState('')
  const [collectNodeId, setCollectNodeId] = useState('')
  const [collected, setCollected] = useState<Set<string>>(new Set())

  const targetNodeId = collectNodeId || nodes[0]?.id || ''

  // 同步持久化：面板可能在处理中被关闭而卸载，只靠 effect 会丢失结果或残留已确认的旧草稿
  const persist = (next: Session) => {
    setSession(next)
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式 / 配额不足时忽略，不影响本次会话
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setError('')
    setNotice('')
    const messages: ChatTurn[] = [...session.messages, { role: 'user' as const, content: text }].slice(-MAX_TURNS)
    try {
      const r = await api.graphDraft({ messages, draft: session.draft })
      // 只截断一次（发送前），保留尽可能多的多轮上下文
      persist({
        messages: [...messages, { role: 'assistant' as const, content: r.reply }],
        draft: r.draft,
      })
    } catch (e) {
      // 失败时回滚用户消息与输入框，保留上一版预览草稿
      setInput(text)
      setError(e instanceof Error ? e.message : '生成草稿失败')
    } finally {
      setBusy(false)
    }
  }

  const confirmBuild = async () => {
    if (!session.draft || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const r = await api.applyGraphDraft(session.draft)
      setNotice(`已新建 ${r.nodes} 个节点、${r.edges} 条连线，图谱已刷新`)
      persist({ messages: [], draft: null })
      onBuilt()
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失败')
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    persist({ messages: [], draft: null })
    setInput('')
    setError('')
    setNotice('')
  }

  const doSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    setSearchMsg('')
    try {
      const r = await api.webSearch(query.trim())
      setHits(r.results)
      setCollected(new Set())
    } catch (e) {
      setSearchMsg(e instanceof Error ? e.message : '联网搜索失败')
      setHits(null)
    } finally {
      setSearching(false)
    }
  }

  const collect = async (hit: WebHit, url: string) => {
    if (!targetNodeId) {
      setSearchMsg('请先在知识图谱中创建节点，才能收藏搜索结果')
      return
    }
    setSearchMsg('')
    try {
      await api.addResource({
        node_id: targetNodeId,
        title: hit.title || url,
        url,
        kind: 'article',
      })
      setCollected((prev) => new Set([...prev, hit.url]))
      setSearchMsg(`已收藏到「${nodes.find((n) => n.id === targetNodeId)?.name ?? targetNodeId}」的资源链接`)
    } catch (e) {
      setSearchMsg(e instanceof Error ? e.message : '收藏失败')
    }
  }

  return (
    <div>
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setMode('build')}
          className={`rounded-md px-3 py-1 text-sm ${mode === 'build' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
        >
          对话构建图谱
        </button>
        <button
          onClick={() => setMode('search')}
          className={`rounded-md px-3 py-1 text-sm ${mode === 'search' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
        >
          联网搜索
        </button>
      </div>

      {mode === 'build' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            描述学习方向后先给出预览图谱；可以继续提修改意见（多轮对话），确认后才正式新建。
          </p>

          {session.messages.length > 0 && (
            <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-background p-2">
              {session.messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <p
                    className={`max-w-xs whitespace-pre-wrap rounded-md px-2 py-1 text-xs ${
                      m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'
                    }`}
                  >
                    {m.content}
                  </p>
                </div>
              ))}
              {busy && <p className="text-xs text-muted-foreground">正在思考…</p>}
            </div>
          )}

          {session.draft && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">预览图谱</h3>
                <span className="text-xs text-muted-foreground">
                  {session.draft.nodes.length} 节点 / {session.draft.edges.length} 连线
                </span>
              </div>
              <GraphDraftPreview draft={session.draft} />
              <details className="rounded-md border border-border p-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">查看知识点清单</summary>
                <ul className="mt-2 space-y-1">
                  {session.draft.nodes.map((n) => (
                    <li key={n.id} className="text-xs">
                      <span className="font-medium">{n.name}</span>
                      <span className="text-muted-foreground">
                        {' · '}{DOMAIN_LABEL[n.domain] ?? n.domain}{' · L'}{n.level}
                        {n.tags?.length ? ` · ${n.tags.join('、')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              placeholder={session.draft ? '例如：加两个实战项目，去掉安全部分' : '例如：我想系统学习 Java + AI 应用开发'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              disabled={busy}
              className="flex-1"
            />
            <Button onClick={send} disabled={busy || !input.trim()}>
              {busy ? '处理中…' : session.draft ? '提交修改' : '生成预览'}
            </Button>
          </div>

          <div className="flex gap-2">
            <Button onClick={confirmBuild} disabled={busy || !session.draft || session.draft.nodes.length === 0}>
              确认新建
            </Button>
            <Button variant="outline" onClick={reset} disabled={busy || (!session.draft && !session.messages.length)}>
              重新开始
            </Button>
          </div>

          {busy && <p className="text-sm text-muted-foreground">首次生成需联网搜索，通常 10~30 秒…</p>}
          {error && <p className="text-sm text-primary">{error}</p>}
          {notice && <p className="text-sm text-primary">{notice}</p>}
        </div>
      )}

      {mode === 'search' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">联网搜索当前信息，结果可一键收藏为知识点的资源链接。</p>
          <div className="flex gap-2">
            <Input
              placeholder="搜索关键词…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
              disabled={searching}
              className="flex-1"
            />
            <Button onClick={doSearch} disabled={searching || !query.trim()}>
              {searching ? '搜索中…' : '搜索'}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">收藏到</span>
            <Select value={targetNodeId} onChange={(e) => setCollectNodeId(e.target.value)} className="w-56">
              <option value="">选择知识点…</option>
              {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </Select>
          </div>
          {hits && (
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {hits.length === 0 && <p className="text-sm text-muted-foreground">无结果</p>}
              {hits.map((h, i) => {
                const url = safeHttpUrl(h.url)
                if (!url) return null
                const done = collected.has(h.url)
                return (
                  <div key={i} className="rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary">
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <span className="font-medium text-primary">{h.title}</span>
                      {h.description && <span className="block text-xs text-muted-foreground line-clamp-2">{h.description}</span>}
                    </a>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      disabled={done || !targetNodeId}
                      onClick={() => collect(h, url)}
                    >
                      {done ? '已收藏' : '收藏为资源'}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
          {searchMsg && <p className="text-xs text-muted-foreground">{searchMsg}</p>}
        </div>
      )}
    </div>
  )
}
