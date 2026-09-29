/**
 * 自动化（阶段 6）的前端状态层：触发器 / 按钮栏 / 脚本 / 运行记录。
 *
 * 数据来源有两条，职责划分得很清楚：
 * - **REST** 负责「定义」：规则的增删改、脚本源码、宏步骤。低频、需要持久化。
 * - **WebSocket** 负责「运行态」：命中事件、脚本日志、宏进度。高频、过期即弃。
 *
 * 因此这里既不是纯粹的「服务端缓存」，也不是纯粹的本地面板状态：
 * 定义部分严格镜像服务端（改完就重新拉取，不做乐观更新 —— 规则写错的代价
 * 是它会在每个会话上乱发命令，这种时候「界面显示已保存但服务端没存」是不可接受的）；
 * 运行态则只增不减地滚动保留，用来给面板提供「刚才发生了什么」。
 *
 * 运行态**不落 localStorage**：刷新页面后进程内存里的统计本来就清零了，
 * 把陈旧的命中记录恢复出来只会让人误判。
 */
import { create } from 'zustand'
import type {
  AutomationCapabilities,
  CreateMacroRequest,
  CreateScriptRequest,
  CreateTriggerRequest,
  MacroDefinition,
  ScriptDefinition,
  ScriptLogEntry,
  ScriptRunRecord,
  TriggerHighlightColor,
  TriggerRule,
  TriggerStats,
  UpdateMacroRequest,
  UpdateScriptRequest,
  UpdateTriggerRequest,
} from '@webterm/shared'
import * as api from '../api/client'

/** 命中记录的保留条数（面板里按时间倒序展示） */
const MAX_HITS = 200
/** 单次脚本运行在前端保留的日志条数 */
const MAX_LIVE_LOGS = 500
/** 已结束的脚本运行在前端保留的条数 */
const MAX_LIVE_RUNS = 30

/** 一次触发器命中在界面上的留痕 */
export interface TriggerHit {
  id: string
  tabId: string
  /** 命中时的终端标题，标签关掉后仍能看懂这条记录 */
  tabTitle: string
  ruleId: string
  ruleName: string
  line: string
  matched: string
  color: TriggerHighlightColor
  /** 服务端已完成的动作摘要（自动应答、执行脚本等） */
  performed: string[]
  /** 需要浏览器通知时，通知是否真的弹出来了 */
  notified: boolean
  labels: string[]
  at: number
}

/** 前端侧实时维护的脚本运行视图（REST 的 script-runs 是「回看」用的快照） */
export interface LiveScriptRun {
  runId: string
  tabId: string
  scriptName: string
  phase: 'running' | 'done' | 'error' | 'timeout'
  logs: ScriptLogEntry[]
  result?: unknown
  error?: string
  elapsedMs?: number
  startedAt: number
  /** 因超出上限而未保留的日志条数 */
  droppedLogs: number
}

/** 宏执行进度 */
export interface MacroRunState {
  runId: string
  tabId: string
  macroName: string
  phase: 'start' | 'step' | 'done' | 'error'
  stepIndex?: number
  stepCount?: number
  detail?: string
  error?: string
  at: number
}

/** 面板的四个分区 */
export const AUTOMATION_SECTIONS = ['triggers', 'macros', 'scripts', 'batch'] as const
export type AutomationSection = (typeof AUTOMATION_SECTIONS)[number]

export const AUTOMATION_SECTION_LABEL: Record<AutomationSection, string> = {
  triggers: '触发器',
  macros: '按钮栏',
  scripts: '脚本',
  batch: '批量执行',
}

interface AutomationStore {
  /* 面板 */
  panelOpen: boolean
  section: AutomationSection
  openPanel: (section?: AutomationSection) => void
  closePanel: () => void
  setSection: (section: AutomationSection) => void

