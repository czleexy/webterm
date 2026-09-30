/**
 * 自动化服务：把触发器 / 宏 / 脚本 / 批量四块能力接到终端会话上。
 *
 * 这是阶段 6 的胶水层，承担四件事：
 * 1. **装配**：会话就绪后按「全局 + 会话级」取出生效的触发器规则，挂上输出观察者
 * 2. **托管运行**：脚本与宏的运行记录、日志缓冲、同一会话的互斥（避免两个脚本
 *    同时往一个 PTY 里写，读到的输出会互相污染）
 * 3. **宿主能力**：给脚本提供 SFTP 通道（借用宿主会话已登录的 SSH 连接）
 * 4. **生命周期**：会话关闭时摘掉观察者与引擎，不留悬挂的定时器
 *
 * 运行记录只放在内存里（最近 `SCRIPT_RUN_HISTORY` 条）：脚本日志是排障用的即时信息，
 * 落库反而会带来「日志表越长越大」的运维负担，而真正需要留痕的是阶段 7 的会话日志。
 */
import { randomUUID } from 'node:crypto'
import type { FileEntry, SFTPWrapper, Stats } from 'ssh2'
import type {
  AutomationCapabilities,
  RunBatchRequest,
  RunBatchResponse,
  RunMacroRequest,
  RunMacroResponse,
  RunScriptResponse,
  ServerControlMessage,
  ScriptLogLevel,
  ScriptRunRecord,
  TriggerStats,
} from '@webterm/shared'
import {
  BATCH_DEFAULT_CONCURRENCY,
  BATCH_MAX_CONCURRENCY,
  BATCH_MAX_TARGETS,
  MACRO_MAX_STEPS,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_GLOBAL_NAMES,
  SCRIPT_MAX_CODE_BYTES,
  SCRIPT_MAX_LOGS,
  SCRIPT_MAX_TIMEOUT_MS,
  SCRIPT_RUN_HISTORY,
  TRIGGER_DEFAULT_COOLDOWN_MS,
  TRIGGER_FLAG_CHARS,
  TRIGGER_MATCH_MODES,
  TRIGGER_MAX_COOLDOWN_MS,
  TRIGGER_MAX_RULES,
  protocolOf,
  targetUsername,
} from '@webterm/shared'
import type { LibraryStore } from '../db/library.js'
import type { TerminalManager } from '../terminal/terminal-manager.js'
import type { TerminalSession } from '../terminal/terminal-session.js'
import type { KnownHostsStore } from '../ssh/known-hosts.js'
import type { SessionResolver } from '../api/resolver.js'
import type { AutomationStore } from '../db/automation.js'
import { runBatch } from './batch-runner.js'
import { AutomationFailure } from './errors.js'
import { runMacro } from './macro.js'
import {
  runScript as executeScript,
  type ScriptDirEntry,
  type ScriptEngineDeps,
  type ScriptSessionView,
  type ScriptSftpHandle,
  type ScriptStatInfo,
} from './script-engine.js'
import { TriggerEngine, type TriggerScriptContext } from './triggers.js'

export interface AutomationLogger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface AutomationServiceOptions {
  store: AutomationStore
  library: LibraryStore
  terminals: TerminalManager
  knownHosts: KnownHostsStore
  sessionResolver: SessionResolver
  logger: AutomationLogger
  /**
   * 插件运行时（阶段 9）。只依赖「执行一个插件注册的触发器动作」这一个能力，
   * 因此这里声明成结构化接口而不是 import PluginRuntime：
   * 自动化子系统不必知道插件的目录、清单、沙箱是怎么一回事。
   */
  plugins?: PluginActionInvoker
}

/** 自动化子系统眼中「插件」的全部面貌 */
export interface PluginActionInvoker {
  invokeTriggerAction(input: {
    pluginId: string
    actionId: string
    params?: string
    ruleId: string
    ruleName: string
    line: string
    matched: string
    terminalId: string
  }): { ok: boolean; message: string }
}

