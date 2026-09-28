/**
 * SFTP 工作区：本地栏 + 远端栏 + 传输队列。
 *
 * 这里是「跨栏动作」的汇聚点，因为只有它同时知道两栏的当前目录：
 * - 拖拽/按钮发起的传输（upload / download）
 * - 同侧拖拽 = 移动（用 rename 实现，两端都支持且是原子的）
 * - 从操作系统拖进来的文件 = 浏览器上传（octet-stream，带进度）
 *
 * 两栏的当前路径由本组件持有，面板内容各自管理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SftpSide, TransferDirection, TransferTask } from '@webterm/shared'
import { createTransfer, posixJoinPosix, renameSftp, uploadToRemote } from '../api/sftp'
import { ApiRequestError } from '../api/client'
import { useSftpStore, type SftpTab } from '../store/useSftpStore'
import { cn } from '../utils/cn'
import { FileViewer } from './FileViewer'
import { SftpPane } from './SftpPane'
import { TransferDrawer } from './TransferDrawer'
import { baseName, formatBytes } from './format'

interface SftpWorkspaceProps {
  tab: SftpTab
  /** 非活动标签用 CSS 隐藏，保持目录状态与滚动位置 */
  active: boolean
}

interface BrowserUpload {
  id: string
  name: string
  loaded: number
  total: number
  done: boolean
  error?: string
}

