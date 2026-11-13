import { useEffect, useRef, useState } from 'react'
import {
  api,
  ChatTurn,
  Domain,
  domainLabelOf,
  DraftConflicts,
  GraphDraft,
  GraphDraftNode,
  Node,
  WebSearchHit,
} from '@/api'
import { safeHttpUrl } from '@/lib/sanitize'
import GraphDraftPreview from '@/components/GraphDraftPreview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

interface Props {
  onBuilt: () => void
  nodes: Node[]
  domains: Domain[]
}

type Session = {
  messages: ChatTurn[]
  draft: GraphDraft | null
  sources: WebSearchHit[]
  searchConfigured?: boolean
  conflicts?: DraftConflicts | null
}

const SESSION_KEY = 'study-plans:graph-agent-session'
const PERSIST_KEY = 'study-plans:graph-agent-saved'
const MAX_TURNS = 12

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

function readSession(key: string): Session {
  try {
    const raw = sessionStorage.getItem(key) ?? (key === SESSION_KEY ? null : localStorage.getItem(key))
    if (!raw) return { messages: [], draft: null, sources: [] }
    const parsed = JSON.parse(raw) as Session
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [], draft: null, sources: [] }
    const messages = parsed.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS)
    return {
      messages,
      draft: validDraft(parsed.draft) ? parsed.draft : null,
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      searchConfigured: parsed.searchConfigured,
      conflicts: parsed.conflicts ?? null,
    }
  } catch {
    return { messages: [], draft: null, sources: [] }
  }
}

function classifyError(msg: string): string {
  if (/TAVILY|未配置|联网|search/i.test(msg)) return '搜索未配置或失败：' + msg
  if (/超时|abort|AbortError|The user aborted/i.test(msg)) return '已取消或请求超时'
  if (/JSON|模型|草稿|解析/i.test(msg)) return '模型输出异常：' + msg
  return msg
}

