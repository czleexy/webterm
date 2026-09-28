/**
 * SFTP 单栏面板。
 *
 * 一个面板 = 一个「文件系统视图」：路径栏 + 工具栏 + 文件列表 + 右键菜单。
 * 本地栏与远端栏共用这个组件，差异全部通过 props 注入（可导航的最深目录、
 * 路径分隔符、是否支持 chmod 等），避免两套几乎相同的代码各自漂移。
 *
 * 状态归属：**当前路径由父组件（SftpWorkspace）持有**。
 * 原因是拖拽落点需要同时知道两栏的当前目录，若各自持有就只能靠 ref 反查。
 * 目录内容与选中集则留在本组件内，它们只服务于这一栏的渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SftpEntry, SftpListResponse, SftpSide, TransferDirection } from '@webterm/shared'
import {
  chmodSftp,
  listSftpDir,
  mkdirSftp,
  removeSftp,
  renameSftp,
  touchSftp,
} from '../api/sftp'
import { ApiRequestError } from '../api/client'
import { cn } from '../utils/cn'
import { DEFAULT_SORT, FileList, type FileSort } from './FileList'
import { baseName } from './format'
import { hasOsFiles, readDragPayload } from './drag'

interface SftpPaneProps {
  side: SftpSide
  sftpId: string
  /** 当前目录（受控） */
  path: string
  /** 允许向上导航的最深目录；local 侧为受限根目录 */
  rootPath?: string
  /** 「回到初始目录」的落点 */
  homePath?: string
  /** 递增即强制刷新（用于传输完成后同步另一栏） */
  reloadToken: number
  onNavigate: (path: string) => void
  /** 把本栏选中的路径传到对侧（direction 以远端为参照） */
  onRequestTransfer: (direction: TransferDirection, paths: string[], source: SftpSide) => void
  /** 同一侧内的移动（落点是本栏当前目录） */
  onRequestMove: (side: SftpSide, paths: string[]) => void
  /** 从操作系统拖进来的文件：走浏览器上传通道，先落到本地栏再上传由其自行决定 */
  onOsFilesDropped: (files: File[]) => void
  onPreview: (entry: SftpEntry) => void
  /** 外部要求刷新（父组件在传输结束后触发） */
  onListingLoaded?: (side: SftpSide, path: string) => void
  title: string
  /** 面板左上角的元信息（主机名 / 本地根目录等） */
  subtitle?: string
}

interface ContextMenuState {
  x: number
  y: number
  entry: SftpEntry | null
}

