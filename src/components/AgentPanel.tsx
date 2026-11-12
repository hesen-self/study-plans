import { useState } from 'react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  onBuilt: () => void
}

type WebHit = { url: string; title: string; description?: string }

export default function AgentPanel({ onBuilt }: Props) {
  const [mode, setMode] = useState<'search' | 'build'>('build')
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState('')
  const [hits, setHits] = useState<WebHit[] | null>(null)
  const [building, setBuilding] = useState(false)
  const [searching, setSearching] = useState(false)
  const [buildMsg, setBuildMsg] = useState('')

  const doSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const r = await api.webSearch(query.trim())
      setHits(r.results)
    } catch (e) {
      setBuildMsg(e instanceof Error ? e.message : '联网搜索失败')
      setHits(null)
    } finally {
      setSearching(false)
    }
  }

  const doBuild = async () => {
    if (!topic.trim()) return
    setBuilding(true)
    setBuildMsg('')
    try {
      const r = await api.buildGraph(topic.trim())
      setBuildMsg(`构建完成：新增 ${r.nodes} 个节点、${r.edges} 条连线`)
      setTopic('')
      onBuilt()
    } catch (e) {
      setBuildMsg(e instanceof Error ? e.message : '构建失败')
    } finally {
      setBuilding(false)
    }
  }

  return (
    <div>
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setMode('build')}
          className={`rounded-md px-3 py-1 text-sm ${mode === 'build' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
        >
          智能对话构建图谱
        </button>
        <button
          onClick={() => setMode('search')}
          className={`rounded-md px-3 py-1 text-sm ${mode === 'search' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
        >
          联网搜索
        </button>
      </div>

      {mode === 'build' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            用一句话描述你想学习的方向，我会自动拆解知识点、联网搜索并构建知识图谱。
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="例如：我想系统地学习 Java + AI 应用开发"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doBuild()}
              disabled={building}
              className="flex-1"
            />
            <Button onClick={doBuild} disabled={building || !topic.trim()}>
              {building ? '构建中…' : '构建图谱'}
            </Button>
          </div>
          {building && <p className="text-sm text-muted-foreground">正在分析拆解主题并联网搜索，通常需要 10~30 秒…</p>}
          {buildMsg && <p className="text-sm">{buildMsg}</p>}
        </div>
      )}

      {mode === 'search' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">联网搜索当前信息，结果来自 Web Search API。</p>
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
          {hits && (
            <div className="max-h-72 overflow-y-auto space-y-1">
              {hits.length === 0 && <p className="text-sm text-muted-foreground">无结果</p>}
              {hits.map((h, i) => (
                <a
                  key={i}
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="font-medium text-primary">{h.title}</span>
                  {h.description && <span className="block text-xs text-muted-foreground line-clamp-2">{h.description}</span>}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
