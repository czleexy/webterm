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
import { VaultGate } from './components/VaultGate'
import { useHealth } from './hooks/useHealth'
import { TERMINAL_TAB_TONE, useTerminalStore, newTab, newTabFromSession } from './store/useTerminalStore'
import { SFTP_TAB_TONE, useSftpStore } from './store/useSftpStore'
import { useTunnelStore } from './store/useTunnelStore'
import { useVaultStore } from './store/useVaultStore'
import { useLibraryStore } from './store/useLibraryStore'
import { TerminalPane } from './terminal/TerminalPane'
import { SftpWorkspace } from './sftp/SftpWorkspace'
import { applyTheme, useThemeStore } from './theme/useTheme'
import { createLibraryNode } from './api/client'
import { asSshConfig } from './utils/protocol'

/** 终端与 SFTP 共处一条标签栏，用前缀区分来源，避免 id 空间冲突 */
const terminalKey = (id: string): string => `terminal:${id}`
const sftpKey = (id: string): string => `sftp:${id}`

export default function App() {
  const mode = useThemeStore((state) => state.mode)
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

  const [quickOpen, setQuickOpen] = useState(false)
  const [quickMode, setQuickMode] = useState<ConnectMode>('terminal')
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false)
  const [editingSession, setEditingSession] = useState<LibraryNode | null>(null)
  const [sessionParentId, setSessionParentId] = useState<string | null>(null)
  const [folderPrompt, setFolderPrompt] = useState<{ parentId: string | null; name: string } | null>(null)
  /** 当前显示的是哪一类标签；两边的 activeId 各自维护，这里只决定渲染谁 */
  const [activeKind, setActiveKind] = useState<'terminal' | 'sftp'>('terminal')

  const activeKey = activeKind === 'sftp'
    ? (activeSftpId ? sftpKey(activeSftpId) : null)
    : (activeTerminalId ? terminalKey(activeTerminalId) : null)

  useEffect(() => {
    applyTheme(mode)
  }, [mode])

  // 首屏拉取保险库状态；未就绪期间 VaultGate 显示加载态
  useEffect(() => {
    void useVaultStore.getState().refresh()
  }, [])

  // 保险库解锁状态变化时刷新会话库与凭据
  useEffect(() => {
    if (vaultReady && vaultUnlocked) {
      void useLibraryStore.getState().refresh()
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

  /** 统一的标签视图：终端在前、SFTP 在后 */
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
  }, [sftpTabs, tabs])

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
    },
    [removeAndFocusNext, removeSftpAndFocusNext, tabs],
  )

  const handleSelect = useCallback(
    (unifiedId: string) => {
      if (unifiedId.startsWith('sftp:')) {
        setActiveKind('sftp')
        setActiveSftp(unifiedId.slice('sftp:'.length))
        return
      }
      setActiveKind('terminal')
      setActiveTerminal(unifiedId.slice('terminal:'.length))
    },
    [setActiveSftp, setActiveTerminal],
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

  /** 全局快捷键：用 Alt 组合键，避免与浏览器自身的 Ctrl+T / Ctrl+W 冲突 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const key = e.key.toLowerCase()

      if (key === 't') {
        e.preventDefault()
        openQuick('terminal')
        return
      }
      if (key === 'w') {
        e.preventDefault()
        if (activeKey) handleClose(activeKey)
        return
      }
      if (key === 'arrowdown' || key === 'arrowup') {
        if (tabItems.length < 2) return
        e.preventDefault()
        const index = tabItems.findIndex((t) => t.id === activeKey)
        const delta = key === 'arrowdown' ? 1 : -1
        const next = tabItems[(index + delta + tabItems.length) % tabItems.length]
        if (next) handleSelect(next.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeKey, handleClose, handleSelect, openQuick, tabItems])

  // 保险库未就绪 / 未解锁时，整个应用被门禁挡住
  if (!vaultUnlocked) {
    return (
      <div className="h-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <AppHeader status={health.status} serverVersion={health.data?.version} />
        <div className="h-[calc(100%-2.25rem)]">
          <VaultGate>{null}</VaultGate>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <AppHeader
        status={health.status}
        serverVersion={health.data?.version}
        onOpenTunnels={openTunnels}
        tunnelCount={tunnelCount}
      />

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          connections={connections}
          activeKey={activeKey}
          nodes={nodes}
          vaultUnlocked={vaultUnlocked}
          onSelect={handleSelect}
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
              // 所有面板同时挂载，非活动的用 CSS 隐藏：
              // 这样切换标签不会丢失滚动缓冲，也不会重建 WebSocket 连接
              <>
                {tabs.map((tab) => (
                  <TerminalPane
                    key={tab.id}
                    tab={tab}
                    active={activeKind === 'terminal' && tab.id === activeTerminalId}
                  />
                ))}
                {sftpTabs.map((tab) => (
                  <SftpWorkspace
                    key={tab.id}
                    tab={tab}
                    active={activeKind === 'sftp' && tab.id === activeSftpId}
                  />
                ))}
              </>
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
    </div>
  )
}
