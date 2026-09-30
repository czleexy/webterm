/**
 * 骨架屏（阶段 8）。
 *
 * 只做一件事：在「内容还没到」的那段时间里给出结构占位，让等待有形状。
 * 比转圈好在两点 —— 不会让布局在内容到达时跳一下；用户能预判马上要出现什么。
 *
 * 强调「这段时间」是真的短：连接建立通常在百毫秒级，骨架屏闪一下反而像卡顿。
 * 因此 `Skeleton` 支持 `delayMs`，默认 220ms —— 早于这个时间就绪的话
 * 用户根本看不到占位，感知上就是「秒开」。
 */
import { useEffect, useState } from 'react'
import { cn } from '../utils/cn'

interface SkeletonProps {
  className?: string
  /** 多少毫秒后才真正显示；早于此时长完成加载则完全不出现（避免闪烁） */
  delayMs?: number
}

/** 单条占位块 */
export function Skeleton({ className, delayMs = 220 }: SkeletonProps) {
  const [shown, setShown] = useState(delayMs <= 0)

  useEffect(() => {
    if (delayMs <= 0) return
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs])

  if (!shown) return null
  return (
    <span
      className={cn(
        'block animate-pulse rounded bg-neutral-200 dark:bg-neutral-800',
        className,
      )}
    />
  )
}

interface SkeletonBlockProps {
  /** 行数 */
  lines?: number
  className?: string
  delayMs?: number
  /** 装饰性占位，屏幕阅读器应忽略 */
  label?: string
}

/**
 * 多行占位块。
 *
 * 宽度刻意做成不等长的比例而不是满宽 —— 等长的方块看起来像表格，
 * 不等长才像「一段文字」。
 */
const WIDTHS = ['w-full', 'w-11/12', 'w-4/5', 'w-full', 'w-9/12', 'w-10/12']

export function SkeletonBlock({ lines = 3, className, delayMs = 220, label }: SkeletonBlockProps) {
  return (
    <div
      className={cn('space-y-2', className)}
      data-testid="skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3', WIDTHS[index % WIDTHS.length])} delayMs={delayMs} />
      ))}
    </div>
  )
}
