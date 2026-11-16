export type NavItem = {
  to: string
  label: string
  group: string
  icon: 'graph' | 'roadmap' | 'knowledge' | 'stats' | 'domains' | 'profile'
}

export const navItems: NavItem[] = [
  { to: '/graph', label: '知识图谱', group: '学习', icon: 'graph' },
  { to: '/roadmap', label: '学习路线', group: '学习', icon: 'roadmap' },
  { to: '/knowledge', label: '知识库', group: '学习', icon: 'knowledge' },
  { to: '/stats', label: '打卡统计', group: '学习', icon: 'stats' },
  { to: '/domains', label: '领域管理', group: '管理', icon: 'domains' },
  { to: '/profile', label: '个人资料', group: '管理', icon: 'profile' },
]

export const navGroups = [
  { key: 'study', label: '学习', items: navItems.filter((i) => i.group === '学习') },
  { key: 'manage', label: '管理', items: navItems.filter((i) => i.group === '管理') },
]

export function findNavByPath(pathname: string): NavItem | undefined {
  return navItems.find((i) => i.to === pathname)
}
