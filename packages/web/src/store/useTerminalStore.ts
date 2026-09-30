/**
 * 终端标签页状态。
 *
 * 设计说明：标签状态不做持久化。
 * 原因是服务端的终端持有一次性附加令牌，刷新页面后浏览器已拿不到该令牌，
 * 恢复出来的标签也无法重新附加。服务端会在超时后回收这些孤儿终端（见 terminal-manager.ts）。
 * 持久化「会话配置」（阶段 2 的会话库）才是用户真正需要的，那是另一回事。
 */
import { create } from 'zustand'
import type {
  ConnectionProtocol,
  SessionConfig,
  SessionLogSettings,
  TelnetNegotiationSummary,
  TerminalNegotiationSummary,
} from '@webterm/shared'
import { DEFAULT_TERM_COLS, DEFAULT_TERM_ROWS, protocolOf, targetLabel } from '@webterm/shared'

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
  /**
   * 连接协议。
   * 单独冗余一份而不总是从 config 推导：会话库引用（sessionId）的标签没有 config，
   * 而标签栏需要它来决定「是否提供 SFTP 入口」（Telnet 没有文件传输子系统）。
   */
  protocol: ConnectionProtocol
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
  /** Telnet 选项协商结果，仅 telnet 标签存在（SSH 标签恒为 undefined） */
  telnetOptions?: TelnetNegotiationSummary
  /** 结束原因 / 错误说明，用于标签提示与面板内的提示条 */
  notice?: string
  /**
   * 由触发器「记录标签」动作打上的标签（去重、保持追加顺序）。
   * 放在标签上而不是自动化 store 里：标签的语义是「这个终端现在是什么状态」，
   * 标签栏、批量执行的目标列表都可能要读它。
   */
  labels?: string[]
  /** 会话日志配置（阶段 7）：html 格式时面板需要定期上传序列化快照 */
  logging?: SessionLogSettings
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
  /** 打标签：已存在时什么都不做，避免重复追加把标签栏撑爆 */
  addLabel: (id: string, label: string) => void
}

export function createTabId(): string {
  // crypto.randomUUID 在现代浏览器均可用；降级方案保证不抛错
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * 由会话配置推导一个默认标题。
 * 规则与后端共用同一份实现（shared 的 targetLabel），
 * 避免标签上出现 `root@host` 与 `host` 两种格式。
 */
export function defaultTitleFor(config: SessionConfig): string {
  return targetLabel(config)
}

export function newTab(config: SessionConfig, title?: string): TerminalTab {
  return {
    id: createTabId(),
    title: title?.trim() || defaultTitleFor(config),
    protocol: protocolOf(config),
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
export function newTabFromSession(
  sessionId: string,
  title: string,
  protocol: ConnectionProtocol = 'ssh',
): TerminalTab {
  return {
    id: createTabId(),
    title: title.trim() || '会话',
    protocol,
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

  addLabel: (id, label) => {
    const trimmed = label.trim()
    if (!trimmed) return
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== id) return tab
        const labels = tab.labels ?? []
        if (labels.includes(trimmed)) return tab
        return { ...tab, labels: [...labels, trimmed] }
      }),
    }))
  },
}))
