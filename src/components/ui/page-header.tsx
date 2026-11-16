import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PageHeaderProps = {
  title: string
  desc?: string
  children?: ReactNode
  className?: string
}

export function PageHeader({ title, desc, children, className }: PageHeaderProps) {
  return (
    <header className={cn('page-head', className)}>
      <div className="page-head-main">
        <h1 className="page-title">{title}</h1>
        {desc ? <p className="page-desc">{desc}</p> : null}
      </div>
      {children ? (
        <div className="page-head-side">
          <div className="page-actions">{children}</div>
        </div>
      ) : null}
    </header>
  )
}
