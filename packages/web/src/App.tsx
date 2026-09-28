import { useCallback, useEffect, useState } from 'react'
import type { LibraryNode, SessionConfig } from '@webterm/shared'
import { closeTerminal } from './api/client'
import { AppHeader } from './components/AppHeader'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalTabs } from './components/TerminalTabs'
import { WelcomePane } from './components/WelcomePane'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SessionDialog } from './components/SessionDialog'
import { VaultGate } from './components/VaultGate'
import { useHealth } from './hooks/useHealth'
import { useTerminalStore, newTab, newTabFromSession } from './store/useTerminalStore'
import { useVaultStore } from './store/useVaultStore'
import { useLibraryStore } from './store/useLibraryStore'
import { TerminalPane } from './terminal/TerminalPane'
import { applyTheme, useThemeStore } from './theme/useTheme'
import { createLibraryNode } from './api/client'

export default function App() {
  const mode = useThemeStore((state) => state.mode)
  const health = useHealth()

  const tabs = useTerminalStore((state) => state.tabs)
  const activeTabId = useTerminalStore((state) => state.activeTabId)
  const addTab = useTerminalStore((state) => state.addTab)
  const removeAndFocusNext = useTerminalStore((state) => state.removeAndFocusNext)
  const setActive = useTerminalStore((state) => state.setActive)

  const vaultReady = useVaultStore((s) => s.ready)
  const vaultStatus = useVaultStore((s) => s.status)
  const vaultUnlocked = Boolean(vaultStatus?.initialized && vaultStatus?.unlocked)

  const nodes = useLibraryStore((s) => s.nodes)
  const credentials = useLibraryStore((s) => s.credentials)

  const [quickOpen, setQuickOpen] = useState(false)
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false)
  const [editingSession, setEditingSession] = useState<LibraryNode | null>(null)
  const [sessionParentId, setSessionParentId] = useState<string | null>(null)
  const [folderPrompt, setFolderPrompt] = useState<{ parentId: string | null; name: string } | null>(null)

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

  const handleCreate = useCallback(
    (config: SessionConfig, title: string) => {
      addTab(newTab(config, title))
      setQuickOpen(false)
    },
    [addTab],
  )

  const handleConnectSession = useCallback(
    (node: LibraryNode) => {
      if (!node.session) return
      addTab(newTabFromSession(node.id, node.name))
    },
    [addTab],
  )

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

  /**
   * 关闭标签。
   * 必须显式调用 DELETE：仅关闭 WebSocket 只会让服务端进入「等待重连」状态，
   * SSH 连接会保留数分钟，目标设备上的 VTY 线路也会一直被占用。
   */
  const handleClose = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id)
      if (tab?.terminalId) {
        void closeTerminal(tab.terminalId).catch(() => {
          // 终端可能已自行结束，清理失败无需打扰用户
        })
      }
      removeAndFocusNext(id)
    },
    [removeAndFocusNext, tabs],
  )

  /** 全局快捷键：用 Alt 组合键，避免与浏览器自身的 Ctrl+T / Ctrl+W 冲突 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const key = e.key.toLowerCase()

      if (key === 't') {
        e.preventDefault()
        setQuickOpen(true)
        return
      }
      if (key === 'w') {
        e.preventDefault()
        if (activeTabId) handleClose(activeTabId)
        return
      }
      if (key === 'arrowdown' || key === 'arrowup') {
        if (tabs.length < 2) return
        e.preventDefault()
        const index = tabs.findIndex((t) => t.id === activeTabId)
        const delta = key === 'arrowdown' ? 1 : -1
        const next = tabs[(index + delta + tabs.length) % tabs.length]
        if (next) setActive(next.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTabId, handleClose, setActive, tabs])

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
      <AppHeader status={health.status} serverVersion={health.data?.version} />

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          tabs={tabs}
          activeTabId={activeTabId}
          nodes={nodes}
          vaultUnlocked={vaultUnlocked}
          onSelect={setActive}
          onClose={handleClose}
          onNew={() => setQuickOpen(true)}
          onConnectSession={handleConnectSession}
          onEditSession={handleEditSession}
          onNewSessionIn={handleNewSessionIn}
          onNewFolderIn={handleNewFolderIn}
          onDeleteNode={handleDeleteNode}
          onLockVault={handleLockVault}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 ? (
            <TerminalTabs
              tabs={tabs}
              activeTabId={activeTabId}
              onSelect={setActive}
              onClose={handleClose}
              onNew={() => setQuickOpen(true)}
            />
          ) : null}

          <div className="min-h-0 flex-1">
            {tabs.length === 0 ? (
              <div className="h-full overflow-auto">
                <WelcomePane health={health} onNew={() => setQuickOpen(true)} />
              </div>
            ) : (
              // 所有终端同时挂载，非活动的用 CSS 隐藏：
              // 这样切换标签不会丢失滚动缓冲，也不会重建 WebSocket 连接
              tabs.map((tab) => (
                <TerminalPane key={tab.id} tab={tab} active={tab.id === activeTabId} />
              ))
            )}
          </div>
        </main>
      </div>

      <NewSessionDialog
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
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
    </div>
  )
}
