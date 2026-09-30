/**
 * 插件契约（阶段 9）。
 *
 * 三段式设计 —— 这个文件描述的是**边界**，不是实现：
 *
 * 1. **清单**（`plugin.json`）：目录即插件。`data/plugins/<目录>/plugin.json`
 *    里声明 id / 版本 / 配置项，`main` 指向入口 JS。
 * 2. **注册项**：插件在加载时通过 Host API 声明「我能提供什么」——
 *    触发器动作、命令、面板。宿主把它们收集起来，
 *    界面据此渲染（触发器动作进下拉、命令变按钮、面板变数据表）。
 * 3. **宿主 API**（`PluginHost`）：插件能看到的全部能力。
 *
 * 一条必须说清楚的边界：**`node:vm` 不是安全沙箱**。
 * 我们的插件是用户自己放在 `data/plugins` 下的本地代码，和「装了个 npm 包」
 * 是同等级别的信任；沙箱的目的是**隔离与可控**（限定 API 面、便于统一
 * 清理定时器与订阅、插件崩溃不拖垮服务端），不是防恶意代码。
 * 因此清单里的 `permissions` 只用于**提示与展示**，不承担拦截职责 ——
 * 把它当成权限系统会让用户产生错误的安全预期。
 */

/** 当前宿主支持的插件 API 版本。插件清单里的 apiVersion 必须与之匹配 */
export const PLUGIN_API_VERSION = 1

/** 插件入口文件默认名；清单未写 main 时使用 */
export const PLUGIN_DEFAULT_MAIN = 'index.js'

/** 插件清单文件名 */
export const PLUGIN_MANIFEST_FILE = 'plugin.json'

/** 单个插件保留的日志条数（内存环形缓冲） */
export const PLUGIN_LOG_LIMIT = 200

/** 插件注册的触发动作单次执行的最长等待（毫秒）。超时只记日志，不阻断终端 */
export const PLUGIN_ACTION_TIMEOUT_MS = 5_000

/**
 * 插件声明的能力标签。
 * **仅作展示**：宿主不做拦截（见文件头说明），界面用它告诉用户
 * 「这个插件会碰会话输入 / 会发通知」，把判断权交回用户。
 */
export const PLUGIN_PERMISSIONS = ['session:read', 'session:write', 'notify'] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export const PLUGIN_PERMISSION_LABEL: Record<PluginPermission, string> = {
  'session:read': '读取会话列表与输出',
  'session:write': '向会话写入数据',
  notify: '发送通知',
}

/* ================================================================== */
/* 清单                                                                */
/* ================================================================== */

/** 声明式配置项 —— 宿主按 type 渲染表单，插件不必自己写设置界面 */
export type PluginConfigType = 'string' | 'number' | 'boolean'

export interface PluginConfigField {
  /** 配置键；插件通过 host.config[key] / host.getConfig(key) 读取 */
  key: string
  label: string
  type: PluginConfigType
  /** 缺省值；也是「用户没改过」时的生效值 */
  default: string | number | boolean
  description?: string
  /** type = number 时的取值范围 */
  min?: number
  max?: number
}

export interface PluginManifest {
  /** 插件唯一标识，建议与目录名一致；注册项 id 会以此为前提拼接 */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 必须等于 PLUGIN_API_VERSION 才允许加载 */
  apiVersion: number
  /** 入口文件，相对插件目录；默认 PLUGIN_DEFAULT_MAIN */
  main?: string
  /** 声明式配置 */
  config?: PluginConfigField[]
  permissions?: PluginPermission[]
}

/** 生效配置值（默认值 + 用户覆盖） */
export type PluginConfigValue = string | number | boolean
export type PluginConfigMap = Record<string, PluginConfigValue>

/* ================================================================== */
/* 注册项                                                              */
/* ================================================================== */

/** 插件注册的触发器动作 → 会成为触发器规则里 `type: 'plugin'` 的一个动作 */
export interface PluginTriggerActionDef {
  /**
   * 动作 id（插件内唯一）。
   * 最终在规则里以 `{ type: 'plugin', pluginId, actionId }` 出现 ——
   * 带 pluginId 而不是拼成一个长字符串，是为了插件被卸载/改名后
   * 规则能明确判断出「引用的插件动作已不存在」，而不是变成一个看不出所以然的字符串
   */
  id: string
  label: string
  description?: string
}