export interface AttachSessionOptions {
  /** 会话库节点 id；快速连接（不经会话库）时为 undefined */
  sessionId?: string
  /** 会话记录里显式指定的启动脚本 */
  startupScripts?: string[]
}

export interface RunScriptInput {
  terminalId: string
  scriptId?: string
  code?: string
  timeoutMs?: number
  scriptName?: string
  params?: Record<string, unknown>
  /** 由触发器动作发起时携带命中上下文 */
  triggerContext?: TriggerScriptContext
  runId?: string
}

export class AutomationService {
  private readonly opts: AutomationServiceOptions
  /** 每个会话一个触发器引擎；值为引擎与它的退订函数 */
  private readonly engines = new Map<string, { engine: TriggerEngine; unsubscribe: () => void }>()
  /**
   * terminalId → 会话库节点 id。
   * 规则变更后要重建引擎，而重建时得知道「这条会话该用哪些会话级规则」——
   * 这个映射就是为此保留的（TerminalSession 本身并不认识会话库）。
   */
  private readonly sessionIds = new Map<string, string | undefined>()
  /** 脚本运行记录（内存，环形保留） */
  private readonly runs = new Map<string, ScriptRunRecord>()
  private readonly runOrder: string[] = []
  /** 正在跑自动化任务的会话：同一会话同时只允许一个 */
  private readonly busy = new Set<string>()
  private disposed = false

  constructor(opts: AutomationServiceOptions) {
    this.opts = opts
  }

  capabilities(): AutomationCapabilities {
    return {
      supportedTriggerMatchModes: [...TRIGGER_MATCH_MODES],
      supportedTriggerFlagChars: [...TRIGGER_FLAG_CHARS],
      maxTriggers: TRIGGER_MAX_RULES,
      maxMacroSteps: MACRO_MAX_STEPS,
      maxScriptCodeBytes: SCRIPT_MAX_CODE_BYTES,
      defaultScriptTimeoutMs: SCRIPT_DEFAULT_TIMEOUT_MS,
      maxScriptTimeoutMs: SCRIPT_MAX_TIMEOUT_MS,
      defaultBatchConcurrency: BATCH_DEFAULT_CONCURRENCY,
      maxBatchConcurrency: BATCH_MAX_CONCURRENCY,
      maxBatchTargets: BATCH_MAX_TARGETS,
      scriptGlobals: [...SCRIPT_GLOBAL_NAMES],
    }
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 会话就绪后装配自动化能力。
   * 由 REST 层在终端创建成功后调用 —— 此时 SSH 已可用，注入的输入不会丢。
   */
  attachSession(session: TerminalSession, options: AttachSessionOptions = {}): void {
    if (this.disposed) return

    this.sessionIds.set(session.id, options.sessionId)
    this.installTriggers(session, options.sessionId)

    const startupIds = this.resolveStartupScripts(options.startupScripts ?? [])
    if (startupIds.length > 0) {
      void this.runStartupScripts(session, startupIds)
    }
  }

  /**
   * 规则变更后重建全部存活会话的触发器引擎。
   *
   * 不做「每次匹配前先查库」的懒加载：逐行输出时查一次 SQLite 的代价
   * 与「改完规则即时生效」的收益不成比例。规则是低频写、高频读的东西，
   * 变更时重建一次最划算。
   */
  refreshAll(): void {
    if (this.disposed) return
    for (const [terminalId, sessionId] of this.sessionIds) {
      const session = this.opts.terminals.get(terminalId)
      if (!session || session.closed) {
        this.sessionIds.delete(terminalId)
        continue
      }
      this.uninstallTriggers(terminalId)
      this.installTriggers(session, sessionId)
    }
  }

  private installTriggers(session: TerminalSession, sessionId: string | undefined): void {
    const rules = this.opts.store.triggerRulesForSession(sessionId)
    if (rules.length === 0) return

    const engine = new TriggerEngine(rules, {
      logger: this.opts.logger,
      sendToRemote: (text) => session.sendToRemote(text),
      emitUi: (payload) => session.postControl({ t: 'trigger', ...payload }),
      resolveScript: (scriptId) => {
        const script = this.opts.store.getScript(scriptId)
        return script ? { id: script.id, name: script.name } : undefined
      },
      runScript: (script, context) => {
        // 触发器发起的脚本不阻塞输出处理；失败已通过 WS 与运行记录体现
        this.startScript({
          terminalId: session.id,
          scriptId: script.id,
          scriptName: script.name,
          triggerContext: context,
        })
      },
      // 插件动作：把 terminalId 在这里补上（引擎本身不必知道自己在哪个会话里跑）
      runPluginAction: (input) => {
        const plugins = this.opts.plugins
        if (!plugins) return { ok: false, message: '插件子系统未启用' }
        return plugins.invokeTriggerAction({ ...input, terminalId: session.id })
      },
    })
    const unsubscribe = session.subscribeOutput((text) => engine.feed(text))
    this.engines.set(session.id, { engine, unsubscribe })
  }

  private uninstallTriggers(terminalId: string): void {
    const entry = this.engines.get(terminalId)
    if (!entry) return
    entry.unsubscribe()
    entry.engine.dispose()
    this.engines.delete(terminalId)
  }

  /** 会话关闭时摘掉观察者（会话自己也会清空，这里负责引擎侧的定时器） */
  detachSession(terminalId: string): void {
    this.uninstallTriggers(terminalId)
    this.sessionIds.delete(terminalId)
  }

  /**
   * terminalId → 会话库节点 id。
   * 插件需要一个「会话属于会话库哪一条记录」的视图，而这份映射天然属于
   * 自动化子系统（它已经在维护了）；插件不另存一份，避免两处漂移。
   */
  sessionIdOf(terminalId: string): string | undefined {
    return this.sessionIds.get(terminalId)
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.engines.values()) {
      entry.unsubscribe()
      entry.engine.dispose()
    }
    this.engines.clear()
    this.sessionIds.clear()
    this.runs.clear()
    this.runOrder.length = 0
    this.busy.clear()
  }

