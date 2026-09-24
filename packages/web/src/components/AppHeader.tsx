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
}

export function AppHeader({ status, serverVersion }: AppHeaderProps) {
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
