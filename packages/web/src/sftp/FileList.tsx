/**
 * 文件列表。
 *
 * 交互约定（尽量贴近桌面客户端，减少学习成本）：
 * - 单击选中，Ctrl 追加，Shift 连选
 * - 双击进入目录 / 打开文件（文件默认走文本预览）
 * - 右键出上下文菜单
 * - 拖拽选中项到另一栏即触发传输
 *
 * 排序把目录恒定置顶：这是文件管理器的通用预期，
 * 且对我们这个「老设备 + 少量目录」的场景更实用。
 */
import { useMemo } from 'react'
import type { SftpEntry, SftpSide } from '@webterm/shared'
import { cn } from '../utils/cn'
import { formatBytes, formatMtime } from './format'
import { setDragPayload } from './drag'

export type FileSortKey = 'name' | 'size' | 'mtime' | 'type'

export interface FileSort {
  key: FileSortKey
  asc: boolean
}

export const DEFAULT_SORT: FileSort = { key: 'name', asc: true }

interface FileListProps {
  side: SftpSide
  entries: SftpEntry[]
  selected: ReadonlySet<string>
  loading: boolean
  sort: FileSort
  onSortChange: (sort: FileSort) => void
  onActivate: (entry: SftpEntry) => void
  onSelect: (entry: SftpEntry, modifiers: { ctrl: boolean; shift: boolean }) => void
  onContextMenu: (entry: SftpEntry, x: number, y: number) => void
  onEmptyContextMenu: (x: number, y: number) => void
  onDropData: (dt: DataTransfer) => void
  emptyHint?: string
  /** 高亮：作为拖拽目标时 */
  dropActive: boolean
}

const TYPE_ORDER: Record<SftpEntry['type'], number> = { dir: 0, link: 1, file: 2, other: 3 }

export function FileList({
  side,
  entries,
  selected,
  loading,
  sort,
  onSortChange,
  onActivate,
  onSelect,
  onContextMenu,
  onEmptyContextMenu,
  onDropData,
  emptyHint,
  dropActive,
}: FileListProps) {
  const sorted = useMemo(() => {
    const factor = sort.asc ? 1 : -1
    return [...entries].sort((a, b) => {
      // 目录永远在前，与升/降序无关
      const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      if (byType !== 0) return byType

      let diff = 0
      switch (sort.key) {
        case 'size':
          diff = a.size - b.size
          break
        case 'mtime':
          diff = a.mtime - b.mtime
          break
        case 'type':
          diff = a.type.localeCompare(b.type)
          break
        case 'name':
        default:
          diff = a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      }
      if (diff !== 0) return diff * factor
      // 次级排序用名称，保证顺序稳定（localeCompare 对中文同一拼音也可能相等）
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
    })
  }, [entries, sort])

  const toggleSort = (key: FileSortKey): void => {
    onSortChange({ key, asc: sort.key === key ? !sort.asc : true })
  }

  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-auto',
        dropActive && 'bg-blue-50/60 dark:bg-blue-950/30',
      )}
      onDragOver={(e) => {
        // 必须 preventDefault 才会收到 drop 事件
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropData(e.dataTransfer)
      }}
      onContextMenu={(e) => {
        // 空白处右键：目标是当前目录
        e.preventDefault()
        onEmptyContextMenu(e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        const first = sorted.find((entry) => selected.has(entry.path))
        if (first) onActivate(first)
      }}
    >
      <table className="w-full table-fixed border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-neutral-50 text-[11px] text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            <SortHeader
              label="名称"
              active={sort.key === 'name'}
              asc={sort.asc}
              onClick={() => toggleSort('name')}
              className="pl-2"
            />
            <SortHeader
              label="大小"
              active={sort.key === 'size'}
              asc={sort.asc}
              onClick={() => toggleSort('size')}
              className="w-20 text-right"
            />
            <SortHeader
              label="修改时间"
              active={sort.key === 'mtime'}
              asc={sort.asc}
              onClick={() => toggleSort('mtime')}
              className="w-24"
            />
            <th className="w-24 px-2 py-1.5 text-left font-medium">权限</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => {
            const isSelected = selected.has(entry.path)
            return (
              <tr
                key={entry.path}
                data-testid={`entry-${side}`}
                data-name={entry.name}
                data-type={entry.type}
                data-selected={isSelected ? '1' : '0'}
                draggable
                onDragStart={(e) => {
                  // 拖动未选中的行时，只拖这一行（与桌面客户端一致）
                  const paths = isSelected && selected.size > 0 ? [...selected] : [entry.path]
                  setDragPayload(e.dataTransfer, { side, paths })
                }}
                onClick={(e) => onSelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                onDoubleClick={() => onActivate(entry)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu(entry, e.clientX, e.clientY)
                }}
                className={cn(
                  'cursor-default select-none border-b border-neutral-100 dark:border-neutral-800/60',
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950/40'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60',
                )}
                title={entry.path}
              >
                <td className="truncate py-1 pl-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <EntryIcon entry={entry} />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        entry.type === 'link' && 'text-sky-600 dark:text-sky-400',
                        entry.type === 'dir' && 'text-neutral-900 dark:text-neutral-100',
                      )}
                    >
                      {entry.name}
                    </span>
                    {entry.type === 'link' && entry.target ? (
                      <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                        → {entry.target}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="truncate px-2 py-1 text-right font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                  {entry.type === 'dir' ? '—' : formatBytes(entry.size)}
                </td>
                <td className="truncate px-2 py-1 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                  {formatMtime(entry.mtime)}
                </td>
                <td className="truncate px-2 py-1 font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                  {entry.modeText}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {sorted.length === 0 && !loading ? (
        <p className="px-3 py-6 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
          {emptyHint ?? '空目录'}
        </p>
      ) : null}
      {loading ? (
        <p className="px-3 py-3 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
          读取中…
        </p>
      ) : null}
    </div>
  )
}

function SortHeader({
  label,
  active,
  asc,
  onClick,
  className,
}: {
  label: string
  active: boolean
  asc: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <th className={cn('px-2 py-1.5 text-left font-medium', className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-0.5 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100',
          active && 'text-neutral-800 dark:text-neutral-100',
        )}
      >
        {label}
        {active ? <span aria-hidden="true">{asc ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  )
}

function EntryIcon({ entry }: { entry: SftpEntry }) {
  if (entry.type === 'dir') {
    return (
      <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-amber-500" aria-hidden="true">
        <path
          d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2h9.2A1.5 1.5 0 0 1 21 9.7v7.8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"
          fill="currentColor"
        />
      </svg>
    )
  }
  if (entry.type === 'link') {
    return (
      <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-sky-500" aria-hidden="true">
        <path
          d="M9.5 14.5 14.5 9.5M8 12l-1.6 1.6a3.4 3.4 0 0 0 4.8 4.8L13 16.8M16 12l1.6-1.6a3.4 3.4 0 0 0-4.8-4.8L11 7.2"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5 shrink-0 text-neutral-400 dark:text-neutral-500"
      aria-hidden="true"
    >
      <path
        d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
    </svg>
  )
}
