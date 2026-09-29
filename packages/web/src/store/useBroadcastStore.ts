/**
 * 同步输入（广播模式）状态。
 *
 * 语义：开启后，在**任意**终端里敲的每一个键都会同时投递给 `targets` 里的终端
 * （源终端自己不算，它本来就会收到自己的输入）。
 *
 * 三个刻意的设计取舍：
 *
 * 1. **目标集在开启的那一刻锁定**，而不是「所有已打开的终端」动态计算。
 *    动态计算看着更省事，但用户中途新开一个标签时，那个标签会**静默地**开始接收
 *    别人的按键 —— 在一个能往生产设备写命令的工具里，这种「悄悄多了一个受害者」
 *    的行为不可接受。新标签要加入必须显式勾选。
 * 2. **不做去抖与合并**。终端输入是有时序的（方向键、Tab 补全、Ctrl 组合键），
 *    合并两次按键会让远端收到的序列彻底错位。
 * 3. **关闭是即时的、无残留**。广播只活在内存里，刷新页面即失效 ——
 *    一个「忘了关的广播」比「每次都要重新打开」危险得多。
 */
import { create } from 'zustand'

/** 最近一次广播的回执，用于警告条上回显「刚才发给了几个终端」 */
export interface BroadcastReceipt {
  at: number
  delivered: number
  skipped: number
}

interface BroadcastStore {
  enabled: boolean
  /** 接收方 tabId 列表（不含源终端） */
  targets: string[]
  /** 广播面板是否展开 */
  panelOpen: boolean
  last: BroadcastReceipt | null

  /**
   * 开启广播。
   * `seed` 是「开启这一刻可写的终端」，调用方（面板）负责提供 ——
   * store 不主动去问终端连接状态，保持它对连接层零依赖。
   */
  enable: (seed: string[]) => void
  disable: () => void
  setPanelOpen: (open: boolean) => void
  toggleTarget: (tabId: string) => void
  setTargets: (ids: string[]) => void
  /** 标签被关闭时清理；返回是否因此自动关闭了广播 */
  prune: (liveTabIds: readonly string[]) => void
  recordReceipt: (receipt: Omit<BroadcastReceipt, 'at'>) => void
}

export const useBroadcastStore = create<BroadcastStore>((set, get) => ({
  enabled: false,
  targets: [],
  panelOpen: false,
  last: null,

  enable: (seed) => {
    const unique = [...new Set(seed)].filter(Boolean)
    // 一个接收方都没有时开启广播是没有意义的，且会让「已开启」的提示骗人
    if (unique.length === 0) return
    set({ enabled: true, targets: unique, last: null })
  },

  disable: () => set({ enabled: false, targets: [], last: null }),

  setPanelOpen: (open) => set({ panelOpen: open }),

  toggleTarget: (tabId) => {
    const { targets } = get()
    const next = targets.includes(tabId)
      ? targets.filter((id) => id !== tabId)
      : [...targets, tabId]
    // 把最后一个接收方取消掉就自动关闭 —— 否则界面上「广播中」的绿灯亮着，
    // 实际一个终端都收不到，用户会以为命令下发出去了
    set(next.length === 0 ? { targets: [], enabled: false, last: null } : { targets: next })
  },

  setTargets: (ids) => {
    const unique = [...new Set(ids)].filter(Boolean)
    set(unique.length === 0 ? { targets: [], enabled: false, last: null } : { targets: unique })
  },

  prune: (liveTabIds) => {
    const live = new Set(liveTabIds)
    const { targets, enabled } = get()
    const next = targets.filter((id) => live.has(id))
    if (next.length === targets.length) return
    if (next.length === 0) {
      set({ targets: [], enabled: false, last: null })
      return
    }
    // 目标少了几个但还有剩：保持开启，但用户必须被告知（面板会显示实际接收方数量）
    set({ targets: next, enabled: enabled && next.length > 0 })
  },

  recordReceipt: (receipt) => set({ last: { ...receipt, at: Date.now() } }),
}))
