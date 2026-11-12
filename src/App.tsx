import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import GraphView from './pages/GraphView'
import RoadmapView from './pages/RoadmapView'
import StatsView from './pages/StatsView'

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">学习提升</div>
        <nav>
          <NavLink to="/graph">知识图谱</NavLink>
          <NavLink to="/roadmap">学习路线</NavLink>
          <NavLink to="/stats">打卡统计</NavLink>
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/graph" replace />} />
          <Route path="/graph" element={<GraphView />} />
          <Route path="/roadmap" element={<RoadmapView />} />
          <Route path="/stats" element={<StatsView />} />
        </Routes>
      </main>
    </div>
  )
}
