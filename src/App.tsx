import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from '@/api'
import AppShell from '@/components/layout/AppShell'
import GraphView from '@/pages/GraphView'
import RoadmapView from '@/pages/RoadmapView'
import StatsView from '@/pages/StatsView'
import ProfileView from '@/pages/ProfileView'
import KnowledgeView from '@/pages/KnowledgeView'
import DomainView from '@/pages/DomainView'
import LoginView from '@/pages/LoginView'

export default function App() {
  const [authStatus, setAuthStatus] = useState<'loading' | 'authed' | 'guest'>('loading')
  const [email, setEmail] = useState('')
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('')

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.authMe()
      if (me.authenticated) {
        setEmail(me.email)
        setNickname(me.nickname ?? '')
        setAvatar(me.avatar ?? '')
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

  // 资料保存后只刷新昵称/头像：不重判登录态，网络抖动时也不会把用户踢回登录页
  const refreshIdentity = useCallback(async () => {
    try {
      const me = await api.authMe()
      if (me.authenticated) {
        setNickname(me.nickname ?? '')
        setAvatar(me.avatar ?? '')
      }
    } catch {
      // 保留当前昵称、头像与登录态
    }
  }, [])

  // 任意 API 返回 401（会话过期）时统一回到登录页；资料页保存后立即刷新顶栏显示
  useEffect(() => {
    const onUnauthorized = () => {
      setAuthStatus('guest')
      setEmail('')
      setNickname('')
      setAvatar('')
    }
    const onProfileUpdated = () => {
      void refreshIdentity()
    }
    window.addEventListener('app:unauthorized', onUnauthorized)
    window.addEventListener('app:profile-updated', onProfileUpdated)
    return () => {
      window.removeEventListener('app:unauthorized', onUnauthorized)
      window.removeEventListener('app:profile-updated', onProfileUpdated)
    }
  }, [refreshIdentity])

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      setAuthStatus('guest')
      setEmail('')
      setNickname('')
      setAvatar('')
    }
  }

  if (authStatus === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--stage)' }}>
        <p className="text-sm text-muted-foreground">加载中…</p>
      </div>
    )
  }

  if (authStatus === 'guest') {
    return <LoginView onLogin={checkAuth} />
  }

  return (
    <AppShell email={email} nickname={nickname} avatar={avatar} onLogout={() => void logout()}>
      <Routes>
        <Route path="/" element={<Navigate to="/graph" replace />} />
        <Route path="/graph" element={<GraphView />} />
        <Route path="/roadmap" element={<RoadmapView />} />
        <Route path="/knowledge" element={<KnowledgeView />} />
        <Route path="/stats" element={<StatsView />} />
        <Route path="/domains" element={<DomainView />} />
        <Route path="/profile" element={<ProfileView />} />
      </Routes>
    </AppShell>
  )
}
