/**
 * 单个终端面板：xterm.js 实例 + 与远端 PTY 的双向同步。
 *
 * 连接的建立、消息分发与重连由 useTerminalConnection 负责，本组件只关注渲染层：
 * 创建 xterm、把键盘输入转成二进制帧、跟随主题/外观设置与容器尺寸。
 *
 * 关键设计（详见各自注释）：
 * - 所有标签同时挂载，用 CSS 隐藏不可见的面板，避免丢失滚动缓冲
 * - 二进制帧直通 xterm，不自行解析转义序列
 * - 用 xterm 的写入回调作为消费确认，驱动服务端背压
 * - `active`（聚焦）与 `visible`（可见）是两件事：分屏时 2~4 个面板同时可见，
 *   但只有一个是键盘输入的去处
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { IDisposable, ITheme } from '@xterm/xterm'
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
import { resolveTerminalTheme } from '../settings/terminalThemes'
import { useHighlightRules, useSettingsStore } from '../settings/useSettingsStore'
import { useTerminalConnection } from './useTerminalConnection'
import { useTerminalHighlighter } from './useTerminalHighlighter'
import { broadcastInput, registerTerminalEndpoint } from './terminalBus'
import { useT } from '../i18n'
import { toast } from '../ui/toast'
import { notifyEvent } from '../ui/desktopNotify'
import { SkeletonBlock } from '../ui/Skeleton'
import { cn } from '../utils/cn'
import { PROTOCOL_CHIP_CLASS, protocolLabel } from '../utils/protocol'

/**
 * 连字连接器：把常见多字符运算符渲染成一个整体，配合支持连字的字体才能看出效果。
 *
 * 注意（如实说明）：xterm 的字符连接器**只在 WebGL 渲染器下生效**，
 * 默认的 DOM 渲染器会忽略它。所以这个开关在当前技术栈里是「为将来接 WebGL 预留」，
 * 设置页也据此给出提示，不会让用户以为是自己搞错了。
 */
const LIGATURE_SEQUENCES = ['->', '=>', '!=', '>=', '<=', '===', '!==', '::', '|>', '<<', '>>']
const LIGATURE_PATTERN = new RegExp(LIGATURE_SEQUENCES.map(escapeRegExp).join('|'), 'g')

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 搜索的装饰上限，同时也是 `SearchAddon` 统计命中数的上限。
 *
 * addon 的 `resultCount` 就是它铺过装饰的命中数（`_searchResults` 被 `highlightLimit`
 * 截断），所以缓冲里的命中数一旦超过这个值，计数只能报「上限」而不是真值 ——
 * 界面上据此显示成 `2000+`，避免把 10 万处命中报成 2000 处。
 */
const SEARCH_HIGHLIGHT_LIMIT = 2_000

/**
 * 分屏格子的附加信息。
 * 只在分屏时传入（单格模式下为 undefined）—— 单格不需要「这个格子放的是哪个会话」
 * 这种信息，工具栏左侧照旧显示协议徽标。
 */
export interface PaneChrome {
  index: number
  focused: boolean
  options: { id: string; title: string }[]
  onFocus: () => void
  onClear: () => void
  onPick: (tabId: string) => void
}

interface TerminalPaneProps {
  tab: TerminalTab
  /** 是否聚焦（键盘输入落点、自动化角标的「已读」判定） */
  active: boolean
  /** 是否可见（分屏时多个同时为 true；不可见的不做 fit，否则会算出 0 列） */
  visible: boolean
  /** 分屏时该面板在网格里的位置；单格模式不传（网格只有一格，无需指派） */
  gridArea?: string
  /** 分屏格子信息；不传表示单格模式 */
  pane?: PaneChrome
}

