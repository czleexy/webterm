/**
 * SFTP 会话与传输任务的状态。
 *
 * 与终端标签的区别（刻意不合并成一个 store）：
 * - 终端标签承载的是「连接 + 字节流」，状态机围绕 WebSocket 展开；
 * - SFTP 标签承载的是「一条 SSH 连接上的文件视图」，除了会话本身，
 *   还要维护传输队列这一份**由服务端推送**的独立状态。
 * 两者的生命周期与副作用完全不同，硬合并只会让两边的重连逻辑互相干扰。
 *
 * WebSocket 句柄放在模块级 Map 里而不是 store 里：
 * 它是有副作用、不可序列化的资源，塞进 store 会让状态快照变得不可比较，
 * 也容易在 React 严格模式的双调用下被误关。
 */
import { create } from 'zustand'
import type { CreateSftpSessionRequest, SftpServerMessage, SshTarget, TransferTask } from '@webterm/shared'
import { buildSftpWsUrl, closeSftpSession, createSftpSession, listTransfers } from '../api/sftp'

export type SftpTabStatus = 'connecting' | 'ready' | 'error' | 'closed'

export interface SftpTab {
  /** 客户端侧唯一 id，与页签一一对应 */
  id: string
  title: string
  status: SftpTabStatus
  notice?: string
  sftpId?: string
  attachToken?: string
  wsPath?: string
  target?: SshTarget
  /** 远端家目录（realpath('.') 的结果） */
  remoteHome?: string
  /** 服务端受限的本地根目录，本地栏据此禁止向上越界 */
  localRoot?: string
  /** 本地初始目录 */
  localHome?: string
  /** 是否复用了某个终端的 SSH 连接（复用可避免老设备 VTY 线路被重复占用） */
  reusedConnection?: boolean
  createdAt: number
  /** 建连参数，供「重新连接」复用 */
  request: CreateSftpSessionRequest
}

interface SftpStore {
  tabs: SftpTab[]
  activeTabId: string | null
  /** sftpId → 该会话的传输任务（保持创建顺序） */
  transfers: Record<string, TransferTask[]>
  /** 服务端当前并发上限，仅用于展示 */
  concurrency: number

  addTab: (tab: SftpTab) => void
  updateTab: (id: string, patch: Partial<SftpTab>) => void
  setActive: (id: string) => void
  /** 关闭标签：先断连再移除，选相邻标签激活 */
  removeAndFocusNext: (id: string) => void

  /** 用一组建连参数打开一个新的 SFTP 标签（内部完成建连与附加） */
  openSftp: (request: CreateSftpSessionRequest, title: string) => Promise<string>
  /** 手动重新连接（自动重连耗尽后可用） */
  reconnect: (tabId: string) => void
  /** 服务端推来的任务更新 */
  upsertTransfer: (sftpId: string, task: TransferTask) => void
  /** 服务端推来的全量快照 */
  setTransfers: (sftpId: string, tasks: TransferTask[], concurrency?: number) => void
  dropTransfer: (sftpId: string, taskId: string) => void
}

/** 状态点的颜色与文案，与终端标签保持一致的视觉语言 */
export const SFTP_TAB_TONE: Record<
  SftpTabStatus,
  { dot: string; text: string; pulse?: boolean }
> = {
  connecting: { dot: 'bg-neutral-400', text: '连接中', pulse: true },
  ready: { dot: 'bg-emerald-500', text: '已连接' },
  error: { dot: 'bg-red-500', text: '出错' },
  closed: { dot: 'bg-neutral-500', text: '已关闭' },
}

export function createSftpTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sftp-${crypto.randomUUID()}`
  }
  return `sftp-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function sftpTitleFor(request: CreateSftpSessionRequest, fallback: string): string {
  const trimmed = fallback.trim()
  if (trimmed) return trimmed
  const target = request.config?.target
  if (target) {
    return `${target.username}@${target.host}${target.port === 22 ? '' : `:${target.port}`} · SFTP`
  }
  return 'SFTP 文件传输'
}

/* ------------------------------------------------------------------ */
/* WebSocket 生命周期（模块级资源）                                     */
/* ------------------------------------------------------------------ */

const sockets = new Map<string, WebSocket>()
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const retryCounts = new Map<string, number>()
/** 正在主动关闭的会话：此时 onclose 不应触发重连 */
const closing = new Set<string>()

/** 断线重连退避（毫秒）；次数用尽后交给用户手动重连 */
const RECONNECT_DELAYS = [600, 1500, 3000]

