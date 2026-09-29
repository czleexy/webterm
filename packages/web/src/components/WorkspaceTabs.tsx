/**
 * 顶部标签栏（终端与 SFTP 共用一条）。
 *
 * 把两种标签统一到一条栏上的理由：它们本质上都是「一个已建立的服务端会话」，
 * 分两条栏会让用户在两个地方找同一条连接，也让「关闭哪个」变得含糊。
 * 组件本身不认识任何 store —— 上层把标签压成 WorkspaceTabItem 数组传进来，
 * 这样新增会话类型（比如后续的端口转发）不需要改这里。
 */
import type { ConnectionProtocol } from '@webterm/shared'
import { cn } from '../utils/cn'
import { PROTOCOL_CHIP_CLASS, protocolLabel } from '../utils/protocol'

export interface WorkspaceTabItem {
  /** 全局唯一（终端与 SFTP 的 id 前缀不同，天然不冲突） */
  id: string
  title: string
  kind: 'terminal' | 'sftp'
  /** 连接协议，用于标签上的协议小标 */
  protocol?: ConnectionProtocol
  /**
   * 是否允许在该标签上打开 SFTP。
   * 缺省视为允许；Telnet 标签显式传 false（协议没有 SFTP 子系统）。
   */
  sftpAvailable?: boolean
  /** 状态点颜色类，由各 store 的 tone 表提供 */
  dot: string
  /** 状态文案，用于 title 提示 */
  label: string
  pulse?: boolean
  notice?: string
}

interface WorkspaceTabsProps {
  items: WorkspaceTabItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** 为终端标签提供「在该连接上打开 SFTP」的入口 */
  onOpenSftpFor?: (terminalTabId: string) => void
}

export function WorkspaceTabs({
  items,
  activeId,
  onSelect,
  onClose,
  onNew,
  onOpenSftpFor,
}: WorkspaceTabsProps) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {items.map((item) => {
          const active = item.id === activeId
          return (
            <div
              key={item.id}
              className={cn(
                'group flex min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-2 border-r border-neutral-200 px-3 text-xs transition-colors dark:border-neutral-800',
                active
                  ? 'bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800/60',
              )}
              onClick={() => onSelect(item.id)}
              onAuxClick={(e) => {
                // 鼠标中键关闭，符合浏览器与编辑器的通用习惯
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(item.id)
                }
              }}
              title={item.notice ? `${item.label}：${item.notice}` : item.label}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(item.id)
                }
              }}
            >
              <span
                className={cn('size-1.5 shrink-0 rounded-full', item.dot, item.pulse && 'animate-pulse')}
              />
              {item.kind === 'sftp' ? (
                <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-amber-500" aria-hidden="true">
                  <path
                    d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2h9.2A1.5 1.5 0 0 1 21 9.7v7.8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"
                    fill="currentColor"
                  />
                </svg>
              ) : (
                <span
                  className={cn(
                    'shrink-0 rounded border px-1 py-px text-[9px] leading-none',
                    PROTOCOL_CHIP_CLASS[item.protocol ?? 'ssh'],
                  )}
                >
                  {protocolLabel(item.protocol)}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{item.title}</span>

              {item.kind === 'terminal' && onOpenSftpFor && item.sftpAvailable !== false ? (
                <button
                  type="button"
                  aria-label={`在 ${item.title} 上打开 SFTP 文件传输`}
                  title="在此连接上打开 SFTP 文件传输（复用同一条 SSH 连接）"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenSftpFor(item.id)
                  }}
                  className="flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-700 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                >
                  <svg viewBox="0 0 24 24" className="size-3" aria-hidden="true">
                    <path
                      d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2h9.2A1.5 1.5 0 0 1 21 9.7v7.8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              ) : null}

              <button
                type="button"
                aria-label={`关闭 ${item.title}`}
                onClick={(e) => {
                  // 阻止冒泡，否则关闭动作同时会触发标签选中
                  e.stopPropagation()
                  onClose(item.id)
                }}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <svg viewBox="0 0 24 24" className="size-3" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
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
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
