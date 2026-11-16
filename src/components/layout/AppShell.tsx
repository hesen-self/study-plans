import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import Sidebar from './Sidebar'
import Topbar from './Topbar'

const RAIL_KEY = 'study.railCollapsed'

type AppShellProps = {
  email: string
  nickname: string
  onLogout: () => void
  children: ReactNode
}

export default function AppShell({ email, nickname, onLogout, children }: AppShellProps) {
  const location = useLocation()
  const displayName = nickname.trim() || email
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === '1'
    } catch {
      return false
    }
  })
  const [mobile, setMobile] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)')
    const sync = () => {
      setMobile(mq.matches)
      if (!mq.matches) setMobileOpen(false)
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // 路由切换后清顶栏凝结态；内容区 key 已强制滚回顶部
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 与 pathname 同步的 UI 复位，非外部订阅
    setScrolled(false)
  }, [location.pathname])

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [railCollapsed])

  const toggleRail = () => {
    if (mobile) setMobileOpen((v) => !v)
    else setRailCollapsed((v) => !v)
  }

  return (
    <div className="stage">
      <div
        className={cn(
          'app-frame',
          railCollapsed && !mobile && 'is-collapsed',
          mobile && mobileOpen && 'is-mobile-open'
        )}
      >
        <Sidebar displayName={displayName} onNavigate={() => setMobileOpen(false)} />
        {mobile && mobileOpen && (
          <div className="rail-scrim" aria-hidden="true" onClick={() => setMobileOpen(false)} />
        )}
        <div className={cn('workspace', scrolled && 'is-scrolled')}>
          <Topbar
            displayName={displayName}
            email={email}
            onToggleRail={toggleRail}
            onLogout={onLogout}
          />
          <main
            key={location.pathname}
            className="content"
            tabIndex={-1}
            onScroll={(e) => {
              const next = e.currentTarget.scrollTop > 8
              setScrolled((prev) => (prev === next ? prev : next))
            }}
          >
            <div className="page">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
