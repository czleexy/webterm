/**
 * 插件沙箱：用 `node:vm` 造一个只带宿主 API 的执行环境，把入口脚本跑起来。
 *
 * 先说要紧的一句话：**这不是安全沙箱。**
 * `node:vm` 的官方文档写得很清楚，它不提供隔离保证 —— 上下文里的代码
 * 可以通过 `this.constructor.constructor('return process')()` 一类手段
 * 拿回真实全局。我们的插件是用户自己放在 `data/plugins` 下的本地代码，
 * 信任级别等同「装了个 npm 包」，所以这里的目标不是防恶意代码，而是：
 *
 * 1. **限定 API 面**：插件只能看到我们注入的东西（没有 require / process /
 *    文件系统），绝大多数情况下「它做不了不该做的事」，而不是「我们不能让它做」。
 * 2. **可控的生命周期**：定时器与事件订阅都由宿主登记，卸载插件时可以一次性
 *    清干净 —— 否则一个 `setInterval` 就能让 Node 进程退不出去。
 * 3. **崩溃隔离**：入口抛错只让这一个插件进入 error 状态，服务端与其它插件照常。
 *
 * 因此清单里的 `permissions` 只用于界面提示，**不承担拦截职责** ——
 * 假装有权限系统会让用户产生错误的安全预期，那比没有更糟。
 */
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import type {
  PluginCommandDef,
  PluginConfigMap,
  PluginConfigValue,
  PluginEventName,
  PluginHost,
  PluginManifest,
  PluginPanelData,
  PluginPanelDef,
  PluginLogLevel,
  PluginNotifyLevel,
  PluginSessionInfo,
  PluginTriggerActionDef,
  PluginTriggerActionContext,
  PluginInvokeContext,
} from '@webterm/shared'
import { PluginFailure } from './errors.js'
import { describeError } from './manifest.js'

export type TriggerActionHandler = (
  ctx: PluginTriggerActionContext,
) => void | Promise<void>
export type CommandHandler = (
  ctx: PluginInvokeContext,
) => void | string | Promise<void | string>
export type PanelHandler = (ctx: PluginInvokeContext) => PluginPanelData | Promise<PluginPanelData>
export type EventHandler = (payload: unknown) => void

export interface RegisteredTriggerAction {
  def: PluginTriggerActionDef
  handler: TriggerActionHandler
}
export interface RegisteredCommand {
  def: PluginCommandDef
  handler: CommandHandler
}
export interface RegisteredPanel {
  def: PluginPanelDef
  handler: PanelHandler
}

/**
 * 一个插件的全部注册结果与需要清理的资源。
 * 由运行时持有，卸载时按顺序清理：退订事件 → 清定时器 → 丢弃注册表。
 */
export interface PluginRegistrations {
  triggerActions: Map<string, RegisteredTriggerAction>
  commands: Map<string, RegisteredCommand>
  panels: Map<string, RegisteredPanel>
  subscriptions: Map<PluginEventName, Set<EventHandler>>
  /** 插件注册的定时器（已包装过，便于统一清除） */
  timeouts: Set<NodeJS.Timeout>
  intervals: Set<NodeJS.Timeout>
}

export function createRegistrations(): PluginRegistrations {
  return {
    triggerActions: new Map(),
    commands: new Map(),
    panels: new Map(),
    subscriptions: new Map(),
    timeouts: new Set(),
    intervals: new Set(),
  }
}

export interface SandboxDeps {
  manifest: PluginManifest
  config: PluginConfigMap
  registrations: PluginRegistrations
  /** 插件日志（进环形缓冲 + 服务端日志） */
  log: (level: PluginLogLevel, message: string) => void
  /** 插件通知（走全局事件通道） */
  notify: (level: PluginNotifyLevel, title: string, body: string) => void
  sessions: {
    list: () => PluginSessionInfo[]
    get: (terminalId: string) => PluginSessionInfo | undefined
    send: (terminalId: string, text: string) => boolean
  }
}

export interface Sandbox {
  /** 注入插件的宿主 API（同时也是脚本里的全局 `host`） */
  host: PluginHost
  context: vm.Context
}

/* ------------------------------------------------------------------ */
/* 注册项校验                                                           */
/* ------------------------------------------------------------------ */

/** 注册项 id 的格式：与插件 id 同规则，避免出现 `/` 之类会打乱路由的字符 */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
/** 事件名白名单（从 shared 的常量取，运行时校验一次，防止插件写错名字静默失效） */
const EVENT_NAMES = new Set<string>(['session:opened', 'session:closed', 'session:output'])

