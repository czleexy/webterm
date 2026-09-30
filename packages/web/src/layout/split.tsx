/**
 * 分屏网格的纯计算与分隔条。
 *
 * 布局参数（哪些终端在哪个格子、分隔条在哪）由 useLayoutStore 管，
 * 这里只把它们翻译成 CSS Grid 的模板与 grid-area —— 纯函数，
 * 方便 E2E 直接对着断言，不需要经过真实拖拽。
 */
import { useCallback, useRef } from 'react'
import { RATIO_MAX, RATIO_MIN, type LayoutMode } from './useLayoutStore'
import { t } from '../i18n'
import { cn } from '../utils/cn'

/** 分隔条占用的网格尺寸（像素） */
export const DIVIDER_SIZE = 5

export interface GridTemplate {
  gridTemplateColumns: string
  gridTemplateRows: string
}

export function gridTemplate(mode: LayoutMode, ratioX: number, ratioY: number): GridTemplate {
  const x = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratioX))
  const y = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratioY))
  const columns = `${x}fr ${DIVIDER_SIZE}px ${1 - x}fr`
  if (mode === 'split-2') return { gridTemplateColumns: columns, gridTemplateRows: '1fr' }
  if (mode === 'grid-4') {
    return { gridTemplateColumns: columns, gridTemplateRows: `${y}fr ${DIVIDER_SIZE}px ${1 - y}fr` }
  }
  return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
}

/**
 * 每个格子的 grid-area。
 * 行列都是「1 格子 / 2 分隔条 / 3 格子」，所以格子索引 → 行列坐标是固定映射。
 */
export function slotArea(mode: LayoutMode, index: number): string {
  if (mode === 'single') return '1 / 1 / 2 / 2'
  if (mode === 'split-2') return index === 0 ? '1 / 1 / 2 / 2' : '1 / 3 / 2 / 4'
  const areas = ['1 / 1 / 2 / 2', '1 / 3 / 2 / 4', '3 / 1 / 4 / 2', '3 / 3 / 4 / 4']
  return areas[index] ?? '1 / 1 / 2 / 2'
}

/** 空格占位（显示「选择一个会话」）的 grid-area，与真实格子共用一套坐标 */
export function emptySlotArea(mode: LayoutMode, index: number): string {
  return slotArea(mode, index)
}

export interface DividerSpec {
  id: string
  axis: 'x' | 'y'
  area: string
}

/**
 * 分隔条：四宫格是十字。
 *
 * 十字用**四段**拼出来，中间交叉点留空 —— 若让竖条贯穿整列、横条贯穿整行，
 * 两根条会在正中重叠，后渲染的横条压在上面：用户看着是竖条，一按下去抓到的
 * 却是横条，于是「拖竖条改列宽」变成「改行高」，越是往中间拖越明显。
 * 拆段后每根条只占自己那半段，交叉点由网格底色补齐，视觉上仍是连通的十字。
 */
export function dividerSpecs(mode: LayoutMode): DividerSpec[] {
  if (mode === 'split-2') return [{ id: 'col', axis: 'x', area: '1 / 2 / 2 / 3' }]
  if (mode === 'grid-4') {
    return [
      { id: 'col-top', axis: 'x', area: '1 / 2 / 2 / 3' },
      { id: 'col-bottom', axis: 'x', area: '3 / 2 / 4 / 3' },
      { id: 'row-left', axis: 'y', area: '2 / 1 / 3 / 2' },
      { id: 'row-right', axis: 'y', area: '2 / 3 / 3 / 4' },
    ]
  }
  return []
}

interface DividerProps {
  axis: 'x' | 'y'
  area: string
  ratio: number
  onRatio: (ratio: number) => void
}

/**
 * 可拖拽的分隔条。
 *
 * 用原生鼠标事件而不是指针事件：终端里到处是鼠标交互（选区、链接），
 * 指针捕获一旦泄漏就会让终端「点不动」。这里在 mouseup 时无条件移除监听，
 * 不用 setPointerCapture，避免和 xterm 的选区逻辑打架。
 */
export function Divider({ axis, area, ratio, onRatio }: DividerProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const container = ref.current?.parentElement
      if (!container) return
      e.preventDefault()
      draggingRef.current = true
      const rect = container.getBoundingClientRect()

      const move = (event: MouseEvent) => {
        if (!draggingRef.current) return
        const next =
          axis === 'x'
            ? (event.clientX - rect.left) / Math.max(1, rect.width)
            : (event.clientY - rect.top) / Math.max(1, rect.height)
        onRatio(next)
      }
      const up = () => {
        draggingRef.current = false
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      // 拖拽期间锁光标：不然鼠标一离开那 5px 宽的条就变回箭头，看着像没抓住
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [axis, onRatio],
  )

  return (
    <div
      ref={ref}
      data-testid={`split-divider-${axis}`}
      data-ratio={ratio.toFixed(3)}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => onRatio(0.5)}
      title="拖动调整大小，双击复位"
      style={{ gridArea: area }}
      className={cn(
        'z-10 bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600',
        axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize',
      )}
    />
  )
}

interface EmptySlotProps {
  area: string
  focused: boolean
  options: { id: string; title: string }[]
  onPick: (tabId: string) => void
  onFocus: () => void
}

/** 空格：分屏后没分配到会话的格子 */
export function EmptySlot({ area, focused, options, onPick, onFocus }: EmptySlotProps) {
  return (
    <div
      data-testid="split-empty-slot"
      data-focused={focused ? 'true' : 'false'}
      onMouseDown={onFocus}
      style={{ gridArea: area }}
      className={cn(
        'flex flex-col items-center justify-center gap-2 border bg-neutral-50 dark:bg-neutral-900',
        focused
          ? 'border-neutral-400 ring-1 ring-inset ring-neutral-400 dark:border-neutral-600'
          : 'border-neutral-200 dark:border-neutral-800',
      )}
    >
      <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
        {t('terminal.layout.empty')}
      </span>
      <select
        data-testid="split-empty-select"
        value=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value)
        }}
        className="max-w-[80%] rounded border border-neutral-200 bg-white px-2 py-0.5 text-[11px] text-neutral-800 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.title}
          </option>
        ))}
      </select>
    </div>
  )
}
