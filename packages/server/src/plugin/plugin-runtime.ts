/**
 * 插件运行时：发现 → 加载 → 注册 → 调度 → 卸载。
 *
 * 四条贯穿始终的原则：
 *
 * 1. **插件是「把目录放进去就能用」的东西**。启用状态默认是开的，加载在进程
 *    启动时自动完成，注册项（触发器动作 / 命令 / 面板）直接出现在界面上。
 *    要求用户先去某页点一次「启用」，插件机制的可用性就废了一半。
 * 2. **一个插件坏了不能影响别人**。清单非法、入口抛错、动作超时、回调抛错，
 *    全部收敛成「这一个插件进入 error 状态并留下原因」，服务端与其它插件照常。
 * 3. **资源必须可回收**。定时器与事件订阅都由运行时登记，卸载时一次性清空 ——
 *    否则「停用插件」只是表面上停了，进程里还跑着它的 setInterval。
 * 4. **不补发历史事件**。插件加载时不会收到「已开着的那些会话」的 opened 事件：
 *    「已建立」是过去时，补发会让插件作者写日志时看到时间错乱。
 *    要看当前有哪些会话，用 `host.sessions.list()` —— 语义清晰，也不用猜。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_ACTION_TIMEOUT_MS,
  PLUGIN_API_VERSION,
  PLUGIN_EVENT_LABEL,
  PLUGIN_LOG_LIMIT,
  protocolOf,
  targetUsername,
  type PluginConfigMap,
  type PluginEventName,
  type PluginInfo,
  type PluginInvokeContext,
  type PluginLogEntry,
  type PluginLogLevel,
  type PluginManifest,
  type PluginPanelData,
  type PluginPanelDef,
  type PluginSessionInfo,
  type PluginState,
  type PluginTriggerActionContext,
  type RunPluginCommandResponse,
} from '@webterm/shared'
import type { TerminalSession } from '../terminal/terminal-session.js'
import type { TerminalManager } from '../terminal/terminal-manager.js'
import type { PluginStore } from '../db/plugins.js'
import type { EventHub } from '../events/hub.js'
import { PluginFailure } from './errors.js'
import { describeError, loadManifest, resolveConfig, coerceConfigValue } from './manifest.js'
import {
  createRegistrations,
  createSandbox,
  runPluginEntry,
  type PluginRegistrations,
  type Sandbox,
} from './sandbox.js'

export interface PluginRuntimeLogger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface PluginRuntimeOptions {
  /** 插件根目录（data/plugins 的绝对路径） */
  dir: string
  store: PluginStore
  hub: EventHub
  terminals: TerminalManager
  logger: PluginRuntimeLogger
  /** terminalId → 会话库节点 id；由自动化服务提供，避免两处各存一份映射 */
  resolveSessionId?: (terminalId: string) => string | undefined
}

/** 触发器动作调用的返回值：给触发器引擎用的人读结论（**不抛错**） */
export interface PluginActionResult {
  ok: boolean
  message: string
}

export interface InvokeTriggerActionInput {
  pluginId: string
  actionId: string
  ruleId: string
  ruleName: string
  line: string
  matched: string
  params?: string
  /** 命中规则所在会话；会话已关闭时为 undefined */
  terminalId?: string
}

interface LoadedPlugin {
  /** 目录名：id 未知时也用它兜底，保证「清单坏了」的插件照样能在界面上列出来 */
  dirName: string
  dirPath: string
  manifest: PluginManifest
  entry: string
  enabled: boolean
  state: PluginState
  error?: string
  loadedAt?: string
  /** 加载时记下的入口文件 mtime（ISO），与磁盘现值不同即「文件已改动」 */
  mtime?: string
  /** **与沙箱共享同一个对象引用**：热更新配置时直接改这里，插件立刻看到新值 */
  config: PluginConfigMap
  registrations: PluginRegistrations
  logs: PluginLogEntry[]
  sandbox?: Sandbox
  loaded: boolean
}

/** 面板数据的防护上限：插件返回十万行会把浏览器直接冻住 */
const PANEL_MAX_ROWS = 500
const PANEL_MAX_COLUMNS = 16
const PANEL_MAX_CELL_CHARS = 300

