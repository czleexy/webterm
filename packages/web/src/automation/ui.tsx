/**
 * 自动化面板里共用的样式常量与小组件。
 *
 * 抽出来的理由很实际：四个分区加起来有二十多个输入框、十几种按钮，
 * 各自写一份 className 的结果一定是「某个分区的主按钮颜色和别处不一样」。
 */
import type { ReactNode } from 'react'
import { cn } from '../utils/cn'

export const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500'

export const monoInputClass = `${inputClass} font-mono text-[12px]`

export const labelClass = 'mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400'

export const hintClass = 'mt-1 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400'

export const primaryButtonClass =
  'rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300'

export const secondaryButtonClass =
  'rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'

export const dangerButtonClass =
  'rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40'

export const cardClass =
  'rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'

/** 小号状态徽标 */
export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet'
  title?: string
}) {
  const tones: Record<string, string> = {
    neutral:
      'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
    green:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400',
    amber:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    red: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
    blue: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-400',
    violet:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-400',
  }
  return (
    <span
      title={title}
      className={cn(
        'shrink-0 rounded border px-1.5 py-px text-[10px] leading-none',
        tones[tone] ?? tones.neutral,
      )}
    >
      {children}
    </span>
  )
}

/** 分区顶部的标题栏 */
export function SectionHeader({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{title}</h3>
        <p className="mt-0.5 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** 空态占位 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      {children}
    </div>
  )
}
