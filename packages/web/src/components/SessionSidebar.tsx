/**
 * 左侧栏：上半是「当前连接」（终端与 SFTP 共用一份列表），下半是「会话库」树。
 *
 * 会话库节点支持：连接、打开 SFTP、编辑（会话）、新建子文件夹、删除（文件夹递归）。
 *
 * 组件刻意不直接依赖任何 store 类型：连接列表由上层压成 ConnectionItem 传入，
 * 这样终端与 SFTP 两种会话能在同一个列表里共存，而不用在这里做类型分支。
 */
import { useState } from 'react'
import type { ConnectionProtocol, LibraryNode } from '@webterm/shared'
import { protocolOf } from '@webterm/shared'
import { cn } from '../utils/cn'
import { PROTOCOL_CHIP_CLASS, protocolLabel } from '../utils/protocol'

export interface ConnectionItem {
  /** 全局唯一 key（'terminal:<id>' / 'sftp:<id>'） */
  key: string
  kind: 'terminal' | 'sftp'
  title: string
  /** 连接协议，用于列表上的协议小标 */
  protocol?: ConnectionProtocol
  dot: string
  statusText: string
}

interface SessionSidebarProps {
  connections: ConnectionItem[]
  activeKey: string | null
  nodes: LibraryNode[]
  vaultUnlocked: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onNew: () => void
  onConnectSession: (node: LibraryNode) => void
  /** 为会话库中的配置打开一个 SFTP 文件传输标签 */
  onOpenSftp: (node: LibraryNode) => void
  onEditSession: (node: LibraryNode) => void
  onNewSessionIn: (parentId: string | null) => void
  onNewFolderIn: (parentId: string | null) => void
  onDeleteNode: (node: LibraryNode) => void
  onLockVault: () => void
}