export class PluginRuntime {
  private readonly opts: PluginRuntimeOptions
  /** pluginId → 已发现/加载的插件 */
  private readonly plugins = new Map<string, LoadedPlugin>()
  /** 会话输出订阅：terminalId → 退订函数（全局一份，由 emit 扇出给订阅的插件） */
  private readonly outputSubscriptions = new Map<string, () => void>()
  private readonly disposers: Array<() => void> = []
  private disposed = false

  constructor(opts: PluginRuntimeOptions) {
    this.opts = opts
  }

  get dir(): string {
    return this.opts.dir
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /** 扫描目录并加载全部启用的插件。进程启动时调用一次 */
  init(): void {
    if (this.disposed) return
    this.disposers.push(this.opts.terminals.onSessionCreated((session) => this.onSessionOpened(session)))
    this.disposers.push(
      this.opts.terminals.onSessionClosed((session, reason) => this.onSessionClosed(session, reason)),
    )
    this.scan()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
    for (const plugin of this.plugins.values()) this.unload(plugin)
    this.plugins.clear()
    for (const unsubscribe of this.outputSubscriptions.values()) unsubscribe()
    this.outputSubscriptions.clear()
  }

  /* ------------------------------------------------------------------ */
  /* 查询                                                               */
  /* ------------------------------------------------------------------ */

  list(): PluginInfo[] {
    return [...this.plugins.values()]
      .map((plugin) => this.toInfo(plugin))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  get(pluginId: string): PluginInfo | undefined {
    const plugin = this.plugins.get(pluginId)
    return plugin ? this.toInfo(plugin) : undefined
  }

  /** 供前端下拉使用：全部「已就绪」插件注册的触发器动作，附带来源插件名 */
  readyTriggerActions(): Array<{
    pluginId: string
    pluginName: string
    actionId: string
    label: string
    description?: string
  }> {
    const out: Array<{
      pluginId: string
      pluginName: string
      actionId: string
      label: string
      description?: string
    }> = []
    for (const plugin of this.plugins.values()) {
      if (plugin.state !== 'ready') continue
      for (const registered of plugin.registrations.triggerActions.values()) {
        out.push({
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          actionId: registered.def.id,
          label: registered.def.label,
          ...(registered.def.description ? { description: registered.def.description } : {}),
        })
      }
    }
    return out
  }

  /* ------------------------------------------------------------------ */
  /* 变更操作                                                            */
  /* ------------------------------------------------------------------ */

  /** 重新扫描目录：新增的加载、消失的移除。用户往目录里丢了新插件后用它 */
  rescan(): PluginInfo[] {
    this.scan()
    this.opts.hub.broadcast({ t: 'plugins-changed', reason: 'discovered' })
    return this.list()
  }

  setEnabled(pluginId: string, enabled: boolean): PluginInfo {
    const plugin = this.require(pluginId)
    this.opts.store.setEnabled(plugin.manifest.id, enabled)
    const next = this.loadInto(plugin.dirName, plugin.dirPath)
    this.replace(next)
    this.log(
      next,
      'info',
      enabled ? '插件已启用' : '插件已停用（注册项已从界面移除）',
    )
    this.opts.hub.broadcast({ t: 'plugins-changed', reason: enabled ? 'enabled' : 'disabled' })
    return this.toInfo(next)
  }

  /**
   * 更新配置：**热更新，不重载插件**。
   *
   * 重载更简单，但会把插件的内存状态一起清掉 —— 一个「心跳监视器」被改个
   * 检查间隔就丢掉全部会话的存活记录，是不能接受的。所以这里就地改
   * `plugin.config`（沙箱与运行时共享同一对象引用），插件下一次读取就是新值。
   * 代价要说清楚：**插件如果在加载时把配置抄进了局部常量，就不会跟随更新** ——
   * 约定是「按需读取 host.config / host.getConfig()」。
   */
  updateConfig(pluginId: string, overrides: PluginConfigMap): PluginInfo {
    const plugin = this.require(pluginId)
    // 先按清单规范化再落库：越界值钳到范围内、清单里没有的键直接丢掉。
    // 否则库里会留下「用户填过 9999」这种永远不会生效的残留 ——
    // 下次有人在界面上把 max 调大，它会突然变成 9999 生效，没人能解释为什么
    const normalized = normalizeOverrides(plugin.manifest, overrides)
    const stored = this.opts.store.setConfig(plugin.manifest.id, normalized)
    this.applyConfig(plugin, stored.config)
    this.log(plugin, 'info', '配置已更新（插件无需重载即生效）')
    this.opts.hub.broadcast({ t: 'plugins-changed', reason: 'reloaded' })
    return this.toInfo(plugin)
  }

  /** 重载：重新读清单与入口。改了插件代码（或换了清单）之后用它 */
  reload(pluginId: string): PluginInfo {
    const plugin = this.require(pluginId)
    const next = this.loadInto(plugin.dirName, plugin.dirPath)
    this.replace(next)
    this.opts.hub.broadcast({ t: 'plugins-changed', reason: 'reloaded' })
    return this.toInfo(next)
  }

  reloadAll(): PluginInfo[] {
    return this.rescan()
  }

  /* ------------------------------------------------------------------ */
  /* 命令与面板                                                          */
  /* ------------------------------------------------------------------ */

  async runCommand(pluginId: string, commandId: string): Promise<RunPluginCommandResponse> {
    const plugin = this.requireReady(pluginId, '命令')
    const registered = plugin.registrations.commands.get(commandId)
    if (!registered) {
      throw new PluginFailure('NOT_FOUND', `命令不存在：${commandId}`)
    }

    const ctx = this.invokeContext(plugin)
    try {
      const result = await this.withTimeout(
        Promise.resolve(registered.handler(ctx)),
        `命令「${registered.def.label}」`,
        plugin,
      )
      return {
        ok: true,
        message: typeof result === 'string' && result.trim() !== '' ? result : `已执行「${registered.def.label}」`,
      }
    } catch (err) {
      const message = describeError(err)
      this.log(plugin, 'error', `命令「${registered.def.label}」执行失败：${message}`)
      // 命令处理器抛错不是「接口错误」而是「业务结果」：返回 200 + ok:false，
      // 界面据此弹一条红字提示。抛 500 会让前端只能显示「服务器错误」，信息更少
      return { ok: false, message }
    }
  }

  async getPanel(pluginId: string, panelId: string): Promise<PluginPanelData> {
    const plugin = this.requireReady(pluginId, '面板')
    const registered = plugin.registrations.panels.get(panelId)
    if (!registered) {
      throw new PluginFailure('NOT_FOUND', `面板不存在：${panelId}`)
    }

    const ctx = this.invokeContext(plugin)
    try {
      const raw = await this.withTimeout(
        Promise.resolve(registered.handler(ctx)),
        `面板「${registered.def.title}」`,
        plugin,
      )
      return normalizePanel(raw, registered.def)
    } catch (err) {
      const message = describeError(err)
      this.log(plugin, 'error', `面板「${registered.def.title}」取数失败：${message}`)
      // 面板取不到数不该让整个插件面板变成错误页：返回一张空表 + 原因说明
      return {
        title: registered.def.title,
        columns: [],
        rows: [],
        note: `插件返回失败：${message}`,
        updatedAt: new Date().toISOString(),
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 触发器动作                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 由触发器引擎调用。**同步返回**，绝不阻塞终端输出路径：
   * 插件处理器可能是异步的（甚至写了 await 网络请求），而这一路径在
   * 「远端每输出一行」的链路上 —— 在这里等插件，等于让插件决定终端吞吐。
   * 所以：同步抛错当场返回失败原因，异步结果（成功或失败）走插件日志与通知。
   */
  invokeTriggerAction(input: InvokeTriggerActionInput): PluginActionResult {
    const plugin = this.plugins.get(input.pluginId)
    if (!plugin) return { ok: false, message: `插件不存在：${input.pluginId}` }
    if (plugin.state !== 'ready') {
      return { ok: false, message: `插件「${plugin.manifest.name}」当前不可用（${stateLabel(plugin.state)}）` }
    }

    const registered = plugin.registrations.triggerActions.get(input.actionId)
    if (!registered) {
      return {
        ok: false,
        message: `插件动作不存在：${input.pluginId}:${input.actionId}（插件可能已更新或改名）`,
      }
    }

    const session = input.terminalId ? this.opts.terminals.get(input.terminalId) : undefined
    const def = registered.def
    const ctx: PluginTriggerActionContext = {
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      line: input.line,
      matched: input.matched,
      ...(session ? { session: this.sessionInfo(session) } : {}),
      ...(input.params !== undefined ? { params: input.params } : {}),
      send: (text) => (session && !session.closed ? session.sendToRemote(text) : false),
      notify: (title, body) =>
        this.notify(plugin, 'info', String(title), body === undefined ? '' : String(body)),
      log: (level, message) => this.log(plugin, level, message),
    }

    try {
      const result = registered.handler(ctx) as unknown
      if (isPromise(result)) {
        this.observeAsync(plugin, `触发器动作「${def.label}」`, result)
      }
    } catch (err) {
      const message = describeError(err)
      this.log(plugin, 'error', `触发器动作「${def.label}」抛错：${message}`)
      return { ok: false, message }
    }

    return { ok: true, message: `插件「${plugin.manifest.name}」：${def.label}` }
  }

  /* ================================================================== */
  /* 内部：发现 / 加载 / 卸载                                            */
  /* ================================================================== */

  private scan(): void {
    const dirNames = listPluginDirs(this.opts.dir)
    const seen = new Set<string>()

    for (const dirName of dirNames) {
      const next = this.loadInto(dirName, path.join(this.opts.dir, dirName))
      if (seen.has(next.manifest.id)) {
        // id 冲突：后面的目录覆盖前面的，并明确记一条日志 ——
        // 静默丢掉一个插件会让作者完全摸不着头脑
        this.log(next, 'warn', `插件 id 与另一个目录重复，已被后出现的目录覆盖：${next.manifest.id}`)
      }
      seen.add(next.manifest.id)
      this.replace(next)
    }

    for (const [id, plugin] of [...this.plugins]) {
      if (!seen.has(id)) {
        this.unload(plugin)
        this.plugins.delete(id)
      }
    }

    this.syncOutputSubscriptions()
  }

  /**
   * 加载单个插件目录。**永不抛错** —— 任何失败都变成 state='error' 的记录，
   * 这样「清单写错了」这件事在界面上是可见的，而不是一个空的插件列表。
   */
  private loadInto(dirName: string, dirPath: string): LoadedPlugin {
    const base: LoadedPlugin = {
      dirName,
      dirPath,
      manifest: fallbackManifest(dirName),
      entry: '',
      enabled: false,
      state: 'error',
      config: {},
      registrations: createRegistrations(),
      logs: [],
      loaded: false,
    }

    let manifest: PluginManifest
    let entry: string
    try {
      const loaded = loadManifest(dirPath)
      manifest = loaded.manifest
      entry = loaded.entry
    } catch (err) {
      base.error = describeError(err)
      this.log(base, 'error', `插件清单不合法：${base.error ?? ''}`)
      return base
    }

    const plugin: LoadedPlugin = {
      ...base,
      manifest,
      entry,
      mtime: fileMtime(entry),
    }

    const stored = this.opts.store.getOrDefault(manifest.id)
    plugin.enabled = stored.enabled
    plugin.config = resolveConfig(manifest, stored.config)

    if (!stored.enabled) {
      plugin.state = 'disabled'
      this.log(plugin, 'info', '插件已被用户停用，未加载')
      return plugin
    }

    try {
      const sandbox = createSandbox({
        manifest,
        // 传引用而不是副本：配置热更新要靠这个共同引用透传进沙箱
        config: plugin.config,
        registrations: plugin.registrations,
        log: (level, message) => this.log(plugin, level, message),
        notify: (level, title, body) => this.notify(plugin, level, title, body),
        sessions: {
          list: () => this.opts.terminals.all().map((session) => this.sessionInfo(session)),
          get: (terminalId) => {
            const session = this.opts.terminals.get(terminalId)
            return session ? this.sessionInfo(session) : undefined
          },
          send: (terminalId, text) => {
            const session = this.opts.terminals.get(terminalId)
            return session && !session.closed ? session.sendToRemote(text) : false
          },
        },
      })
      runPluginEntry(entry, sandbox)
      plugin.sandbox = sandbox
      plugin.state = 'ready'
      plugin.loaded = true
      plugin.loadedAt = new Date().toISOString()
      this.log(
        plugin,
        'info',
        `插件已加载 v${manifest.version}　触发器动作 ${plugin.registrations.triggerActions.size} 个 · ` +
          `命令 ${plugin.registrations.commands.size} 个 · 面板 ${plugin.registrations.panels.size} 个 · ` +
          `订阅 ${[...plugin.registrations.subscriptions.keys()].map((e) => PLUGIN_EVENT_LABEL[e]).join('、') || '无'}`,
      )
    } catch (err) {
      plugin.state = 'error'
      plugin.error = describeError(err)
      this.log(plugin, 'error', `插件加载失败：${plugin.error}`)
      // 已经注册了一半的定时器/订阅要清掉，避免「加载失败但还在跑」
      this.releaseResources(plugin)
    }

    return plugin
  }

  /** 把新加载的记录放进注册表；同 id 的旧记录先卸载 */
  private replace(next: LoadedPlugin): void {
    const existing = this.plugins.get(next.manifest.id)
    if (existing && existing !== next) this.unload(existing)
    this.plugins.set(next.manifest.id, next)
    // 卸载会顺手把「已没人要」的输出订阅退掉，因此这里必须重新同步一遍 ——
    // 否则「停用再启用」或「重载」之后，插件的 session:output 就永远收不到了
    // （会话事件靠钩子扇出不受影响，只有输出订阅是懒建的，容易漏）
    this.syncOutputSubscriptions()
  }

  /** 卸载：清定时器、退订事件、丢弃注册表。**不改变 map** */
  private unload(plugin: LoadedPlugin): void {
    this.releaseResources(plugin)
    plugin.sandbox = undefined
    plugin.loaded = false
    plugin.state = plugin.enabled ? 'error' : 'disabled'
  }

  private releaseResources(plugin: LoadedPlugin): void {
    for (const handlers of plugin.registrations.subscriptions.values()) handlers.clear()
    plugin.registrations.subscriptions.clear()
    for (const timer of plugin.registrations.timeouts) clearTimeout(timer)
    plugin.registrations.timeouts.clear()
    for (const timer of plugin.registrations.intervals) clearInterval(timer)
    plugin.registrations.intervals.clear()
    plugin.registrations.triggerActions.clear()
    plugin.registrations.commands.clear()
    plugin.registrations.panels.clear()
    this.dropOutputSubscriptionsIfUnused()
  }

  private applyConfig(plugin: LoadedPlugin, overrides: PluginConfigMap): void {
    const next = resolveConfig(plugin.manifest, overrides)
    // 清单里删掉的配置项要真的消失，否则插件会一直读到上一次的残留值
    for (const key of Object.keys(plugin.config)) {
      if (!(key in next)) delete plugin.config[key]
    }
    Object.assign(plugin.config, next)
  }

  /* ================================================================== */
  /* 内部：会话事件扇出                                                  */
  /* ================================================================== */

  private onSessionOpened(session: TerminalSession): void {
    if (this.disposed) return
    this.ensureOutputSubscription(session)
    this.emit('session:opened', { session: this.sessionInfo(session) })
  }

  private onSessionClosed(session: TerminalSession, reason: string): void {
    if (this.disposed) return
    this.dropOutputSubscription(session.id)
    this.emit('session:closed', { terminalId: session.id, title: session.title, reason })
  }

  /** 逐个插件分发事件；一个插件的处理器抛错只记在它自己的日志里 */
  private emit(event: PluginEventName, payload: unknown): void {
    for (const plugin of [...this.plugins.values()]) {
      if (plugin.state !== 'ready') continue
      const handlers = plugin.registrations.subscriptions.get(event)
      if (!handlers || handlers.size === 0) continue
      for (const handler of [...handlers]) {
        try {
          handler(payload)
        } catch (err) {
          this.log(plugin, 'error', `事件「${PLUGIN_EVENT_LABEL[event]}」的处理器抛错：${describeError(err)}`)
        }
      }
    }
  }

  private wantsOutput(): boolean {
    for (const plugin of this.plugins.values()) {
      if (plugin.state !== 'ready') continue
      if ((plugin.registrations.subscriptions.get('session:output')?.size ?? 0) > 0) return true
    }
    return false
  }

  /**
   * 会话输出订阅是**全局一份**、由 emit 扇出的：
   * 若按「每插件每会话」订阅，10 个插件 × 20 个会话就是 200 个订阅，
   * 每次输出走 200 次函数调用，而其中绝大多数插件对这个事件毫无兴趣。
   */
  private syncOutputSubscriptions(): void {
    if (this.wantsOutput()) {
      for (const session of this.opts.terminals.all()) this.ensureOutputSubscription(session)
      return
    }
    for (const unsubscribe of this.outputSubscriptions.values()) unsubscribe()
    this.outputSubscriptions.clear()
  }

  private ensureOutputSubscription(session: TerminalSession): void {
    if (this.outputSubscriptions.has(session.id)) return
    if (!this.wantsOutput()) return
    const unsubscribe = session.subscribeOutput((text) => {
      this.emit('session:output', { terminalId: session.id, text })
    })
    this.outputSubscriptions.set(session.id, unsubscribe)
  }

  private dropOutputSubscription(terminalId: string): void {
    const unsubscribe = this.outputSubscriptions.get(terminalId)
    if (unsubscribe) {
      unsubscribe()
      this.outputSubscriptions.delete(terminalId)
    }
  }

  private dropOutputSubscriptionsIfUnused(): void {
    if (!this.wantsOutput()) {
      for (const unsubscribe of this.outputSubscriptions.values()) unsubscribe()
      this.outputSubscriptions.clear()
    }
  }

  /* ================================================================== */
  /* 内部：工具                                                          */
  /* ================================================================== */

  private sessionInfo(session: TerminalSession): PluginSessionInfo {
    const sessionId = this.opts.resolveSessionId?.(session.id)
    return {
      terminalId: session.id,
      ...(sessionId ? { sessionId } : {}),
      title: session.title,
      protocol: protocolOf(session.config),
      host: session.config.target.host,
      port: session.config.target.port,
      username: targetUsername(session.config),
      attached: session.attached,
      cols: session.dimensions.cols,
      rows: session.dimensions.rows,
      createdAt: session.createdAt.toISOString(),
    }
  }

  private invokeContext(plugin: LoadedPlugin): PluginInvokeContext {
    return {
      notify: (title, body) => this.notify(plugin, 'info', String(title), body ?? ''),
      log: (level, message) => this.log(plugin, level, message),
      source: 'ui',
    }
  }

  private require(pluginId: string): LoadedPlugin {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new PluginFailure(
        'NOT_FOUND',
        `插件不存在：${pluginId}`,
        `插件目录：${this.opts.dir}　可用插件请刷新插件面板查看。`,
      )
    }
    return plugin
  }

  private requireReady(pluginId: string, what: string): LoadedPlugin {
    const plugin = this.require(pluginId)
    if (plugin.state !== 'ready') {
      throw new PluginFailure(
        'UNAVAILABLE',
        `插件「${plugin.manifest.name}」当前不可用（${stateLabel(plugin.state)}），无法执行${what}`,
        plugin.error ?? (plugin.state === 'disabled' ? '请先在插件面板中启用它。' : undefined),
      )
    }
    return plugin
  }

  /** 等一个可能挂很久的处理器；超时按失败处理，不让 HTTP 请求陪着一起挂 */
  private async withTimeout<T>(promise: Promise<T>, what: string, plugin: LoadedPlugin): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`超过 ${PLUGIN_ACTION_TIMEOUT_MS}ms 未返回`)),
            PLUGIN_ACTION_TIMEOUT_MS,
          )
          timer.unref?.()
        }),
      ])
    } catch (err) {
      const detail = describeError(err)
      if (detail.includes('未返回')) this.log(plugin, 'warn', `${what}${detail}`)
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 异步处理器：结果不影响调用方，失败记日志 + 发通知（用户不盯着日志也能知道） */
  private observeAsync(plugin: LoadedPlugin, what: string, promise: Promise<unknown>): void {
    void this.withTimeout(promise, what, plugin).catch((err) => {
      const message = describeError(err)
      this.log(plugin, 'error', `${what}执行失败：${message}`)
      this.notify(plugin, 'error', `${plugin.manifest.name}：${what}失败`, message)
    })
  }

  private notify(
    plugin: LoadedPlugin,
    level: 'info' | 'warn' | 'error',
    title: string,
    body: string,
  ): void {
    this.log(plugin, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', `通知：${title}${body ? ` — ${body}` : ''}`)
    this.opts.hub.broadcast({
      t: 'plugin-notify',
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
      title,
      body,
      level,
      at: new Date().toISOString(),
    })
  }

  private log(plugin: LoadedPlugin, level: PluginLogLevel, message: string): void {
    plugin.logs.push({ at: new Date().toISOString(), level, message })
    if (plugin.logs.length > PLUGIN_LOG_LIMIT) {
      plugin.logs.splice(0, plugin.logs.length - PLUGIN_LOG_LIMIT)
    }
    const fields = { pluginId: plugin.manifest.id, plugin: plugin.manifest.name }
    if (level === 'error') this.opts.logger.error(fields, message)
    else if (level === 'warn') this.opts.logger.warn(fields, message)
    else if (level === 'debug') this.opts.logger.debug(fields, message)
    else this.opts.logger.info(fields, message)
  }

  /** 组装给 REST 层的完整视图 */
  private toInfo(plugin: LoadedPlugin): PluginInfo {
    const mtime = (plugin.entry ? fileMtime(plugin.entry) : undefined) ?? plugin.mtime
    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
      ...(plugin.manifest.author ? { author: plugin.manifest.author } : {}),
      dir: plugin.dirName,
      entry: plugin.entry,
      state: plugin.state,
      enabled: plugin.enabled,
      ...(plugin.error ? { error: plugin.error } : {}),
      ...(plugin.loadedAt ? { loadedAt: plugin.loadedAt } : {}),
      ...(mtime ? { mtime } : {}),
      apiVersion: plugin.manifest.apiVersion,
      permissions: plugin.manifest.permissions ?? [],
      configFields: plugin.manifest.config ?? [],
      config: { ...plugin.config },
      triggerActions: [...plugin.registrations.triggerActions.values()].map((r) => r.def),
      commands: [...plugin.registrations.commands.values()].map((r) => r.def),
      panels: [...plugin.registrations.panels.values()].map((r) => r.def),
      subscriptions: [...plugin.registrations.subscriptions.entries()]
        .filter(([, handlers]) => handlers.size > 0)
        .map(([name]) => name),
      logs: [...plugin.logs],
    }
  }
}

