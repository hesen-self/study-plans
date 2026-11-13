import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { marked } from 'marked'
import { api, DOMAIN_LABEL, Node, Resource, STATUS_LABEL } from '@/api'
import { sanitizeHtml, safeHttpUrl } from '@/lib/sanitize'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

interface Props {
  nodeId: string
  node: Node | null
  onClose: () => void
  onChanged: () => void
}

export default function NodeDrawer({ nodeId, node, onClose, onChanged }: Props) {
  const navigate = useNavigate()
  const [note, setNote] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [resources, setResources] = useState<Resource[]>([])
  const [resTitle, setResTitle] = useState('')
  const [resUrl, setResUrl] = useState('')
  const [resKind, setResKind] = useState<Resource['kind']>('doc')
  const [saving, setSaving] = useState(false)
  // 进度滑杆：本地值即时响应拖动，PATCH 防抖 300ms，避免每 5% 打一次接口
  const [localProgress, setLocalProgress] = useState(node?.progress ?? 0)
  const progressTimer = useRef<number | null>(null)

  useEffect(() => {
    api.note(nodeId).then((r) => setNote(r.content))
    api.resources(nodeId).then(setResources)
  }, [nodeId])

  useEffect(() => {
    // 外部（打卡驱动等）更新进度时同步到滑杆
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalProgress(node?.progress ?? 0)
  }, [node?.progress, nodeId])

  useEffect(() => () => {
    if (progressTimer.current !== null) window.clearTimeout(progressTimer.current)
  }, [])

  if (!node) return null

  const updateStatus = async (status: Node['status']) => {
    const progress = status === 'done' ? 100 : status === 'todo' ? 0 : node.progress
    await api.updateNode(nodeId, { status, progress })
    onChanged()
  }

  const updateProgress = async (progress: number) => {
    const status = progress >= 100 ? 'done' : progress > 0 ? 'learning' : 'todo'
    await api.updateNode(nodeId, { progress, status })
    onChanged()
  }

  const onProgressInput = (value: number) => {
    setLocalProgress(value)
    if (progressTimer.current !== null) window.clearTimeout(progressTimer.current)
    progressTimer.current = window.setTimeout(() => {
      void updateProgress(value).catch(() => setLocalProgress(node?.progress ?? 0))
    }, 300)
  }

  const saveNote = async () => {
    setSaving(true)
    await api.saveNote(nodeId, note)
    setSaving(false)
    setEditingNote(false)
  }

  const addResource = async () => {
    if (!resTitle.trim() || !resUrl.trim()) return
    await api.addResource({ node_id: nodeId, title: resTitle.trim(), url: resUrl.trim(), kind: resKind })
    setResTitle(''); setResUrl('')
    api.resources(nodeId).then(setResources)
  }

  const removeResource = async (id: number) => {
    await api.deleteResource(id)
    api.resources(nodeId).then(setResources)
  }

  let tags: string[] = []
  try { tags = node.tags ? JSON.parse(node.tags) : [] } catch { /* ignore */ }

  return (
    <>
      <div className="fixed inset-0 z-10 bg-black/25" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-[11] w-[440px] max-w-[90vw] overflow-y-auto border-l border-border bg-card p-5 shadow-lg">
        <h2 className="text-2xl font-semibold tracking-tight">{node.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {DOMAIN_LABEL[node.domain]} · {['', '入门', '进阶', '高级'][node.level]} · {node.id}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="mt-4 w-full"
          onClick={() => navigate(`/knowledge?node=${encodeURIComponent(nodeId)}`)}
        >
          查看知识库明细
        </Button>

        <section className="mt-5">
          <h3 className="text-lg font-medium">学习状态</h3>
          <div className="mt-2 flex gap-2">
            {(['todo', 'learning', 'done'] as const).map((s) => (
              <Button
                key={s}
                variant={node.status === s ? 'default' : 'outline'}
                onClick={() => updateStatus(s)}
              >
                {STATUS_LABEL[s]}
              </Button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary" style={{ width: `${localProgress}%` }} />
            </div>
            <span className="text-sm text-muted-foreground">{localProgress}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={localProgress}
            className="mt-2 w-full accent-primary"
            aria-label="学习进度"
            onChange={(e) => onProgressInput(Number(e.target.value))}
          />
        </section>

        <section className="mt-5">
          <h3 className="text-lg font-medium">笔记</h3>
          {editingNote ? (
            <div className="mt-2">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="支持 Markdown…"
                className="min-h-[200px] font-mono"
              />
              <div className="mt-2 flex gap-2">
                <Button onClick={saveNote} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
                <Button variant="outline" onClick={() => setEditingNote(false)}>取消</Button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="mt-2 min-h-[100px] rounded-lg border border-border p-3 text-sm"
                dangerouslySetInnerHTML={{
                  __html: note
                    ? sanitizeHtml(marked.parse(note) as string)
                    : '<i class="text-muted-foreground">暂无笔记</i>',
                }}
              />
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setEditingNote(true)}>
                编辑
              </Button>
            </>
          )}
        </section>

        <section className="mt-5">
          <h3 className="text-lg font-medium">资源链接</h3>
          <div className="mt-2">
            {resources.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 border-b border-dashed border-border py-1.5"
              >
                <Badge variant="secondary">{r.kind}</Badge>
                <a
                  href={safeHttpUrl(r.url) || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-sm text-primary hover:underline"
                >
                  {r.title}
                </a>
                <Button variant="ghost" size="sm" onClick={() => removeResource(r.id)}>删</Button>
              </div>
            ))}
            <div className="mt-3 flex gap-2">
              <Input
                placeholder="标题"
                value={resTitle}
                onChange={(e) => setResTitle(e.target.value)}
                className="w-28"
              />
              <Input
                placeholder="URL"
                value={resUrl}
                onChange={(e) => setResUrl(e.target.value)}
                className="flex-1"
              />
              <Select
                value={resKind}
                onChange={(e) => setResKind(e.target.value as Resource['kind'])}
                className="w-24"
              >
                <option value="doc">文档</option>
                <option value="video">视频</option>
                <option value="repo">仓库</option>
                <option value="article">文章</option>
              </Select>
              <Button onClick={addResource}>加</Button>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
