/**
 * 终端标签页状态。
 *
 * 设计说明：标签状态不做持久化。
 * 原因是服务端的终端持有一次性附加令牌，刷新页面后浏览器已拿不到该令牌，
 * 恢复出来的标签也无法重新附加。服务端会在超时后回收这些孤儿终端（见 terminal-manager.ts）。
 * 持久化「会话配置」（阶段 2 的会话库）才是用户真正需要的，那是另一回事。
 */
import { create } from 'zustand'
import type { SessionConfig, TerminalNegotiationSummary } from '@webterm/shared'
import { DEFAULT_TERM_COLS, DEFAULT_TERM_ROWS } from '@webterm/shared'

export type TabStatus = 'connecting' | 'ready' | 'flow-paused' | 'exited' | 'error'

/**
 * 状态点的颜色与文案。
 * 定义在 store 侧而不是标签栏组件里：标签栏是通用组件，不认识任何 store，
 * 由上层把 tone 拼进统一的标签视图（见 components/WorkspaceTabs.tsx）。
 */
export const TERMINAL_TAB_TONE: Record<
  TabStatus,
  { dot: string; text: string; pulse?: boolean }
> = {
  connecting: { dot: 'bg-neutral-400', text: '连接中', pulse: true },
  ready: { dot: 'bg-emerald-500', text: '已连接' },
  'flow-paused': { dot: 'bg-amber-500', text: '限速中（背压保护）' },
  exited: { dot: 'bg-neutral-500', text: '已结束' },
  error: { dot: 'bg-red-500', text: '出错' },
}

export interface TerminalTab {
  /** 客户端侧唯一 id，与页签一一对应 */
  id: string
  title: string
  /** 快速连接时的直传配置；与会话库引用二选一 */
  config?: SessionConfig
  /** 会话库引用：连接参数由服务端解析（凭据 + 跳板链） */
  sessionId?: string
  status: TabStatus
  /** 服务端终端 id（创建成功后才有） */
  terminalId?: string
  attachToken?: string
  wsPath?: string
  negotiation?: TerminalNegotiationSummary
  /** 结束原因 / 错误说明，用于标签提示与面板内的提示条 */
  notice?: string
  /** 服务端记录的实际 PTY 尺寸 */
  dims: { cols: number; rows: number }
  createdAt: number
}

interface TerminalStore {
  tabs: TerminalTab[]
  activeTabId: string | null
  addTab: (tab: TerminalTab) => void
  updateTab: (id: string, patch: Partial<TerminalTab>) => void
  removeTab: (id: string) => void
  setActive: (id: string) => void
  /** 关闭后自动选择相邻标签（优先右侧，否则左侧） */
  removeAndFocusNext: (id: string) => void
}

export function createTabId(): string {
  // crypto.randomUUID 在现代浏览器均可用；降级方案保证不抛错
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 由会话配置推导一个默认标题，与后端的推导规则保持一致 */
export function defaultTitleFor(config: SessionConfig): string {
  const { host, port, username } = config.target
  return `${username}@${host}${port === 22 ? '' : `:${port}`}`
}

export function newTab(config: SessionConfig, title?: string): TerminalTab {
  return {
    id: createTabId(),
    title: title?.trim() || defaultTitleFor(config),
    config,
    status: 'connecting',
    dims: {
      cols: config.terminal.cols || DEFAULT_TERM_COLS,
      rows: config.terminal.rows || DEFAULT_TERM_ROWS,
    },
    createdAt: Date.now(),
  }
}

/** 从会话库记录创建标签：连接参数由服务端解析 */
export function newTabFromSession(sessionId: string, title: string): TerminalTab {
  return {
    id: createTabId(),
    title: title.trim() || '会话',
    sessionId,
    status: 'connecting',
    dims: { cols: DEFAULT_TERM_COLS, rows: DEFAULT_TERM_ROWS },
    createdAt: Date.now(),
  }
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) => {
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))
  },

  updateTab: (id, patch) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }))
  },

  removeTab: (id) => {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      const activeTabId =
        state.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : state.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActive: (id) => {
    if (get().activeTabId === id) return
    set({ activeTabId: id })
  },

  removeAndFocusNext: (id) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const tabs2 = tabs.filter((tab) => tab.id !== id)
    let nextActive = activeTabId
    if (activeTabId === id) {
      // 优先选中右邻，没有则选左邻
      nextActive = tabs2[index]?.id ?? tabs2[index - 1]?.id ?? null
    }
    set({ tabs: tabs2, activeTabId: nextActive })
  },
}))