/** 插件注册的命令 → 面板上的按钮 */
export interface PluginCommandDef {
  id: string
  label: string
  description?: string
}

/** 插件注册的面板 → 面板里的一张数据表 */
export interface PluginPanelDef {
  id: string
  title: string
  description?: string
}

/** 注册项在规则/界面上的**全局**标识，便于日志与错误提示里一眼看出归属 */
export function pluginTriggerActionKey(pluginId: string, actionId: string): string {
  return `${pluginId}:${actionId}`
}

/* ================================================================== */
/* 事件                                                                */
/* ================================================================== */

/**
 * 插件可订阅的宿主事件。
 *
 * `session:output` 是**原样透传**的远端输出（可能每秒几百 KB）：
 * 订阅它的插件会拿到每一次写入。宿主不做节流，因为节流的粒度
 * 取决于插件想干什么（找关键字 vs 统计流量），替插件决定反而错。
 * 但插件作者要自己控制开销 —— 在回调里做正则全扫是会把终端拖慢的。
 */
export const PLUGIN_EVENT_NAMES = [
  'session:opened',
  'session:closed',
  'session:output',
] as const

export type PluginEventName = (typeof PLUGIN_EVENT_NAMES)[number]

export const PLUGIN_EVENT_LABEL: Record<PluginEventName, string> = {
  'session:opened': '会话已建立',
  'session:closed': '会话已关闭',
  'session:output': '会话输出',
}

/** 会话的最小视图：插件只认得这些字段，看不到配置与凭据 */
export interface PluginSessionInfo {
  terminalId: string
  /** 会话库节点 id；快速连接时为 undefined */
  sessionId?: string
  title: string
  protocol: string
  host: string
  port: number
  username: string
  /** 是否有浏览器客户端附着 */
  attached: boolean
  cols: number
  rows: number
  createdAt: string
}

export interface PluginSessionOpenedEvent {
  session: PluginSessionInfo
}

export interface PluginSessionClosedEvent {
  terminalId: string
  title: string
  reason: string
}

export interface PluginSessionOutputEvent {
  terminalId: string
  /** 本次写入的文本（已按会话编码解码） */
  text: string
}

/** 触发器动作被触发时传给插件的上下文 */
export interface PluginTriggerActionContext {
  ruleId: string
  ruleName: string
  /** 命中的整行（已剥离 ANSI 控制序列） */
  line: string
  /** 行内实际匹配到的片段 */
  matched: string
  /** 触发这条规则的会话；会话已关闭时为 undefined */
  session?: PluginSessionInfo
  /** 动作里填的额外参数（原样字符串，语义由插件定义） */
  params?: string
  /** 往触发规则的会话写回文本；会话不存在或已关闭时返回 false */
  send: (text: string) => boolean
  /** 给界面发一条通知（走全局事件通道，等同 host.notify） */
  notify: (title: string, body?: string, level?: PluginNotifyLevel) => void
  /** 写一条插件日志（可在插件面板看到） */
  log: (level: PluginLogLevel, message: string) => void
}

/** 命令与面板处理器的上下文（两者都只需要日志与通知） */
export interface PluginInvokeContext {
  notify: (title: string, body?: string, level?: PluginNotifyLevel) => void
  log: (level: PluginLogLevel, message: string) => void
  /** 发起调用的来源，便于插件区分「用户点的」与「触发器触发的」 */
  source: 'ui' | 'trigger'
}

/**
 * 面板数据表。
 *
 * 为什么不让插件直接返回 HTML：那等于把宿主页面交给插件渲染，
 * 样式、主题、安全都得再想一遍。改成「插件给数据、宿主来渲染」，
 * 插件作者只需关心表格内容，界面一致性也由宿主保证。
 */