  /* ------------------------------------------------------------------ */
  /* 触发器                                                              */
  /* ------------------------------------------------------------------ */

  /** 汇总各存活会话里规则的命中情况，供界面展示 */
  triggerStats(): TriggerStats[] {
    const merged = new Map<string, TriggerStats>()
    for (const { engine } of this.engines.values()) {
      for (const stat of engine.stats()) {
        const existing = merged.get(stat.ruleId)
        if (!existing) {
          merged.set(stat.ruleId, { ...stat })
          continue
        }
        existing.hitCount += stat.hitCount
        if (stat.lastFiredAt && (!existing.lastFiredAt || stat.lastFiredAt > existing.lastFiredAt)) {
          existing.lastFiredAt = stat.lastFiredAt
        }
        if (stat.lastError) existing.lastError = stat.lastError
      }
    }
    return [...merged.values()]
  }

  /* ------------------------------------------------------------------ */
  /* 脚本                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 启动一次脚本运行并立即返回；进度与结果通过终端 WebSocket 推送。
   *
   * 这里**同步**把「能不能跑」判完（终端在不在、脚本存不存在、会话是否已被占用）。
   * 若只靠 `runScript` 里的检查，「会话忙」会在 await 之后才暴露，而那时 REST
   * 早已返回 202 —— 用户看到「已接受」却什么也不会发生，日志里才有一行 debug。
   * 抛出去还能让触发器侧把原因记进 `lastError`（见 TriggerEngine.fire 的 try）。
   */
  startScript(input: RunScriptInput): RunScriptResponse {
    const session = this.opts.terminals.get(input.terminalId)
    if (!session) {
      throw new AutomationFailure('NOT_FOUND', `终端不存在或已关闭：${input.terminalId}`)
    }
    if (session.closed) {
      throw new AutomationFailure('SESSION_CLOSED', '会话已关闭，无法运行脚本')
    }
    // 顺手校验一次源码可用性（脚本 id 不存在 / 既没 id 也没 code）
    this.resolveScriptSource(input)
    this.assertNotBusy(session.id)

    const runId = input.runId ?? newRunId('run')
    void this.runScript({ ...input, runId }).catch((err: unknown) => {
      // 运行期失败已经写进运行记录并推给了前端，这里只避免未处理的 rejection
      this.opts.logger.debug({ runId, err: String(err) }, '脚本运行结束（失败）')
    })
    return { runId, accepted: true }
  }

