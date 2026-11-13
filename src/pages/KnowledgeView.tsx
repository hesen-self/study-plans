import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { marked } from 'marked'
import { api, DOMAIN_LABEL, KnowledgeDoc, KnowledgeJob } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { sanitizeHtml, safeHttpUrl } from '@/lib/sanitize'
import { downloadText } from '@/lib/utils'

marked.setOptions({ breaks: true })

type TreeNode = { id: string; name: string; domain: string; level: number; parent_ids: string[] }
type TreeItem = TreeNode & { children: TreeItem[] }

function docToMarkdown(d: KnowledgeDoc): string {
  const parts = [`# ${d.title || d.node_id}`, '']
  if (d.content) parts.push(d.content, '')
  if (d.code) parts.push('## 示例代码', '', '```', d.code, '```', '')
  try {
    const urls: unknown = JSON.parse(d.source_urls ?? '[]')
    if (Array.isArray(urls)) {
      const safe = urls
        .filter((u): u is string => typeof u === 'string')
        .map((u) => safeHttpUrl(u))
        .filter(Boolean)
      if (safe.length) parts.push('## 参考来源', '', ...safe.map((u, i) => `[${i + 1}] ${u}`), '')
    }
  } catch {
    // source_urls 非法 JSON，忽略
  }
  return parts.join('\n')
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'knowledge'
}