export function SftpWorkspace({ tab, active }: SftpWorkspaceProps) {
  const sftpId = tab.sftpId ?? ''
  const allTransfers = useSftpStore((s) => s.transfers)
  const concurrency = useSftpStore((s) => s.concurrency)
  const reconnect = useSftpStore((s) => s.reconnect)
  const tasks: TransferTask[] = useMemo(() => allTransfers[sftpId] ?? [], [allTransfers, sftpId])

  const [paths, setPaths] = useState<Record<SftpSide, string>>({ local: '', remote: '' })
  const [reload, setReload] = useState<Record<SftpSide, number>>({ local: 0, remote: 0 })
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<BrowserUpload[]>([])
  /** 初始化一次即可：远端家目录与本地初始目录来自建连响应 */
  const bootstrappedRef = useRef(false)

  useEffect(() => {
    if (bootstrappedRef.current) return
    if (!tab.remoteHome && !tab.localHome) return
    bootstrappedRef.current = true
    setPaths({ local: tab.localHome ?? '', remote: tab.remoteHome ?? '' })
  }, [tab.localHome, tab.remoteHome])

  const bump = useCallback((side: SftpSide) => {
    setReload((prev) => ({ ...prev, [side]: prev[side] + 1 }))
  }, [])

  const bumpBoth = useCallback(() => {
    setReload((prev) => ({ local: prev.local + 1, remote: prev.remote + 1 }))
  }, [])

  const navigate = useCallback((side: SftpSide, path: string) => {
    setPaths((prev) => ({ ...prev, [side]: path }))
  }, [])

  /**
   * 发起传输。
   *
   * 覆盖策略：默认**不覆盖**（服务端在计划阶段就会拒绝并给出明确提示），
   * 拿到「已存在」的失败后再问用户是否覆盖。
   * 之所以能这样同步等待：这类失败是计划阶段的预检，不会等到数据开始流动，
   * 所以用一个很短的窗口去观察就够，不会让用户面对长时间的等待。
   */
  const startTransfer = useCallback(
    async (direction: TransferDirection, sources: string[], overwrite = false) => {
      if (!sftpId || sources.length === 0) return
      const targetDir = direction === 'upload' ? paths.remote : paths.local
      if (!targetDir) return
      setActionError(null)
      try {
        const created = await createTransfer(sftpId, {
          direction,
          sources,
          targetDir,
          overwrite,
          recursive: true,
          preserveMode: true,
        })
        if (overwrite) return

        const first = created.tasks[0]
        if (!first) return
        const settled = await observeEarlyFailure(sftpId, first.id, 1500)
        if (settled?.state === 'failed' && /已存在/.test(settled.error ?? '')) {
          const ok = window.confirm(
            `${settled.error}\n\n是否覆盖目标中的同名文件？\n覆盖会直接写坏已存在的文件，请确认无误后再继续。`,
          )
          if (ok) await startTransfer(direction, sources, true)
        }
      } catch (err) {
        setActionError(err instanceof ApiRequestError ? err.message : String(err))
      }
    },
    [paths.local, paths.remote, sftpId],
  )

  const moveWithin = useCallback(
    async (side: SftpSide, sourcePaths: string[]) => {
      if (!sftpId) return
      const targetDir = paths[side]
      setActionError(null)
      for (const from of sourcePaths) {
        const to = side === 'remote' ? posixJoinPosix(targetDir, baseName(from)) : joinLocal(targetDir, baseName(from))
        if (to === from) continue
        try {
          await renameSftp({ side, from, to }, sftpId)
        } catch (err) {
          setActionError(err instanceof ApiRequestError ? err.message : String(err))
        }
      }
      bump(side)
    },
    [bump, paths, sftpId],
  )

  /** 从操作系统拖进来的文件：落到本地栏时按「拷进服务端本地面板」处理需要额外接口，
   *  这里只支持拖到远端栏 —— 也就是最常见的「从电脑传文件上去」。 */
  const handleOsFiles = useCallback(
    async (files: File[], targetSide: SftpSide) => {
      if (!sftpId) return
      if (targetSide === 'local') {
        setActionError(
          '不支持把系统文件直接拖到本地面板（面板展示的是服务端磁盘）。请拖到右侧远端面板完成上传。',
        )
        return
      }
      setActionError(null)
      const targetDir = paths.remote
      if (!targetDir) return

      // 顺序上传：并发上传大文件只会互相抢带宽，进度也更难看懂
      for (const file of files) {
        const id = `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        setUploads((prev) => [
          ...prev,
          { id, name: file.name, loaded: 0, total: file.size, done: false },
        ])
        try {
          await uploadToRemote(sftpId, posixJoinPosix(targetDir, file.name), file, {
            onProgress: (p) => {
              setUploads((prev) =>
                prev.map((u) => (u.id === id ? { ...u, loaded: p.loaded, total: p.total } : u)),
              )
            },
          })
          setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, done: true, loaded: file.size } : u)))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, done: true, error: message } : u)))
        }
      }
      bump('remote')
    },
    [bump, paths.remote, sftpId],
  )

  const subtitle = useMemo(() => {
    const host = tab.target ? `${tab.target.username}@${tab.target.host}:${tab.target.port}` : ''
    return host
  }, [tab.target])

  const notReady = !sftpId
  const busyUploads = uploads.filter((u) => !u.done)

  return (
    <div
      data-testid="sftp-workspace"
      data-status={tab.status}
      className={cn('flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950', !active && 'hidden')}
    >
      {/* 会话信息条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] dark:border-neutral-800 dark:bg-neutral-900">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">{tab.title}</span>
        {tab.reusedConnection ? (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            复用终端连接
          </span>
        ) : (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            独立连接
          </span>
        )}
        {subtitle ? (
          <span className="font-mono text-neutral-500 dark:text-neutral-400">{subtitle}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              bumpBoth()
            }}
            className="rounded border border-neutral-200 px-1.5 py-0.5 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            刷新两栏
          </button>
          <button
            type="button"
            onClick={() => reconnect(tab.id)}
            className="rounded border border-neutral-200 px-1.5 py-0.5 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            重新连接
          </button>
        </span>
      </div>

      {tab.notice ? (
        <div
          className={cn(
            'shrink-0 border-b px-2 py-1 text-[11px]',
            tab.status === 'error'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'
              : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
          )}
        >
          {tab.notice}
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {actionError}
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-2 underline decoration-dotted"
          >
            知道了
          </button>
        </div>
      ) : null}

      {notReady ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md text-center">
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              {tab.status === 'connecting' ? '正在建立 SFTP 会话…' : 'SFTP 会话不可用'}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              远端主机需要开启 SFTP 子系统。部分网络设备只提供 SSH 命令行、不提供文件子系统，
              此时只能使用终端。
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SftpPane
            side="local"
            sftpId={sftpId}
            path={paths.local}
            rootPath={tab.localRoot}
            homePath={tab.localHome}
            reloadToken={reload.local}
            onNavigate={(p) => navigate('local', p)}
            onRequestTransfer={(direction, sourcePaths) => void startTransfer(direction, sourcePaths)}
            onRequestMove={(side, sourcePaths) => void moveWithin(side, sourcePaths)}
            onOsFilesDropped={(files) => void handleOsFiles(files, 'local')}
            onPreview={(entry) => setViewerPath(entry.path)}
            title="本机（服务端磁盘）"
            subtitle={tab.localRoot}
          />

          <div className="w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />

          <SftpPane
            side="remote"
            sftpId={sftpId}
            path={paths.remote}
            homePath={tab.remoteHome}
            reloadToken={reload.remote}
            onNavigate={(p) => navigate('remote', p)}
            onRequestTransfer={(direction, sourcePaths) => void startTransfer(direction, sourcePaths)}
            onRequestMove={(side, sourcePaths) => void moveWithin(side, sourcePaths)}
            onOsFilesDropped={(files) => void handleOsFiles(files, 'remote')}
            onPreview={(entry) => setViewerPath(entry.path)}
            title="远端主机"
            subtitle={subtitle}
          />
        </div>
      )}

      {busyUploads.length > 0 ? (
        <div className="shrink-0 border-t border-neutral-200 bg-neutral-50 px-2 py-1 dark:border-neutral-800 dark:bg-neutral-900">
          {busyUploads.map((u) => (
            <div key={u.id} className="flex items-center gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-200">
                浏览器上传：{u.name}
              </span>
              <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                {formatBytes(u.loaded)} / {formatBytes(u.total)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {uploads.some((u) => u.error) ? (
        <div className="shrink-0 border-t border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {uploads
            .filter((u) => u.error)
            .map((u) => `${u.name}：${u.error}`)
            .join('；')}
          <button
            type="button"
            onClick={() => setUploads((prev) => prev.filter((u) => !u.error))}
            className="ml-2 underline decoration-dotted"
          >
            清除
          </button>
        </div>
      ) : null}

      <TransferDrawer
        sftpId={sftpId}
        tasks={tasks}
        concurrency={concurrency}
        open={drawerOpen}
        onToggle={() => setDrawerOpen((v) => !v)}
        onTransfersSettled={bumpBoth}
      />

      {viewerPath ? (
        <FileViewer
          sftpId={sftpId}
          path={viewerPath}
          onClose={() => setViewerPath(null)}
          onSaved={() => bump('remote')}
        />
      ) : null}
    </div>
  )
}

/** 本地路径拼接：交给服务端归一化，这里只保证不重复分隔符 */
function joinLocal(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  const trimmed = dir.replace(/[/\\]+$/, '')
  return trimmed === '' ? name : `${trimmed}${sep}${name}`
}

/**
 * 在短窗口内观察任务是否**立即失败**（计划阶段的预检错误）。
 * 只用于「已存在」这类需要追问用户的情形，不做长时间等待。
 */
function observeEarlyFailure(
  sftpId: string,
  taskId: string,
  windowMs: number,
): Promise<TransferTask | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + windowMs
    const check = (): void => {
      const task = useSftpStore.getState().transfers[sftpId]?.find((t) => t.id === taskId)
      if (task && (task.state === 'failed' || task.state === 'done' || task.state === 'canceled')) {
        resolve(task)
        return
      }
      if (Date.now() >= deadline) {
        resolve(task ?? null)
        return
      }
      setTimeout(check, 100)
    }
    check()
  })
}