export function TerminalPane({ tab, active, visible, gridArea, pane }: TerminalPaneProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  /** 搜索异常只提示一次，避免用户每敲一个字符刷一条警告 */
  const searchWarnedRef = useRef(false)
  const joinerRef = useRef<number | null>(null)
  /** 避免在 xterm 创建前的回调里访问未就绪的实例 */
  const [termReady, setTermReady] = useState(false)

  const [banner, setBanner] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchCase, setSearchCase] = useState(false)
  const [searchWholeWord, setSearchWholeWord] = useState(false)
  /**
   * 是否显示「正在连接」骨架屏。
   *
   * 加 400ms 延迟是有意的：本机/局域网连接通常在百毫秒内就绪，
   * 立刻铺一层遮罩会让每次开标签都闪一下，观感比空白更差。
   * 只有真的慢了（跨网段、跳板链长）才值得告诉用户「在等什么」。
   */
  const [slowConnect, setSlowConnect] = useState(false)
  const [searchResult, setSearchResult] = useState<{ index: number; count: number } | null>(null)

  const appearance = useSettingsStore((state) => state.appearance)
  const highlightRules = useHighlightRules()
  const resolvedTheme = useThemeStore((state) => state.resolved)
  /** 当前实际生效的终端配色（`auto` 已按界面明暗解析） */
  const effectiveTheme = useMemo(
    () => resolveTerminalTheme(appearance.themeId, resolvedTheme),
    [appearance.themeId, resolvedTheme],
  )
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

  /** 复制当前选中内容（快捷键与工具栏共用） */
  const copySelection = useCallback(() => {
    const text = termRef.current?.getSelection()
    if (!text) {
      toast('info', t('toast.copyFailed'))
      return
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => toast('success', t('toast.copied')))
      .catch(() => toast('error', t('toast.copyFailed')))
  }, [t])

  /* ------------------------------------------------------------------ */
  /* 0. 登记到输入总线（同步输入广播 / 全局快捷键都按 tabId 找目标）           */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    return registerTerminalEndpoint({
      tabId: tab.id,
      title: tab.title,
      sendBinary,
      sendControl,
      isWritable,
      openSearch: () => setSearchOpen(true),
      focus: () => termRef.current?.focus(),
      copySelection,
    })
  }, [tab.id, tab.title, sendBinary, sendControl, isWritable, copySelection])

  /* ------------------------------------------------------------------ */
  /* 1. 创建 xterm 实例（仅一次）                                          */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance
    const term = new Terminal({
      /**
       * 必须显式打开 proposed API，否则 `registerDecoration` / `registerMarker`
       * / `registerCharacterJoiner` 全部抛错（xterm 6 仍把它们标为提案状态）。
       * 它影响的正是阶段 8 的三件事：搜索命中高亮、关键词行底装饰、连字连接器。
       * 踩过一次：不打开时搜索会**静默**返回 0 个结果（异常被 catch 吞掉），
       * 表现得像「关键字真的不存在」，极难排查。
       */
      allowProposedApi: true,
      scrollback: initial.scrollback || DEFAULT_SCROLLBACK,
      cursorBlink: initial.cursorBlink,
      cursorStyle: initial.cursorStyle,
      fontFamily: initial.fontFamily,
      fontSize: initial.fontSize,
      lineHeight: initial.lineHeight,
      theme: resolveTerminalTheme(initial.themeId, useThemeStore.getState().resolved),
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const search = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
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
      if (joinerRef.current !== null) {
        try {
          term.deregisterCharacterJoiner(joinerRef.current)
        } catch {
          /* 渲染器不支持时忽略 */
        }
        joinerRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      setTermReady(false)
    }
    // sendControl / sendBinary 都是稳定的 useCallback，不会导致 xterm 重建
  }, [sendControl, sendBinary])

  /* ------------------------------------------------------------------ */
  /* 2. 外观设置联动（主题 / 字体 / 光标 / 缓冲）                            */
  /* ------------------------------------------------------------------ */

  /** 字号、字族、行高都会改变单个字符的盒子尺寸，改完必须重新 fit 并同步远端 PTY */
  const applyFontMetrics = useCallback(() => {
    const raf = requestAnimationFrame(() => {
      if (!visible) return
      try {
        fitRef.current?.fit()
      } catch {
        /* 忽略 */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = effectiveTheme
  }, [effectiveTheme])

  useEffect(() => {
    const term = termRef.current
    if (!term || !termReady) return
    term.options.fontFamily = appearance.fontFamily
    term.options.fontSize = appearance.fontSize
    term.options.lineHeight = appearance.lineHeight
    return applyFontMetrics()
  }, [
    appearance.fontFamily,
    appearance.fontSize,
    appearance.lineHeight,
    applyFontMetrics,
    termReady,
  ])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = appearance.cursorStyle
    term.options.cursorBlink = appearance.cursorBlink
    term.options.scrollback = appearance.scrollback
  }, [appearance.cursorBlink, appearance.cursorStyle, appearance.scrollback])

  /** 连字开关：注册 / 注销字符连接器 */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (joinerRef.current !== null) {
      try {
        term.deregisterCharacterJoiner(joinerRef.current)
      } catch {
        /* 忽略 */
      }
      joinerRef.current = null
    }
    if (!appearance.ligatures) return
    try {
      joinerRef.current = term.registerCharacterJoiner((text) => {
        const ranges: [number, number][] = []
        LIGATURE_PATTERN.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = LIGATURE_PATTERN.exec(text)) !== null) {
          ranges.push([match.index, match.index + match[0].length])
        }
        return ranges
      })
    } catch {
      /* DOM 渲染器不支持字符连接器，静默跳过 */
    }
  }, [appearance.ligatures, termReady])

  /* ------------------------------------------------------------------ */
  /* 2.5 关键词高亮                                                       */
  /* ------------------------------------------------------------------ */

  const handleHighlightLimit = useCallback(() => {
    writeNotice('高亮行数已达上限，后续命中不再标记（可通过搜索定位）')
  }, [writeNotice])

  useTerminalHighlighter({
    term: termReady ? termRef.current : null,
    ready: termReady,
    rules: highlightRules,
    mode: resolvedTheme,
    onLimitReached: handleHighlightLimit,
  })

  /* ------------------------------------------------------------------ */
  /* 3. 切换为可见时重算尺寸并聚焦                                          */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!visible || !termReady) return
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
      if (active) term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, active, termReady])

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
        // 不可见时容器尺寸为 0，此时 fit 会把 cols/rows 算成极小值，必须跳过
        if (!visible) return
        try {
          fitRef.current?.fit()
        } catch {
          /* 忽略 */
        }
      })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [visible])

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
          (term.options.theme as ITheme | undefined) ??
            resolveTerminalTheme(
              useSettingsStore.getState().appearance.themeId,
              useThemeStore.getState().resolved,
            ),
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
  /* 4.8 断开提醒（阶段 8）：Toast + 桌面通知                              */
  /* ------------------------------------------------------------------ */

  const prevStatusRef = useRef(tab.status)
  useEffect(() => {
    const previous = prevStatusRef.current
    prevStatusRef.current = tab.status
    if (previous === tab.status) return
    // 「连接中 → 出错」也算，否则首连失败会悄无声息
    if (tab.status !== 'exited' && tab.status !== 'error') return
    toast(tab.status === 'error' ? 'error' : 'warning', t('toast.disconnected', { title: tab.title }), {
      detail: tab.notice,
    })
    notifyEvent('disconnect', t('toast.disconnected', { title: tab.title }), tab.notice ?? '')
  }, [tab.status, tab.notice, tab.title, t])

  /* ------------------------------------------------------------------ */
  /* 5. 搜索                                                              */
  /* ------------------------------------------------------------------ */

  const searchOptions = useMemo(
    () => ({
      regex: searchRegex,
      caseSensitive: searchCase,
      wholeWord: searchWholeWord,
      decorations: {
        matchBackground: resolvedTheme === 'dark' ? '#4a3a12' : '#ffe9a8',
        matchBorder: resolvedTheme === 'dark' ? '#8a6d1f' : '#e0b64d',
        matchOverviewRuler: '#e0b64d',
        activeMatchBackground: resolvedTheme === 'dark' ? '#8a5f12' : '#ffc857',
        activeMatchBorder: '#c99b1f',
        activeMatchColorOverviewRuler: '#ffb01f',
      },
    }),
    [resolvedTheme, searchCase, searchRegex, searchWholeWord],
  )

  // 结果计数：SearchAddon 会带上「第几个 / 共几个」
  useEffect(() => {
    if (!termReady) return
    const search = searchRef.current
    if (!search) return
    let sub: IDisposable | null = null
    try {
      sub = search.onDidChangeResults((event) => {
        setSearchResult({ index: event.resultIndex, count: event.resultCount })
      })
    } catch {
      /* 老版本 addon 没有该事件时忽略 */
    }
    return () => sub?.dispose()
  }, [termReady])

  const runSearch = useCallback(
    (direction: 'next' | 'prev') => {
      const search = searchRef.current
      if (!search || !searchTerm) return
      // incremental 只在「边打边找」时需要；这里显式跳转时关掉，
      // 否则 xterm 会把选择范围一路扩到最后一个匹配
      const options = { ...searchOptions, incremental: false }
      if (direction === 'next') search.findNext(searchTerm, options)
      else search.findPrevious(searchTerm, options)
    },
    [searchOptions, searchTerm],
  )

  // 输入变化时增量查找：把「打字」当作连续的下一次搜索
  useEffect(() => {
    if (!searchOpen) return
    const search = searchRef.current
    if (!search) return
    if (!searchTerm) {
      search.clearDecorations()
      setSearchResult(null)
      return
    }
    const timer = setTimeout(() => {
      try {
        search.findNext(searchTerm, { ...searchOptions, incremental: true })
      } catch (error) {
        // 用户正在输入一个还不完整的正则，忽略这次查找。
        // 但**要留下痕迹**：同类异常若被完全吞掉，症状会表现为
        // 「关键字明明在屏幕上却搜不到 0 个结果」，排查起来极其费时。
        if (!searchWarnedRef.current) {
          searchWarnedRef.current = true
          console.warn('[webterm] 终端搜索失败：', error)
        }
      }
    }, 180)
    return () => clearTimeout(timer)
  }, [searchOpen, searchTerm, searchOptions])

  // 关闭搜索条时清掉高亮，避免残留在屏幕上
  useEffect(() => {
    if (searchOpen) return
    searchRef.current?.clearDecorations()
    setSearchResult(null)
  }, [searchOpen])

  // Ctrl+F 由全局快捷键转到这里（见 terminalBus 的 openSearch）
  useEffect(() => {
    if (!searchOpen || !visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen, visible])

  // 「正在连接」骨架屏的延迟闸门（见 slowConnect 的说明）
  useEffect(() => {
    if (tab.status !== 'connecting') {
      setSlowConnect(false)
      return
    }
    const timer = setTimeout(() => setSlowConnect(true), 400)
    return () => clearTimeout(timer)
  }, [tab.status])

  return (
    <div
      // 测试钩子：面板一律挂载（不可见的用 CSS 隐藏），因此外部需要能定位「当前活动的那个」
      data-testid="terminal-pane"
      data-active={active ? 'true' : 'false'}
      data-visible={visible ? 'true' : 'false'}
      data-protocol={tab.protocol}
      data-status={tab.status}
      data-slot={pane ? pane.index : undefined}
      // 测试钩子：所有面板都挂载着（不可见的只是 CSS 隐藏），
      // 外部要靠标题/客户端 tabId 才能定位「我要读哪一个终端」的内容
      data-tab-title={tab.title}
      data-tab-id={tab.id}
      style={gridArea ? { gridArea } : undefined}
      // 点一下格子里的任何地方（含终端）就把焦点交给它：分屏时这是最自然的聚焦方式
      onMouseDownCapture={() => {
        if (pane && !pane.focused) pane.onFocus()
      }}
      className={cn('h-full min-h-0 flex-col overflow-hidden', visible ? 'flex' : 'hidden')}
    >
      {banner ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] leading-snug text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{banner}</span>
          <button
            type="button"
            onClick={reconnect}
            className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium transition-colors hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40"
          >
            {t('terminal.reconnect')}
          </button>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1 dark:border-neutral-800 dark:bg-neutral-900">
        {pane ? <PaneBar pane={pane} tab={tab} /> : <ConnectionInfo tab={tab} />}
        <ToolbarButton testId="terminal-search-open" onClick={() => setSearchOpen((v) => !v)}>
          {t('terminal.search')}
        </ToolbarButton>
        <ToolbarButton testId="terminal-copy" onClick={copySelection}>
          {t('terminal.copy')}
        </ToolbarButton>
        <ToolbarButton
          testId="terminal-clear"
          onClick={() => {
            termRef.current?.clear()
          }}
        >
          {t('terminal.clear')}
        </ToolbarButton>
      </div>

      {/* 按钮栏：宏是「针对这个会话」的动作，所以长在终端上而不是面板里。
          分屏时隐藏 —— 四宫格里每一格再占一行按钮，终端本身就没多少高度了 */}
      {pane ? null : <MacroBar tab={tab} />}

      {/* xterm 需要容器有确定尺寸，故用绝对定位填满剩余空间。
          搜索条悬浮在上面而不是占一行高度：占高度会触发容器尺寸变化，
          每开一次搜索终端都要重新 fit、回滚位置也会跳。 */}
      <div className="relative min-h-0 flex-1 bg-white dark:bg-neutral-950">
        <div ref={hostRef} className="absolute inset-0 px-1 py-1" />

        {/* 首屏骨架屏：只在真的等久了才出现（详见 slowConnect） */}
        {slowConnect ? (
          <div
            data-testid="terminal-connecting"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 dark:bg-neutral-950/95"
          >
            <SkeletonBlock lines={4} className="w-64" delayMs={0} label={t('terminal.connecting')} />
            <p className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
              {t('terminal.connecting')}
            </p>
            <p className="max-w-72 text-center text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {t('terminal.connecting.hint')}
            </p>
          </div>
        ) : null}

        {searchOpen ? (
          <div
            data-testid="terminal-search-bar"
            className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-neutral-300 bg-white/95 px-2 py-1 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95"
          >
            <input
              autoFocus
              data-testid="terminal-search-input"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch(e.shiftKey ? 'prev' : 'next')
                if (e.key === 'Escape') {
                  setSearchOpen(false)
                  termRef.current?.focus()
                }
              }}
              placeholder={t('terminal.search.placeholder')}
              spellCheck={false}
              className="w-44 rounded border border-neutral-200 bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
            <SearchToggle
              testId="terminal-search-regex"
              label=".*"
              title={t('terminal.search.regex')}
              active={searchRegex}
              onClick={() => setSearchRegex((v) => !v)}
            />
            <SearchToggle
              testId="terminal-search-case"
              label="Aa"
              title={t('terminal.search.caseSensitive')}
              active={searchCase}
              onClick={() => setSearchCase((v) => !v)}
            />
            <SearchToggle
              testId="terminal-search-word"
              label="W"
              title={t('terminal.search.wholeWord')}
              active={searchWholeWord}
              onClick={() => setSearchWholeWord((v) => !v)}
            />
            <span
              data-testid="terminal-search-count"
              data-index={searchResult?.index ?? -1}
              data-count={searchResult?.count ?? 0}
              className="min-w-14 text-center font-mono text-[10px] text-neutral-500 dark:text-neutral-400"
            >
              {!searchTerm
                ? ''
                : searchResult && searchResult.count > 0
                  ? t('terminal.search.count', {
                      index: searchResult.index + 1,
                      // 命中数被装饰上限截断时补一个「+」，不把 10 万处报成 2000 处
                      total:
                        searchResult.count >= SEARCH_HIGHLIGHT_LIMIT
                          ? `${searchResult.count}+`
                          : searchResult.count,
                    })
                  : t('terminal.search.noResult')}
            </span>
            <button
              type="button"
              data-testid="terminal-search-prev"
              onClick={() => runSearch('prev')}
              title={t('terminal.search.prev')}
              className="rounded px-1 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              ↑
            </button>
            <button
              type="button"
              data-testid="terminal-search-next"
              onClick={() => runSearch('next')}
              title={t('terminal.search.next')}
              className="rounded px-1 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              ↓
            </button>
            <button
              type="button"
              data-testid="terminal-search-close"
              onClick={() => {
                setSearchOpen(false)
                termRef.current?.focus()
              }}
              className="rounded px-1 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 分屏格子的头部：格号 + 会话切换 + 清空。
 *
 * 「清空」只把格子腾出来，**不关闭会话** —— 分屏时格子和标签栏同时存在，
 * 在这里误关掉一条正在跑任务的 SSH 连接，代价远大于多点一次标签栏的 ×。
 */
function PaneBar({ pane, tab }: { pane: PaneChrome; tab: TerminalTab }) {
  const t = useT()
  return (
    <span className="mr-auto flex min-w-0 items-center gap-1.5">
      <span
        data-testid="pane-index"
        title={t('terminal.focusHint')}
        className={cn(
          'shrink-0 rounded border px-1.5 py-px text-[10px] leading-none',
          pane.focused
            ? 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
            : 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400',
        )}
      >
        {pane.index + 1}
      </span>
      <select
        data-testid="pane-select"
        value={tab.id}
        onChange={(e) => pane.onPick(e.target.value)}
        title={tab.title}
        className="min-w-0 max-w-40 truncate rounded border border-neutral-200 bg-white px-1.5 py-px text-[11px] text-neutral-700 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
      >
        {pane.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="pane-clear"
        onClick={pane.onClear}
        title="清空此格（会话仍在标签栏中保留）"
        className="shrink-0 rounded border border-neutral-200 px-1.5 py-px text-[10px] text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        ×
      </button>
    </span>
  )
}

function ToolbarButton({
  testId,
  onClick,
  children,
}: {
  testId: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {children}
    </button>
  )
}

function SearchToggle({
  testId,
  label,
  title,
  active,
  onClick,
}: {
  testId: string
  label: string
  title: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      title={title}
      onClick={onClick}
      className={cn(
        'rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors',
        active
          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
          : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
      )}
    >
      {label}
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