export function SessionSidebar({
  connections,
  activeKey,
  nodes,
  vaultUnlocked,
  onSelect,
  onClose,
  onNew,
  onConnectSession,
  onOpenSftp,
  onEditSession,
  onNewSessionIn,
  onNewFolderIn,
  onDeleteNode,
  onLockVault,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 把扁平节点列表按 parent 归组，保持服务端返回的排序
  const childrenOf = (parentId: string | null): LibraryNode[] =>
    nodes.filter((n) => (n.parentId ?? null) === parentId)

  const renderNode = (node: LibraryNode, depth: number) => {
    const isFolder = node.kind === 'folder'
    const isCollapsed = collapsed.has(node.id)
    // 会话库节点的协议；旧记录没有 protocol 字段，按 ssh 处理
    const sessionProtocol = isFolder ? undefined : protocolOf(node.session ?? {})
    const sftpAllowed = sessionProtocol !== 'telnet'

    return (
      <li key={node.id}>
        <div
          // 测试钩子：节点的协议与类型是界面上最难用文本断言的部分
          data-testid="library-node"
          data-kind={node.kind}
          data-name={node.name}
          data-protocol={sessionProtocol ?? ''}
          className={cn(
            'group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/60',
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {isFolder ? (
            <button
              type="button"
              onClick={() => toggle(node.id)}
              className="flex size-4 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              aria-label={isCollapsed ? '展开' : '折叠'}
            >
              <svg
                viewBox="0 0 24 24"
                className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')}
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-neutral-400" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 9l3 3-3 3M13 15h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          )}

          {sessionProtocol ? (
            <span
              className={cn(
                'shrink-0 rounded border px-1 py-px text-[9px] leading-none',
                PROTOCOL_CHIP_CLASS[sessionProtocol],
              )}
            >
              {protocolLabel(sessionProtocol)}
            </span>
          ) : null}

          <span
            role="button"
            tabIndex={0}
            onClick={() => (isFolder ? toggle(node.id) : onConnectSession(node))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (isFolder) toggle(node.id)
                else onConnectSession(node)
              }
            }}
            className="min-w-0 flex-1 cursor-pointer truncate text-xs text-neutral-700 dark:text-neutral-300"
            title={
              isFolder
                ? node.name
                : sftpAllowed
                  ? `${node.name}（单击即连接）`
                  : `${node.name}（Telnet 明文连接，单击即连接）`
            }
          >
            {node.name}
          </span>

          {/* 悬停操作 */}
          <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
            {isFolder ? (
              <>
                <button
                  type="button"
                  title="在此新建会话"
                  onClick={() => onNewSessionIn(node.id)}
                  className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  +会话
                </button>
                <button
                  type="button"
                  title="在此新建分组"
                  onClick={() => onNewFolderIn(node.id)}
                  className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  +组
                </button>
              </>
            ) : (
              <>
                {sftpAllowed ? (
                  <button
                    type="button"
                    title="打开 SFTP 文件传输"
                    onClick={() => onOpenSftp(node)}
                    className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  >
                    SFTP
                  </button>
                ) : null}
                <button
                  type="button"
                  title="编辑会话"
                  onClick={() => onEditSession(node)}
                  className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  编辑
                </button>
              </>
            )}
            <button
              type="button"
              title={isFolder ? '删除分组（含全部子节点）' : '删除会话'}
              onClick={() => onDeleteNode(node)}
              className="text-[10px] text-neutral-400 hover:text-red-500"
            >
              删除
            </button>
          </span>
        </div>

        {isFolder && !isCollapsed ? (
          <ul>{childrenOf(node.id).map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    )
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      {/* 当前连接 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          连接
          {connections.length > 0 ? (
            <span className="ml-1 text-neutral-400 dark:text-neutral-500">({connections.length})</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onNew}
          className="rounded border border-neutral-200 bg-white px-1.5 py-px text-[10px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          快速连接
        </button>
      </div>

      <ul className="max-h-[38%] shrink-0 overflow-y-auto p-1.5">
        {connections.length === 0 ? (
          <li className="px-2 py-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">暂无连接</li>
        ) : (
          connections.map((item) => {
            const active = item.key === activeKey
            return (
              <li key={item.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(item.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(item.key)
                    }
                  }}
                  className={cn(
                    'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                    active
                      ? 'bg-white shadow-sm dark:bg-neutral-800'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60',
                  )}
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', item.dot)} title={item.statusText} />
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
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-300">
                    {item.title}
                  </span>
                  <button
                    type="button"
                    aria-label={`关闭 ${item.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(item.key)
                    }}
                    className="flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                  >
                    <svg viewBox="0 0 24 24" className="size-3" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </li>
            )
          })
        )}
      </ul>

      {/* 会话库 */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">会话库</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              title="在根目录新建会话"
              onClick={() => onNewSessionIn(null)}
              className="rounded border border-neutral-200 bg-white px-1.5 py-px text-[10px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              +会话
            </button>
            <button
              type="button"
              title="在根目录新建分组"
              onClick={() => onNewFolderIn(null)}
              className="rounded border border-neutral-200 bg-white px-1.5 py-px text-[10px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              +组
            </button>
          </span>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5 pt-0">
          {childrenOf(null).map((node) => renderNode(node, 0))}
          {nodes.length === 0 ? (
            <li className="px-2 py-2 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              会话库为空。
              {vaultUnlocked
                ? '点击「+会话」创建第一个连接配置。'
                : '解锁保险库后可创建带凭据的会话。'}
            </li>
          ) : null}
        </ul>

        <div className="shrink-0 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
              <span className={cn('size-1.5 rounded-full', vaultUnlocked ? 'bg-emerald-500' : 'bg-amber-500')} />
              {vaultUnlocked ? '保险库已解锁' : '保险库已锁定'}
            </span>
            {vaultUnlocked ? (
              <button
                type="button"
                onClick={onLockVault}
                className="text-[10px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline dark:hover:text-neutral-200"
              >
                锁定
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  )
}