const CLOSE_UNAUTHORIZED = 4401
const CLOSE_NOT_FOUND = 4404

function clearRetry(sftpId: string): void {
  const timer = retryTimers.get(sftpId)
  if (timer) clearTimeout(timer)
  retryTimers.delete(sftpId)
}

/** 找到当前持有该 sftpId 的标签（一个会话只会被一个标签持有） */
function findTabBySftpId(sftpId: string): SftpTab | undefined {
  return useSftpStore.getState().tabs.find((tab) => tab.sftpId === sftpId)
}

function applyTabPatch(sftpId: string, patch: Partial<SftpTab>): void {
  const tab = findTabBySftpId(sftpId)
  if (tab) useSftpStore.getState().updateTab(tab.id, patch)
}

function attachSocket(sftpId: string, wsPath: string, attachToken: string): void {
  const existing = sockets.get(sftpId)
  if (existing) {
    existing.onopen = null
    existing.onmessage = null
    existing.onclose = null
    existing.onerror = null
    try {
      existing.close()
    } catch {
      /* 忽略 */
    }
    sockets.delete(sftpId)
  }

  const ws = new WebSocket(buildSftpWsUrl(wsPath, attachToken))
  sockets.set(sftpId, ws)

  ws.onopen = () => {
    retryCounts.set(sftpId, 0)
    applyTabPatch(sftpId, { status: 'ready', notice: undefined })
  }

  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    let msg: SftpServerMessage
    try {
      msg = JSON.parse(event.data) as SftpServerMessage
    } catch {
      return
    }
    const store = useSftpStore.getState()
    switch (msg.t) {
      case 'ready':
        applyTabPatch(sftpId, {
          status: 'ready',
          remoteHome: msg.remoteHome,
          localRoot: msg.localRoot,
          notice: undefined,
        })
        break
      case 'transfers':
        store.setTransfers(sftpId, msg.tasks)
        break
      case 'transfer':
        store.upsertTransfer(sftpId, msg.task)
        break
      case 'removed':
        store.dropTransfer(sftpId, msg.taskId)
        break
      case 'error':
        applyTabPatch(sftpId, { status: msg.fatal ? 'error' : 'ready', notice: msg.message })
        break
      case 'pong':
        break
    }
  }

  ws.onclose = (event: CloseEvent) => {
    if (sockets.get(sftpId) === ws) sockets.delete(sftpId)
    if (closing.has(sftpId)) return

    if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_NOT_FOUND) {
      applyTabPatch(sftpId, {
        status: 'error',
        notice:
          event.code === CLOSE_NOT_FOUND
            ? 'SFTP 会话已在服务端关闭，无法重新附加，请重新打开文件传输。'
            : '附加令牌无效，请重新打开文件传输。',
      })
      return
    }

    const attempt = retryCounts.get(sftpId) ?? 0
    if (attempt < RECONNECT_DELAYS.length) {
      retryCounts.set(sftpId, attempt + 1)
      const delay = RECONNECT_DELAYS[attempt] ?? 3000
      applyTabPatch(sftpId, {
        status: 'connecting',
        notice: `连接已断开，${(delay / 1000).toFixed(1)} 秒后自动重试（第 ${attempt + 1}/${RECONNECT_DELAYS.length} 次）…`,
      })
      clearRetry(sftpId)
      retryTimers.set(
        sftpId,
        setTimeout(() => {
          retryTimers.delete(sftpId)
          const tab = findTabBySftpId(sftpId)
          if (tab?.wsPath && tab.attachToken) attachSocket(sftpId, tab.wsPath, tab.attachToken)
        }, delay),
      )
      return
    }

    applyTabPatch(sftpId, { status: 'closed', notice: '连接已断开，自动重连未成功。' })
  }

  ws.onerror = () => {
    // 错误必然伴随 close，统一在那里处理
  }
}