function checkDefId(what: string, id: unknown): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new PluginFailure('INVALID', `${what} 的 id 不能为空`)
  }
  const trimmed = id.trim()
  if (!ID_PATTERN.test(trimmed)) {
    throw new PluginFailure(
      'INVALID',
      `${what} 的 id 只能包含字母、数字、点、下划线与连字符：${trimmed}`,
    )
  }
  return trimmed
}

function checkLabel(what: string, label: unknown): string {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new PluginFailure('INVALID', `${what} 的 label 不能为空（界面按钮上要有字）`)
  }
  return label.trim().slice(0, 64)
}

function checkHandler(what: string, handler: unknown): void {
  if (typeof handler !== 'function') {
    throw new PluginFailure('INVALID', `${what} 的第二个参数必须是函数`)
  }
}

/**
 * 构造沙箱并注入宿主 API。
 *
 * 注意 `context` 里**只**放这些东西：新 vm 上下文自带完整的 JS 内置对象
 * （Object / Array / Promise / Math / JSON…），我们额外给的每一件都要有理由。
 * 特别是：不给 `require`、不给 `process`、不给 `Buffer`、不给 `fetch` ——
 * 插件要碰网络或文件，应当由宿主 API 开口子，而不是自己拿通道。
 */
export function createSandbox(deps: SandboxDeps): Sandbox {
  const { manifest, registrations } = deps

  const context = vm.createContext({})

  const log = (level: PluginLogLevel, message: unknown): void => {
    deps.log(level, stringify(message))
  }
  const notify = (title: unknown, body?: unknown, level?: unknown): void => {
    const text = stringify(title).slice(0, 120) || manifest.name
    const tone: PluginNotifyLevel = level === 'warn' || level === 'error' ? level : 'info'
    deps.notify(tone, text, stringify(body ?? '').slice(0, 500))
  }

  const host: PluginHost = {
    manifest: Object.freeze({ ...manifest }),
    /**
     * **同一个对象引用**，不是副本：运行时的配置热更新就是靠改这个对象透传进沙箱的
     * （见 PluginRuntime.updateConfig 的说明）。做成副本的话，用户改完配置
     * 必须重载插件才能生效，而重载会丢掉插件的内存状态。
     */
    config: deps.config,

    getConfig: <T extends PluginConfigValue>(key: string, fallback?: T): T => {
      const value = deps.config[key]
      if (value === undefined) {
        // 不静默返回 undefined：插件拼错 key 是最常见的低级错误，
        // 记一条 warn 比让它在业务逻辑里以 NaN 的形式爆出来好找得多
        deps.log('warn', `配置项不存在：${key}（已返回默认值 ${String(fallback)}）`)
        return fallback as T
      }
      if (fallback !== undefined && typeof value !== typeof fallback) {
        deps.log(
          'warn',
          `配置项 ${key} 的类型是 ${typeof value}，与期望的 ${typeof fallback} 不一致`,
        )
      }
      return value as T
    },

    log,

    notify,

    registerTriggerAction: (def, handler) => {
      const id = checkDefId('触发器动作', def?.id)
      checkLabel('触发器动作', def?.label)
      checkHandler('registerTriggerAction', handler)
      if (registrations.triggerActions.has(id)) {
        throw new PluginFailure('DUPLICATE', `触发器动作 id 重复：${id}`)
      }
      registrations.triggerActions.set(id, {
        def: {
          id,
          label: def.label.trim().slice(0, 64),
          ...(def.description ? { description: def.description.slice(0, 200) } : {}),
        },
        handler,
      })
    },

    registerCommand: (def, handler) => {
      const id = checkDefId('命令', def?.id)
      checkLabel('命令', def?.label)
      checkHandler('registerCommand', handler)
      if (registrations.commands.has(id)) {
        throw new PluginFailure('DUPLICATE', `命令 id 重复：${id}`)
      }
      registrations.commands.set(id, {
        def: {
          id,
          label: def.label.trim().slice(0, 64),
          ...(def.description ? { description: def.description.slice(0, 200) } : {}),
        },
        handler,
      })
    },

    registerPanel: (def, handler) => {
      const id = checkDefId('面板', def?.id)
      checkHandler('registerPanel', handler)
      if (typeof def?.title !== 'string' || def.title.trim() === '') {
        throw new PluginFailure('INVALID', '面板的 title 不能为空')
      }
      if (registrations.panels.has(id)) {
        throw new PluginFailure('DUPLICATE', `面板 id 重复：${id}`)
      }
      registrations.panels.set(id, {
        def: {
          id,
          title: def.title.trim().slice(0, 64),
          ...(def.description ? { description: def.description.slice(0, 200) } : {}),
        },
        handler,
      })
    },

    on: (event, handler) => {
      if (typeof event !== 'string' || !EVENT_NAMES.has(event)) {
        throw new PluginFailure(
          'INVALID',
          `不支持的事件名：${String(event)}。可用事件：session:opened / session:closed / session:output`,
        )
      }
      checkHandler(`on(${event})`, handler)
      const name = event as PluginEventName
      let set = registrations.subscriptions.get(name)
      if (!set) {
        set = new Set()
        registrations.subscriptions.set(name, set)
      }
      set.add(handler)
      return () => {
        set?.delete(handler)
      }
    },

    sessions: {
      list: () => deps.sessions.list(),
      get: (terminalId) => deps.sessions.get(terminalId),
      send: (terminalId, text) => deps.sessions.send(terminalId, text),
    },
  }

  // 定时器包装：插件里 setTimeout / setInterval 拿到的句柄就是宿主登记的句柄。
  // 卸载时统一 clear，避免「插件停了但定时器还在跑」——那会让进程退不出去。
  const wrapTimeout: typeof setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = setTimeout(() => {
      registrations.timeouts.delete(timer)
      try {
        fn(...args)
      } catch (err) {
        deps.log('error', `定时器回调抛错：${describeError(err)}`)
      }
    }, clampDelay(ms))
    timer.unref?.()
    registrations.timeouts.add(timer)
    return timer
  }) as typeof setTimeout

  const wrapInterval: typeof setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = setInterval(() => {
      try {
        fn(...args)
      } catch (err) {
        // 在插件里抛错会变成 uncaughtException；在这里兜住，插件坏了也不影响服务端。
        // 这也是「插件故障不拖垮宿主」的具体落点
        deps.log('error', `定时器回调抛错：${describeError(err)}`)
      }
    }, clampDelay(ms))
    timer.unref?.()
    registrations.intervals.add(timer)
    return timer
  }) as typeof setInterval

  const clearWrappedTimeout: typeof clearTimeout = ((timer?: NodeJS.Timeout) => {
    if (timer) registrations.timeouts.delete(timer)
    clearTimeout(timer as NodeJS.Timeout)
  }) as typeof clearTimeout

  const clearWrappedInterval: typeof clearInterval = ((timer?: NodeJS.Timeout) => {
    if (timer) registrations.intervals.delete(timer)
    clearInterval(timer as NodeJS.Timeout)
  }) as typeof clearInterval

  Object.assign(context, {
    host,
    // 只给这些全局。`console` 转发到插件日志而不是标准输出 ——
    // 服务端日志里混进插件的 console.log 会淹没真正的排障信息
    console: {
      log: (...args: unknown[]) => log('info', args.map(stringify).join(' ')),
      info: (...args: unknown[]) => log('info', args.map(stringify).join(' ')),
      warn: (...args: unknown[]) => log('warn', args.map(stringify).join(' ')),
      error: (...args: unknown[]) => log('error', args.map(stringify).join(' ')),
      debug: (...args: unknown[]) => log('debug', args.map(stringify).join(' ')),
    },
    setTimeout: wrapTimeout,
    setInterval: wrapInterval,
    clearTimeout: clearWrappedTimeout,
    clearInterval: clearWrappedInterval,
  })

  return { host, context }
}

