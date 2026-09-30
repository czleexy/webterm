/**
 * Toast 通知（阶段 8）。
 *
 * 用 zustand 存队列而不是 Context：任务完成、连接断开这类事件发生在
 * 深层组件或 store 回调里（例如 SFTP 传输队列的回调），
 * 走 Context 就得把这些地方全包进 Provider，或者把回调层层传下去。
 */
import { create } from 'zustand'
import { useSettingsStore } from '../settings/useSettingsStore'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  tone: ToastTone
  message: string
  /** 次要说明，换行显示 */
  detail?: string
  /** 自动消失时长（毫秒） */
  timeout: number
  at: number
}

interface ToastState {
  items: ToastItem[]
  push: (toast: Omit<ToastItem, 'id' | 'at'>) => string
  dismiss: (id: string) => void
  clear: () => void
}

/** 同时最多显示的条数：再多就会盖住终端，用户反而看不到 */
const MAX_VISIBLE = 4

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const useToastStore = create<ToastState>((set) => ({
  items: [],

  push: (toast) => {
    const id = newId()
    set((state) => {
      const items = [...state.items, { ...toast, id, at: Date.now() }]
      // 超出上限时丢最早的，保证新发生的（更相关的）事件一定看得见
      return { items: items.length > MAX_VISIBLE ? items.slice(items.length - MAX_VISIBLE) : items }
    })
    return id
  },

  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clear: () => set({ items: [] }),
}))

export interface ToastOptions {
  detail?: string
  timeout?: number
}

/**
 * 便捷入口。
 * **会尊重「站内提示条」开关** —— 关掉之后仍走桌面通知（若开启），
 * 两者是互补关系：一个负责「正在看着屏幕时」，一个负责「去泡咖啡了」。
 */
export function toast(tone: ToastTone, message: string, options: ToastOptions = {}): void {
  if (!useSettingsStore.getState().notifications.toast) return
  const defaultTimeout = tone === 'error' ? 8000 : 4000
  useToastStore.getState().push({
    tone,
    message,
    detail: options.detail,
    timeout: options.timeout ?? defaultTimeout,
  })
}
