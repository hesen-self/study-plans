import { cn } from '@/lib/utils'

interface ProgressBarProps {
  /** 0~100，组件内部会裁剪并取整 */
  value: number
  label?: string
  hint?: string
  className?: string
  ariaLabel?: string
}

/**
 * 项目统一进度条：沿用 StatsView 原 GoalBar 的语义 Token 配色
 * （bg-secondary 底 + bg-primary 填充），不引入新的颜色变量或组件库。
 */
export function ProgressBar({ value, label, hint, className, ariaLabel }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className={cn('w-full', className)}>
      {(label || hint) && (
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span>{hint}</span>
        </div>
      )}
      <div
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label={ariaLabel ?? label ?? '进度'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
