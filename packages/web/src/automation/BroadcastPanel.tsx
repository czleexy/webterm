/**
 * 同步输入（广播模式）的面板与警告条。
 *
 * 这是整个工具里最容易造成生产事故的一个开关：一次回车会落到 N 台设备上。
 * 因此界面上做了三件事，一件都不能省：
 *
 * 1. **警告条常驻**，只要开着就霸占工作区顶部一行 —— 不能只靠一个小绿灯，
 *    用户切去看别的东西之后回来，很容易忘记自己还开着广播。
 * 2. **接收方数量写在警告条上**，永远可见。「广播中(3)」比「广播中」有用得多。
 * 3. **默认只勾选当前打开着的、已连接的终端**，且新开的标签不会自动加入
 *    （见 useBroadcastStore 的注释）。宁可让用户手动勾一个，也不要静默扩大影响面。
 */
import { useEffect, useMemo } from 'react'
import { listTerminalEndpoints } from '../terminal/terminalBus'
import { useBroadcastStore } from '../store/useBroadcastStore'
import { useTerminalStore } from '../store/useTerminalStore'
import { Chip, EmptyState, primaryButtonClass, secondaryButtonClass } from './ui'
import { cn } from '../utils/cn'

/**
 * 常驻警告条。
 * 直接读 store 的 enabled，因此组件可以无脑挂在 App 里。
 */
export function BroadcastBar() {
  const enabled = useBroadcastStore((s) => s.enabled)
  const targets = useBroadcastStore((s) => s.targets)
  const last = useBroadcastStore((s) => s.last)
  const disable = useBroadcastStore((s) => s.disable)
  const setPanelOpen = useBroadcastStore((s) => s.setPanelOpen)

  if (!enabled) return null

  return (
    <div
      data-testid="broadcast-bar"
      className="flex shrink-0 items-center gap-3 border-b border-amber-400 bg-amber-100 px-3 py-1.5 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-medium">
        <span className="inline-block size-2 animate-pulse rounded-full bg-amber-600 dark:bg-amber-400" />
        同步输入已开启
      </span>
      <span className="min-w-0 flex-1 truncate">
        你在任意终端里敲的每一个键都会同时发给 <b>{targets.length}</b> 个终端 ——
        包括回车。请确认这些设备都受得起这条命令。
        {last ? `（最近一次：投递 ${last.delivered} 个${last.skipped > 0 ? `，跳过 ${last.skipped} 个未连接` : ''}）` : ''}
      </span>
      <button
        type="button"
        data-testid="broadcast-bar-configure"
        onClick={() => setPanelOpen(true)}
        className="shrink-0 rounded border border-amber-500 px-2 py-0.5 transition-colors hover:bg-amber-200 dark:border-amber-700 dark:hover:bg-amber-900/50"
      >
        接收方
      </button>
      <button
        type="button"
        data-testid="broadcast-bar-stop"
        onClick={disable}
        className="shrink-0 rounded border border-amber-600 bg-amber-200 px-2 py-0.5 font-medium transition-colors hover:bg-amber-300 dark:border-amber-600 dark:bg-amber-900/60 dark:hover:bg-amber-900"
      >
        立即停止
      </button>
    </div>
  )
}

