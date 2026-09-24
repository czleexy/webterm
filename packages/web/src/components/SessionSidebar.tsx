/**
 * 左侧会话栏。
 *
 * 阶段 1 展示当前打开的终端；阶段 2 会在此叠加「会话库」（分组、搜索、加密凭据）。
 * 这里刻意先把「当前活动会话」的视图做出来 —— 它是多标签工作流的导航基础。
 */
import { type TerminalTab, type TabStatus } from '../store/useTerminalStore'
import { cn } from '../utils/cn'

const STATUS_DOT: Record<TabStatus, string> = {
  connecting: 'bg-neutral-400 animate-pulse',
  ready: 'bg-emerald-500',
  'flow-paused': 'bg-amber-500',
  exited: 'bg-neutral-500',
  error: 'bg-red-500',
}

const STATUS_TEXT: Record<TabStatus, string> = {
  connecting: '连接中',
  ready: '已连接',
  'flow-paused': '限速中',
  exited: '已结束',
  error: '出错',
}

interface SessionSidebarProps {
  tabs: TerminalTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function SessionSidebar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
}: SessionSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          连接
          {tabs.length > 0 ? (
            <span className="ml-1 text-neutral-400 dark:text-neutral-500">({tabs.length})</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onNew}
          className="rounded border border-neutral-200 bg-white px-1.5 py-px text-[10px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          新建
        </button>
      </div>

      {tabs.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <svg
            viewBox="0 0 24 24"
            className="size-8 text-neutral-300 dark:text-neutral-700"
            aria-hidden="true"
          >
            <rect
              x="3"
              y="4"
              width="18"
              height="16"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M7 9l3 3-3 3M13 15h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            暂无连接
            <br />
            点击上方「新建」发起 SSH 会话
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId
            return (
              <li key={tab.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(tab.id)
                    }
                  }}
                  className={cn(
                    'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                    active
                      ? 'bg-white shadow-sm dark:bg-neutral-800'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60',
                  )}
                >
                  <span
                    className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[tab.status])}
                    title={STATUS_TEXT[tab.status]}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-xs',
                        active
                          ? 'text-neutral-900 dark:text-neutral-100'
                          : 'text-neutral-700 dark:text-neutral-300',
                      )}
                    >
                      {tab.title}
                    </span>
                    <span className="mt-px block truncate text-[10px] text-neutral-400 dark:text-neutral-500">
                      {STATUS_TEXT[tab.status]}
                      {tab.negotiation?.legacy ? ' · legacy' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(tab.id)
                    }}
                    className="flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
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
              </li>
            )
          })}
        </ul>
      )}

      <div className="shrink-0 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          会话库（分组 / 搜索 / 加密凭据）将在阶段 2 交付
        </p>
      </div>
    </aside>
  )
}
