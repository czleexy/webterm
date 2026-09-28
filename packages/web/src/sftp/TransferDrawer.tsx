/**
 * 传输面板。
 *
 * 数据来自服务端推送（useSftpStore 维护），本组件只负责渲染与发指令，
 * 不在本地推算进度 —— 否则刷新页面、切换标签后进度就会对不上。
 *
 * 一个细节：任务进入终态时通知父组件刷新两栏。
 * 目录传输会新建大量文件，靠「传输时顺手刷新」是不可靠的，
 * 统一在终态上做一次刷新更简单也更准确。
 */
import { useEffect, useMemo, useRef } from 'react'
import type { TransferAction, TransferState, TransferTask } from '@webterm/shared'
import { removeTransfer, transferAction } from '../api/sftp'
import { cn } from '../utils/cn'
import { formatBytes, formatEta, formatSpeed, progressPercent } from './format'

interface TransferDrawerProps {
  sftpId: string
  tasks: TransferTask[]
  concurrency: number
  open: boolean
  onToggle: () => void
  /** 所有任务到达终态后触发（用于刷新两栏列表） */
  onTransfersSettled: () => void
}

const STATE_LABEL: Record<TransferState, string> = {
  pending: '排队中',
  running: '传输中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STATE_TONE: Record<TransferState, string> = {
  pending: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
  running: 'text-blue-700 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-300',
  paused: 'text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300',
  done: 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300',
  failed: 'text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300',
  canceled: 'text-neutral-600 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
}

export function TransferDrawer({
  sftpId,
  tasks,
  concurrency,
  open,
  onToggle,
  onTransfersSettled,
}: TransferDrawerProps) {
  const active = tasks.filter((t) => t.state === 'running' || t.state === 'pending').length
  const failed = tasks.filter((t) => t.state === 'failed').length

  /**
   * 终态检测：只有当「上一轮还有在跑的任务、这一轮全都结束了」才刷新。
   * 否则每次收到进度事件都会触发一次目录重取，把服务端打爆。
   */
  const settledRef = useRef(true)
  useEffect(() => {
    const hasUnsettled = tasks.some(
      (t) => t.state === 'running' || t.state === 'pending' || t.state === 'paused',
    )
    if (hasUnsettled) {
      settledRef.current = false
      return
    }
    if (!settledRef.current) {
      settledRef.current = true
      onTransfersSettled()
    }
  }, [tasks, onTransfersSettled])

  const ordered = useMemo(
    () => [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [tasks],
  )

  const clearFinished = (): void => {
    for (const task of ordered) {
      if (task.state === 'done' || task.state === 'canceled') {
        void removeTransfer(sftpId, task.id).catch(() => {})
      }
    }
  }

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <button
        type="button"
        onClick={onToggle}
        data-testid="transfer-drawer-toggle"
        className="flex w-full items-center gap-2 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        <span aria-hidden="true" className="text-neutral-400">
          {open ? '▾' : '▸'}
        </span>
        <span className="font-medium">传输队列</span>
        {active > 0 ? (
          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
            {active} 进行中
          </span>
        ) : null}
        {failed > 0 ? (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {failed} 失败
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-neutral-400 dark:text-neutral-500">
          并发上限 {concurrency || '—'} · 共 {tasks.length} 条
        </span>
      </button>

      {open ? (
        <div className="max-h-56 overflow-auto border-t border-neutral-100 dark:border-neutral-800/60">
          {ordered.length === 0 ? (
            <p className="px-3 py-3 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
              暂无传输任务。在左侧选中文件后点「上传 →」，或直接把文件拖到对侧面板。
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
              {ordered.map((task) => (
                <TransferRow
                  key={task.id}
                  task={task}
                  sftpId={sftpId}
                  onClear={() => void removeTransfer(sftpId, task.id).catch(() => {})}
                />
              ))}
            </ul>
          )}

          {ordered.some((t) => t.state === 'done' || t.state === 'canceled') ? (
            <div className="flex justify-end px-2 py-1">
              <button
                type="button"
                onClick={clearFinished}
                className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                清除已完成
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TransferRow({
  task,
  sftpId,
  onClear,
}: {
  task: TransferTask
  sftpId: string
  onClear: () => void
}) {
  const percent = progressPercent(task.transferred, task.size)
  const isActive = task.state === 'running' || task.state === 'pending' || task.state === 'paused'

  const act = (action: TransferAction): void => {
    void transferAction(sftpId, task.id, action).catch(() => {})
  }

  return (
    <li className="px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          title={task.direction === 'upload' ? '上传（本地 → 远端）' : '下载（远端 → 本地）'}
          className={cn(
            'shrink-0 rounded px-1 text-[10px] font-medium',
            task.direction === 'upload'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
          )}
        >
          {task.direction === 'upload' ? '↑ 上传' : '↓ 下载'}
        </span>

        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-800 dark:text-neutral-200" title={`${task.source}\n→ ${task.target}`}>
          {task.name}
          {task.isDirectory ? <span className="ml-1 text-neutral-400">（目录）</span> : null}
        </span>

        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', STATE_TONE[task.state])}>
          {STATE_LABEL[task.state]}
        </span>

        <span className="shrink-0 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
          {formatBytes(task.transferred)}
          {task.size > 0 ? ` / ${formatBytes(task.size)}` : ''}
        </span>

        <span className="flex shrink-0 items-center gap-0.5">
          {task.state === 'running' ? (
            <RowButton label="暂停" onClick={() => act('pause')}>
              ⏸
            </RowButton>
          ) : null}
          {task.state === 'paused' ? (
            <RowButton label="继续" onClick={() => act('resume')}>
              ▶
            </RowButton>
          ) : null}
          {task.state === 'failed' ? (
            <RowButton label="重试" onClick={() => act('retry')}>
              ↻
            </RowButton>
          ) : null}
          {isActive ? (
            <RowButton label="取消" onClick={() => act('cancel')}>
              ✕
            </RowButton>
          ) : (
            <RowButton label="从列表移除" onClick={onClear}>
              ␡
            </RowButton>
          )}
        </span>
      </div>

      {task.state !== 'done' || (percent !== null && percent < 100) ? (
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-200',
                task.state === 'failed'
                  ? 'bg-red-500'
                  : task.state === 'canceled'
                    ? 'bg-neutral-400'
                    : task.state === 'paused'
                      ? 'bg-amber-500'
                      : 'bg-blue-500',
              )}
              style={{ width: percent === null ? '100%' : `${percent}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
            {percent === null ? '大小未知' : `${percent.toFixed(1)}%`}
          </span>
          {task.isDirectory ? (
            <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {task.filesDone}/{task.filesTotal}
            </span>
          ) : null}
          {task.state === 'running' ? (
            <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {formatSpeed(task.speed)} · 剩余 {formatEta(task.etaSec)}
            </span>
          ) : null}
        </div>
      ) : null}

      {task.error ? (
        <p className="mt-0.5 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
          {task.error}
        </p>
      ) : null}
    </li>
  )
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded text-[11px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
    >
      {children}
    </button>
  )
}
