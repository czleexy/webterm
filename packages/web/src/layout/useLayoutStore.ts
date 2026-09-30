/**
 * 分屏布局（阶段 8）。
 *
 * 三种布局：单格 / 左右两格 / 四宫格。
 *
 * **为什么不引入计划里写的 `react-resizable-panels`**（这段结论是实测出来的，不是偏好）：
 * 该库用 `PanelGroup > Panel > 内容` 的层级表达布局，而「切布局」意味着终端组件的
 * 父级节点发生变化 —— React 会把整棵子树卸载重建。对普通 UI 这只是重渲染，
 * 但对终端是灾难：xterm 实例被销毁、WebSocket 重建，而重建走的是
 * `POST /terminals` 的完整创建流程，**服务端会再建一条 SSH 连接**。
 * 老交换机 / 路由器的 VTY 线路通常只有几条，用户每切一次布局就多占一条，
 * 很快就会「明明没开几个会话却连不上」。
 *
 * 所以布局用 CSS Grid 实现：**所有终端恒为同一个网格容器的直接子元素**
 * （顺序不变、key 不变），切布局只是改各自的 `grid-area` 与显示状态，
 * React 不会重建任何终端。拖拽分隔条用原生鼠标事件自绘，代码量不大，还省一个依赖。
 */
import { create } from 'zustand'

export type LayoutMode = 'single' | 'split-2' | 'grid-4'

export const LAYOUT_SLOT_COUNT: Record<LayoutMode, number> = {
  single: 1,
  'split-2': 2,
  'grid-4': 4,
}

/**
 * 布局名对应的 i18n 键。
 *
 * 字面量联合而不是 `MessageKey`：布局模块不该为了一个显示名去依赖 i18n 模块
 * （虽然当前不会形成循环，但让「布局」认识「词典」是概念上的倒置）。
 * 三个值都是词典里真实存在的键，写错会在调用处立刻报类型错。
 */
export const LAYOUT_LABEL_KEY = {
  single: 'terminal.layout.single',
  'split-2': 'terminal.layout.split2',
  'grid-4': 'terminal.layout.grid4',
} as const

/** 分隔比例的安全区间：任一格都不小于 15% */
export const RATIO_MIN = 0.15
export const RATIO_MAX = 0.85

interface LayoutState {
  mode: LayoutMode
  /** 每个格子放哪个终端标签；null 表示空格（显示「选择一个会话」） */
  slots: (string | null)[]
  /** 当前聚焦的格子索引（键盘输入落点） */
  focusIndex: number
  /**
   * 分隔条位置（占容器比例）。
   *
   * 横竖两条各存一个：早先共用一个值，结果拖竖条会连带把行高也改掉 ——
   * 用户拖的是「左右的分界」，行高跟着动完全没有道理。
   */
  ratioX: number
  ratioY: number

  setMode: (mode: LayoutMode, candidates: string[], preferred?: string | null) => void
  setSlot: (index: number, tabId: string | null) => void
  setFocus: (index: number) => void
  setRatio: (axis: 'x' | 'y', value: number) => void
  /**
   * 把空格子用「还没在别处出现过」的会话补齐。
   * 关闭一个会话后分屏会留下空洞，用户还得手动去选 —— 这个动作把「还有空位就自动填上」
   * 这件显然的事替用户做了。不覆盖已有分配，所以不会把用户摆好的布局打乱。
   */
  fillEmptySlots: (candidates: string[]) => void
  /** 标签被关闭后清理引用；保留 focusIndex 以免焦点乱跳 */
  pruneSlots: (validIds: string[]) => void
  reset: () => void
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  mode: 'single',
  slots: [null],
  focusIndex: 0,
  ratioX: 0.5,
  ratioY: 0.5,

  setMode: (mode, candidates, preferred) => {
    const count = LAYOUT_SLOT_COUNT[mode]
    const current = get().slots
    const next: (string | null)[] = []

    // 优先保留当前聚焦格里的会话，其次是已有的分配，最后才按顺序补
    const first = preferred ?? current[get().focusIndex] ?? null
    if (first && candidates.includes(first)) next.push(first)
    for (const id of current) {
      if (next.length >= count) break
      if (id && !next.includes(id) && candidates.includes(id)) next.push(id)
    }
    for (const id of candidates) {
      if (next.length >= count) break
      if (!next.includes(id)) next.push(id)
    }
    while (next.length < count) next.push(null)

    set({
      mode,
      slots: next.slice(0, count),
      focusIndex: 0,
    })
  },

  setSlot: (index, tabId) =>
    set((state) => {
      if (index < 0 || index >= state.slots.length) return state
      const slots = [...state.slots]
      // 同一个终端不能同时出现在两个格子里：先把它在别处的位置腾空
      if (tabId) {
        for (let i = 0; i < slots.length; i += 1) {
          if (i !== index && slots[i] === tabId) slots[i] = null
        }
      }
      slots[index] = tabId
      return { slots }
    }),

  setFocus: (index) =>
    set((state) => {
      if (index < 0 || index >= state.slots.length) return state
      return { focusIndex: index }
    }),

  setRatio: (axis, value) => {
    const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, value))
    set(axis === 'x' ? { ratioX: clamped } : { ratioY: clamped })
  },

  fillEmptySlots: (candidates) =>
    set((state) => {
      const used = new Set(state.slots.filter((id): id is string => Boolean(id)))
      const free = candidates.filter((id) => !used.has(id))
      if (free.length === 0) return state
      let cursor = 0
      let changed = false
      const slots = state.slots.map((id) => {
        if (id !== null) return id
        const next = free[cursor]
        if (next === undefined) return id
        cursor += 1
        changed = true
        return next
      })
      return changed ? { slots } : state
    }),

  pruneSlots: (validIds) =>
    set((state) => {
      const valid = new Set(validIds)
      let changed = false
      const slots = state.slots.map((id) => {
        if (id && !valid.has(id)) {
          changed = true
          return null
        }
        return id
      })
      return changed ? { slots } : state
    }),

  reset: () => set({ mode: 'single', slots: [null], focusIndex: 0, ratioX: 0.5, ratioY: 0.5 }),
}))
