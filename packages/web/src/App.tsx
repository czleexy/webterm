import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LibraryNode, SessionConfig } from '@webterm/shared'
import { protocolOf } from '@webterm/shared'
import { closeTerminal } from './api/client'
import { AppHeader } from './components/AppHeader'
import { SessionSidebar, type ConnectionItem } from './components/SessionSidebar'
import { WorkspaceTabs, type WorkspaceTabItem } from './components/WorkspaceTabs'
import { WelcomePane } from './components/WelcomePane'
import { NewSessionDialog, type ConnectMode } from './components/NewSessionDialog'
import { SessionDialog } from './components/SessionDialog'
import { TunnelPanel } from './components/TunnelPanel'
import { AutomationPanel } from './components/AutomationPanel'
import { LogsPanel } from './logs/LogsPanel'
import { BroadcastBar, BroadcastPanel } from './automation/BroadcastPanel'
import { VaultGate } from './components/VaultGate'
import { useHealth } from './hooks/useHealth'
import {
  TERMINAL_TAB_TONE,
  useTerminalStore,
  newTab,
  newTabFromSession,
} from './store/useTerminalStore'
import { SFTP_TAB_TONE, useSftpStore } from './store/useSftpStore'
import { useTunnelStore } from './store/useTunnelStore'
import { useVaultStore } from './store/useVaultStore'
import { useLibraryStore } from './store/useLibraryStore'
import { useAutomationStore } from './store/useAutomationStore'
import { useBroadcastStore } from './store/useBroadcastStore'
import { TerminalPane } from './terminal/TerminalPane'
import { getTerminalEndpoint } from './terminal/terminalBus'
import { SftpWorkspace } from './sftp/SftpWorkspace'
import { SettingsPanel } from './settings/SettingsPanel'
import { useGlobalShortcuts } from './settings/useGlobalShortcuts'
import { useSettingsStore } from './settings/useSettingsStore'
import { ToastHost } from './ui/ToastHost'
import { toast } from './ui/toast'
import { useT } from './i18n'
import { useLayoutStore, LAYOUT_LABEL_KEY, type LayoutMode } from './layout/useLayoutStore'
import { Divider, EmptySlot, dividerSpecs, gridTemplate, slotArea } from './layout/split'
import { useThemeStore, watchSystemTheme } from './theme/useTheme'
import { createLibraryNode } from './api/client'
import { asSshConfig } from './utils/protocol'
import { cn } from './utils/cn'

/** 终端与 SFTP 共处一条标签栏，用前缀区分来源，避免 id 空间冲突 */
const terminalKey = (id: string): string => `terminal:${id}`
const sftpKey = (id: string): string => `sftp:${id}`

