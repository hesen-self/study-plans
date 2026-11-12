import { useState } from 'react'
import { api, Edge, Node } from '@/api'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

interface Props {
  nodes: Node[]
  onClose: () => void
  onSaved: () => void
}

const EDGE_TYPES: { value: Edge['type']; label: string }[] = [
  { value: 'prerequisite', label: '前置' },
  { value: 'related', label: '相关' },
  { value: 'extend', label: '扩展' },
]

export default function EdgeEditor({ nodes, onClose, onSaved }: Props) {
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [type, setType] = useState<Edge['type']>('prerequisite')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!source || !target || source === target) return
    setSaving(true)
    try {
      await api.createEdge({ source, target, type })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const opts = (exclude?: string) =>
    nodes.filter((n) => n.id !== exclude).map((n) => (
      <option key={n.id} value={n.id}>{n.name}</option>
    ))

  return (
    <>
      <div className="fixed inset-0 z-20 bg-black/25" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-[21] w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-lg">
        <h2 className="text-2xl font-semibold tracking-tight">新建连线</h2>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">起点</label>
            <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-full">
              <option value="">选择节点…</option>
              {opts(target)}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">终点</label>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full">
              <option value="">选择节点…</option>
              {opts(source)}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">关系类型</label>
            <Select value={type} onChange={(e) => setType(e.target.value as Edge['type'])} className="w-full">
              {EDGE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={saving || !source || !target || source === target}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </>
  )
}
