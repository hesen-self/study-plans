import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { cn } from '@/lib/utils'
import GraphView from '@/pages/GraphView'
import RoadmapView from '@/pages/RoadmapView'
import StatsView from '@/pages/StatsView'
import ProfileView from '@/pages/ProfileView'

const navItems = [
  { to: '/graph', label: '知识图谱' },
  { to: '/roadmap', label: '学习路线' },
  { to: '/stats', label: '打卡统计' },
  { to: '/profile', label: '个人资料' },
]

export default function App() {
  return (
    <div className="flex h-screen">
      <aside className="w-[180px] shrink-0 border-r border-border bg-card px-3 py-5">
        <div className="px-3 pb-5 text-2xl font-semibold tracking-tight">学习提升</div>
        <nav className="flex flex-col gap-1">
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
      </aside>
      <main className="flex-1 overflow-auto p-5">
        <Routes>
          <Route path="/" element={<Navigate to="/graph" replace />} />
          <Route path="/graph" element={<GraphView />} />
          <Route path="/roadmap" element={<RoadmapView />} />
          <Route path="/stats" element={<StatsView />} />
          <Route path="/profile" element={<ProfileView />} />
        </Routes>
      </main>
    </div>
  )
}