  /* 定义 */
  triggers: TriggerRule[]
  stats: Record<string, TriggerStats>
  macros: MacroDefinition[]
  scripts: api.ScriptDefinition[]
  capabilities: AutomationCapabilities | null
  loading: boolean
  /** 最近一次加载/写入的错误说明，面板顶部据此提示 */
  error: string | null

  /* 运行态 */
  hits: TriggerHit[]
  liveRuns: LiveScriptRun[]
  macroRuns: MacroRunState[]
  /** 已从服务端拉回的历史运行记录 */
  runs: ScriptRunRecord[]
  /** 各标签「还没被看过的」命中数，用于在标签栏上打角标 */
  unseenHits: Record<string, number>
  /**
   * 命中时是否在终端里追加一行提示。
   * 默认开启：自动应答最危险的失败模式是「答了但用户不知道」。
   * 但全屏 TUI 里插入一行会破坏画面，所以给用户留一个关掉的口子。
   */
  announceInTerminal: boolean

  loadAll: () => Promise<void>
  refreshTriggers: () => Promise<void>
  refreshMacros: () => Promise<void>
  refreshScripts: () => Promise<void>
  refreshRuns: () => Promise<void>
  setError: (message: string | null) => void
  setAnnounceInTerminal: (value: boolean) => void

  /* 触发器的写操作：写完全量刷新，不做乐观更新（规则写错的代价太高） */
  createTrigger: (body: CreateTriggerRequest) => Promise<TriggerRule>
  saveTrigger: (id: string, body: UpdateTriggerRequest) => Promise<TriggerRule>
  removeTrigger: (id: string) => Promise<void>
  setTriggerEnabled: (id: string, enabled: boolean) => Promise<void>

  createMacro: (body: CreateMacroRequest) => Promise<MacroDefinition>
  saveMacro: (id: string, body: UpdateMacroRequest) => Promise<MacroDefinition>
  removeMacro: (id: string) => Promise<void>

  createScript: (body: CreateScriptRequest) => Promise<ScriptDefinition>
  saveScript: (id: string, body: UpdateScriptRequest) => Promise<ScriptDefinition>
  /** 删除脚本；返回「被引用次数」，调用方据此提示用户哪些绑定会失效 */
  removeScript: (id: string) => Promise<number>

  recordHit: (hit: Omit<TriggerHit, 'id' | 'at'>) => void
  clearHits: (tabId?: string) => void
  /** 用户切到该标签，角标清零 */
  markHitsSeen: (tabId: string) => void

  applyScriptMessage: (
    tabId: string,
    tabTitle: string,
    msg: {
      runId: string
      scriptName: string
      phase: 'start' | 'log' | 'done' | 'error' | 'timeout'
      level?: ScriptLogEntry['level']
      message?: string
      result?: unknown
      error?: string
      elapsedMs?: number
      at: string
    },
  ) => void
  applyMacroMessage: (
    tabId: string,
    msg: {
      runId: string
      macroName: string
      phase: 'start' | 'step' | 'done' | 'error'
      stepIndex?: number
      stepCount?: number
      detail?: string
      error?: string
      at: string
    },
  ) => void
  clearLiveRuns: () => void
}