  /** 同一会话同时只允许一个自动化任务 */
  private assertNotBusy(terminalId: string): void {
    if (!this.busy.has(terminalId)) return
    throw new AutomationFailure(
      'BUSY',
      '该会话上已有自动化任务在运行',
      '同一会话同时只允许一个脚本或宏 —— 两个任务同时往一个终端里写，读到的输出会互相污染。',
    )
  }

  /**
   * 运行脚本并等待结束。
   * 会话启动脚本用它（需要串行），触发器与 REST 用 `startScript`（不阻塞）。
   */
  async runScript(input: RunScriptInput): Promise<ScriptRunRecord> {
    const session = this.opts.terminals.get(input.terminalId)
    if (!session) {
      throw new AutomationFailure('NOT_FOUND', `终端不存在或已关闭：${input.terminalId}`)
    }
    if (session.closed) {
      throw new AutomationFailure('SESSION_CLOSED', '会话已关闭，无法运行脚本')
    }

    const resolved = this.resolveScriptSource(input)
    const runId = input.runId ?? newRunId('run')

    if (this.busy.has(session.id)) {
      this.assertNotBusy(session.id)
    }
    this.busy.add(session.id)

    const record: ScriptRunRecord = {
      runId,
      terminalId: session.id,
      terminalTitle: session.title,
      scriptName: resolved.name,
      phase: 'running',
      startedAt: new Date().toISOString(),
      logs: [],
    }
    if (input.scriptId) record.scriptId = input.scriptId
    this.rememberRun(record)

    const started = Date.now()
    this.post(session, {
      t: 'script',
      runId,
      scriptName: resolved.name,
      phase: 'start',
      at: new Date().toISOString(),
    })

    try {
      const outcome = await executeScript({
        runId,
        scriptName: resolved.name,
        code: resolved.code,
        timeoutMs: resolved.timeoutMs,
        session: this.sessionView(session),
        params: this.scriptParams(input),
        deps: this.scriptDeps(session, record),
      })

      record.phase = 'done'
      record.elapsedMs = Date.now() - started
      record.finishedAt = new Date().toISOString()
      if (outcome.result !== undefined) record.result = outcome.result

      this.post(session, {
        t: 'script',
        runId,
        scriptName: resolved.name,
        phase: 'done',
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        elapsedMs: record.elapsedMs,
        at: record.finishedAt,
      })
      return record
    } catch (err) {
      const failure =
        err instanceof AutomationFailure
          ? err
          : new AutomationFailure('RUNTIME', err instanceof Error ? err.message : String(err))

      record.phase = failure.code === 'TIMEOUT' ? 'timeout' : 'error'
      record.error = failure.hint ? `${failure.message}（${failure.hint}）` : failure.message
      record.elapsedMs = Date.now() - started
      record.finishedAt = new Date().toISOString()

      this.post(session, {
        t: 'script',
        runId,
        scriptName: resolved.name,
        phase: record.phase === 'timeout' ? 'timeout' : 'error',
        error: record.error,
        elapsedMs: record.elapsedMs,
        at: record.finishedAt,
      })
      throw failure
    } finally {
      this.busy.delete(session.id)
    }
  }

  /** 最近若干次运行记录，最新的在前 */
  scriptRuns(): ScriptRunRecord[] {
    return this.runOrder
      .map((id) => this.runs.get(id))
      .filter((r): r is ScriptRunRecord => r !== undefined)
      .reverse()
  }

  /* ------------------------------------------------------------------ */
  /* 宏                                                                  */
  /* ------------------------------------------------------------------ */

