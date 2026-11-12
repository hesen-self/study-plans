import { useState } from 'react'
import { api, DOMAIN_LABEL, Node } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

interface Props {
  node?: Node | null
  onClose: () => void
  onSaved: () => void
}

type Domain = Node['domain']
const DOMAINS = Object.keys(DOMAIN_LABEL) as Domain[]

export default function NodeEditor({ node, onClose, onSaved }: Props) {
  const isEdit = !!node
  const [name, setName] = useState(node?.name ?? '')
  const [domain, setDomain] = useState<Domain>(node?.domain ?? 'java-ai')
  const [level, setLevel] = useState(node?.level ?? 1)
  const [tags, setTags] = useState(() => {
    try { return node?.tags ? (JSON.parse(node.tags) as string[]).join(', ') : '' } catch { return '' }
  })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    const tagArr = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    const payload = {
      name: name.trim(),
      domain,
      level,
      tags: JSON.stringify(tagArr),
    }
    setSaving(true)
    try {
      if (isEdit && node) {
        await api.updateNode(node.id, payload)
      } else {
        const id = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        await api.createNode({ ...payload, id: id || `node-${Date.now()}` })
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-20 bg-black/25" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-[21] w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-lg">
        <h2 className="text-2xl font-semibold tracking-tight">{isEdit ? '编辑节点' : '新建节点'}</h2>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="知识点名称" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">领域</label>
            <Select value={domain} onChange={(e) => setDomain(e.target.value as Domain)} className="w-full">
              {DOMAINS.map((d) => <option key={d} value={d}>{DOMAIN_LABEL[d]}</option>)}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">等级</label>
            <Select value={String(level)} onChange={(e) => setLevel(Number(e.target.value))} className="w-full">
              <option value="1">1 入门</option>
              <option value="2">2 进阶</option>
              <option value="3">3 高级</option>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">标签（逗号分隔）</label>
            <Textarea value={tags} onChange={(e) => setTags(e.target.value)} className="min-h-[60px]" />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </>
  )
}
