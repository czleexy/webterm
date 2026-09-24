/**
 * 终端标签栏。
 *
 * 状态点用颜色表达连接阶段，鼠标悬停显示具体原因：
 *   灰 连接中 / 绿 已就绪 / 黄 背压限速 / 红 出错 / 深灰 已结束
 */
import type { TerminalTab, TabStatus } from '../store/useTerminalStore'
import { cn } from '../utils/cn'

const STATUS_TONE: Record<TabStatus, { dot: string; text: string; pulse?: boolean }> = {
  connecting: { dot: 'bg-neutral-400', text: '连接中', pulse: true },
  ready: { dot: 'bg-emerald-500', text: '已连接' },
  'flow-paused': { dot: 'bg-amber-500', text: '限速中（背压保护）' },
  exited: { dot: 'bg-neutral-500', text: '已结束' },
  error: { dot: 'bg-red-500', text: '出错' },
}

interface TerminalTabsProps {
  tabs: TerminalTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function TerminalTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
}: TerminalTabsProps) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const tone = STATUS_TONE[tab.status]
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-2 border-r border-neutral-200 px-3 text-xs transition-colors dark:border-neutral-800',
                active
                  ? 'bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800/60',
              )}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                // 鼠标中键关闭，符合浏览器与编辑器的通用习惯
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.id)
                }
              }}
              title={tab.notice ? `${tone.text}：${tab.notice}` : tone.text}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(tab.id)
                }
              }}
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  tone.dot,
                  tone.pulse && 'animate-pulse',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                onClick={(e) => {
                  // 阻止冒泡，否则关闭动作同时会触发标签选中
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <svg viewBox="0 0 24 24" className="size-3" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onNew}
        title="新建连接"
        aria-label="新建连接"
        className="flex w-9 shrink-0 items-center justify-center border-l border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
