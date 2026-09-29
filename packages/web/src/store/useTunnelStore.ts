/**
 * 隧道（端口转发）状态。
 *
 * 两个刻意的设计：
 *
 * 1. **面板打开时才轮询**。字节数与活跃连接数的变化不会触发任何事件
 *    （数据在服务端流过去就流过去了），只能定时拉。让轮询跟着面板开关走，
 *    面板关掉就停 —— 没人看的数字不值得每两秒打一次接口。
 *
 * 2. **写操作抛错、由调用方就地展示**。隧道失败的原因（端口被占用、对端禁止
 *    转发）都非常具体，塞进全局 store 的 error 字段再让别的组件去读，
 *    反而容易在错误的时机显示；表单里原地弹出来才是用户需要的位置。
 */
import { create } from 'zustand'
import type { TunnelInfo, TunnelSpec } from '@webterm/shared'
import { TUNNEL_STATS_POLL_MS } from '@webterm/shared'
import {
  createTunnel as apiCreateTunnel,
  deleteTunnel as apiDeleteTunnel,
  listTunnels,
  startTunnel as apiStartTunnel,
  stopTunnel as apiStopTunnel,
} from '../api/client'

interface TunnelState {
  tunnels: TunnelInfo[]
  /** 首屏是否已拉取过（用于区分「空」与「还没加载」） */
  loaded: boolean
  panelOpen: boolean
  /** 拉取列表失败的原因（面板里显示为顶部提示条） */
  error: string | null

  refresh: () => Promise<void>
  openPanel: () => void
  closePanel: () => void
  /** 创建并启动；失败时抛出，由表单就地展示 */
  create: (terminalId: string, spec: TunnelSpec) => Promise<TunnelInfo>
  setRunning: (id: string, running: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
}

/** 面板打开期间生效的轮询定时器 */
let pollTimer: ReturnType<typeof setInterval> | undefined

function stopPolling(): void {
  if (pollTimer === undefined) return
  clearInterval(pollTimer)
  pollTimer = undefined
}

export const useTunnelStore = create<TunnelState>((set, get) => ({
  tunnels: [],
  loaded: false,
  panelOpen: false,
  error: null,

  refresh: async () => {
    try {
      const { tunnels } = await listTunnels()
      set({ tunnels, loaded: true, error: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loaded: true })
    }
  },

  openPanel: () => {
    set({ panelOpen: true })
    void get().refresh()
    stopPolling()
    pollTimer = setInterval(() => {
      // 面板已关闭时不再打扰服务端（closePanel 也会清定时器，这里只是双保险）
      if (!useTunnelStore.getState().panelOpen) {
        stopPolling()
        return
      }
      void useTunnelStore.getState().refresh()
    }, TUNNEL_STATS_POLL_MS)
  },

  closePanel: () => {
    stopPolling()
    set({ panelOpen: false })
  },

  create: async (terminalId, spec) => {
    const { tunnel } = await apiCreateTunnel({ terminalId, spec })
    await get().refresh()
    return tunnel
  },

  setRunning: async (id, running) => {
    const { tunnel } = running ? await apiStartTunnel(id) : await apiStopTunnel(id)
    set({
      tunnels: get().tunnels.map((t) => (t.id === tunnel.id ? tunnel : t)),
    })
  },

  remove: async (id) => {
    await apiDeleteTunnel(id)
    set({ tunnels: get().tunnels.filter((t) => t.id !== id) })
  },
}))
