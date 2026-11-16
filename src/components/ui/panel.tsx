import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PanelProps = {
  title?: string
  meta?: string
  tools?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  flush?: boolean
}

export function Panel({
  title,
  meta,
  tools,
  children,
  className,
  bodyClassName,
  flush = false,
}: PanelProps) {
  const showHead = Boolean(title || meta || tools)

  return (
    <section className={cn('panel m-surface', className)}>
      {showHead ? (
        <header className="panel-head">
          <div className="flex min-w-0 items-baseline gap-3">
            {title ? <h2 className="section-label">{title}</h2> : null}
            {meta ? <span className="panel-meta">{meta}</span> : null}
          </div>
          {tools ? <div className="panel-tools">{tools}</div> : null}
        </header>
      ) : null}
      <div
        className={cn(
          flush ? 'panel-body is-flush' : 'panel-body',
          !showHead && !flush && 'pt-5',
          bodyClassName
        )}
      >
        {children}
      </div>
    </section>
  )
}
