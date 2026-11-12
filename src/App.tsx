import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { api } from '@/api'
import GraphView from '@/pages/GraphView'
import RoadmapView from '@/pages/RoadmapView'
import StatsView from '@/pages/StatsView'
import ProfileView from '@/pages/ProfileView'
import KnowledgeView from '@/pages/KnowledgeView'
import DomainView from '@/pages/DomainView'
import LoginView from '@/pages/LoginView'

const navItems = [
  { to: '/graph', label: '知识图谱' },
  { to: '/roadmap', label: '学习路线' },
  { to: '/knowledge', label: '知识库' },
  { to: '/stats', label: '打卡统计' },
  { to: '/domains', label: '领域管理' },
  { to: '/profile', label: '个人资料' },
]

export default function App() {
  const [authStatus, setAuthStatus] = useState<'loading' | 'authed' | 'guest'>('loading')
  const [email, setEmail] = useState('')

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.authMe()
      if (me.authenticated) {
        setEmail(me.email)
        setAuthStatus('authed')
      } else {
        setAuthStatus('guest')
      }
    } catch {
      setAuthStatus('guest')
    }
  }, [])

  useEffect(() => {
    // 挂载时异步获取登录态，setState 发生在 await 之后，非同步级联渲染
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkAuth()
  }, [checkAuth])

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      setAuthStatus('guest')
      setEmail('')
    }
  }

  if (authStatus === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">加载中…</p>
      </div>
    )
  }

  if (authStatus === 'guest') {
    return <LoginView onLogin={checkAuth} />
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-border bg-card px-3 py-5">
        <div className="px-3 pb-5 text-2xl font-semibold tracking-tight">学习提升</div>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2.5 text-sm transition-colors',
                  isActive
                    ? 'bg-secondary font-medium text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border px-3 pt-3">
          <p className="mb-2 truncate text-xs text-muted-foreground">{email}</p>
          <button
            onClick={logout}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-5">
        <Routes>
          <Route path="/" element={<Navigate to="/graph" replace />} />
          <Route path="/graph" element={<GraphView />} />
          <Route path="/roadmap" element={<RoadmapView />} />
          <Route path="/knowledge" element={<KnowledgeView />} />
          <Route path="/stats" element={<StatsView />} />
          <Route path="/domains" element={<DomainView />} />
          <Route path="/profile" element={<ProfileView />} />
        </Routes>
      </main>
    </div>
  )
}