  runMacro(input: RunMacroRequest): RunMacroResponse {
    const session = this.opts.terminals.get(input.terminalId)
    if (!session) {
      throw new AutomationFailure('NOT_FOUND', `终端不存在或已关闭：${input.terminalId}`)
    }
    if (session.closed) {
      throw new AutomationFailure('SESSION_CLOSED', '会话已关闭，无法执行宏')
    }

    let name = input.macroName ?? '临时宏'
    let steps = input.steps
    if (input.macroId) {
      const macro = this.opts.store.getMacro(input.macroId)
      if (!macro) throw new AutomationFailure('NOT_FOUND', `宏不存在：${input.macroId}`)
      name = macro.name
      steps = macro.steps
    }
    if (!steps || steps.length === 0) {
      throw new AutomationFailure('INVALID', '宏没有可执行的步骤')
    }

    if (this.busy.has(session.id)) {
      throw new AutomationFailure(
        'BUSY',
        '该会话上已有自动化任务在运行',
        '同一会话同时只允许一个脚本或宏。',
      )
    }
    this.busy.add(session.id)

    const runId = newRunId('macro')
    void runMacro({
      runId,
      macroName: name,
      terminalId: session.id,
      steps,
      deps: {
        logger: this.opts.logger,
        subscribeOutput: (id, fn) => this.opts.terminals.get(id)?.subscribeOutput(fn),
        writeToRemote: (id, text) => this.opts.terminals.get(id)?.sendToRemote(text) ?? false,
        isAlive: (id) => {
          const target = this.opts.terminals.get(id)
          return target !== undefined && !target.closed
        },
        emit: (event) => {
          this.post(session, {
            t: 'macro',
            runId: event.runId,
            macroName: event.macroName,
            phase: event.phase,
            ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
            ...(event.stepCount !== undefined ? { stepCount: event.stepCount } : {}),
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
            at: event.at,
          })
        },
      },
    })
      .catch((err: unknown) => {
        this.opts.logger.debug({ runId, err: String(err) }, '宏执行结束（失败）')
      })
      .finally(() => {
        this.busy.delete(session.id)
      })

    return { runId, accepted: true }
  }

  /* ------------------------------------------------------------------ */
  /* 批量执行                                                            */
  /* ------------------------------------------------------------------ */

  runBatch(req: RunBatchRequest): Promise<RunBatchResponse> {
    return runBatch(req, {
      logger: this.opts.logger,
      knownHosts: this.opts.knownHosts,
      getTerminal: (terminalId) => {
        const session = this.opts.terminals.get(terminalId)
        if (!session) return undefined
        return {
          terminalId: session.id,
          client: session.sshClient,
          protocol: protocolOf(session.config),
          host: session.config.target.host,
          port: session.config.target.port,
          username: targetUsername(session.config),
          title: session.title,
          encoding: session.config.terminal.encoding,
        }
      },
      resolveSession: (sessionId) => {
        const { node, record } = this.opts.library.getSessionRecord(sessionId)
        const protocol = protocolOf(record)
        if (protocol === 'telnet') {
          // Telnet 会在 batch-runner 里被明确拒绝；这里给一个形状合法的占位 target，
          // 免得在「还没走到拒绝分支」时先因为类型缺字段炸掉
          return {
            sessionId,
            title: node.name,
            protocol,
            target: {
              host: record.host,
              port: record.port,
              username: '',
              authMethod: 'password' as const,
            },
            jumpChain: [],
            encoding: record.encoding,
          }
        }
        const plan = this.opts.sessionResolver.resolve(record)
        return {
          sessionId,
          title: node.name,
          protocol,
          target: plan.target,
          jumpChain: plan.jumpChain,
          encoding: record.encoding,
        }
      },
    })
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 解析要运行的脚本源码。
   * 保存的脚本取库里的定义；临时脚本直接用请求里的代码。
   */
  private resolveScriptSource(input: RunScriptInput): {
    name: string
    code: string
    timeoutMs: number
  } {
    if (input.scriptId) {
      const script = this.opts.store.getScript(input.scriptId)
      if (!script) throw new AutomationFailure('NOT_FOUND', `脚本不存在：${input.scriptId}`)
      return {
        name: input.scriptName ?? script.name,
        code: script.code,
        timeoutMs: clampTimeout(input.timeoutMs ?? script.timeoutMs),
      }
    }
    if (input.code === undefined) {
      throw new AutomationFailure('INVALID', '必须提供 scriptId 或 code 之一')
    }
    if (input.code.length > SCRIPT_MAX_CODE_BYTES) {
      throw new AutomationFailure('INVALID', `脚本代码超过 ${SCRIPT_MAX_CODE_BYTES} 字节上限`)
    }
    return {
      name: input.scriptName ?? '临时脚本',
      code: input.code,
      timeoutMs: clampTimeout(input.timeoutMs),
    }
  }

  /** 启动脚本 = 会话记录里显式指定的（保持用户排的顺序）+ 全局勾选「随会话运行」的 */
  private resolveStartupScripts(explicit: string[]): string[] {
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const id of explicit) {
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push(id)
    }
    for (const script of this.opts.store.listConnectScripts()) {
      if (seen.has(script.id)) continue
      seen.add(script.id)
      ordered.push(script.id)
    }
    return ordered
  }

