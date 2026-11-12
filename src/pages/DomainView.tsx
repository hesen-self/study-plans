import { useEffect, useState } from 'react'
import { api, Domain } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function DomainView() {
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 新增表单
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#378ADD')
  // 编辑中的领域（id -> 编辑态）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')

  const load = () => {
    api.domains().then((ds) => {
      setDomains(ds)
      setLoading(false)
    }).catch(() => {
      setError('加载领域失败')
      setLoading(false)
    })
  }

  useEffect(() => { load() }, [])

  const add = async () => {
    if (!newId.trim() || !newName.trim() || !newColor.trim()) {
      setError('请填写完整的领域信息')
      return
    }
    setError('')
    try {
      await api.createDomain({ id: newId.trim(), name: newName.trim(), color: newColor })
      setNewId(''); setNewName(''); setNewColor('#378ADD')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '新增失败（领域 id 可能已存在）')
    }
  }

  const startEdit = (d: Domain) => {
    setEditingId(d.id)
    setEditName(d.name)
    setEditColor(d.color)
  }

  const saveEdit = async (id: string) => {
    if (!editName.trim() || !editColor.trim()) return
    await api.updateDomain(id, { name: editName.trim(), color: editColor })
    setEditingId(null)
    load()
  }

  const remove = async (d: Domain) => {
    if (!confirm(`确认删除领域「${d.name}」？已有节点会保留其领域值，但不再显示中文名。`)) return
    await api.deleteDomain(d.id)
    load()
  }

  if (loading) return <p className="mt-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">领域管理</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        领域为学科粗分类，具体方向用标签二级细分。此处可增删改领域，图例与下拉选项会同步更新。
      </p>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {/* 新增领域 */}
      <div className="mt-6 rounded-lg border border-border bg-card p-4">
        <h3 className="text-lg font-medium">新增领域</h3>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">标识（英文）</label>
            <Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="如 cloud-native" className="w-40" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">中文名</label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 云原生" className="w-40" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">颜色</label>
            <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-9 w-16 cursor-pointer rounded-md border border-border" />
          </div>
          <Button onClick={add} disabled={!newId.trim() || !newName.trim()}>新增</Button>
        </div>
      </div>

      {/* 领域列表 */}
      <div className="mt-6 space-y-2">
        {domains.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
            {editingId === d.id ? (
              <>
                <span className="w-28 shrink-0 text-sm font-mono text-muted-foreground">{d.id}</span>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-44" />
                <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} className="h-9 w-16 cursor-pointer rounded-md border border-border" />
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => saveEdit(d.id)}>保存</Button>
                  <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>取消</Button>
                </div>
              </>
            ) : (
              <>
                <span
                  className="inline-block h-3.5 w-3.5 shrink-0 rounded-full"
                  style={{ backgroundColor: d.color }}
                />
                <span className="w-28 shrink-0 text-sm font-mono text-muted-foreground">{d.id}</span>
                <span className="text-sm font-medium">{d.name}</span>
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => startEdit(d)}>编辑</Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(d)}>删除</Button>
                </div>
              </>
            )}
          </div>
        ))}
        {domains.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            暂无领域，请新增。
          </p>
        )}
      </div>
    </div>
  )
}