/** 延迟兜底：负数或 NaN 会被 Node 当成 1（几乎立刻），统一钳到 [10, 24h] 更符合直觉 */
function clampDelay(ms: number | undefined): number {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
  return Math.min(Math.max(value, 10), 24 * 60 * 60 * 1000)
}

/**
 * 把入口脚本按「普通脚本」在沙箱里执行。
 *
 * 不引入 ESM 加载器也不做 `require` 解析：插件是单文件常见形态，
 * 需要多文件时用「一个入口 + 把公共代码内联」的门槛，比给插件开一个
 * 模块解析器更可控（后者会连带着把 `node_modules` 暴露给它）。
 */
export function runPluginEntry(entry: string, app: Sandbox, timeoutMs = 5_000): void {
  let code: string
  try {
    code = readFileSync(entry, 'utf8')
  } catch (err) {
    throw new PluginFailure('RUNTIME', `无法读取入口文件：${describeError(err)}`)
  }

  const script = new vm.Script(code, { filename: entry })

  try {
    script.runInContext(app.context, { timeout: timeoutMs })
  } catch (err) {
    if (err instanceof PluginFailure) throw err
    const message = describeError(err)
    const stack = err instanceof Error && err.stack ? `\n${firstStackLines(err.stack)}` : ''
    throw new PluginFailure('RUNTIME', `插件入口执行失败：${message}${stack}`)
  }
}

/** 堆栈只留前几行：插件作者的错在自己那一行，宿主的调用栈对他没意义 */
function firstStackLines(stack: string): string {
  return stack
    .split('\n')
    .slice(0, 4)
    .map((line) => line.trim())
    .join('\n')
}

/** 日志里的值统一转成一行可读文本；对象做浅层 JSON，避免循环引用抛错 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
