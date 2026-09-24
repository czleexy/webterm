/**
 * 单个终端面板：xterm.js 实例 + 与远端 PTY 的双向同步。
 *
 * 连接的建立、消息分发与重连由 useTerminalConnection 负责，本组件只关注渲染层：
 * 创建 xterm、把键盘输入转成二进制帧、跟随主题与容器尺寸。
 *
 * 关键设计（详见各自注释）：
 * - 所有标签同时挂载，用 CSS 隐藏非活动标签，避免丢失滚动缓冲
 * - 二进制帧直通 xterm，不自行解析转义序列
 * - 用 xterm 的写入回调作为消费确认，驱动服务端背压
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_SCROLLBACK } from '@webterm/shared'
import { useTerminalStore, type TerminalTab } from '../store/useTerminalStore'
import { useThemeStore } from '../theme/useTheme'
import { terminalTheme } from './theme'
import { useTerminalConnection } from './useTerminalConnection'
import { cn } from '../utils/cn'

interface TerminalPaneProps {
  tab: TerminalTab
  active: boolean
}

export function TerminalPane({ tab, active }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  /** 避免在 xterm 创建前的回调里访问未就绪的实例 */
  const [termReady, setTermReady] = useState(false)

  const [banner, setBanner] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  const mode = useThemeStore((state) => state.mode)
  const updateTab = useTerminalStore((state) => state.updateTab)

  const getTerm = useCallback(() => termRef.current, [])

  const setStatus = useCallback(
    (patch: Partial<TerminalTab>) => {
      updateTab(tab.id, patch)
    },
    [tab.id, updateTab],
  )

  const { sendControl, sendBinary, reconnect } = useTerminalConnection({
    tab,
    getTerm,
    setStatus,
    setBanner,
  })

  /* ------------------------------------------------------------------ */
  /* 1. 创建 xterm 实例（仅一次）                                          */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      scrollback: DEFAULT_SCROLLBACK,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        '"JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: terminalTheme(useThemeStore.getState().mode),
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const search = new SearchAddon()
    term.loadAddon(search)

    term.open(host)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    setTermReady(true)

    // 键盘输入 → 二进制帧发往服务端。
    // 用 TextEncoder 得到 UTF-8 字节；若目标编码不是 UTF-8，服务端会再转码。
    const inputSub = term.onData((data) => {
      sendBinary(new TextEncoder().encode(data))
    })

    // 尺寸变化（FitAddon 触发）→ 通知服务端调整远端 PTY
    const resizeSub = term.onResize(({ cols, rows }) => {
      sendControl({ t: 'resize', cols, rows })
    })

    // 初次布局：等一帧让容器拿到真实尺寸，否则 fit 会算出 0 列
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* 容器尺寸为 0 时忽略 */
      }
    })

    return () => {
      cancelAnimationFrame(raf)
      inputSub.dispose()
      resizeSub.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      setTermReady(false)
    }
    // sendControl / sendBinary 都是稳定的 useCallback，不会导致 xterm 重建
  }, [sendControl, sendBinary])

  /* ------------------------------------------------------------------ */
  /* 2. 主题联动                                                          */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme(mode)
  }, [mode])

  /* ------------------------------------------------------------------ */
  /* 3. 切换为活动标签时重算尺寸并聚焦                                      */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!active || !termReady) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    // 显示状态的变化需要等浏览器完成布局，用 rAF 保证拿到真实容器尺寸
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* 忽略 */
      }
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, termReady])

  /* ------------------------------------------------------------------ */
  /* 4. 容器尺寸变化自适应                                                 */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let pending = false
    const observer = new ResizeObserver(() => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        // 非活动标签尺寸为 0，此时 fit 会把 cols/rows 算成极小值，必须跳过
        if (!active) return
        try {
          fitRef.current?.fit()
        } catch {
          /* 忽略 */
        }
      })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [active])

  const runSearch = useCallback(
    (direction: 'next' | 'prev') => {
      if (!searchTerm) return
      if (direction === 'next') searchRef.current?.findNext(searchTerm)
      else searchRef.current?.findPrevious(searchTerm)
    },
    [searchTerm],
  )

  return (
    <div className={cn('h-full min-h-0 flex-col', active ? 'flex' : 'hidden')}>
      {banner ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] leading-snug text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{banner}</span>
          <button
            type="button"
            onClick={reconnect}
            className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium transition-colors hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40"
          >
            重新连接
          </button>
        </div>
      ) : null}

      {searchOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">搜索</span>
          <input
            autoFocus
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') setSearchOpen(false)
            }}
            placeholder="输入关键字后回车"
            className="w-56 rounded border border-neutral-200 bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <button
            type="button"
            onClick={() => runSearch('prev')}
            className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            上一个
          </button>
          <button
            type="button"
            onClick={() => runSearch('next')}
            className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            下一个
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1 dark:border-neutral-800 dark:bg-neutral-900">
        <ToolbarButton onClick={() => setSearchOpen((v) => !v)}>搜索</ToolbarButton>
        <ToolbarButton
          onClick={() => {
            const text = termRef.current?.getSelection()
            if (text) void navigator.clipboard.writeText(text)
          }}
        >
          复制选中
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            termRef.current?.clear()
          }}
        >
          清屏
        </ToolbarButton>
      </div>

      {/* xterm 需要容器有确定尺寸，故用绝对定位填满剩余空间 */}
      <div className="relative min-h-0 flex-1 bg-white dark:bg-neutral-950">
        <div ref={hostRef} className="absolute inset-0 px-1 py-1" />
      </div>
    </div>
  )
}

function ToolbarButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {children}
    </button>
  )
}
