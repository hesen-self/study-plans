import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { navGroups } from './nav'
import { NavIcon } from './icons'

type SidebarProps = {
  displayName: string
  onNavigate?: () => void
}

export default function Sidebar({ displayName, onNavigate }: SidebarProps) {
  const location = useLocation()
  const navRef = useRef<HTMLElement>(null)
  const [thumbY, setThumbY] = useState(0)
  const [thumbVisible, setThumbVisible] = useState(false)

  const syncThumb = () => {
    const nav = navRef.current
    if (!nav) return
    const active = nav.querySelector<HTMLElement>('.nav-item.is-active')
    if (!active) {
      setThumbVisible(false)
      return
    }
    const navBox = nav.getBoundingClientRect()
    const itemBox = active.getBoundingClientRect()
    setThumbY(itemBox.top - navBox.top + nav.scrollTop)
    setThumbVisible(true)
  }

  useLayoutEffect(() => {
    syncThumb()
  }, [location.pathname])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const ro = new ResizeObserver(() => syncThumb())
    ro.observe(nav)
    nav.addEventListener('scroll', syncThumb, { passive: true })
    return () => {
      ro.disconnect()
      nav.removeEventListener('scroll', syncThumb)
    }
  }, [])

  return (
    <aside className="rail m-rail" aria-label="主导航">
      <div className="rail-brand">
        <span className="brand-mark" aria-hidden="true">
          <img src="/favicon.svg" alt="" width={34} height={34} className="brand-mark-img" />
        </span>
        <div className="brand-text">
          <div className="brand-name">学习提升</div>
          <div className="brand-sub">Study Plans</div>
        </div>
      </div>

      <nav ref={navRef} className="rail-nav">
        {thumbVisible && (
          <span
            className="nav-thumb m-pill"
            aria-hidden="true"
            style={{ transform: `translateY(${thumbY}px)` }}
          />
        )}
        {navGroups.map((group) => (
          <div key={group.key} className="nav-group">
            <div className="nav-group-title">{group.label}</div>
            <div className="nav-list">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  title={item.label}
                  onClick={onNavigate}
                  className={({ isActive }) => cn('nav-item', isActive && 'is-active')}
                >
                  <NavIcon name={item.icon} className="nav-ico" size={18} />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="rail-foot">
        <p className="rail-foot-user" title={displayName}>
          {displayName}
        </p>
      </div>
    </aside>
  )
}
