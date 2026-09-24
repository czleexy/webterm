import { useCallback, useEffect, useState } from 'react'
import type { SessionConfig } from '@webterm/shared'
import { closeTerminal } from './api/client'
import { AppHeader } from './components/AppHeader'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalTabs } from './components/TerminalTabs'
import { WelcomePane } from './components/WelcomePane'
import { NewSessionDialog } from './components/NewSessionDialog'
import { useHealth } from './hooks/useHealth'
import { useTerminalStore, newTab } from './store/useTerminalStore'
import { TerminalPane } from './terminal/TerminalPane'
import { applyTheme, useThemeStore } from './theme/useTheme'

export default function App() {
  const mode = useThemeStore((state) => state.mode)
  const health = useHealth()

  const tabs = useTerminalStore((state) => state.tabs)
  const activeTabId = useTerminalStore((state) => state.activeTabId)
  const addTab = useTerminalStore((state) => state.addTab)
  const removeAndFocusNext = useTerminalStore((state) => state.removeAndFocusNext)
  const setActive = useTerminalStore((state) => state.setActive)

  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    applyTheme(mode)
  }, [mode])

  const handleCreate = useCallback(
    (config: SessionConfig, title: string) => {
      addTab(newTab(config, title))
      setDialogOpen(false)
    },
    [addTab],
  )

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
        setDialogOpen(true)
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

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <AppHeader status={health.status} serverVersion={health.data?.version} />

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActive}
          onClose={handleClose}
          onNew={() => setDialogOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 ? (
            <TerminalTabs
              tabs={tabs}
              activeTabId={activeTabId}
              onSelect={setActive}
              onClose={handleClose}
              onNew={() => setDialogOpen(true)}
            />
          ) : null}

          <div className="min-h-0 flex-1">
            {tabs.length === 0 ? (
              <div className="h-full overflow-auto">
                <WelcomePane health={health} onNew={() => setDialogOpen(true)} />
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
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleCreate}
      />
    </div>
  )
}