function detachSocket(sftpId: string): void {
  closing.add(sftpId)
  clearRetry(sftpId)
  retryCounts.delete(sftpId)
  const ws = sockets.get(sftpId)
  sockets.delete(sftpId)
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 建连                                                               */
/* ------------------------------------------------------------------ */

/**
 * 建立服务端 SFTP 会话并附加事件流。
 *
 * 抽出来是为了让「首次打开」和「建连失败后重试」共用同一条路径 ——
 * 两处各写一遍的话，重试很容易漏掉「标签已被关掉要回收会话」这类边界。
 */
async function establish(tabId: string, request: CreateSftpSessionRequest): Promise<void> {
  try {
    const conn = await createSftpSession(request)
    const stillThere = useSftpStore.getState().tabs.some((t) => t.id === tabId)
    if (!stillThere) {
      // 用户在建连过程中关掉了标签：回收服务端会话，避免留下孤儿 SSH 连接
      void closeSftpSession(conn.sftpId).catch(() => {})
      return
    }

    useSftpStore.getState().updateTab(tabId, {
      status: 'connecting',
      sftpId: conn.sftpId,
      attachToken: conn.attachToken,
      wsPath: conn.wsPath,
      // 用户自定义的标题优先；否则用服务端推导的「用户@主机:端口」并标出这是文件传输标签
      title: request.title?.trim() || `${conn.title} · SFTP`,
      remoteHome: conn.remoteHome,
      localRoot: conn.localRoot,
      localHome: conn.localHome,
      reusedConnection: conn.reusedConnection,
      notice: undefined,
    })

    // 先拉一次全量，避免 WebSocket 快照到达前的空窗
    void listTransfers(conn.sftpId)
      .then((res) => useSftpStore.getState().setTransfers(conn.sftpId, res.tasks, res.concurrency))
      .catch(() => {})

    attachSocket(conn.sftpId, conn.wsPath, conn.attachToken)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useSftpStore.getState().updateTab(tabId, { status: 'error', notice: message })
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export const useSftpStore = create<SftpStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  transfers: {},
  concurrency: 0,

  addTab: (tab) => {
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))
  },

  updateTab: (id, patch) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }))
  },

  setActive: (id) => {
    if (get().activeTabId === id) return
    set({ activeTabId: id })
  },

  removeAndFocusNext: (id) => {
    const { tabs, activeTabId, transfers } = get()
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const tab = tabs[index]
    const tabs2 = tabs.filter((t) => t.id !== id)

    let nextActive = activeTabId
    if (activeTabId === id) {
      nextActive = tabs2[index]?.id ?? tabs2[index - 1]?.id ?? null
    }

    const nextTransfers = { ...transfers }
    if (tab?.sftpId) {
      detachSocket(tab.sftpId)
      // 显式 DELETE：仅断开 WebSocket 会留下服务端会话与 SSH 连接
      void closeSftpSession(tab.sftpId).catch(() => {})
      delete nextTransfers[tab.sftpId]
    }

    set({ tabs: tabs2, activeTabId: nextActive, transfers: nextTransfers })
  },

  openSftp: async (request, title) => {
    const tab: SftpTab = {
      id: createSftpTabId(),
      title: sftpTitleFor(request, title),
      status: 'connecting',
      createdAt: Date.now(),
      request,
    }
    get().addTab(tab)
    // 建连结果通过 store 推送（标签先渲染出「连接中」，避免界面卡住没有反馈）
    void establish(tab.id, request)
    return tab.id
  },

  reconnect: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return

    if (tab.sftpId && tab.wsPath && tab.attachToken) {
      // 会话还在，只是 WebSocket 掉了：直接重新附加，不必重新认证
      clearRetry(tab.sftpId)
      retryCounts.set(tab.sftpId, 0)
      get().updateTab(tabId, { status: 'connecting', notice: undefined })
      attachSocket(tab.sftpId, tab.wsPath, tab.attachToken)
      return
    }

    // 会话本身就没建成（认证失败 / 远端没有 SFTP 子系统）：用原参数重来一次
    get().updateTab(tabId, { status: 'connecting', notice: undefined })
    await establish(tabId, tab.request)
  },

  setTransfers: (sftpId, tasks, concurrency) => {
    set((state) => ({
      transfers: { ...state.transfers, [sftpId]: [...tasks] },
      concurrency: concurrency ?? state.concurrency,
    }))
  },

  upsertTransfer: (sftpId, task) => {
    set((state) => {
      const list = state.transfers[sftpId] ?? []
      const index = list.findIndex((t) => t.id === task.id)
      const next =
        index === -1 ? [...list, task] : list.map((t) => (t.id === task.id ? task : t))
      return { transfers: { ...state.transfers, [sftpId]: next } }
    })
  },

  dropTransfer: (sftpId, taskId) => {
    set((state) => {
      const list = state.transfers[sftpId]
      if (!list) return state
      return {
        transfers: { ...state.transfers, [sftpId]: list.filter((t) => t.id !== taskId) },
      }
    })
  },
}))
