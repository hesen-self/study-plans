import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { findNavByPath } from './nav'
import { IconChevron, IconLogout, IconSidebar } from './icons'

type TopbarProps = {
  displayName: string
  email: string
  avatar?: string
  onToggleRail: () => void
  onLogout: () => void
}

export default function Topbar({ displayName, email, avatar = '', onToggleRail, onLogout }: TopbarProps) {
  const location = useLocation()
  const current = findNavByPath(location.pathname)
  const chipRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, right: 0 })

  const openMenu = () => {
    const rect = chipRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
    setMenuOpen(true)
  }

  const closeMenu = () => setMenuOpen(false)

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node
      if (chipRef.current?.contains(t) || menuRef.current?.contains(t)) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const initial = (displayName.trim() || email || '?').slice(0, 1).toUpperCase()

  return (
    <header className="topbar">
      <button type="button" className="shell-icon-btn" aria-label="切换导航" onClick={onToggleRail}>
        <IconSidebar size={18} />
      </button>
      <div className="crumbs" aria-label="当前位置">
        {current?.group && (
          <>
            <span>{current.group}</span>
            <IconChevron className="crumb-sep" />
          </>
        )}
        <span className="crumb-current">{current?.label ?? '学习提升'}</span>
      </div>
      <div className="spacer" />
      <button
        ref={chipRef}
        type="button"
        className="user-chip"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => (menuOpen ? closeMenu() : openMenu())}
      >
        <span className="user-avatar">
          {avatar ? (
            <img src={avatar} alt="" className="user-avatar-img" />
          ) : (
            initial
          )}
        </span>
        <span className="user-meta">
          <span className="user-name" style={{ display: 'block' }}>
            {displayName}
          </span>
          <span className="user-role" style={{ display: 'block' }}>
            {email}
          </span>
        </span>
      </button>

      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="menu-pop m-float"
            role="menu"
            style={{ top: pos.top, right: pos.right }}
          >
            <button
              type="button"
              className="menu-item is-danger"
              role="menuitem"
              onClick={() => {
                closeMenu()
                onLogout()
              }}
            >
              <IconLogout size={16} />
              退出登录
            </button>
          </div>,
          document.body
        )}
    </header>
  )
}