/** 接收方选择面板 */
export function BroadcastPanel() {
  const open = useBroadcastStore((s) => s.panelOpen)
  const enabled = useBroadcastStore((s) => s.enabled)
  const targets = useBroadcastStore((s) => s.targets)
  const setPanelOpen = useBroadcastStore((s) => s.setPanelOpen)
  const enable = useBroadcastStore((s) => s.enable)
  const disable = useBroadcastStore((s) => s.disable)
  const toggleTarget = useBroadcastStore((s) => s.toggleTarget)
  const setTargets = useBroadcastStore((s) => s.setTargets)
  const prune = useBroadcastStore((s) => s.prune)

  const tabs = useTerminalStore((s) => s.tabs)
  const activeTabId = useTerminalStore((s) => s.activeTabId)

  // 标签被关掉时把它的 id 从接收方里剔掉：
  // 留着一个不存在的 tabId 会让「广播中(3)」这个数字骗人
  useEffect(() => {
    prune(tabs.map((t) => t.id))
  }, [prune, tabs])

  /**
   * 可选的接收方。
   * 只列「已经连上服务端」的终端：还没连上的终端接收不到任何东西，
   * 把它列进来会让用户以为命令发出去了。
   */
  const candidates = useMemo(() => {
    const live = new Set(listTerminalEndpoints().filter((e) => e.isWritable()).map((e) => e.tabId))
    return tabs
      .filter((t) => Boolean(t.terminalId))
      .map((t) => ({
        id: t.id,
        title: t.title,
        protocol: t.protocol,
        writable: live.has(t.id),
      }))
  }, [tabs])

  if (!open) return null

  const writableIds = candidates.filter((c) => c.writable).map((c) => c.id)

  return (
    <div
      data-testid="broadcast-panel"
      className="fixed inset-0 z-[55] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setPanelOpen(false)
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div>
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              同步输入（广播）
            </h3>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              在任意终端里敲的键会同时投递给下列终端。不做去抖与合并，输入时序原样保留。
            </p>
          </div>
          <button type="button" onClick={() => setPanelOpen(false)} className={secondaryButtonClass}>
            关闭
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <span>
              <b>⚠️ 回车也会一起发出去。</b>
              在一条会删文件的命令上开启广播，就等于在每一台目标设备上删一次。
              确认好接收方名单再开启。
            </span>
          </div>

          {candidates.length === 0 ? (
            <EmptyState>还没有已建立的终端。广播需要至少两个已连接的终端才有意义。</EmptyState>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
                  接收方（{targets.length}）
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="broadcast-select-writable"
                    onClick={() => setTargets(writableIds.filter((id) => id !== activeTabId))}
                    disabled={writableIds.length === 0}
                    className={secondaryButtonClass}
                  >
                    选中全部已连接
                  </button>
                  <button
                    type="button"
                    data-testid="broadcast-clear"
                    onClick={() => setTargets([])}
                    disabled={targets.length === 0}
                    className={secondaryButtonClass}
                  >
                    清空
                  </button>
                </div>
              </div>

              <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="broadcast-targets">
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <label className="flex items-center gap-2 rounded px-1 py-1 text-[11px] hover:bg-neutral-50 dark:hover:bg-neutral-800/60">
                      <input
                        type="checkbox"
                        data-testid={`broadcast-target-${candidate.id}`}
                        checked={targets.includes(candidate.id)}
                        onChange={() => toggleTarget(candidate.id)}
                      />
                      <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">
                        {candidate.title}
                        {candidate.id === activeTabId ? (
                          <span className="ml-1 text-neutral-400 dark:text-neutral-500">
                            （当前标签 —— 它本来就收到自己的输入，不必勾选）
                          </span>
                        ) : null}
                      </span>
                      {candidate.writable ? (
                        <Chip tone="green">已连接</Chip>
                      ) : (
                        <Chip tone="amber">未连接</Chip>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            广播只存在于内存里，刷新页面即失效。
          </p>
          <div className="flex items-center gap-2">
            {enabled ? (
              <button type="button" data-testid="broadcast-stop" onClick={disable} className={cn(secondaryButtonClass, 'border-red-300 text-red-600 dark:border-red-900 dark:text-red-400')}>
                停止广播
              </button>
            ) : (
              <button
                type="button"
                data-testid="broadcast-start"
                onClick={() => {
                  enable(targets.length > 0 ? targets : writableIds.filter((id) => id !== activeTabId))
                  // 开启后立刻收起面板：警示条已经接管了「广播中」这件事的提示，
                  // 而面板挡在终端前面，用户根本没法验证按键有没有发出去
                  setPanelOpen(false)
                }}
                disabled={writableIds.length === 0 || targets.length === 0}
                className={primaryButtonClass}
              >
                开启广播
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