export default function App() {
  const t = useT()
  const health = useHealth()

  const tabs = useTerminalStore((state) => state.tabs)
  const activeTerminalId = useTerminalStore((state) => state.activeTabId)
  const addTab = useTerminalStore((state) => state.addTab)
  const removeAndFocusNext = useTerminalStore((state) => state.removeAndFocusNext)
  const setActiveTerminal = useTerminalStore((state) => state.setActive)

  const sftpTabs = useSftpStore((state) => state.tabs)
  const activeSftpId = useSftpStore((state) => state.activeTabId)
  const openSftp = useSftpStore((state) => state.openSftp)
  const removeSftpAndFocusNext = useSftpStore((state) => state.removeAndFocusNext)
  const setActiveSftp = useSftpStore((state) => state.setActive)

  const vaultReady = useVaultStore((s) => s.ready)
  const vaultStatus = useVaultStore((s) => s.status)
  const vaultUnlocked = Boolean(vaultStatus?.initialized && vaultStatus?.unlocked)

  const nodes = useLibraryStore((s) => s.nodes)
  const credentials = useLibraryStore((s) => s.credentials)

  const openTunnels = useTunnelStore((s) => s.openPanel)
  // 只统计运行中的：徽标上的数字要能回答「现在有几条隧道在工作」
  const tunnelCount = useTunnelStore((s) => s.tunnels.filter((t) => t.status === 'active').length)

  /* ---------------- 阶段 6：自动化与同步输入 ---------------- */

  const openAutomation = useAutomationStore((s) => s.openPanel)
  // 徽标统计「启用中的规则」：那是真正会在会话上生效的数量
  const enabledTriggerCount = useAutomationStore((s) => s.triggers.filter((r) => r.enabled).length)
  const unseenHits = useAutomationStore((s) => s.unseenHits)
  const broadcastEnabled = useBroadcastStore((s) => s.enabled)
  const setBroadcastPanelOpen = useBroadcastStore((s) => s.setPanelOpen)
  const disableBroadcast = useBroadcastStore((s) => s.disable)

  /* ---------------- 阶段 8：布局与设置 ---------------- */

  const layoutMode = useLayoutStore((s) => s.mode)
  const slots = useLayoutStore((s) => s.slots)
  const focusIndex = useLayoutStore((s) => s.focusIndex)
  const ratioX = useLayoutStore((s) => s.ratioX)
  const ratioY = useLayoutStore((s) => s.ratioY)
  const setSettingsOpen = useSettingsStore((s) => s.setPanelOpen)

  const [quickOpen, setQuickOpen] = useState(false)
  const [quickMode, setQuickMode] = useState<ConnectMode>('terminal')
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  /** 窄屏下会话树折叠成抽屉（桌面端始终展开，这个状态无用） */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileNoticeClosed, setMobileNoticeClosed] = useState(false)
  const [editingSession, setEditingSession] = useState<LibraryNode | null>(null)
  const [sessionParentId, setSessionParentId] = useState<string | null>(null)
  const [folderPrompt, setFolderPrompt] = useState<{ parentId: string | null; name: string } | null>(null)
  /** 当前显示的是哪一类标签；两边的 activeId 各自维护，这里只决定渲染谁 */
  const [activeKind, setActiveKind] = useState<'terminal' | 'sftp'>('terminal')

  const activeKey = activeKind === 'sftp'
    ? (activeSftpId ? sftpKey(activeSftpId) : null)
    : (activeTerminalId ? terminalKey(activeTerminalId) : null)

  /**
   * 主题应用。
   * 三态里的 `auto` 依赖 `prefers-color-scheme`，系统在用户开着页面时切换是常事
   * （macOS 的日落自动切换），所以订阅它并重新解析。
   */
  useEffect(() => {
    useThemeStore.getState().apply()
    return watchSystemTheme(() => useThemeStore.getState().apply())
  }, [])

  // 首屏拉取保险库状态；未就绪期间 VaultGate 显示加载态
  useEffect(() => {
    void useVaultStore.getState().refresh()
  }, [])

  // 保险库解锁状态变化时刷新会话库与凭据
  useEffect(() => {
    if (vaultReady && vaultUnlocked) {
      void useLibraryStore.getState().refresh()
      // 自动化定义一次拉全：触发器要在第一个会话建立之前就位，
      // 否则「先连上设备、再去面板加规则」这段时间里规则是不生效的
      void useAutomationStore.getState().loadAll()
    }
  }, [vaultReady, vaultUnlocked])

  /**
   * 会话数量变化时同步一次隧道列表。
   * 面板没打开时也会拉：入口上的徽标要准确，而且会话被关闭会连带回收隧道，
   * 不刷新的话徽标会一直停在旧数字上，看着像隧道还活着。
   */
  useEffect(() => {
    if (vaultUnlocked) void useTunnelStore.getState().refresh()
  }, [tabs.length, vaultUnlocked])

  /* ---------------- 布局与标签的同步 ---------------- */

  // 单格模式下 slots[0] 恒等于当前活动终端：布局是派生的，不该成为第二个真相
  useEffect(() => {
    const layout = useLayoutStore.getState()
    if (layout.mode !== 'single') return
    if (layout.slots[0] !== activeTerminalId) layout.setSlot(0, activeTerminalId)
  }, [activeTerminalId, layoutMode])

  // 标签集合变化：清掉已关闭标签的引用，并把空格子用闲置会话补齐
  useEffect(() => {
    const ids = tabs.map((tab) => tab.id)
    const layout = useLayoutStore.getState()
    layout.pruneSlots(ids)
    if (layout.mode !== 'single') useLayoutStore.getState().fillEmptySlots(ids)
  }, [tabs])

  const applyLayout = useCallback(
    (mode: LayoutMode) => {
      const layout = useLayoutStore.getState()
      if (layout.mode === mode) return
      const ids = tabs.map((tab) => tab.id)
      layout.setMode(mode, ids, activeTerminalId)
      if (mode !== 'single') useLayoutStore.getState().fillEmptySlots(ids)
      toast('info', t('toast.layoutChanged', { layout: t(LAYOUT_LABEL_KEY[mode]) }))
    },
    [tabs, activeTerminalId, t],
  )

  /** 在格子之间移动焦点（分屏时才有多格） */
  const movePaneFocus = useCallback((delta: number) => {
    const layout = useLayoutStore.getState()
    if (layout.mode === 'single') return
    const count = layout.slots.length
    const next = (layout.focusIndex + delta + count) % count
    layout.setFocus(next)
    const tabId = layout.slots[next]
    if (tabId) useTerminalStore.getState().setActive(tabId)
  }, [])

  /* ---------------- 标签视图 ---------------- */

  const tabItems = useMemo<WorkspaceTabItem[]>(() => {
    const terminalItems: WorkspaceTabItem[] = tabs.map((tab) => {
      const tone = TERMINAL_TAB_TONE[tab.status]
      return {
        id: terminalKey(tab.id),
        title: tab.title,
        kind: 'terminal',
        protocol: tab.protocol,
        // Telnet 没有 SFTP 子系统，标签上不提供「打开 SFTP」入口
        sftpAvailable: tab.protocol === 'ssh',
        dot: tone.dot,
        label: tone.text,
        pulse: tone.pulse,
        notice: tab.notice,
        labels: tab.labels,
        unseenHits: unseenHits[tab.id] ?? 0,
      }
    })
    const sftpItems: WorkspaceTabItem[] = sftpTabs.map((tab) => {
      const tone = SFTP_TAB_TONE[tab.status]
      return {
        id: sftpKey(tab.id),
        title: tab.title,
        kind: 'sftp',
        protocol: 'ssh',
        dot: tone.dot,
        label: tone.text,
        pulse: tone.pulse,
        notice: tab.notice,
      }
    })
    return [...terminalItems, ...sftpItems]
  }, [sftpTabs, tabs, unseenHits])

  const connections = useMemo<ConnectionItem[]>(
    () =>
      tabItems.map((item) => ({
        key: item.id,
        kind: item.kind,
        title: item.title,
        protocol: item.protocol,
        dot: item.dot,
        statusText: item.notice ? `${item.label}：${item.notice}` : item.label,
      })),
    [tabItems],
  )

  /* ---------------- 打开新会话 ---------------- */

  const handleCreate = useCallback(
    (config: SessionConfig, title: string, connectMode: ConnectMode) => {
      setQuickOpen(false)
      if (connectMode === 'sftp') {
        // SFTP 只能跑在 SSH 之上；Telnet 配置进到这里说明状态被绕过了，直接忽略
        const ssh = asSshConfig(config)
        if (!ssh) return
        setActiveKind('sftp')
        void openSftp(
          { config: { target: ssh.target, legacyCompat: ssh.legacyCompat }, title },
          title,
        )
        return
      }
      setActiveKind('terminal')
      addTab(newTab(config, title))
    },
    [addTab, openSftp],
  )

  const handleConnectSession = useCallback(
    (node: LibraryNode) => {
      if (!node.session) return
      setActiveKind('terminal')
      addTab(newTabFromSession(node.id, node.name, protocolOf(node.session)))
    },
    [addTab],
  )

  /** 从会话库直接打开 SFTP（连接参数与凭据由服务端解析）；Telnet 会话没有 SFTP */
  const handleOpenSftpSession = useCallback(
    (node: LibraryNode) => {
      if (!node.session) return
      if (protocolOf(node.session) === 'telnet') return
      setActiveKind('sftp')
      void openSftp({ sessionId: node.id, title: `${node.name} · SFTP` }, '')
    },
    [openSftp],
  )

  /**
   * 在已有终端上打开 SFTP。
   *
   * 优先把 terminalId 交给服务端复用同一条 SSH 连接 ——
   * 老设备（交换机/路由器）的 VTY 线路常常只有几条，重复登录会直接把人挡在门外。
   * Telnet 会话没有 SFTP 子系统，直接返回。
   */
  const handleOpenSftpForTerminal = useCallback(
    (unifiedId: string) => {
      const terminalTabId = unifiedId.slice('terminal:'.length)
      const tab = tabs.find((t) => t.id === terminalTabId)
      if (!tab || tab.protocol !== 'ssh') return
      setActiveKind('sftp')

      if (tab.terminalId) {
        void openSftp({ terminalId: tab.terminalId, title: `${tab.title} · SFTP` }, '')
        return
      }
      const ssh = asSshConfig(tab.config)
      if (ssh) {
        void openSftp(
          {
            config: { target: ssh.target, legacyCompat: ssh.legacyCompat },
            title: `${tab.title} · SFTP`,
          },
          '',
        )
        return
      }
      if (tab.sessionId) {
        void openSftp({ sessionId: tab.sessionId, title: `${tab.title} · SFTP` }, '')
      }
    },
    [openSftp, tabs],
  )

  /* ---------------- 关闭与选中 ---------------- */

  /**
   * 关闭标签。
   * 终端必须显式调用 DELETE：仅关闭 WebSocket 只会让服务端进入「等待重连」状态，
   * SSH 连接会保留数分钟，目标设备上的 VTY 线路也会一直被占用。
   * SFTP 的会话回收在 removeAndFocusNext 里完成（同样要 DELETE）。
   */
  const handleClose = useCallback(
    (unifiedId: string) => {
      if (unifiedId.startsWith('sftp:')) {
        removeSftpAndFocusNext(unifiedId.slice('sftp:'.length))
        return
      }
      const id = unifiedId.slice('terminal:'.length)
      const tab = tabs.find((t) => t.id === id)
      if (tab?.terminalId) {
        void closeTerminal(tab.terminalId).catch(() => {
          // 终端可能已自行结束，清理失败无需打扰用户
        })
      }
      removeAndFocusNext(id)
      // 关掉标签后把它的命中记录一并清掉：那个终端已经不存在了，
      // 留着记录只会在面板里堆一堆指向空 tabId 的条目
      useAutomationStore.getState().clearHits(id)
      useBroadcastStore.getState().prune(tabs.filter((t) => t.id !== id).map((t) => t.id))
    },
    [removeAndFocusNext, removeSftpAndFocusNext, tabs],
  )

  const handleSelect = useCallback(
    (unifiedId: string) => {
      if (unifiedId.startsWith('sftp:')) {
        // SFTP 与分屏是两套布局语义，同时出现只会互相打架：切到 SFTP 时退回单格
        const layout = useLayoutStore.getState()
        if (layout.mode !== 'single') {
          layout.setMode('single', tabs.map((tab) => tab.id), activeTerminalId)
        }
        setActiveKind('sftp')
        setActiveSftp(unifiedId.slice('sftp:'.length))
        return
      }
      setActiveKind('terminal')
      const terminalTabId = unifiedId.slice('terminal:'.length)
      setActiveTerminal(terminalTabId)
      // 切过去看到的就是这个终端的现状，角标该清了
      useAutomationStore.getState().markHitsSeen(terminalTabId)

      // 分屏时：该会话已在某个格子里就聚焦它，否则替换当前聚焦格的内容
      const layout = useLayoutStore.getState()
      if (layout.mode === 'single') return
      const existing = layout.slots.indexOf(terminalTabId)
      if (existing >= 0) layout.setFocus(existing)
      else layout.setSlot(layout.focusIndex, terminalTabId)
    },
    [activeTerminalId, setActiveSftp, setActiveTerminal, tabs],
  )

  /** 在标签之间循环（快捷键用） */
  const cycleTab = useCallback(
    (delta: number) => {
      if (tabItems.length < 2) return
      const index = tabItems.findIndex((item) => item.id === activeKey)
      const next = tabItems[(index + delta + tabItems.length) % tabItems.length]
      if (next) handleSelect(next.id)
    },
    [activeKey, handleSelect, tabItems],
  )

  // 当前类型的标签全部关掉后，自动切到另一类，避免停在空白页
  useEffect(() => {
    if (activeKind === 'terminal' && tabs.length === 0 && sftpTabs.length > 0) {
      setActiveKind('sftp')
    } else if (activeKind === 'sftp' && sftpTabs.length === 0 && tabs.length > 0) {
      setActiveKind('terminal')
    }
  }, [activeKind, sftpTabs.length, tabs.length])

  const handleEditSession = useCallback((node: LibraryNode) => {
    setEditingSession(node)
    setSessionDialogOpen(true)
  }, [])

  const handleNewSessionIn = useCallback((parentId: string | null) => {
    setEditingSession(null)
    setSessionParentId(parentId)
    setSessionDialogOpen(true)
  }, [])

  const handleNewFolderIn = useCallback((parentId: string | null) => {
    const name = window.prompt('分组名称：')
    if (name && name.trim()) {
      setFolderPrompt({ parentId, name: name.trim() })
    }
  }, [])

  // folderPrompt 有值时触发创建（避免在事件回调里直接 await）
  useEffect(() => {
    if (!folderPrompt) return
    const { parentId, name } = folderPrompt
    setFolderPrompt(null)
    void createLibraryNode({ kind: 'folder', name, parentId })
      .then(() => useLibraryStore.getState().refresh())
      .catch(() => {})
  }, [folderPrompt])

  const handleDeleteNode = useCallback((node: LibraryNode) => {
    const msg =
      node.kind === 'folder'
        ? `删除分组「${node.name}」及其全部子节点？该操作不可恢复。`
        : `删除会话「${node.name}」？`
    if (!window.confirm(msg)) return
    void useLibraryStore.getState().removeNode(node.id).catch(() => {})
  }, [])

  const handleSavedSession = useCallback(() => {
    void useLibraryStore.getState().refresh()
  }, [])

  const handleLockVault = useCallback(() => {
    void useVaultStore.getState().lock()
  }, [])

  const openQuick = useCallback((m: ConnectMode) => {
    setQuickMode(m)
    setQuickOpen(true)
  }, [])

  /* ---------------- 全局快捷键 ---------------- */

  useGlobalShortcuts({
    'new-connection': () => openQuick('terminal'),
    'close-tab': () => {
      if (activeKey) handleClose(activeKey)
    },
    'next-tab': () => cycleTab(1),
    'prev-tab': () => cycleTab(-1),
    'terminal-search': () => {
      if (activeTerminalId) getTerminalEndpoint(activeTerminalId)?.openSearch?.()
    },
    'copy-selection': () => {
      if (activeTerminalId) getTerminalEndpoint(activeTerminalId)?.copySelection?.()
    },
    'broadcast-toggle': () => {
      // 这是唯一一个「越快越好」的操作：广播开着的时候，
      // 用户意识到不对劲到下一次按回车之间只有一两秒
      if (useBroadcastStore.getState().enabled) disableBroadcast()
      else setBroadcastPanelOpen(true)
    },
    'layout-single': () => applyLayout('single'),
    'layout-split-2': () => applyLayout('split-2'),
    'layout-grid-4': () => applyLayout('grid-4'),
    'focus-next-pane': () => movePaneFocus(1),
    'focus-prev-pane': () => movePaneFocus(-1),
    'open-settings': () => setSettingsOpen(true),
    'open-logs': () => setLogsOpen(true),
    'open-automation': () => openAutomation(),
    'open-tunnels': () => openTunnels(),
  })

  // 保险库未就绪 / 未解锁时，整个应用被门禁挡住
  if (!vaultUnlocked) {
    return (
      <div className="h-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <AppHeader status={health.status} serverVersion={health.data?.version} />
        <div className="h-[calc(100%-2.25rem)]">
          <VaultGate>{null}</VaultGate>
        </div>
        <ToastHost />
        <SettingsPanel />
      </div>
    )
  }

  /* ---------------- 分屏渲染参数 ---------------- */

  const template = gridTemplate(layoutMode, ratioX, ratioY)
  const slotOf = new Map<string, number>()
  slots.forEach((id, index) => {
    if (id) slotOf.set(id, index)
  })

  const terminalVisible = (tabId: string): boolean => {
    if (activeKind !== 'terminal') return false
    if (layoutMode === 'single') return tabId === activeTerminalId
    return slotOf.has(tabId)
  }

  const emptySlots = layoutMode === 'single'
    ? []
    : slots.map((id, index) => ({ id, index })).filter((entry) => entry.id === null)

  const paneOptions = tabs.map((tab) => ({ id: tab.id, title: tab.title }))

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <AppHeader
        status={health.status}
        serverVersion={health.data?.version}
        onOpenTunnels={openTunnels}
        tunnelCount={tunnelCount}
        onOpenAutomation={() => openAutomation()}
        triggerCount={enabledTriggerCount}
        onOpenBroadcast={() => setBroadcastPanelOpen(true)}
        broadcastOn={broadcastEnabled}
        onOpenLogs={() => setLogsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        layoutMode={layoutMode}
        onLayoutChange={applyLayout}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />

      {/* 同步输入开着时，工作区顶部常驻警示条 —— 不能只靠一个小指示灯 */}
      <BroadcastBar />

      {/* 窄屏下终端体验确实受限，直说比让用户困惑好 */}
      {mobileNoticeClosed ? null : (
        <div
          data-testid="mobile-notice"
          className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-3 py-1 text-[11px] text-neutral-600 md:hidden dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
        >
          <span className="min-w-0 flex-1">{t('app.mobileNotice')}</span>
          <button
            type="button"
            onClick={() => setMobileNoticeClosed(true)}
            className="rounded px-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 小于 768px 时变成抽屉；遮罩点击关闭 */}
        {sidebarOpen ? (
          <div
            data-testid="sidebar-mask"
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        ) : null}
        <SessionSidebar
          className={cn(
            'fixed inset-y-0 left-0 z-50 transition-transform md:static md:z-auto',
            sidebarOpen ? 'translate-x-0 shadow-2xl md:shadow-none' : '-translate-x-full md:translate-x-0',
          )}
          connections={connections}
          activeKey={activeKey}
          nodes={nodes}
          vaultUnlocked={vaultUnlocked}
          onSelect={(key) => {
            handleSelect(key)
            setSidebarOpen(false)
          }}
          onClose={handleClose}
          onNew={() => openQuick('terminal')}
          onConnectSession={handleConnectSession}
          onOpenSftp={handleOpenSftpSession}
          onEditSession={handleEditSession}
          onNewSessionIn={handleNewSessionIn}
          onNewFolderIn={handleNewFolderIn}
          onDeleteNode={handleDeleteNode}
          onLockVault={handleLockVault}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {tabItems.length > 0 ? (
            <WorkspaceTabs
              items={tabItems}
              activeId={activeKey}
              onSelect={handleSelect}
              onClose={handleClose}
              onNew={() => openQuick('terminal')}
              onOpenSftpFor={handleOpenSftpForTerminal}
            />
          ) : null}

          <div className="min-h-0 flex-1">
            {tabItems.length === 0 ? (
              <div className="h-full overflow-auto">
                <WelcomePane health={health} onNew={() => openQuick('terminal')} />
              </div>
            ) : (
              /**
               * 所有面板同时挂载、且**恒为同一个网格容器的直接子元素**：
               * 这样切标签、切布局都只改变 grid-area 与显示状态，不会卸载重建，
               * 滚动缓冲与 WebSocket 连接都得以保留（详见 layout/useLayoutStore.ts 的说明）。
               */
              <div
                data-testid="terminal-grid"
                data-layout={layoutMode}
                className={cn(
                  'relative h-full min-h-0',
                  // 分屏时网格底色与分隔条同色：四段分隔条在正中留空的交叉点
                  // 由这层底色补上，十字看起来才是连通的
                  layoutMode === 'single' ? '' : 'bg-neutral-200 dark:bg-neutral-800',
                )}
                style={{
                  display: 'grid',
                  gridTemplateColumns: template.gridTemplateColumns,
                  gridTemplateRows: template.gridTemplateRows,
                }}
              >
                {tabs.map((tab) => {
                  const slotIndex = slotOf.get(tab.id)
                  return (
                    <TerminalPane
                      key={tab.id}
                      tab={tab}
                      visible={terminalVisible(tab.id)}
                      active={activeKind === 'terminal' && tab.id === activeTerminalId}
                      gridArea={layoutMode === 'single' ? undefined : slotArea(layoutMode, slotIndex ?? 0)}
                      pane={
                        layoutMode === 'single' || slotIndex === undefined
                          ? undefined
                          : {
                              index: slotIndex,
                              focused: slotIndex === focusIndex,
                              options: paneOptions,
                              onFocus: () => {
                                useLayoutStore.getState().setFocus(slotIndex)
                                setActiveTerminal(tab.id)
                              },
                              onClear: () => useLayoutStore.getState().setSlot(slotIndex, null),
                              onPick: (tabId: string) => {
                                useLayoutStore.getState().setSlot(slotIndex, tabId)
                                useLayoutStore.getState().setFocus(slotIndex)
                                setActiveTerminal(tabId)
                              },
                            }
                      }
                    />
                  )
                })}

                {sftpTabs.map((tab) => (
                  <div
                    key={tab.id}
                    style={{ gridArea: '1 / 1 / 2 / 2' }}
                    className={cn(
                      'min-h-0',
                      activeKind === 'sftp' && tab.id === activeSftpId ? 'flex' : 'hidden',
                    )}
                  >
                    <SftpWorkspace
                      tab={tab}
                      active={activeKind === 'sftp' && tab.id === activeSftpId}
                    />
                  </div>
                ))}

                {dividerSpecs(layoutMode).map((spec) => (
                  <Divider
                    key={spec.id}
                    axis={spec.axis}
                    area={spec.area}
                    ratio={spec.axis === 'x' ? ratioX : ratioY}
                    onRatio={(value) => useLayoutStore.getState().setRatio(spec.axis, value)}
                  />
                ))}

                {emptySlots.map((entry) => (
                  <EmptySlot
                    key={`empty-${entry.index}`}
                    area={slotArea(layoutMode, entry.index)}
                    focused={entry.index === focusIndex}
                    options={paneOptions}
                    onFocus={() => useLayoutStore.getState().setFocus(entry.index)}
                    onPick={(tabId) => {
                      useLayoutStore.getState().setSlot(entry.index, tabId)
                      useLayoutStore.getState().setFocus(entry.index)
                      useTerminalStore.getState().setActive(tabId)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      <NewSessionDialog
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        initialMode={quickMode}
        onSubmit={handleCreate}
      />

      <SessionDialog
        open={sessionDialogOpen}
        onClose={() => setSessionDialogOpen(false)}
        editing={editingSession}
        credentials={credentials}
        folders={nodes.filter((n) => n.kind === 'folder')}
        defaultParentId={sessionParentId}
        onSaved={handleSavedSession}
      />

      <TunnelPanel />
      <AutomationPanel />
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
      <BroadcastPanel />
      <SettingsPanel />
      <ToastHost />
    </div>
  )
}
