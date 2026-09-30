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
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_SCROLLBACK, type ServerControlMessage } from '@webterm/shared'
import { useTerminalStore, type TerminalTab } from '../store/useTerminalStore'
import { useBroadcastStore } from '../store/useBroadcastStore'
import { useAutomationStore } from '../store/useAutomationStore'
import { reactToTrigger } from '../automation/terminalReactions'
import { MacroBar } from '../automation/MacroBar'
import { useThemeStore } from '../theme/useTheme'
import { terminalTheme } from './theme'
import { useTerminalConnection } from './useTerminalConnection'
import { broadcastInput, registerTerminalEndpoint } from './terminalBus'
import { cn } from '../utils/cn'
import { PROTOCOL_CHIP_CLASS, protocolLabel } from '../utils/protocol'

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
  const addLabel = useTerminalStore((state) => state.addLabel)

  const getTerm = useCallback(() => termRef.current, [])

  const setStatus = useCallback(
    (patch: Partial<TerminalTab>) => {
      updateTab(tab.id, patch)
    },
    [tab.id, updateTab],
  )

  /**
   * 活动状态的 ref 副本。
   * 自动化事件回调里需要判断「用户是不是正看着这个终端」来决定要不要打角标，
   * 但回调是在 xterm 的 effect 里注册的、不随 active 变化重建（重建会丢掉滚动缓冲），
   * 所以用 ref 读最新值。
   */
  const activeRef = useRef(active)
  activeRef.current = active

  /** 往终端里追加一行提示（与 useTerminalConnection 内的同名前缀保持一致） */
  const writeNotice = useCallback((text: string, tone: 'error' | 'info' = 'info') => {
    const term = termRef.current
    if (!term) return
    const color = tone === 'error' ? '\x1b[31m' : '\x1b[90m'
    term.write(`\r\n${color}${text}\x1b[0m\r\n`)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 阶段 6：自动化运行态的渲染端反应                                       */
  /* ------------------------------------------------------------------ */

  const handleTrigger = useCallback(
    (msg: Extract<ServerControlMessage, { t: 'trigger' }>) => {
      const automation = useAutomationStore.getState()
      const outcome = reactToTrigger({
        term: termRef.current,
        line: msg.line,
        matched: msg.matched,
        ruleName: msg.ruleName,
        ui: msg.ui,
        performed: msg.performed,
        announce: automation.announceInTerminal,
      })

      automation.recordHit({
        tabId: tab.id,
        tabTitle: tab.title,
        ruleId: msg.ruleId,
        ruleName: msg.ruleName,
        line: msg.line,
        matched: msg.matched,
        color: outcome.color,
        performed: msg.performed,
        notified: outcome.notified,
        labels: outcome.labels,
      })
      // 用户正在看着这个终端，角标不该亮 —— 记录照留，只是不算「未读」
      if (activeRef.current) automation.markHitsSeen(tab.id)
      for (const label of outcome.labels) addLabel(tab.id, label)
    },
    [addLabel, tab.id, tab.title],
  )

  const handleScript = useCallback(
    (msg: Extract<ServerControlMessage, { t: 'script' }>) => {
      useAutomationStore.getState().applyScriptMessage(tab.id, tab.title, msg)
    },
    [tab.id, tab.title],
  )

  const handleMacro = useCallback(
    (msg: Extract<ServerControlMessage, { t: 'macro' }>) => {
      useAutomationStore.getState().applyMacroMessage(tab.id, msg)
      // 宏平时是「看得见的」（命令一条条打在屏幕上），只有失败必须额外说一声：
      // 否则用户只会看到输出停在半路，完全不知道是宏在等一个永远不会出现的东西
      if (msg.phase === 'error') {
        writeNotice(`宏「${msg.macroName}」执行失败：${msg.error ?? '未知错误'}`, 'error')
      }
    },
    [tab.id, writeNotice],
  )

  const { sendControl, sendBinary, reconnect, isWritable } = useTerminalConnection({
    tab,
    getTerm,
    setStatus,
    setBanner,
    onTrigger: handleTrigger,
    onScript: handleScript,
    onMacro: handleMacro,
  })

  /* ------------------------------------------------------------------ */
  /* 0. 登记到输入总线（同步输入广播按 tabId 找目标）                      */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    return registerTerminalEndpoint({
      tabId: tab.id,
      title: tab.title,
      sendBinary,
      sendControl,
      isWritable,
    })
  }, [tab.id, tab.title, sendBinary, sendControl, isWritable])

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

      // 同步输入：开启广播时，同一段按键再投递给其他选中的终端。
      // 先发自己再发别人，是因为源终端必须无条件收到自己的输入 ——
      // 广播配置出问题不该让用户「连自己这台都敲不动」。
      const broadcast = useBroadcastStore.getState()
      if (!broadcast.enabled) return
      const outcome = broadcastInput(data, broadcast.targets, tab.id)
      broadcast.recordReceipt({ delivered: outcome.delivered.length, skipped: outcome.skipped.length })
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

  /* ------------------------------------------------------------------ */
  /* 4.5 HTML 会话日志：定期上传整份序列化快照（阶段 7）                    */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const settings = tab.logging
    if (!termReady || !settings?.enabled || settings.format !== 'html') return
    const term = termRef.current
    if (!term) return

    const addon = new SerializeAddon()
    term.loadAddon(addon)

    let dirty = false
    // 每批输出解析完标记为脏：没有新输出就不重复上传（整份序列化并不便宜）
    const writeSub = term.onWriteParsed(() => {
      dirty = true
    })

    let inFlight = false
    const flush = () => {
      if (inFlight || !dirty || !isWritable()) return
      inFlight = true
      dirty = false
      try {
        // 注意：serialize() 输出的是 ANSI 文本，HTML 回放必须用 serializeAsHTML()
        // 底色跟当前终端主题走（浅色主题下终端是白底，写死深色会让回放页割裂）
        const html = wrapHtmlDocument(
          addon.serializeAsHTML(),
          tab.title,
          (term.options.theme as ITheme | undefined) ?? terminalTheme(useThemeStore.getState().mode),
        )
        // 单帧受 WS maxPayload（1 MiB）约束；中文最坏 3 字节/字符、JSON 转义
        // 最坏再翻倍，每片 60k 字符最坏约 360 KB，留足余量
        const CHUNK = 60_000
        const total = Math.max(1, Math.ceil(html.length / CHUNK))
        for (let i = 0; i < total; i += 1) {
          sendControl({
            t: 'log-html',
            seq: i,
            final: i === total - 1,
            data: html.slice(i * CHUNK, (i + 1) * CHUNK),
          })
        }
      } catch {
        // 序列化失败不影响终端本身，等下一轮再试
        dirty = true
      } finally {
        inFlight = false
      }
    }

    // 15 秒一拍：快照丢失窗口上限 = 间隔 + 一次上传时长
    const timer = setInterval(flush, 15_000)
    const onUnload = () => flush()
    window.addEventListener('beforeunload', onUnload)

    return () => {
      clearInterval(timer)
      window.removeEventListener('beforeunload', onUnload)
      // 卸载前最后一搏（此时 WS 通常还活着 —— 关闭标签先走 DELETE 之外的路径时）
      flush()
      writeSub.dispose()
      addon.dispose()
    }
  }, [isWritable, sendControl, tab.logging, tab.title, termReady])

  /* ------------------------------------------------------------------ */
  /* 5. 搜索与工具栏                                                       */
  /* ------------------------------------------------------------------ */

  const runSearch = useCallback(
    (direction: 'next' | 'prev') => {
      if (!searchTerm) return
      if (direction === 'next') searchRef.current?.findNext(searchTerm)
      else searchRef.current?.findPrevious(searchTerm)
    },
    [searchTerm],
  )

  return (
    <div
      // 测试钩子：面板一律挂载（非活动的用 CSS 隐藏），因此外部需要能定位「当前活动的那个」
      data-testid="terminal-pane"
      data-active={active ? 'true' : 'false'}
      data-protocol={tab.protocol}
      data-status={tab.status}
      // 测试钩子：所有面板都挂载着（非活动的只是 CSS 隐藏），
      // 外部要靠标题/客户端 tabId 才能定位「我要读哪一个终端」的内容
      data-tab-title={tab.title}
      data-tab-id={tab.id}
      className={cn('h-full min-h-0 flex-col', active ? 'flex' : 'hidden')}
    >
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
        <ConnectionInfo tab={tab} />
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

      {/* 按钮栏：宏是「针对这个会话」的动作，所以长在终端上而不是面板里 */}
      <MacroBar tab={tab} />

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

/**
 * 序列化片段 → 可在浏览器直接打开的完整 HTML 文档（等宽、保留色彩）。
 *
 * 底色与前景色取自**当前终端主题**而不是写死深色：应用是浅色主题时终端本来就是白底，
 * 写死深色会让回放页出现「白底终端块浮在深色页面上」的割裂观感。
 */
function wrapHtmlDocument(fragment: string, title: string, theme: ITheme): string {
  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const background = theme.background ?? '#101418'
  const foreground = theme.foreground ?? '#d4d4d4'
  return (
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
    `<title>${safeTitle} · 会话日志</title>\n<style>\n` +
    `body{background:${background};color:${foreground};font-family:"JetBrains Mono",Consolas,monospace;` +
    `font-size:13px;line-height:1.25;padding:8px;margin:0}\n` +
    `pre{white-space:pre-wrap;word-break:break-all;margin:0}\n` +
    `.xterm-bold{font-weight:700}.xterm-italic{font-style:italic}.xterm-underline{text-decoration:underline}\n` +
    `</style>\n</head>\n<body>\n<pre>${fragment}</pre>\n</body>\n</html>\n`
  )
}

/**
 * 左侧的协议徽标。
 *
 * Telnet 的协商结果（远端是否回显、NAWS 是否上报）是排障时最常需要的信息 ——
 * 「键盘像失灵一样」十有八九是设备没打开回显。这些细节放在 title 里，
 * 既不占版面又能随手看到。
 */
function ConnectionInfo({ tab }: { tab: TerminalTab }) {
  const isTelnet = tab.protocol === 'telnet'
  const opts = tab.telnetOptions

  const detail = isTelnet
    ? [
        `协议：Telnet（明文）`,
        tab.negotiation ? `服务端标识：${tab.negotiation.serverIdent || '（无）'}` : null,
        `编码：${tab.config?.terminal.encoding ?? '（由会话库配置）'} · ${tab.dims.cols}×${tab.dims.rows}`,
        opts ? `远端回显：${opts.remoteEcho ? '是' : '否（已启用本地回显）'}` : null,
        opts ? `抑制继续（SGA）：${opts.suppressGoAhead ? '已协商' : '未协商'}` : null,
        opts ? `终端类型请求：${opts.terminalTypeRequested ? '是' : '否'}` : null,
        opts ? `窗口尺寸上报（NAWS）：${opts.windowSizeReported ? '是' : '否'}` : null,
        opts && opts.remoteOptions.length > 0 ? `远端启用选项：${opts.remoteOptions.join(', ')}` : null,
        opts && opts.localOptions.length > 0 ? `本端启用选项：${opts.localOptions.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        `协议：SSH`,
        tab.negotiation ? `服务端标识：${tab.negotiation.serverIdent || '（无）'}` : null,
        tab.negotiation ? `密钥交换：${tab.negotiation.kex}` : null,
        tab.negotiation ? `主机密钥：${tab.negotiation.hostKeyAlgorithm}` : null,
        tab.negotiation ? `加密：${tab.negotiation.cipher}` : null,
        tab.negotiation ? `MAC：${tab.negotiation.mac}` : null,
        tab.negotiation ? `算法档案：${tab.negotiation.profile}${tab.negotiation.legacy ? '（legacy）' : ''}` : null,
      ]
        .filter(Boolean)
        .join('\n')

  return (
    <span className="mr-auto flex items-center gap-1.5">
      <span
        title={detail}
        className={cn(
          'cursor-help rounded border px-1.5 py-px text-[10px] leading-none',
          PROTOCOL_CHIP_CLASS[tab.protocol],
        )}
      >
        {protocolLabel(tab.protocol)}
      </span>
      {tab.dims ? (
        <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
          {tab.dims.cols}×{tab.dims.rows}
        </span>
      ) : null}
    </span>
  )
}
