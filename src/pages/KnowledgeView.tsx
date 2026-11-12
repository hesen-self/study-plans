import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { marked } from 'marked'
import { api, KnowledgeDoc, DOMAIN_LABEL } from '@/api'
import { Button } from '@/components/ui/button'

marked.setOptions({ breaks: true })

type TreeNode = { id: string; name: string; domain: string; level: number; parent_ids: string[] }
type TreeItem = TreeNode & { children: TreeItem[] }

export default function KnowledgeView() {
  const [searchParams] = useSearchParams()
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false) // 一键生成中
  const [rebuilding, setRebuilding] = useState<string | null>(null) // 单节点重新构建中的 node_id
  const [progress, setProgress] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 流式生成状态：当前正在流式输出的节点 id 及其实时内容
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [streamTitle, setStreamTitle] = useState('')
  const [streamContent, setStreamContent] = useState('')
  const [streamCode, setStreamCode] = useState('')
  // 折叠状态：记录被折叠的父节点 id（有子节点的节点）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const load = useCallback(() => api.knowledge().then(setDocs), [])

  useEffect(() => {
    Promise.all([api.knowledgeNodes(), api.knowledge()])
      .then(([n, d]) => {
        setNodes(n)
        setDocs(d)
        // 优先定位 URL 参数指定的节点（来自知识图谱节点详情的跳转）
        const target = searchParams.get('node')
        if (target && n.some((item) => item.id === target)) {
          setSelectedId(target)
        } else if (n.length > 0) {
          setSelectedId(n[0].id)
        }
      })
      .catch(() => setError('加载知识库失败'))
      .finally(() => setLoading(false))
  }, [searchParams])

  // node_id -> doc 映射（已生成教材的节点）
  const docMap = useMemo(() => {
    const m = new Map<string, KnowledgeDoc>()
    for (const d of docs) m.set(d.node_id, d)
    return m
  }, [docs])

  // 根据 prerequisite 前置依赖构建树形目录（森林）
  // 拓扑序保证父节点先于子节点出现，每个节点归属其第一个出现的父节点
  const tree = useMemo(() => {
    const byId = new Map<string, TreeItem>(nodes.map((n) => [n.id, { ...n, children: [] }]))
    const roots: TreeItem[] = []
    for (const n of nodes) {
      const item = byId.get(n.id)!
      // 找第一个存在于列表中的父节点（拓扑序最早）
      let parent: TreeItem | undefined
      for (const pid of n.parent_ids) {
        const p = byId.get(pid)
        if (p) {
          parent = p
          break
        }
      }
      if (parent) parent.children.push(item)
      else roots.push(item)
    }
    return roots
  }, [nodes])

  const selectedDoc = selectedId ? docMap.get(selectedId) : undefined
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : undefined

  // 流式生成单个节点教材：读取 SSE，实时更新标题/正文/代码
  const streamGenerate = async (nodeId: string, seq: number, detailed: boolean): Promise<boolean> => {
    setStreamingId(nodeId)
    setStreamTitle('')
    setStreamContent('')
    setStreamCode('')
    let ok = false
    try {
      const res = await api.streamGenerateKnowledgeNode(nodeId, seq, detailed)
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 事件以 \n\n 分隔
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = rawEvent.startsWith('data: ') ? rawEvent.slice(6) : rawEvent.startsWith('data:') ? rawEvent.slice(5) : rawEvent
          if (!line) continue
          try {
            const evt = JSON.parse(line) as { type: string; value?: string; title?: string; message?: string }
            if (evt.type === 'title' && evt.value) setStreamTitle((p) => p + evt.value)
            else if (evt.type === 'content' && evt.value) setStreamContent((p) => p + evt.value)
            else if (evt.type === 'code' && evt.value) setStreamCode((p) => p + evt.value)
            else if (evt.type === 'done') ok = true
            else if (evt.type === 'error') {
              setError(evt.message || '生成失败')
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '流式生成失败')
    } finally {
      setStreamingId(null)
    }
    return ok
  }

  // 一键生成：仅生成「尚未有教材」的节点，逐节点流式输出
  const generate = async () => {
    setGenerating(true)
    setError('')
    setProgress('正在获取图谱节点…')
    try {
      const pending = nodes.filter((n) => !docMap.has(n.id))
      if (nodes.length === 0) {
        setProgress('')
        setError('图谱为空，请先在知识图谱中构建内容')
        return
      }
      if (pending.length === 0) {
        setProgress('所有节点均已有教材，无需生成')
        return
      }
      let okCount = 0
      for (let i = 0; i < pending.length; i++) {
        setProgress(`正在生成教材（${i + 1}/${pending.length}）：${pending[i].name}…`)
        // 选中当前正在生成的节点，让流式内容实时展示在正文区
        setSelectedId(pending[i].id)
        const ok = await streamGenerate(pending[i].id, i, false)
        if (ok) okCount++
      }
      setProgress(`生成完成：新增 ${okCount}/${pending.length} 个章节，已跳过 ${nodes.length - pending.length} 个已有章节`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败')
      setProgress('')
    } finally {
      setGenerating(false)
    }
  }

  // 单节点重新构建（详细模式，流式）
  const rebuild = async (node: TreeNode) => {
    setRebuilding(node.id)
    setError('')
    try {
      const idx = nodes.findIndex((n) => n.id === node.id)
      setSelectedId(node.id)
      await streamGenerate(node.id, idx >= 0 ? idx : 0, true)
      setProgress(`已重新构建「${node.name}」`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新构建失败')
    } finally {
      setRebuilding(null)
    }
  }

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderSources = (raw: string) => {
    let urls: string[]
    try {
      urls = JSON.parse(raw) as string[]
    } catch {
      return null
    }
    if (urls.length === 0) return null
    return (
      <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="mr-1">参考来源：</span>
        {urls.map((u, i) => (
          <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 text-primary hover:underline">
            [{i + 1}]
          </a>
        ))}
      </div>
    )
  }

  // 递归渲染目录树节点
  const renderTreeItem = (item: TreeItem, depth: number) => {
    const hasChildren = item.children.length > 0
    const isCollapsed = collapsed.has(item.id)
    const has = docMap.has(item.id)
    const active = selectedId === item.id
    return (
      <div key={item.id}>
        <div
          className={`group flex w-full items-center rounded-md text-left text-sm transition-colors ${
            active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary/60'
          }`}
          style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
        >
          {/* 折叠箭头（有子节点才显示） */}
          <button
            onClick={() => hasChildren && toggleCollapse(item.id)}
            className={`flex h-6 w-5 shrink-0 items-center justify-center text-xs text-muted-foreground transition-transform ${
              hasChildren ? 'cursor-pointer hover:text-foreground' : 'cursor-default opacity-0'
            } ${isCollapsed ? '' : 'rotate-90'}`}
            aria-label={hasChildren ? (isCollapsed ? '展开' : '折叠') : undefined}
          >
            ▶
          </button>
          {/* 节点主体：点击选中 */}
          <button
            onClick={() => setSelectedId(item.id)}
            className="flex min-w-0 flex-1 items-center justify-between py-1.5 pr-2"
          >
            <span className="truncate">{item.name}</span>
            <span className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${has ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
          </button>
        </div>
        {hasChildren && !isCollapsed && (
          <div>{item.children.map((child) => renderTreeItem(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  if (loading) {
    return <p className="mt-8 text-center text-sm text-muted-foreground">加载中…</p>
  }

  return (
    <div className="mx-auto max-w-6xl">
      {/* 顶栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">知识库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            根据知识图谱逐节点联网查询并总结生成的教材，含技术类 demo 代码。
          </p>
        </div>
        <Button onClick={generate} disabled={generating}>
          {generating ? '生成中…' : '一键生成知识库'}
        </Button>
      </div>

      {(progress || error) && (
        <p className={`mt-3 text-sm ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {error || progress}
        </p>
      )}

      {nodes.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-muted-foreground">图谱为空，请先在知识图谱中构建内容。</p>
        </div>
      ) : (
        <div className="mt-6 flex gap-6">
          {/* 左侧目录树（可折叠菜单） */}
          <aside className="w-64 shrink-0">
            <div className="sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                目录
              </div>
              <nav className="p-2">
                {tree.map((item) => renderTreeItem(item, 0))}
              </nav>
            </div>
          </aside>

          {/* 右侧正文 */}
          <main className="min-w-0 flex-1">
            {selectedNode ? (
              <article className="rounded-lg border border-border bg-card p-6">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">
                      {DOMAIN_LABEL[selectedNode.domain] ?? selectedNode.domain} · 难度 {selectedNode.level}
                    </div>
                    <h2 className="text-xl font-semibold tracking-tight">
                      {streamingId === selectedId && streamTitle
                        ? streamTitle.trim()
                        : (selectedDoc?.title ?? selectedNode.name)}
                    </h2>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => rebuild(selectedNode)}
                    disabled={rebuilding === selectedNode.id || generating}
                  >
                    {rebuilding === selectedNode.id ? '构建中…' : '重新构建'}
                  </Button>
                </div>

                {streamingId === selectedId ? (
                  // 流式生成中：实时渲染
                  <>
                    {streamContent ? (
                      <div
                        className="kb-content"
                        dangerouslySetInnerHTML={{ __html: marked.parse(streamContent) as string }}
                      />
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        正在生成教材，请稍候…
                        {streamTitle && <span className="ml-1 text-primary">{streamTitle}</span>}
                      </div>
                    )}
                    {streamCode && (
                      <div className="mt-4 overflow-hidden rounded-md border border-border bg-secondary/50">
                        <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">示例代码</div>
                        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
                          <code>{streamCode}</code>
                        </pre>
                      </div>
                    )}
                  </>
                ) : selectedDoc ? (
                  <>
                    {selectedDoc.content && (
                      <div
                        className="kb-content"
                        dangerouslySetInnerHTML={{ __html: marked.parse(selectedDoc.content) as string }}
                      />
                    )}
                    {selectedDoc.code && (
                      <div className="mt-4 overflow-hidden rounded-md border border-border bg-secondary/50">
                        <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">示例代码</div>
                        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
                          <code>{selectedDoc.code}</code>
                        </pre>
                      </div>
                    )}
                    {renderSources(selectedDoc.source_urls)}
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-10 text-center">
                    <p className="text-sm text-muted-foreground">
                      该节点尚未生成教材。点击右上角「一键生成知识库」批量生成，或点击上方「重新构建」单独生成。
                    </p>
                  </div>
                )}
              </article>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-10 text-center">
                <p className="text-muted-foreground">请从左侧目录选择节点查看教材。</p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}
