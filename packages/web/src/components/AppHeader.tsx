import { APP_NAME, APP_VERSION } from '@webterm/shared'
import type { HealthStatus } from '../hooks/useHealth'
import { useThemeStore } from '../theme/useTheme'
import { StatusDot, type DotTone } from './StatusDot'

const STATUS_TEXT: Record<HealthStatus, string> = {
  loading: '连接中',
  online: '服务在线',
  offline: '服务离线',
}

const STATUS_TONE: Record<HealthStatus, DotTone> = {
  loading: 'warning',
  online: 'success',
  offline: 'danger',
}

interface AppHeaderProps {
  status: HealthStatus
  serverVersion?: string
  /** 打开隧道面板；未解锁时不传（此时还没有任何会话可承载隧道） */
  onOpenTunnels?: () => void
  /** 运行中的隧道数量，用于入口上的徽标 */
  tunnelCount?: number
  /** 打开自动化面板（触发器 / 按钮栏 / 脚本 / 批量执行） */
  onOpenAutomation?: () => void
  /** 处于启用状态（或已命中过）的规则数量，用于入口上的徽标 */
  triggerCount?: number
  /** 打开同步输入面板 */
  onOpenBroadcast?: () => void
  /** 同步输入是否已开启 —— 入口本身也要变红，不能只在警示条上提示 */
  broadcastOn?: boolean
  /** 打开日志与审计面板（阶段 7） */
  onOpenLogs?: () => void
}

export function AppHeader({
  status,
  serverVersion,
  onOpenTunnels,
  tunnelCount = 0,
  onOpenAutomation,
  triggerCount = 0,
  onOpenBroadcast,
  broadcastOn = false,
  onOpenLogs,
}: AppHeaderProps) {
  const mode = useThemeStore((state) => state.mode)
  const toggleTheme = useThemeStore((state) => state.toggle)

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 bg-neutral-50 px-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-neutral-900 text-[10px] font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900">
          WT
        </span>
        <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {APP_NAME}
        </span>
        <span className="rounded border border-neutral-200 px-1.5 py-px font-mono text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          v{APP_VERSION}
        </span>
        {serverVersion && serverVersion !== APP_VERSION ? (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            （服务端 {serverVersion}）
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {onOpenAutomation ? (
          <button
            type="button"
            data-testid="open-automation"
            onClick={onOpenAutomation}
            title="自动化：触发器 / 按钮栏 / 脚本 / 批量执行"
            className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path
                d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            自动化
            {triggerCount > 0 ? (
              <span className="rounded bg-violet-100 px-1 text-[10px] font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                {triggerCount}
              </span>
            ) : null}
          </button>
        ) : null}

        {onOpenBroadcast ? (
          <button
            type="button"
            data-testid="open-broadcast"
            data-active={broadcastOn ? 'true' : 'false'}
            onClick={onOpenBroadcast}
            title="同步输入：一次按键同时发给多个终端"
            className={
              broadcastOn
                ? 'flex items-center gap-1.5 rounded-md border border-amber-500 bg-amber-100 px-2 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                : 'flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path
                d="M6 8h12M6 12h12M6 16h7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            同步输入{broadcastOn ? '（开）' : ''}
          </button>
        ) : null}

        {onOpenLogs ? (
          <button
            type="button"
            data-testid="open-logs"
            onClick={onOpenLogs}
            title="日志与审计：会话日志 / 审计 / 保留与脱敏设置"
            className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path
                d="M5 4h10l4 4v12H5zM9 12h6M9 16h6M9 8h3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            日志
          </button>
        ) : null}

        {onOpenTunnels ? (
          <button
            type="button"
            data-testid="open-tunnels"
            onClick={onOpenTunnels}
            title="端口转发与隧道（-L / -R / -D）"
            className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path
                d="M4 8h11M15 8l-2.5-2.5M15 8l-2.5 2.5M20 16H9M9 16l2.5-2.5M9 16l2.5 2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            隧道
            {tunnelCount > 0 ? (
              <span className="rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">
                {tunnelCount}
              </span>
            ) : null}
          </button>
        ) : null}
        <StatusDot
          tone={STATUS_TONE[status]}
          label={STATUS_TEXT[status]}
          pulse={status === 'loading'}
        />
        <button
          type="button"
          onClick={toggleTheme}
          title={mode === 'light' ? '切换到深色主题' : '切换到浅色主题'}
          aria-label={mode === 'light' ? '切换到深色主题' : '切换到浅色主题'}
          className="flex size-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {mode === 'light' ? (
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path
                d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>
    </header>
  )
}