  /** 串行执行启动脚本；任一条失败只记日志，绝不阻断登录 */
  private async runStartupScripts(session: TerminalSession, ids: string[]): Promise<void> {
    for (const scriptId of ids) {
      if (session.closed) return
      try {
        await this.runScript({ terminalId: session.id, scriptId })
      } catch (err) {
        this.opts.logger.warn(
          { terminalId: session.id, scriptId, err: String(err) },
          '随会话自动运行的脚本失败',
        )
      }
    }
  }

  private scriptParams(input: RunScriptInput): Record<string, unknown> {
    const params: Record<string, unknown> = { ...(input.params ?? {}) }
    if (input.triggerContext) params.trigger = input.triggerContext
    return params
  }

  private scriptDeps(session: TerminalSession, record: ScriptRunRecord): ScriptEngineDeps {
    return {
      logger: this.opts.logger,
      getSession: (id) => {
        const target = this.opts.terminals.get(id)
        return target && !target.closed ? this.sessionView(target) : undefined
      },
      subscribeOutput: (id, fn) => this.opts.terminals.get(id)?.subscribeOutput(fn),
      writeToRemote: (id, text) => this.opts.terminals.get(id)?.sendToRemote(text) ?? false,
      openSftp: (id) => this.openSftp(id),
      onLog: (entry) => {
        if (record.logs.length < SCRIPT_MAX_LOGS) {
          record.logs.push({
            level: entry.level,
            message: entry.message,
            ...(entry.line !== undefined ? { line: entry.line } : {}),
            at: new Date().toISOString(),
          })
        } else {
          record.droppedLogs = (record.droppedLogs ?? 0) + 1
        }

        this.post(session, {
          t: 'script',
          runId: record.runId,
          scriptName: record.scriptName,
          phase: 'log',
          level: entry.level as ScriptLogLevel,
          message: entry.message,
          at: new Date().toISOString(),
        })
      },
    }
  }

  /**
   * 打开宿主会话上的 SFTP 通道。
   *
   * 复用宿主的 SSH 连接而不是新建：老设备的 VTY 线路常常只有几条，
   * 一次脚本里读几个文件就多占一条连接，会直接把用户挡在设备外面。
   */
  private openSftp(terminalId: string): Promise<ScriptSftpHandle> {
    const session = this.opts.terminals.get(terminalId)
    const client = session?.sshClient
    if (!client) {
      return Promise.reject(
        new AutomationFailure('SESSION_CLOSED', '宿主会话已关闭，无法打开 SFTP 通道'),
      )
    }
    return new Promise<ScriptSftpHandle>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(new AutomationFailure('SFTP', `打开 SFTP 通道失败：${err.message}`))
          return
        }
        resolve(new SftpFacade(sftp))
      })
    })
  }

  private sessionView(session: TerminalSession): ScriptSessionView {
    return {
      terminalId: session.id,
      title: session.title,
      protocol: protocolOf(session.config),
      host: session.config.target.host,
      port: session.config.target.port,
      username: targetUsername(session.config),
    }
  }

  private post(session: TerminalSession, msg: ServerControlMessage): void {
    session.postControl(msg)
  }

  private rememberRun(record: ScriptRunRecord): void {
    this.runs.set(record.runId, record)
    this.runOrder.push(record.runId)
    while (this.runOrder.length > SCRIPT_RUN_HISTORY) {
      const oldest = this.runOrder.shift()
      if (oldest) this.runs.delete(oldest)
    }
  }
}