export default function AgentPanel({ onBuilt, nodes, domains }: Props) {
  const [mode, setMode] = useState<'build' | 'search'>('build')
  const [session, setSession] = useState<Session>(() => readSession(SESSION_KEY))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'searching' | 'generating' | ''>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [linkExisting, setLinkExisting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<WebSearchHit[] | null>(null)
  const [searchConfigured, setSearchConfigured] = useState<boolean | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState('')
  const [collectNodeId, setCollectNodeId] = useState('')
  const [collected, setCollected] = useState<Set<string>>(new Set())

  const targetNodeId = collectNodeId || session.draft?.nodes[0]?.id || nodes[0]?.id || ''

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  const persist = (next: Session) => {
    setSession(next)
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
    } catch { /* ignore */ }
  }

  const patchDraft = (mutator: (d: GraphDraft) => GraphDraft) => {
    if (!session.draft) return
    const draft = mutator(session.draft)
    persist({ ...session, draft, conflicts: null })
  }

  const removeNode = (id: string) => {
    patchDraft((d) => ({
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.source !== id && e.target !== id),
    }))
    if (editingId === id) setEditingId(null)
  }

  const updateNode = (id: string, patch: Partial<GraphDraftNode>) => {
    patchDraft((d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch, id: n.id } : n)),
    }))
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setError('')
    setNotice('')
    setPhase('')
    const messages: ChatTurn[] = [...session.messages, { role: 'user' as const, content: text }].slice(-MAX_TURNS)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await api.graphDraftStream(
        { messages, draft: session.draft },
        {
          onPhase: (p) => setPhase(p),
          onResult: (r) => {
            persist({
              messages: [...messages, { role: 'assistant', content: r.reply }],
              draft: r.draft,
              sources: r.sources ?? [],
              searchConfigured: r.searchConfigured,
              conflicts: r.conflicts ?? null,
            })
          },
          onError: (err) => {
            setInput(text)
            setError(classifyError(err))
          },
        },
        ac.signal
      )
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setError('已停止生成')
      } else {
        setInput(text)
        setError(classifyError(e instanceof Error ? e.message : '生成草稿失败'))
      }
    } finally {
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  const confirmBuild = async () => {
    if (!session.draft || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const r = await api.applyGraphDraft(session.draft, { linkExisting })
      let msg = `已新建 ${r.nodes} 个节点、${r.edges} 条连线`
      if (r.linked) msg += `（含 ${r.linked} 条挂接到已有节点）`
      setNotice(msg + '，图谱已刷新')
      persist({ messages: [], draft: null, sources: [], conflicts: null })
      onBuilt()
    } catch (e) {
      setError(classifyError(e instanceof Error ? e.message : '新建失败'))
    } finally {
      setBusy(false)
    }
  }

  const createRoadmap = async () => {
    if (!session.draft || busy) return
    setBusy(true)
    setError('')
    try {
      // 先落库再生成路线
      await api.applyGraphDraft(session.draft, { linkExisting })
      const r = await api.draftToRoadmap(session.draft)
      setNotice(`已新建图谱，并生成路线「${r.name}」（${r.steps} 步）`)
      persist({ messages: [], draft: null, sources: [], conflicts: null })
      onBuilt()
    } catch (e) {
      setError(classifyError(e instanceof Error ? e.message : '生成路线失败'))
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    abortRef.current?.abort()
    persist({ messages: [], draft: null, sources: [], conflicts: null })
    setInput('')
    setError('')
    setNotice('')
    setPhase('')
  }

  const saveSession = () => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(session))
      setNotice('会话已保存到本机，可稍后「恢复会话」')
    } catch {
      setError('保存失败（存储配额不足或隐私模式）')
    }
  }

  const restoreSession = () => {
    const saved = readSession(PERSIST_KEY)
    if (!saved.draft && !saved.messages.length) {
      setError('没有已保存的会话')
      return
    }
    persist(saved)
    setNotice('已恢复本机会话')
    setError('')
  }

  const doSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    setSearchMsg('')
    try {
      const r = await api.webSearch(query.trim())
      setHits(r.results)
      setSearchConfigured(r.configured)
      setCollected(new Set())
      if (!r.configured) setSearchMsg('未配置联网搜索（TAVILY_API_KEY），结果可能为空')
    } catch (e) {
      setSearchMsg(classifyError(e instanceof Error ? e.message : '联网搜索失败'))
      setHits(null)
    } finally {
      setSearching(false)
    }
  }

  const collect = async (hit: WebSearchHit, url: string, nodeId?: string) => {
    const nid = nodeId || targetNodeId
    if (!nid || !nodes.find((n) => n.id === nid)) {
      setSearchMsg('请选择已有知识点后再收藏（草稿节点需先确认新建）')
      return
    }
    setSearchMsg('')
    try {
      await api.addResource({
        node_id: nid,
        title: hit.title || url,
        url,
        kind: 'article',
      })
      setCollected((prev) => new Set([...prev, hit.url]))
      setSearchMsg(`已收藏到「${nodes.find((n) => n.id === nid)?.name ?? nid}」`)
    } catch (e) {
      setSearchMsg(classifyError(e instanceof Error ? e.message : '收藏失败'))
    }
  }

  const phaseHint =
    phase === 'searching' ? '正在联网搜索…'
      : phase === 'generating' ? '正在生成图谱…'
        : busy ? '首次生成通常 10~30 秒…' : ''

  return (
    <div>
      <div className="mb-3 flex gap-1">
        <button
          type="button"
          onClick={() => setMode('build')}
          className={`rounded-md px-3 py-1 text-sm ${mode === 'build' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
        >
          对话构建图谱
        </button>
        <button
          type="button"
          onClick={() => setMode('search')}
          className={`rounded-md px-3 py-1 text-sm ${mode === 'search' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
        >
          联网搜索
        </button>
      </div>

      {mode === 'build' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            描述学习方向后先给出预览；可本地改节点，或继续对话修订，确认后才正式新建。
          </p>

          {session.searchConfigured === false && (
            <p className="text-sm text-muted-foreground">
              未配置联网搜索，结果可能过时；可在 Worker secrets 配置 TAVILY_API_KEY。
            </p>
          )}

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
              {busy && <p className="text-xs text-muted-foreground">{phaseHint || '正在思考…'}</p>}
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
              <GraphDraftPreview draft={session.draft} domains={domains} />

              {session.sources.length > 0 && (
                <details className="rounded-md border border-border p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    参考来源（{session.sources.length}）
                  </summary>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                    {session.sources.map((h) => {
                      const url = safeHttpUrl(h.url)
                      if (!url) return null
                      return (
                        <li key={h.url} className="text-xs">
                          <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary">
                            {h.title}
                          </a>
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-2 h-6 px-2"
                            disabled={!nodes.length}
                            onClick={() => collect(h, url, nodes[0]?.id)}
                          >
                            收藏
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                </details>
              )}

              <details className="rounded-md border border-border p-2" open>
                <summary className="cursor-pointer text-xs text-muted-foreground">知识点清单（可本地编辑）</summary>
                <ul className="mt-2 space-y-2">
                  {session.draft.nodes.map((n) => (
                    <li key={n.id} className="rounded-md border border-border p-2 text-xs">
                      {editingId === n.id ? (
                        <div className="space-y-2">
                          <Input
                            value={n.name}
                            onChange={(e) => updateNode(n.id, { name: e.target.value })}
                            className="h-8 text-xs"
                          />
                          <div className="flex flex-wrap gap-2">
                            <Select
                              value={n.domain}
                              onChange={(e) => updateNode(n.id, { domain: e.target.value })}
                              className="h-8 w-40"
                            >
                              {domains.map((d) => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                              ))}
                            </Select>
                            <Select
                              value={String(n.level)}
                              onChange={(e) => updateNode(n.id, { level: Number(e.target.value) })}
                              className="h-8 w-24"
                            >
                              <option value="1">L1 入门</option>
                              <option value="2">L2 进阶</option>
                              <option value="3">L3 高级</option>
                            </Select>
                            <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>完成</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="font-medium">{n.name}</span>
                            <span className="text-muted-foreground">
                              {' · '}{domainLabelOf(n.domain, domains)}{' · L'}{n.level}
                              {n.tags?.length ? ` · ${n.tags.join('、')}` : ''}
                            </span>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => setEditingId(n.id)}>
                              编辑
                            </Button>
                            <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => removeNode(n.id)}>
                              删除
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </details>

              {session.conflicts && (
                <details className="rounded-md border border-border p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">确认前冲突预览</summary>
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <p>将新建 {session.conflicts.willCreate.length} 个节点</p>
                    {session.conflicts.remapped.length > 0 && (
                      <p>
                        id 重命名：{session.conflicts.remapped.map((r) => `${r.from}→${r.to}`).join('，')}
                      </p>
                    )}
                    {session.conflicts.nameSimilar.length > 0 && (
                      <p>
                        名称相近（可能重复）：
                        {session.conflicts.nameSimilar
                          .map((s) => `「${s.draftName}」≈「${s.existingName}」`)
                          .join('；')}
                      </p>
                    )}
                  </div>
                </details>
              )}

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={linkExisting}
                  onChange={(e) => setLinkExisting(e.target.checked)}
                  className="rounded border-border"
                />
                确认时自动把名称相近的新节点挂接到已有知识点
              </label>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              placeholder={session.draft ? '例如：加两个实战项目，去掉安全部分' : '例如：我想系统学习 Java + AI 应用开发'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && send()}
              disabled={busy}
              className="flex-1"
            />
            {busy ? (
              <Button variant="outline" onClick={stop}>停止</Button>
            ) : (
              <Button onClick={send} disabled={!input.trim()}>
                {session.draft ? '提交修改' : '生成预览'}
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={confirmBuild} disabled={busy || !session.draft || session.draft.nodes.length === 0}>
              确认新建
            </Button>
            <Button
              variant="outline"
              onClick={createRoadmap}
              disabled={busy || !session.draft || session.draft.nodes.length === 0}
            >
              新建并生成路线
            </Button>
            <Button variant="outline" onClick={reset} disabled={busy || (!session.draft && !session.messages.length)}>
              重新开始
            </Button>
            <Button variant="outline" onClick={saveSession} disabled={!session.draft && !session.messages.length}>
              保存会话
            </Button>
            <Button variant="outline" onClick={restoreSession}>恢复会话</Button>
          </div>

          {phaseHint && <p className="text-sm text-muted-foreground">{phaseHint}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        </div>
      )}

      {mode === 'search' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">联网搜索当前信息，结果可一键收藏为知识点的资源链接。</p>
          {searchConfigured === false && (
            <p className="text-sm text-muted-foreground">未配置 TAVILY_API_KEY，搜索可能无结果。</p>
          )}
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
                    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                      <span className="font-medium text-primary">{h.title}</span>
                      {h.description && (
                        <span className="block text-xs text-muted-foreground line-clamp-2">{h.description}</span>
                      )}
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