export interface PluginPanelData {
  /** 不填则用面板定义的 title */
  title?: string
  /** 列名 */
  columns: string[]
  /** 行数据；单元格统一按字符串渲染 */
  rows: string[][]
  /** 插件自己补充的一句话说明（如「下次检查还有 12 秒」） */
  note?: string
  updatedAt: string
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 通知级别：debug 不在其列（调试信息属于日志，弹给用户看是打扰） */
export type PluginNotifyLevel = Exclude<PluginLogLevel, 'debug'>

export interface PluginLogEntry {
  at: string
  level: PluginLogLevel
  message: string
}

/* ================================================================== */
/* 宿主 API（插件作者写代码时看到的接口）                                */
/* ================================================================== */

/**
 * 注入插件沙箱的宿主 API。
 *
 * 说明：这是**类型定义**，让插件作者（以及 IDE）知道能用什么；
 * 运行时的对象由服务端 `plugin/sandbox.ts` 构造。两者必须一一对应 ——
 * 沙箱里没有的东西，这里也不该出现。
 */
export interface PluginHost {
  /** 本插件的清单（只读快照） */
  readonly manifest: Readonly<PluginManifest>
  /** 生效配置（默认值 + 用户覆盖） */
  readonly config: PluginConfigMap
  /** 取单项配置并断言类型；类型不符时返回 fallback 并记一条 warn 日志 */
  getConfig: <T extends PluginConfigValue>(key: string, fallback?: T) => T
  log: (level: PluginLogLevel, message: string) => void
  /**
   * 发一条通知：前端弹出 Toast；页面不在前台时由前端决定是否转桌面通知。
   *
   * `level` 让「插件告警」与「插件提示」在界面上能区分开（告警带色、留得更久）。
   * 不给 `debug`：调试信息属于日志，弹给用户看是打扰。
   */
  notify: (title: string, body?: string, level?: PluginNotifyLevel) => void
  registerTriggerAction: (
    def: PluginTriggerActionDef,
    handler: (ctx: PluginTriggerActionContext) => void | Promise<void>,
  ) => void
  /**
   * 注册命令。处理器返回字符串时会作为执行结果提示展示在界面上 ——
   * 比只写日志更直接（用户点了按钮就该看到一句反馈）。
   */
  registerCommand: (
    def: PluginCommandDef,
    handler: (ctx: PluginInvokeContext) => void | string | Promise<void | string>,
  ) => void
  /** 面板处理器会在前端打开面板时被调用，每次调用取最新数据 */
  registerPanel: (
    def: PluginPanelDef,
    handler: (ctx: PluginInvokeContext) => PluginPanelData | Promise<PluginPanelData>,
  ) => void
  /** 订阅宿主事件，返回退订函数（插件被卸载时会自动全部退订） */
  on: (event: PluginEventName, handler: (payload: unknown) => void) => () => void
  sessions: {
    list: () => PluginSessionInfo[]
    get: (terminalId: string) => PluginSessionInfo | undefined
    /** 向指定会话写入文本；返回是否写入成功 */
    send: (terminalId: string, text: string) => boolean
  }
}

/* ================================================================== */
/* REST 契约                                                           */
/* ================================================================== */

/** 插件运行状态 */
export type PluginState =
  /** 已加载并注册成功 */
  | 'ready'
  /** 已加载但抛错（清单非法、入口抛错都会走到这里） */
  | 'error'
  /** 被用户停用，或清单里没有该插件 */
  | 'disabled'

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 插件所在目录名（可能因目录改名与 id 不一致，故单列） */
  dir: string
  /** 入口文件绝对路径（排障用） */
  entry: string
  state: PluginState
  enabled: boolean
  /** state = error 时的原因 */
  error?: string
  loadedAt?: string
  /** 文件系统上的最后修改时间（用于提示「改了代码需要重载」） */
  mtime?: string
  apiVersion: number
  permissions: PluginPermission[]
  configFields: PluginConfigField[]
  /** 生效配置 */
  config: PluginConfigMap
  triggerActions: PluginTriggerActionDef[]
  commands: PluginCommandDef[]
  panels: PluginPanelDef[]
  /** 已订阅的事件名 */
  subscriptions: PluginEventName[]
  logs: PluginLogEntry[]
}

export interface ListPluginsResponse {
  plugins: PluginInfo[]
  /** 插件根目录（绝对路径），界面上展示便于用户放插件 */
  dir: string
  apiVersion: number
}

export interface UpdatePluginRequest {
  enabled?: boolean
  config?: PluginConfigMap
}

export interface PluginMutationResponse {
  plugin: PluginInfo
}

export interface RunPluginCommandResponse {
  ok: boolean
  /** 执行结果提示（处理器返回的字符串），界面直接展示 */
  message?: string
}

export interface PluginPanelResponse {
  panel: PluginPanelData
}

/** 插件清单的合法性结果（供 `/plugins/validate` 与前端提示共用） */
export interface PluginManifestCheck {
  valid: boolean
  errors: string[]
}