/* ------------------------------------------------------------------ */

/** 脚本可见的 SFTP 句柄：把 ssh2 的回调式 API 收成 Promise，并转成纯数据 */
class SftpFacade implements ScriptSftpHandle {
  constructor(private readonly sftp: SFTPWrapper) {}

  list(path: string): Promise<ScriptDirEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(path, (err, entries: FileEntry[]) => {
        if (err) {
          reject(toSftpFailure(err, path))
          return
        }
        resolve(
          entries.map((entry) => ({
            name: entry.filename,
            size: entry.attrs.size,
            isDirectory: isDirectoryEntry(entry.attrs),
            mtimeMs: entry.attrs.mtime * 1000,
          })),
        )
      })
    })
  }

  stat(path: string): Promise<ScriptStatInfo> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (err, stats: Stats) => {
        if (err) {
          reject(toSftpFailure(err, path))
          return
        }
        resolve({
          size: stats.size,
          isDirectory: isDirectoryEntry(stats),
          mtimeMs: stats.mtime * 1000,
          mode: stats.mode,
        })
      })
    })
  }

  read(path: string, encoding: string | null): Promise<string | Uint8Array> {
    return new Promise((resolve, reject) => {
      this.sftp.readFile(path, (err, data: Buffer) => {
        if (err) {
          reject(toSftpFailure(err, path))
          return
        }
        resolve(encoding === null ? new Uint8Array(data) : data.toString(encoding as BufferEncoding))
      })
    })
  }

  write(path: string, content: string | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
      this.sftp.writeFile(path, payload, (err) => {
        if (err) {
          reject(toSftpFailure(err, path))
          return
        }
        resolve()
      })
    })
  }

  /** 用 stat 判存在：readdir 只能看目录，而 exists 要对文件也成立 */
  exists(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (err) => {
        if (!err) {
          resolve(true)
          return
        }
        // 4 = SSH_FX_NO_SUCH_FILE：不存在是正常的否定结果，不是错误
        if ((err as { code?: number }).code === 4) {
          resolve(false)
          return
        }
        reject(toSftpFailure(err, path))
      })
    })
  }

  dispose(): void {
    try {
      this.sftp.end()
    } catch {
      /* 通道可能已关闭 */
    }
  }
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

/**
 * 用 mode 位判断目录，而不是 `attrs.isDirectory()`。
 * `readdir` 返回的 `Attributes` 并没有这个方法（只有 `stat` 的 `Stats` 有），
 * 统一走 mode 位可以省掉一处类型分支，也避免两个来源行为不一致。
 */
function isDirectoryEntry(entry: { mode: number }): boolean {
  return (entry.mode & S_IFMT) === S_IFDIR
}

function toSftpFailure(err: Error, path: string): AutomationFailure {
  return new AutomationFailure('SFTP', `SFTP 操作失败（${path}）：${err.message}`)
}

function newRunId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SCRIPT_DEFAULT_TIMEOUT_MS
  return Math.min(SCRIPT_MAX_TIMEOUT_MS, Math.max(1000, Math.trunc(value)))
}

/** 让外部（REST 层）能一眼看到默认冷却值，避免两处常量漂移 */
export const AUTOMATION_DEFAULT_COOLDOWN_MS = TRIGGER_DEFAULT_COOLDOWN_MS
export const AUTOMATION_MAX_COOLDOWN_MS = TRIGGER_MAX_COOLDOWN_MS