export function SftpPane({
  side,
  sftpId,
  path,
  rootPath,
  homePath,
  reloadToken,
  onNavigate,
  onRequestTransfer,
  onRequestMove,
  onOsFilesDropped,
  onPreview,
  onListingLoaded,
  title,
  subtitle,
}: SftpPaneProps) {
  const [listing, setListing] = useState<SftpListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [sort, setSort] = useState<FileSort>(DEFAULT_SORT)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [pathDraft, setPathDraft] = useState(path)
  const [editingPath, setEditingPath] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const lastClickedRef = useRef<string | null>(null)
  const loadSeqRef = useRef(0)
  /**
   * 已经装载完成的目标目录。
   *
   * 用来区分「切换到别的目录」与「刷新当前目录」：
   * 前者必须先清空列表 —— 否则在新目录数据到达前，界面上还挂着上一个目录的条目，
   * 用户这时点「上一级」会按**旧目录**的 parent 跳走，双击也会拿着旧条目的路径去操作。
   * 后者保留旧列表，刷新时不闪烁。
   */
  const loadedTargetRef = useRef<string | null>(null)

  // 路径受控：外部导航（面包屑、home）后要同步输入框
  useEffect(() => {
    setPathDraft(path)
  }, [path])

  const load = useCallback(
    async (target: string, keepSelection = false) => {
      const switching = loadedTargetRef.current !== target
      if (switching) {
        // 换目录：先清干净，避免旧条目在新数据到达前被误用
        loadedTargetRef.current = target
        setListing(null)
        setSelected(new Set())
        lastClickedRef.current = null
      }

      const seq = ++loadSeqRef.current
      setLoading(true)
      setError(null)
      try {
        const result = await listSftpDir(sftpId, side, target)
        // 只接受最后一次请求的结果：用户快速连点目录时，先发的可能后到
        if (seq !== loadSeqRef.current) return
        setListing(result)
        if (!keepSelection) setSelected(new Set())
        onListingLoaded?.(side, result.path)
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        const message = err instanceof ApiRequestError ? err.message : String(err)
        setError(message)
        setListing(null)
      } finally {
        if (seq === loadSeqRef.current) setLoading(false)
      }
    },
    [onListingLoaded, sftpId, side],
  )

  useEffect(() => {
    void load(path)
    // reloadToken 变化时强制重取；path 变化由 load 的依赖覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpId, side, path, reloadToken])

  /** 相对路径安全拼接：远端用 POSIX，本地用反斜杠靠服务端归一化 */
  const joinChild = useCallback(
    (parent: string, name: string): string => {
      if (side === 'remote') {
        const trimmed = parent.endsWith('/') ? parent.slice(0, -1) : parent
        return trimmed === '' ? `/${name}` : `${trimmed}/${name}`
      }
      // 本地侧交给服务端 path.join 归一化；这里只需保证分隔符不重复
      const sep = parent.includes('\\') ? '\\' : '/'
      const trimmed = parent.replace(/[/\\]+$/, '')
      return trimmed === '' ? name : `${trimmed}${sep}${name}`
    },
    [side],
  )

  const selectedEntries = useMemo(
    () => (listing?.entries ?? []).filter((entry) => selected.has(entry.path)),
    [listing, selected],
  )

  // 只有「列表与当前路径一致」时才能据此导航，否则会拿到上一个目录的 parent
  const listingReady = listing !== null && loadedTargetRef.current === path
  const parentPath = listingReady ? (listing?.parent ?? null) : null

  /* ---------------- 选中 ---------------- */

  const handleSelect = useCallback(
    (entry: SftpEntry, modifiers: { ctrl: boolean; shift: boolean }) => {
      setMenu(null)
      setSelected((prev) => {
        if (modifiers.shift && lastClickedRef.current) {
          const all = listing?.entries ?? []
          const from = all.findIndex((e) => e.path === lastClickedRef.current)
          const to = all.findIndex((e) => e.path === entry.path)
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from]
            return new Set(all.slice(start, end + 1).map((e) => e.path))
          }
        }
        if (modifiers.ctrl) {
          const next = new Set(prev)
          if (next.has(entry.path)) next.delete(entry.path)
          else next.add(entry.path)
          lastClickedRef.current = entry.path
          return next
        }
        lastClickedRef.current = entry.path
        return new Set([entry.path])
      })
    },
    [listing],
  )

  const handleActivate = useCallback(
    (entry: SftpEntry) => {
      if (entry.type === 'dir') {
        onNavigate(entry.path)
        return
      }
      if (entry.type === 'link') {
        // 符号链接可能是目录也可能是文件：交给服务端 stat 判定，失败了再退回文本预览
        onNavigate(entry.path)
        return
      }
      onPreview(entry)
    },
    [onNavigate, onPreview],
  )

  /* ---------------- 拖放 ---------------- */

  const handleDropData = useCallback(
    (dt: DataTransfer) => {
      setDropActive(false)
      if (hasOsFiles(dt)) {
        const files = Array.from(dt.files)
        if (files.length > 0) onOsFilesDropped(files)
        return
      }
      const payload = readDragPayload(dt)
      if (!payload) return
      if (payload.side === side) {
        // 同侧拖放 = 移动；目标就是本栏当前目录，若已经在其中则忽略
        const already = payload.paths.every((p) => joinChild(path, baseName(p)) === p)
        if (already) return
        onRequestMove(side, payload.paths)
        return
      }
      const direction: TransferDirection = payload.side === 'local' ? 'upload' : 'download'
      onRequestTransfer(direction, payload.paths, payload.side)
    },
    [joinChild, onOsFilesDropped, onRequestMove, onRequestTransfer, path, side],
  )

  /* ---------------- 右键菜单动作 ---------------- */

  const runMkdir = useCallback(async () => {
    setMenu(null)
    const name = window.prompt('新建目录名称：')
    if (!name?.trim()) return
    try {
      await mkdirSftp({ side, path, name: name.trim() }, sftpId)
      await load(path, true)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err))
    }
  }, [load, path, sftpId, side])

  const runNewFile = useCallback(async () => {
    setMenu(null)
    const name = window.prompt('新建空文件名称：')
    if (!name?.trim()) return
    try {
      await touchSftp({ side, path: joinChild(path, name.trim()) }, sftpId)
      await load(path, true)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err))
    }
  }, [joinChild, load, path, sftpId, side])

  const runRename = useCallback(
    async (entry: SftpEntry) => {
      setMenu(null)
      const name = window.prompt('重命名为：', entry.name)
      if (!name?.trim() || name.trim() === entry.name) return
      try {
        await renameSftp(
          { side, from: entry.path, to: joinChild(path, name.trim()) },
          sftpId,
        )
        await load(path, true)
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : String(err))
      }
    },
    [joinChild, load, path, sftpId, side],
  )

  const runChmod = useCallback(
    async (entry: SftpEntry) => {
      setMenu(null)
      const current = (entry.mode & 0o777).toString(8).padStart(3, '0')
      const input = window.prompt('权限（八进制，如 644 / 755）：', current)
      if (!input?.trim() || input.trim() === current) return
      try {
        await chmodSftp({ side, path: entry.path, mode: input.trim() }, sftpId)
        await load(path, true)
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : String(err))
      }
    },
    [load, path, sftpId, side],
  )

  const runRemove = useCallback(async () => {
    setMenu(null)
    const targets = selectedEntries
    if (targets.length === 0) return
    const names = targets.map((e) => e.name).join('、')
    if (!window.confirm(`删除 ${targets.length} 项？\n${names}`)) return
    try {
      await removeSftp({ side, paths: targets.map((e) => e.path) }, sftpId)
      await load(path)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err))
    }
  }, [load, path, selectedEntries, sftpId, side])

  const transferSelection = useCallback(
    (direction: TransferDirection) => {
      const paths = selectedEntries.filter((e) => e.type !== 'link').map((e) => e.path)
      if (paths.length === 0) return
      onRequestTransfer(direction, paths, side)
    },
    [onRequestTransfer, selectedEntries, side],
  )

  const canGoUp = Boolean(parentPath) && (!rootPath || parentPath !== rootPath || path !== rootPath)
  const isHome = homePath ? path === homePath : false

  return (
    <section
      data-testid={`sftp-pane-${side}`}
      data-path={path}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={(e) => {
        e.preventDefault()
        setDropActive(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        // 只有真正离开面板时才取消高亮：子元素之间移动也会触发 dragleave
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        handleDropData(e.dataTransfer)
      }}
    >
      {/* 路径栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-1.5 py-1 dark:border-neutral-800 dark:bg-neutral-900">
        {editingPath ? (
          <input
            autoFocus
            value={pathDraft}
            spellCheck={false}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => {
              setEditingPath(false)
              const next = pathDraft.trim()
              if (next && next !== path) onNavigate(next)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setPathDraft(path)
                setEditingPath(false)
              }
            }}
            className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-[11px] outline-none dark:border-neutral-700 dark:bg-neutral-950"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setEditingPath(true)}
            title="双击可编辑路径"
            className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {path || '…'}
          </button>
        )}

        <IconButton
          label="上一级"
          disabled={!canGoUp}
          onClick={() => {
            if (parentPath) onNavigate(parentPath)
          }}
        >
          <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </IconButton>
        <IconButton
          label="初始目录"
          disabled={!homePath || isHome}
          onClick={() => {
            if (homePath) onNavigate(homePath)
          }}
        >
          <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </IconButton>
        <IconButton label="刷新" onClick={() => void load(path, true)}>
          <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
        </IconButton>
      </div>

      {/* 工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-800 dark:bg-neutral-950">
        <span className="mr-1 min-w-0 truncate text-[11px] font-medium text-neutral-700 dark:text-neutral-300" title={subtitle}>
          {title}
        </span>
        <span className="mr-auto text-[10px] text-neutral-400 dark:text-neutral-500">
          {listing ? `${listing.entries.length} 项` : ''}
          {selectedEntries.length > 0 ? ` · 选中 ${selectedEntries.length}` : ''}
        </span>

        <ToolButton onClick={() => void runMkdir()} disabled={loading}>
          新建目录
        </ToolButton>
        <ToolButton onClick={() => void runNewFile()} disabled={loading}>
          新建文件
        </ToolButton>
        {side === 'local' ? (
          <ToolButton
            tone="primary"
            disabled={selectedEntries.length === 0}
            onClick={() => transferSelection('upload')}
          >
            上传 →
          </ToolButton>
        ) : (
          <ToolButton
            tone="primary"
            disabled={selectedEntries.length === 0}
            onClick={() => transferSelection('download')}
          >
            ← 下载
          </ToolButton>
        )}
        <ToolButton
          tone="danger"
          disabled={selectedEntries.length === 0}
          onClick={() => void runRemove()}
        >
          删除
        </ToolButton>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      ) : null}

      <FileList
        side={side}
        entries={listing?.entries ?? []}
        selected={selected}
        loading={loading}
        sort={sort}
        onSortChange={setSort}
        onActivate={handleActivate}
        onSelect={handleSelect}
        onContextMenu={(entry, x, y) => setMenu({ x, y, entry })}
        onEmptyContextMenu={(x, y) => setMenu({ x, y, entry: null })}
        onDropData={handleDropData}
        dropActive={dropActive}
        emptyHint={loading ? '读取中…' : '空目录'}
      />

      {menu ? (
        <ContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          side={side}
          onPreview={onPreview}
          onRename={runRename}
          onChmod={runChmod}
          onRemove={runRemove}
          onMkdir={runMkdir}
          onNewFile={runNewFile}
          onRefresh={() => void load(path, true)}
        />
      ) : null}
    </section>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors dark:text-neutral-400',
        disabled
          ? 'cursor-not-allowed opacity-40'
          : 'hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-700 dark:hover:text-neutral-100',
      )}
    >
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}

function ToolButton({
  onClick,
  disabled,
  tone = 'default',
  children,
}: {
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'danger'
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
        tone === 'default' &&
          'border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800',
        tone === 'primary' &&
          'border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white',
        tone === 'danger' &&
          'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent dark:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  )
}

function ContextMenu({
  state,
  side,
  onClose,
  onPreview,
  onRename,
  onChmod,
  onRemove,
  onMkdir,
  onNewFile,
  onRefresh,
}: {
  state: ContextMenuState
  side: SftpSide
  onClose: () => void
  onPreview: (entry: SftpEntry) => void
  onRename: (entry: SftpEntry) => Promise<void>
  onChmod: (entry: SftpEntry) => Promise<void>
  onRemove: () => Promise<void>
  onMkdir: () => Promise<void>
  onNewFile: () => Promise<void>
  onRefresh: () => void
}) {
  useEffect(() => {
    const onDown = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const entry = state.entry

  // 菜单不允许溢出视口右下角
  const style = {
    left: Math.min(state.x, window.innerWidth - 180),
    top: Math.min(state.y, window.innerHeight - 220),
  }

  return (
    <div
      role="menu"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-44 rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      {entry ? (
        <>
          {entry.type === 'file' ? (
            <MenuItem onClick={() => { onClose(); onPreview(entry) }}>文本预览 / 编辑</MenuItem>
          ) : null}
          <MenuItem onClick={() => void onRename(entry)}>重命名…</MenuItem>
          <MenuItem onClick={() => void onChmod(entry)}>修改权限…</MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => void onRemove()}>
            删除
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem onClick={() => void onMkdir()}>新建目录…</MenuItem>
          <MenuItem onClick={() => void onNewFile()}>新建空文件…</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => { onClose(); onRefresh() }}>刷新</MenuItem>
        </>
      )}
      <MenuSeparator />
      <div className="px-3 py-1 text-[10px] text-neutral-400 dark:text-neutral-500">
        {side === 'local' ? '服务端本地面板' : '远端主机'}
      </div>
    </div>
  )
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'block w-full px-3 py-1 text-left transition-colors',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800',
      )}
    >
      {children}
    </button>
  )
}

function MenuSeparator() {
  return <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
}
