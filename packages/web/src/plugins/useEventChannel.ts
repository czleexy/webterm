/**
 * 全局事件通道客户端（阶段 9）。
 *
 * 一条连接管全部「不属于任何单个终端」的消息：插件通知、插件列表变更。
 * 与终端 WS 的三点不同，都是刻意的：
 *
 * 1. **不传令牌**。这条通道只推「插件发了条通知」这类不含会话数据的消息。
 *    为它再造一个令牌体系，换来的只是一层没人会正确配置的门槛。
 * 2. **断线自动重连**（退避到 30 秒封顶）。服务端重启、笔记本合盖都会断；
 *    没有重连就意味着「重启服务端之后再也收不到插件通知」，而且毫无提示。
 * 3. **只做展示**。它不承载任何业务状态，断了也不会让谁的终端不工作 ——
 *    所以重连失败只记在控制台，不弹错误打扰用户。
 */
import { useEffect } from 'react'
import { WS_EVENTS_PATH, parseServerEvent } from '@webterm/shared'
import { resolveWsBase } from '../api/client'
import { usePluginStore } from '../store/usePluginStore'
import { useSettingsStore } from '../settings/useSettingsStore'
import { toast } from '../ui/toast'
import { notifyEvent } from '../ui/desktopNotify'

/** 重连退避：1s、2s、4s… 最多 30s。太快会刷屏，太慢用户以为坏了 */
const BASE_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000

export function useEventChannel(enabled = true): void {
  const refreshPlugins = usePluginStore((s) => s.refresh)

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return

    let socket: WebSocket | null = null
    let retry = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const connect = (): void => {
      if (disposed) return
      let ws: WebSocket
      try {
        ws = new WebSocket(`${resolveWsBase()}${WS_EVENTS_PATH}`)
      } catch {
        schedule()
        return
      }
      socket = ws

      ws.onopen = () => {
        retry = 0
      }

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const message = parseServerEvent(event.data)
        if (!message) return

        if (message.t === 'plugins-changed') {
          void refreshPlugins()
          return
        }

        // 插件通知：Toast + （可选）桌面通知，与阶段 8 的通知开关共用一套判断
        if (!useSettingsStore.getState().notifications.onPluginNotify) return
        const tone = message.level === 'error' ? 'error' : message.level === 'warn' ? 'warning' : 'info'
        toast(tone, message.title, {
          detail: `${message.pluginName}：${message.body}`,
          timeout: message.level === 'info' ? 5000 : 8000,
        })
        notifyEvent('pluginNotify', `${message.pluginName}：${message.title}`, message.body)
      }

      ws.onclose = () => {
        socket = null
        schedule()
      }

      // onerror 之后浏览器一定会再触发 onclose，这里只需留痕，避免重复排重连
      ws.onerror = () => {
        /* 交给 onclose 处理 */
      }
    }

    const schedule = (): void => {
      if (disposed) return
      const delay = Math.min(BASE_RETRY_MS * 2 ** retry, MAX_RETRY_MS)
      retry += 1
      retryTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      // 主动关闭：把 onclose 摘掉，否则卸载时会再排一次重连
      if (socket) {
        socket.onclose = null
        socket.close()
        socket = null
      }
    }
  }, [enabled, refreshPlugins])
}