export default function KnowledgeView() {
  const [searchParams] = useSearchParams()
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 单节点流式重新构建
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [streamTitle, setStreamTitle] = useState('')
  const [streamContent, setStreamContent] = useState('')
  const [streamCode, setStreamCode] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 服务端批处理任务
  const [job, setJob] = useState<KnowledgeJob | null>(null)
  const [jobBusy, setJobBusy] = useState(false)
  const [autoContinue, setAutoContinue] = useState(true)
  // 人工编辑教材
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editCode, setEditCode] = useState('')
  const [savingDoc, setSavingDoc] = useState(false)

  const load = useCallback(async () => {
    setDocs(await api.knowledge())
  }, [])

  useEffect(() => {
    // activeKnowledgeJob 单独兜底：迁移未执行时也不阻塞页面加载
    const activeJob = api.activeKnowledgeJob().catch(() => ({ job: null }))
    Promise.all([api.knowledgeNodes(), api.knowledge(), activeJob])
      .then(([n, d, a]) => {
        setNodes(n)
        setDocs(d)
        if (a.job) setJob(a.job)
        const target = searchParams.get('node')
        if (target && n.some((item) => item.id === target)) setSelectedId(target)
        else if (n.length > 0) setSelectedId(n[0].id)
      })
      .catch(() => setError('加载知识库失败'))
      .finally(() => setLoading(false))
  }, [searchParams])

  const jobId = job?.id
  const jobStatus = job?.status
  const jobActive = jobStatus === 'running' || jobStatus === 'paused'

  // 轮询服务端任务状态；paused 表示本批次完成，自动续跑剩余章节
  useEffect(() => {
    if (!jobId || !jobActive) return
    // 手动续跑模式下暂停态不再空转轮询，等用户点「继续生成」后再恢复
    if (jobStatus === 'paused' && !autoContinue) return
    let stopped = false
    let timer = 0
    const tick = async () => {
      if (stopped) return
      try {
        const r = await api.knowledgeJob(jobId)
        if (stopped) return
        setJob(r.job)
        if (r.job.status === 'completed' || r.job.status === 'cancelled') {
          await load()
          setProgress(r.job.status === 'completed'
            ? `生成完成：${r.job.completed}/${r.job.total} 章，失败 ${r.job.failed} 章`
            : '任务已取消')
        } else if (r.job.status === 'paused' && autoContinue) {
          const resumed = await api.resumeKnowledgeJob(jobId)
          if (!stopped && resumed.job) setJob(resumed.job)
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : '任务状态获取失败')
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 1500)
    }
    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [jobId, jobStatus, jobActive, autoContinue, load])

  const docMap = useMemo(() => {
    const m = new Map<string, KnowledgeDoc>()
    for (const d of docs) m.set(d.node_id, d)
    return m
  }, [docs])

  // 根据 prerequisite 前置依赖构建树形目录（森林）
  const tree = useMemo(() => {
    const byId = new Map<string, TreeItem>(nodes.map((n) => [n.id, { ...n, children: [] }]))
    const roots: TreeItem[] = []
    for (const n of nodes) {
      const item = byId.get(n.id)!
      let parent: TreeItem | undefined
      for (const pid of n.parent_ids) {
        const p = byId.get(pid)
        if (p) { parent = p; break }
      }
      if (parent) parent.children.push(item)
      else roots.push(item)
    }
    return roots
  }, [nodes])

  const selectedDoc = selectedId ? docMap.get(selectedId) : undefined
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : undefined

  // 单节点流式生成：读取 SSE，实时更新标题/正文/代码
  const streamGenerate = async (nodeId: string, seq: number, detailed: boolean): Promise<boolean> => {
    setStreamingId(nodeId)
    setStreamTitle('')
    setStreamContent('')
    setStreamCode('')
    let ok = false
    try {
      const res = await api.streamGenerateKnowledgeNode(nodeId, seq, detailed)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = rawEvent.startsWith('data: ') ? rawEvent.slice(6) : rawEvent.startsWith('data:') ? rawEvent.slice(5) : rawEvent
          if (!line) continue
          try {
            const evt = JSON.parse(line) as { type: string; value?: string; message?: string }
            if (evt.type === 'title' && evt.value) setStreamTitle((p) => p + evt.value)
            else if (evt.type === 'content' && evt.value) setStreamContent((p) => p + evt.value)
            else if (evt.type === 'code' && evt.value) setStreamCode((p) => p + evt.value)
            else if (evt.type === 'done') ok = true
            else if (evt.type === 'error') setError(evt.message || '生成失败')
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

  // 一键生成 → 创建服务端任务；关页面后可从 active 任务恢复
  const startJob = async (rebuild: boolean) => {
    setJobBusy(true)
    setError('')
    setProgress('正在创建服务端生成任务…')
    try {
      if (nodes.length === 0) {
        setProgress('')
        setError('图谱为空，请先在知识图谱中构建内容')
        return
      }
      const r = await api.startKnowledgeJob({ rebuild })
      if (!r.ok || !r.job) {
        setError(r.error ?? '创建任务失败')
        setProgress('')
        return
      }
      setJob(r.job)
      setProgress(r.reused
        ? '已恢复进行中的生成任务'
        : `任务已创建：共 ${r.job.total} 章，服务端后台生成中（可关闭页面）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建任务失败')
      setProgress('')
    } finally {
      setJobBusy(false)
    }
  }

  const cancelJob = async () => {
    if (!jobId) return
    try {
      await api.cancelKnowledgeJob(jobId)
      const r = await api.knowledgeJob(jobId)
      setJob(r.job)
      setProgress('任务已取消，可重新发起以补齐缺失章节')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消任务失败')
    }
  }

  const resumeJob = async () => {
    if (!jobId) return
    try {
      const r = await api.resumeKnowledgeJob(jobId)
      if (r.job) setJob(r.job)
      setProgress('已继续生成剩余章节')
    } catch (e) {
      setError(e instanceof Error ? e.message : '继续任务失败')
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

  const openEdit = () => {
    if (!selectedDoc) return
    setEditTitle(selectedDoc.title)
    setEditContent(selectedDoc.content)
    setEditCode(selectedDoc.code)
    setEditing(true)
  }

  const saveEdit = async () => {
    if (!selectedDoc) return
    setSavingDoc(true)
    setError('')
    try {
      await api.updateKnowledgeDoc(selectedDoc.node_id, {
        title: editTitle, content: editContent, code: editCode,
      })
      setEditing(false)
      await load()
      setProgress('已保存教材修改（后续批量生成将跳过本章）')
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingDoc(false)
    }
  }

  const exportCurrent = () => {
    if (!selectedDoc) return
    downloadText(
      `${safeFileName(selectedDoc.title || selectedDoc.node_id)}.md`,
      docToMarkdown(selectedDoc),
      'text/markdown;charset=utf-8'
    )
  }

  const exportAll = () => {
    const sorted = [...docs].sort((a, b) => a.seq - b.seq)
    if (!sorted.length) {
      setError('暂无可导出的教材')
      return
    }
    const text = [
      '# 学习知识库', '',
      `导出时间：${new Date().toLocaleString('zh-CN')}`, '',
      ...sorted.flatMap((d) => [docToMarkdown(d), '---', '']),
    ].join('\n')
    downloadText('study-plans-knowledge.md', text, 'text/markdown;charset=utf-8')
    setProgress(`已导出 ${sorted.length} 章教材`)
  }

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderSources = (raw: string | null) => {
    let urls: unknown
    try {
      urls = JSON.parse(raw ?? '[]')
    } catch {
      return null
    }
    if (!Array.isArray(urls)) return null
    const safe = urls
      .filter((u): u is string => typeof u === 'string')
      .map((u) => safeHttpUrl(u))
      .filter(Boolean)
    if (!safe.length) return null
    return (
      <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="mr-1">参考来源：</span>
        {safe.map((u, i) => (
          <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 text-primary hover:underline">
            [{i + 1}]
          </a>
        ))}
      </div>
    )
  }

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
          <button
            onClick={() => hasChildren && toggleCollapse(item.id)}
            className={`flex h-6 w-5 shrink-0 items-center justify-center text-xs text-muted-foreground transition-transform ${
              hasChildren ? 'cursor-pointer hover:text-foreground' : 'cursor-default opacity-0'
            } ${isCollapsed ? '' : 'rotate-90'}`}
            aria-label={hasChildren ? (isCollapsed ? '展开' : '折叠') : undefined}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
          >
            ▶
          </button>
          <button
            onClick={() => { setSelectedId(item.id); setEditing(false) }}
            className="flex min-w-0 flex-1 items-center justify-between py-1.5 pr-2"
          >
            <span className="truncate">{item.name}</span>
            <span className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${has ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
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

  const percent = job?.total ? Math.round((job.completed / job.total) * 100) : 0

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">知识库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            服务端按拓扑序批量生成教材，任务可取消、可断点续跑；教材支持人工编辑与导出。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportAll} disabled={!docs.length}>导出整本</Button>
          <Button variant="outline" size="sm" onClick={() => startJob(true)} disabled={jobBusy || jobActive || !nodes.length}>
            重建全部
          </Button>
          <Button onClick={() => startJob(false)} disabled={jobBusy || jobActive || !nodes.length}>
            {jobActive ? '任务进行中' : jobBusy ? '创建中…' : '一键生成知识库'}
          </Button>
        </div>
      </div>

      {jobActive && job && (
        <div className="mt-3 rounded-lg border border-border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              服务端任务：{job.status === 'running' ? '生成中' : '本批完成，待续跑'} · {job.completed}/{job.total} 章 · 失败 {job.failed} 章
              {job.current_node && <span className="ml-2 text-muted-foreground">当前：{job.current_node}</span>}
            </span>
            <div className="flex gap-2">
              {job.status === 'paused' && !autoContinue && (
                <Button size="sm" onClick={resumeJob}>继续生成</Button>
              )}
              <Button variant="outline" size="sm" onClick={cancelJob}>取消任务</Button>
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoContinue}
              onChange={(e) => setAutoContinue(e.target.checked)}
              className="accent-primary"
            />
            自动续跑剩余章节（关闭后需手动点「继续生成」）
          </label>
        </div>
      )}

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

          <main className="min-w-0 flex-1">
            {selectedNode ? (
              <article className="rounded-lg border border-border bg-card p-6">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">
                      {DOMAIN_LABEL[selectedNode.domain] ?? selectedNode.domain} · 难度 {selectedNode.level}
                      {selectedDoc?.is_edited === 1 && <span className="ml-2 text-primary">已人工编辑</span>}
                    </div>
                    <h2 className="text-xl font-semibold tracking-tight">
                      {streamingId === selectedId && streamTitle
                        ? streamTitle.trim()
                        : (selectedDoc?.title ?? selectedNode.name)}
                    </h2>
                  </div>
                  <div className="flex gap-2">
                    {selectedDoc && !editing && streamingId !== selectedId && (
                      <>
                        <Button variant="outline" size="sm" onClick={exportCurrent}>导出本章</Button>
                        <Button variant="outline" size="sm" onClick={openEdit}>编辑</Button>
                      </>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => rebuild(selectedNode)}
                      disabled={rebuilding === selectedNode.id || jobActive || streamingId !== null}
                    >
                      {rebuilding === selectedNode.id ? '构建中…' : '重新构建'}
                    </Button>
                  </div>
                </div>

                {streamingId === selectedId ? (
                  <>
                    {streamContent ? (
                      <div
                        className="kb-content"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parse(streamContent) as string) }}
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
                        <pre className="overflow-x-auto p-3 text-xs leading-relaxed"><code>{streamCode}</code></pre>
                      </div>
                    )}
                  </>
                ) : editing && selectedDoc ? (
                  <div className="space-y-3">
                    <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} aria-label="章节标题" />
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="min-h-[320px] font-mono"
                      aria-label="章节正文（Markdown）"
                    />
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">示例代码</label>
                      <Textarea
                        value={editCode}
                        onChange={(e) => setEditCode(e.target.value)}
                        className="min-h-[120px] font-mono"
                        aria-label="示例代码"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={saveEdit} disabled={savingDoc}>{savingDoc ? '保存中…' : '保存'}</Button>
                      <Button variant="outline" onClick={() => setEditing(false)}>取消</Button>
                    </div>
                  </div>
                ) : selectedDoc ? (
                  <>
                    {selectedDoc.content && (
                      <div
                        className="kb-content"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parse(selectedDoc.content) as string) }}
                      />
                    )}
                    {selectedDoc.code && (
                      <div className="mt-4 overflow-hidden rounded-md border border-border bg-secondary/50">
                        <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">示例代码</div>
                        <pre className="overflow-x-auto p-3 text-xs leading-relaxed"><code>{selectedDoc.code}</code></pre>
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
