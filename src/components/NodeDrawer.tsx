import { useEffect, useState } from 'react'
import { marked } from 'marked'
import { api, DOMAIN_LABEL, Node, Resource, STATUS_LABEL } from '../api'

interface Props {
  nodeId: string
  node: Node | null
  onClose: () => void
  onChanged: () => void
}

export default function NodeDrawer({ nodeId, node, onClose, onChanged }: Props) {
  const [note, setNote] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [resources, setResources] = useState<Resource[]>([])
  const [resTitle, setResTitle] = useState('')
  const [resUrl, setResUrl] = useState('')
  const [resKind, setResKind] = useState<Resource['kind']>('doc')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.note(nodeId).then((r) => setNote(r.content))
    api.resources(nodeId).then(setResources)
    setEditingNote(false)
  }, [nodeId])

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
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer">
        <h2>{node.name}</h2>
        <div className="meta">
          {DOMAIN_LABEL[node.domain]} · {['', '入门', '进阶', '高级'][node.level]} · {node.id}
        </div>
        <div style={{ marginBottom: 16 }}>
          {tags.map((t) => <span key={t} className="tag">{t}</span>)}
        </div>

        <section>
          <h3>学习状态</h3>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['todo', 'learning', 'done'] as const).map((s) => (
              <button key={s} className={node.status === s ? 'primary' : ''} onClick={() => updateStatus(s)}>
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="progress-bar" style={{ flex: 1 }}>
              <div style={{ width: `${node.progress}%` }} />
            </div>
            <span>{node.progress}%</span>
          </div>
          <input
            type="range" min={0} max={100} step={5} value={node.progress}
            style={{ width: '100%', marginTop: 8 }}
            onChange={(e) => updateProgress(Number(e.target.value))}
          />
        </section>

        <section>
          <h3>笔记</h3>
          {editingNote ? (
            <div className="note-editor">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="支持 Markdown…" />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="primary" onClick={saveNote} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
                <button onClick={() => setEditingNote(false)}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="note-preview"
                dangerouslySetInnerHTML={{ __html: note ? (marked.parse(note) as string) : '<i style="color:var(--text-2)">暂无笔记</i>' }}
              />
              <button style={{ marginTop: 6 }} onClick={() => setEditingNote(true)}>编辑</button>
            </>
          )}
        </section>

        <section>
          <h3>资源链接</h3>
          {resources.map((r) => (
            <div key={r.id} className="resource-item">
              <span className="tag">{r.kind}</span>
              <a href={r.url} target="_blank" rel="noreferrer" style={{ flex: 1 }}>{r.title}</a>
              <button className="danger" onClick={() => removeResource(r.id)}>删</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input placeholder="标题" value={resTitle} onChange={(e) => setResTitle(e.target.value)} style={{ width: 110 }} />
            <input placeholder="URL" value={resUrl} onChange={(e) => setResUrl(e.target.value)} style={{ flex: 1 }} />
            <select value={resKind} onChange={(e) => setResKind(e.target.value as Resource['kind'])}>
              <option value="doc">文档</option>
              <option value="video">视频</option>
              <option value="repo">仓库</option>
              <option value="article">文章</option>
            </select>
            <button className="primary" onClick={addResource}>加</button>
          </div>
        </section>
      </div>
    </>
  )
}
