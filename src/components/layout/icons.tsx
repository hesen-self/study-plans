import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    ...props,
  }
}

export function IconGraph(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 11.2 15.5 7.2M8.2 12.8 15.5 16.8" />
    </svg>
  )
}

export function IconRoadmap(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h10M4 12h16M4 18h8" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </svg>
  )
}

export function IconKnowledge(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
      <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v16h5.5A2.5 2.5 0 0 1 20 21.5z" />
    </svg>
  )
}

export function IconStats(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 19h16" />
      <path d="M7 16V9M12 16V5M17 16v-4" />
    </svg>
  )
}

export function IconDomains(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  )
}

export function IconProfile(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19.5c1.8-3.2 4.2-4.5 7-4.5s5.2 1.3 7 4.5" />
    </svg>
  )
}

export function IconSidebar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15" />
    </svg>
  )
}

export function IconLogout(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" />
      <path d="M14 8l4 4-4 4M18 12H9" />
    </svg>
  )
}

export function IconChevron(props: IconProps) {
  return (
    <svg {...base({ size: 12, ...props })}>
      <path d="M9 5l5 5-5 5" />
    </svg>
  )
}

const iconMap = {
  graph: IconGraph,
  roadmap: IconRoadmap,
  knowledge: IconKnowledge,
  stats: IconStats,
  domains: IconDomains,
  profile: IconProfile,
} as const

export function NavIcon({ name, ...props }: { name: keyof typeof iconMap } & IconProps) {
  const Comp = iconMap[name]
  return <Comp {...props} />
}
