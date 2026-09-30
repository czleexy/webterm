/**
 * Toast 渲染宿主：固定在右下角堆叠。
 *
 * 提到最外层（App 之外的一层）渲染：终端面板、SFTP、弹窗内部都可能触发它，
 * 挂在任何一个业务组件里都会被那个组件的层叠上下文裁掉或盖住。
 */
import { useEffect } from 'react'
import { useToastStore, type ToastTone } from './toast'
import { t } from '../i18n'
import { cn } from '../utils/cn'

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-neutral-300 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100',
  success:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-200',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-200',
  error:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/70 dark:text-red-200',
}

const TONE_ICON: Record<ToastTone, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
}

export function ToastHost() {
  const items = useToastStore((state) => state.items)
  const dismiss = useToastStore((state) => state.dismiss)

  return (
    <div
      data-testid="toast-host"
      className="pointer-events-none fixed bottom-3 right-3 z-[70] flex w-80 flex-col gap-2"
    >
      {items.map((item) => (
        <ToastCard key={item.id} id={item.id} tone={item.tone} message={item.message} detail={item.detail} timeout={item.timeout} onDismiss={dismiss} />
      ))}
      {/* 有一条时给屏幕阅读器一个稳定的公告区 */}
      <span className="sr-only" role="status">
        {items.length > 0 ? items[items.length - 1]?.message : ''}
      </span>
    </div>
  )
}

function ToastCard({
  id,
  tone,
  message,
  detail,
  timeout,
  onDismiss,
}: {
  id: string
  tone: ToastTone
  message: string
  detail?: string
  timeout: number
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    if (timeout <= 0) return
    const timer = setTimeout(() => onDismiss(id), timeout)
    return () => clearTimeout(timer)
  }, [id, onDismiss, timeout])

  return (
    <div
      data-testid="toast"
      data-tone={tone}
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-lg backdrop-blur',
        TONE_CLASS[tone],
      )}
    >
      <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-black/10 text-[10px] font-bold dark:bg-white/15">
        {TONE_ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium">{message}</div>
        {detail ? <div className="mt-0.5 break-words opacity-80">{detail}</div> : null}
      </div>
      <button
        type="button"
        data-testid={`toast-dismiss-${tone}`}
        onClick={() => onDismiss(id)}
        title={t('toast.dismiss')}
        aria-label={t('toast.dismiss')}
        className="shrink-0 rounded px-1 text-[12px] leading-none opacity-60 transition-opacity hover:opacity-100"
      >
        ×
      </button>
    </div>
  )
}