/** 从服务端错误里抽出人话；ApiRequestError 已经带了服务端的 message */
function messageOf(err: unknown): string {
  if (err instanceof api.ApiRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export const useAutomationStore = create<AutomationStore>((set, get) => ({
  panelOpen: false,
  section: 'triggers',

  openPanel: (section) => {
    set({ panelOpen: true, ...(section ? { section } : {}) })
    // 每次打开都重新拉一遍：规则可能被另一个标签页改过，而触发器是「改错就在所有会话上乱发命令」
    // 的东西，界面上显示一份陈旧副本比多一次请求危险得多
    if (get().triggers.length === 0) void get().loadAll()
  },
  closePanel: () => set({ panelOpen: false }),
  setSection: (section) => set({ section }),

  triggers: [],
  stats: {},
  macros: [],
  scripts: [],
  capabilities: null,
  loading: false,
  error: null,

  hits: [],
  liveRuns: [],
  macroRuns: [],
  runs: [],
  unseenHits: {},
  announceInTerminal: true,

  loadAll: async () => {
    set({ loading: true, error: null })
    try {
      // 能力声明决定表单的取值范围（修饰符白名单、上限），必须一起拿到
      const [triggerList, macroList, scriptList, capabilities] = await Promise.all([
        api.listTriggers(),
        api.listMacros(),
        api.listScripts(),
        api.fetchCapabilities(),
      ])
      set({
        triggers: triggerList.rules,
        stats: Object.fromEntries(triggerList.stats.map((s) => [s.ruleId, s])),
        macros: macroList.macros,
        scripts: scriptList.scripts,
        // 能力声明挂在总 capabilities 的 automation 字段下
        capabilities: capabilities.automation,
        loading: false,
      })
    } catch (err) {
      set({ loading: false, error: messageOf(err) })
    }
  },

  refreshTriggers: async () => {
    try {
      const list = await api.listTriggers()
      set({
        triggers: list.rules,
        stats: Object.fromEntries(list.stats.map((s) => [s.ruleId, s])),
      })
    } catch (err) {
      set({ error: messageOf(err) })
    }
  },

  refreshMacros: async () => {
    try {
      set({ macros: (await api.listMacros()).macros })
    } catch (err) {
      set({ error: messageOf(err) })
    }
  },

  refreshScripts: async () => {
    try {
      set({ scripts: (await api.listScripts()).scripts })
    } catch (err) {
      set({ error: messageOf(err) })
    }
  },

  refreshRuns: async () => {
    try {
      set({ runs: (await api.listScriptRuns()).runs })
    } catch (err) {
      set({ error: messageOf(err) })
    }
  },

  setError: (message) => set({ error: message }),

  setAnnounceInTerminal: (value) => set({ announceInTerminal: value }),

  /* ---------------- 触发器写操作 ---------------- */

  createTrigger: async (body) => {
    try {
      const { rule } = await api.createTrigger(body)
      await get().refreshTriggers()
      return rule
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  saveTrigger: async (id, body) => {
    try {
      const { rule } = await api.updateTrigger(id, body)
      await get().refreshTriggers()
      return rule
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  removeTrigger: async (id) => {
    try {
      await api.deleteTrigger(id)
      await get().refreshTriggers()
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  setTriggerEnabled: async (id, enabled) => {
    try {
      await api.updateTrigger(id, { enabled })
      await get().refreshTriggers()
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  /* ---------------- 宏写操作 ---------------- */

  createMacro: async (body) => {
    try {
      const { macro } = await api.createMacro(body)
      await get().refreshMacros()
      return macro
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  saveMacro: async (id, body) => {
    try {
      const { macro } = await api.updateMacro(id, body)
      await get().refreshMacros()
      return macro
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  removeMacro: async (id) => {
    try {
      await api.deleteMacro(id)
      await get().refreshMacros()
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  /* ---------------- 脚本写操作 ---------------- */

  createScript: async (body) => {
    try {
      const { script } = await api.createScript(body)
      await get().refreshScripts()
      return script
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  saveScript: async (id, body) => {
    try {
      const { script } = await api.updateScript(id, body)
      await get().refreshScripts()
      return script
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  removeScript: async (id) => {
    try {
      const result = await api.deleteScript(id)
      await get().refreshScripts()
      // 触发器可能引用了这个脚本，删完顺手刷新规则列表上的错误标记
      await get().refreshTriggers()
      return result.references
    } catch (err) {
      set({ error: messageOf(err) })
      throw err
    }
  },

  recordHit: (hit) => {
    const entry: TriggerHit = {
      ...hit,
      id: `hit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    }
    const { hits, unseenHits } = get()
    const next = [entry, ...hits]
    set({
      hits: next.length > MAX_HITS ? next.slice(0, MAX_HITS) : next,
      unseenHits: {
        ...unseenHits,
        [hit.tabId]: (unseenHits[hit.tabId] ?? 0) + 1,
      },
    })
  },

  clearHits: (tabId) => {
    const { hits, unseenHits } = get()
    if (!tabId) {
      set({ hits: [], unseenHits: {} })
      return
    }
    const rest = { ...unseenHits }
    delete rest[tabId]
    set({ hits: hits.filter((h) => h.tabId !== tabId), unseenHits: rest })
  },

  markHitsSeen: (tabId) => {
    const { unseenHits } = get()
    if (!unseenHits[tabId]) return
    const rest = { ...unseenHits }
    delete rest[tabId]
    set({ unseenHits: rest })
  },

  applyScriptMessage: (tabId, tabTitle, msg) => {
    const { liveRuns } = get()
    const index = liveRuns.findIndex((r) => r.runId === msg.runId)
    const existing = index >= 0 ? liveRuns[index] : undefined

    // start 之后才有 run 对象；正常情况下服务端总是先发 start，
    // 但断线重连可能让前端只看到中间的 log —— 这里补一个占位而不是丢弃这条日志
    const base: LiveScriptRun = existing ?? {
      runId: msg.runId,
      tabId,
      scriptName: msg.scriptName || tabTitle,
      phase: 'running',
      logs: [],
      startedAt: Date.now(),
      droppedLogs: 0,
    }

    let next: LiveScriptRun = base
    if (msg.phase === 'start') {
      next = { ...base, phase: 'running', logs: [], startedAt: Date.now() }
    } else if (msg.phase === 'log') {
      const logs = [
        ...base.logs,
        {
          level: msg.level ?? 'info',
          message: msg.message ?? '',
          at: msg.at,
        },
      ]
      next =
        logs.length > MAX_LIVE_LOGS
          ? { ...base, logs: logs.slice(-MAX_LIVE_LOGS), droppedLogs: base.droppedLogs + 1 }
          : { ...base, logs }
    } else {
      next = {
        ...base,
        phase: msg.phase,
        result: msg.result,
        error: msg.error,
        elapsedMs: msg.elapsedMs,
      }
    }

    const merged = index >= 0 ? liveRuns.map((r, i) => (i === index ? next : r)) : [next, ...liveRuns]
    // 结束的运行按时间保留若干条，正在运行的必须始终留着（用户可能正在看它的输出）
    const finished = merged.filter((r) => r.phase !== 'running')
    const running = merged.filter((r) => r.phase === 'running')
    const keptFinished = finished.slice(0, MAX_LIVE_RUNS)
    set({ liveRuns: [...running, ...keptFinished].sort((a, b) => b.startedAt - a.startedAt) })

    // 跑完就顺手刷新一次服务端快照，让「历史记录」里立刻能看到这一条
    if (msg.phase === 'done' || msg.phase === 'error' || msg.phase === 'timeout') {
      void get().refreshRuns()
    }
  },

  applyMacroMessage: (tabId, msg) => {
    const { macroRuns } = get()
    const entry: MacroRunState = {
      runId: msg.runId,
      tabId,
      macroName: msg.macroName,
      phase: msg.phase,
      stepIndex: msg.stepIndex,
      stepCount: msg.stepCount,
      detail: msg.detail,
      error: msg.error,
      at: Date.parse(msg.at) || Date.now(),
    }
    const index = macroRuns.findIndex((r) => r.runId === msg.runId)
    const next =
      index >= 0 ? macroRuns.map((r, i) => (i === index ? entry : r)) : [entry, ...macroRuns]
    // 已结束的宏只保留最近 10 条，避免长跑一天的界面里堆几百条进度
    const unfinished = next.filter((r) => r.phase !== 'done' && r.phase !== 'error')
    const finished = next.filter((r) => r.phase === 'done' || r.phase === 'error').slice(0, 10)
    set({ macroRuns: [...unfinished, ...finished] })
  },

  clearLiveRuns: () => set({ liveRuns: [] }),
}))
