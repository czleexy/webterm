/**
 * 全局快捷键分发（阶段 8）。
 *
 * 监听用**捕获阶段**：终端输入要先经过 xterm —— 它在自己的 textarea 上监听 keydown，
 * 会把 `Ctrl+F` 直接翻译成 `\x06` 发给远端。如果我们在冒泡阶段才拦，
 * 远端已经收到一个多余的 ACK 字符了。捕获阶段在 window 上先一步
 * `preventDefault + stopPropagation`，事件根本到不了 textarea。
 *
 * 设置面板打开时整体停用：那时用户是在配置快捷键本身，
 * 任何动作都不该被触发（面板自己的录制逻辑另有一套捕获监听）。
 */
import { useEffect, useRef } from 'react'
import { useSettingsStore } from './useSettingsStore'
import { SHORTCUT_ACTION_IDS, normalizeKeys, type ShortcutActionId } from './shortcuts'

export type ShortcutHandlers = Partial<Record<ShortcutActionId, () => void>>

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  // 读 shortcuts 快照的时机放在事件里：自定义快捷键后无需重建监听
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (useSettingsStore.getState().panelOpen) return

      const keys = normalizeKeys(event)
      if (!keys) return

      const shortcuts = useSettingsStore.getState().shortcuts
      for (const id of SHORTCUT_ACTION_IDS) {
        if (shortcuts[id] !== keys) continue
        const handler = handlersRef.current[id]
        // 已绑定但当前上下文无此动作（例如没有会话时的「关闭标签」）：放行给浏览器
        if (!handler) return
        event.preventDefault()
        event.stopPropagation()
        handler()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
