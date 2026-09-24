import { cn } from '../utils/cn'

export type DotTone = 'neutral' | 'success' | 'danger' | 'warning'

const TONE_CLASS: Record<DotTone, string> = {
  neutral: 'bg-neutral-400 dark:bg-neutral-500',
  success: 'bg-emerald-500',
  danger: 'bg-red-500',
  warning: 'bg-amber-500',
}

interface StatusDotProps {
  tone: DotTone
  label: string
  pulse?: boolean
}

export function StatusDot({ tone, label, pulse = false }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">
      <span className="relative flex size-2">
        {pulse ? (
          <span
            className={cn(
              'absolute inline-flex size-full animate-ping rounded-full opacity-60',
              TONE_CLASS[tone],
            )}
          />
        ) : null}
        <span
          className={cn('relative inline-flex size-2 rounded-full', TONE_CLASS[tone])}
        />
      </span>
      {label}
    </span>
  )
}