/* ==================================================================== */
/* 纯函数工具                                                             */
/* ==================================================================== */

/** 列出插件根目录下的候选插件目录；跳过隐藏目录与 node_modules */
export function listPluginDirs(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')
      .sort()
  } catch {
    return []
  }
}

/** 清单读不出来时的兜底：至少让这个目录在界面上出现，并带上「清单不合法」的原因 */
function fallbackManifest(dirName: string): PluginManifest {
  return {
    id: dirName,
    name: dirName,
    version: '—',
    apiVersion: PLUGIN_API_VERSION,
  }
}

function fileMtime(file: string): string | undefined {
  try {
    return new Date(statSync(file).mtimeMs).toISOString()
  } catch {
    return undefined
  }
}

/** 按清单声明把用户提交的覆盖值规范化（类型转换 + 范围钳制 + 丢弃未知键） */
function normalizeOverrides(manifest: PluginManifest, overrides: PluginConfigMap): PluginConfigMap {
  const normalized: PluginConfigMap = {}
  for (const field of manifest.config ?? []) {
    const raw = overrides[field.key]
    if (raw === undefined) continue
    const value = coerceConfigValue(field.type, raw, field.min, field.max)
    if (value !== undefined) normalized[field.key] = value
  }
  return normalized
}

function stateLabel(state: PluginState): string {
  if (state === 'ready') return '已就绪'
  if (state === 'disabled') return '已停用'
  return '加载失败'
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** 校验并夹紧插件返回的面板数据；形状不对时返回一张带说明的空表 */
function normalizePanel(raw: unknown, def: PluginPanelDef): PluginPanelData {
  const updatedAt = new Date().toISOString()
  if (!raw || typeof raw !== 'object') {
    return { title: def.title, columns: [], rows: [], note: '插件未返回数据', updatedAt }
  }

  const data = raw as Partial<PluginPanelData>
  const columns = Array.isArray(data.columns)
    ? data.columns.slice(0, PANEL_MAX_COLUMNS).map((c) => String(c).slice(0, 64))
    : []
  const rows: string[][] = []
  if (Array.isArray(data.rows)) {
    for (const row of data.rows.slice(0, PANEL_MAX_ROWS)) {
      if (!Array.isArray(row)) continue
      rows.push(row.slice(0, PANEL_MAX_COLUMNS).map((cell) => String(cell ?? '').slice(0, PANEL_MAX_CELL_CHARS)))
    }
  }

  const note = typeof data.note === 'string' ? data.note.slice(0, 200) : undefined
  const truncated = Array.isArray(data.rows) && data.rows.length > PANEL_MAX_ROWS
  // 截断提示要盖过插件自己的 note：数据不完整是用户必须知道的第一件事
  const finalNote = truncated ? `数据超过 ${PANEL_MAX_ROWS} 行，已截断（请让插件先过滤）` : note
  return {
    title: typeof data.title === 'string' && data.title.trim() !== '' ? data.title.slice(0, 64) : def.title,
    columns,
    rows,
    ...(finalNote ? { note: finalNote } : {}),
    updatedAt,
  }
}
