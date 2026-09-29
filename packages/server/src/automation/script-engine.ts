/**
 * 脚本引擎：在受控沙箱里跑一段 JS，通过注入的 API 操作会话。
 *
 * 架构（为什么这么做，详见 script-worker-source.ts 的实测表格）：
 *   主线程：持有 TerminalTap / SFTP 通道 / 会话句柄，负责真正的 IO
 *   worker：跑 vm 沙箱，只做「薄封装 + 组合」，通过 RPC 回主线程取数据
 *   超时：vm timeout 先拦同步死循环；主线程再补一刀 `worker.terminate()`
 *         —— 后者能终止任何形态的死循环，这是「不影响服务」的关键
 *
 * 主线程这一侧只做四件事：起 worker、分发 RPC、转发日志、到点终止。
 * 所有状态（输出缓冲、SFTP 连接）都在这里，worker 结束即消失，不存在泄漏。
 */
import { Worker } from 'node:worker_threads'
import type { ConnectionProtocol, ScriptLogLevel } from '@webterm/shared'
import { SCRIPT_GLOBAL_NAMES } from '@webterm/shared'
import { AutomationFailure, SCRIPT_TIMEOUT_MESSAGE } from './errors.js'
import { TerminalTap, type WaitOptions } from './script-terminal.js'
import { SCRIPT_WORKER_SOURCE, DEFAULT_SETTLE_MS } from './script-worker-source.js'

/** 硬终止的宽限期：让 vm 自己的 timeout 先有机会抛出更精确的错误 */
const HARD_KILL_GRACE_MS = 500
/** 单条日志消息的长度上限，防止脚本把巨型对象打进日志面板 */
const MAX_LOG_CHARS = 4000

export interface ScriptSessionView {
  terminalId: string
  title: string
  protocol: ConnectionProtocol
  host: string
  port: number
  username: string
}

export interface ScriptDirEntry {
  name: string
  size: number
  isDirectory: boolean
  mtimeMs: number
}

export interface ScriptStatInfo {
  size: number
  isDirectory: boolean
  mtimeMs: number
  mode: number
}

export interface ScriptSftpHandle {
  list(path: string): Promise<ScriptDirEntry[]>
  stat(path: string): Promise<ScriptStatInfo>
  read(path: string, encoding: string | null): Promise<string | Uint8Array>
  write(path: string, content: string | Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  dispose(): void
}

export interface ScriptEngineLogger {
  debug: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

export interface ScriptEngineDeps {
  logger: ScriptEngineLogger
  /** 取宿主会话视图；返回 undefined 表示会话已关闭 */
  getSession: (terminalId: string) => ScriptSessionView | undefined
  /** 订阅宿主会话的输出文本；返回退订函数 */
  subscribeOutput: (terminalId: string, fn: (text: string) => void) => (() => void) | undefined
  /** 把文本写回远端；返回 false 表示会话已关闭 */
  writeToRemote: (terminalId: string, text: string) => boolean
  /** 惰性打开宿主会话上的 SFTP 通道 */
  openSftp: (terminalId: string) => Promise<ScriptSftpHandle>
  /** 脚本自报的一行日志 */
  onLog: (entry: { level: ScriptLogLevel; message: string; line?: number }) => void
}

export interface RunScriptOptions {
  runId: string
  scriptName: string
  code: string
  timeoutMs: number
  session: ScriptSessionView
  params?: Record<string, unknown>
  deps: ScriptEngineDeps
}

export interface ScriptOutcome {
  /** 脚本 `return` 的值（已 JSON 化） */
  result?: unknown
  /** 是否因超时被判定为超时（含 vm 先抛出的那种） */
  timedOut: boolean
  /** 是否由主线程硬终止（说明 vm timeout 没能拦住） */
  hardKilled: boolean
}

interface WorkerLogMessage {
  t: 'log'
  level: ScriptLogLevel
  message: string
  line?: number
}

interface WorkerCallMessage {
  t: 'call'
  id: number
  method: string
  args: unknown[]
}

interface WorkerDoneMessage {
  t: 'done'
  result?: unknown
}

interface WorkerErrorMessage {
  t: 'error'
  error: { name: string; message: string; code?: string; stack?: string }
  timedOut?: boolean
}

type WorkerMessage = WorkerLogMessage | WorkerCallMessage | WorkerDoneMessage | WorkerErrorMessage

/**
 * 运行一个脚本，直到结束、超时或被硬终止。
 *
 * 成功返回脚本结果；失败抛出 AutomationFailure：
 * - `SANDBOX` 语法错误或触犯沙箱限制
 * - `TIMEOUT` 超时（含硬终止）
 * - `RUNTIME` 脚本自身抛错
 * - `SESSION_CLOSED` 宿主会话中途关闭
 */
export async function runScript(opts: RunScriptOptions): Promise<ScriptOutcome> {
  const { deps, session, timeoutMs } = opts

  const tap = new TerminalTap()
  const unsubscribe = deps.subscribeOutput(session.terminalId, (text) => tap.feed(text))

  /**
   * 用对象持有 SFTP 句柄：`let` 变量会被 TS 的控制流分析收窄成初始值 `null`
   * （闭包内的赋值不被追踪），到 finally 里调 dispose 就会报「属性不存在于 never」。
   * 属性访问不做跨函数收窄，因此用 holder 表达「确实会被惰性赋值」。
   */
  const holder: { sftp: ScriptSftpHandle | null } = { sftp: null }
  const getSftp = async (): Promise<ScriptSftpHandle> => {
    if (holder.sftp) return holder.sftp
    if (session.protocol !== 'ssh') {
      throw new AutomationFailure(
        'SESSION_NOT_SSH',
        '当前会话是 Telnet，没有 SFTP 子系统',
        '请改用 SSH 会话运行需要文件操作的脚本。',
      )
    }
    holder.sftp = await deps.openSftp(session.terminalId)
    return holder.sftp
  }

  const worker = new Worker(SCRIPT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      code: opts.code,
      timeoutMs,
      settleMs: DEFAULT_SETTLE_MS,
      session: {
        terminalId: session.terminalId,
        title: session.title,
        protocol: session.protocol,
        host: session.host,
        port: session.port,
        username: session.username,
      },
      params: opts.params ?? {},
    },
    // 把 worker 自身的 stdout/stderr 丢掉：脚本的 console 已被替换成 RPC，
    // 走到这里的只可能是意外输出，不该混进服务日志
    stdout: true,
    stderr: true,
  })

  try {
    return await new Promise<ScriptOutcome>((resolve, reject) => {
      let done = false
      let hardKilled = false

      const hardTimer = setTimeout(() => {
        // vm 的 timeout 没拦住（await 之后的死循环 / 微任务死循环 / 永不 settle 的 Promise）
        hardKilled = true
        deps.logger.warn(
          { runId: opts.runId, timeoutMs },
          '脚本未被 vm 超时中断，正在强制终止 worker',
        )
        settleReject(new AutomationFailure('TIMEOUT', SCRIPT_TIMEOUT_MESSAGE))
        void worker.terminate()
      }, timeoutMs + HARD_KILL_GRACE_MS)

      const settleResolve = (value: ScriptOutcome): void => {
        if (done) return
        done = true
        clearTimeout(hardTimer)
        resolve(value)
      }

      const settleReject = (err: unknown): void => {
        if (done) return
        done = true
        clearTimeout(hardTimer)
        reject(err)
      }

      worker.on('message', (raw: WorkerMessage) => {
        if (!raw || typeof raw !== 'object') return

        switch (raw.t) {
          case 'log': {
            const message =
              raw.message.length > MAX_LOG_CHARS
                ? `${raw.message.slice(0, MAX_LOG_CHARS)}…（已截断）`
                : raw.message
            deps.onLog({ level: raw.level, message, line: raw.line })
            return
          }

          case 'call': {
            void handleCall(raw, tap, getSftp, deps, session).then(
              (value) => {
                worker.postMessage({ t: 'result', id: raw.id, ok: true, value })
              },
              (err: unknown) => {
                worker.postMessage({ t: 'result', id: raw.id, ok: false, error: shapeError(err) })
              },
            )
            return
          }

          case 'done':
            settleResolve({ result: raw.result, timedOut: false, hardKilled })
            return

          case 'error': {
            if (raw.timedOut) {
              settleReject(new AutomationFailure('TIMEOUT', SCRIPT_TIMEOUT_MESSAGE))
              return
            }
            if (raw.error.name === 'SyntaxError') {
              settleReject(
                new AutomationFailure('SANDBOX', `脚本语法错误：${raw.error.message}`),
              )
              return
            }
            const sandbox = classifySandboxError(raw.error)
            if (sandbox) {
              settleReject(sandbox)
              return
            }
            settleReject(
              new AutomationFailure(
                'RUNTIME',
                raw.error.message,
                raw.error.stack ? `出错位置：\n${firstFrames(raw.error.stack)}` : undefined,
              ),
            )
            return
          }
        }
      })

      worker.on('error', (err: Error) => {
        settleReject(new AutomationFailure('SANDBOX', `脚本沙箱异常：${err.message}`))
      })

      worker.on('exit', (code: number) => {
        // 正常结束由 done/error 消息负责；走到这里说明 worker 非正常退出
        if (done) return
        if (hardKilled) return
        settleReject(
          new AutomationFailure('SANDBOX', `脚本运行线程异常退出（code=${code}）`),
        )
      })
    })
  } finally {
    tap.dispose('脚本运行结束')
    unsubscribe?.()
    holder.sftp?.dispose()
    void worker.terminate()
  }
}

/* ------------------------------------------------------------------ */
/* RPC 分发                                                            */
/* ------------------------------------------------------------------ */

async function handleCall(
  msg: WorkerCallMessage,
  tap: TerminalTap,
  getSftp: () => Promise<ScriptSftpHandle>,
  deps: ScriptEngineDeps,
  session: ScriptSessionView,
): Promise<unknown> {
  const arg = (index: number): unknown => msg.args[index]

  switch (msg.method) {
    case 'session.send': {
      const text = String(arg(0) ?? '')
      if (!deps.getSession(session.terminalId)) {
        throw new AutomationFailure('SESSION_CLOSED', '宿主会话已关闭，无法发送数据')
      }
      const ok = deps.writeToRemote(session.terminalId, text)
      if (!ok) throw new AutomationFailure('SESSION_CLOSED', '宿主会话已关闭，无法发送数据')
      return undefined
    }
    case 'session.waitFor':
      return tap.waitFor(String(arg(0) ?? ''), asWaitOptions(arg(1)))
    case 'session.expect':
      return tap.expect(asStringArray(arg(0)), asWaitOptions(arg(1)))
    case 'session.readUntil':
      return tap.readUntil(String(arg(0) ?? ''), asWaitOptions(arg(1)))
    case 'session.read':
      return tap.read()
    case 'session.clear':
      tap.clear()
      return undefined

    case 'sftp.list':
      return (await getSftp()).list(String(arg(0) ?? ''))
    case 'sftp.stat':
      return (await getSftp()).stat(String(arg(0) ?? ''))
    case 'sftp.read': {
      const options = (arg(1) ?? {}) as { encoding?: string | null }
      const encoding = options.encoding === null ? null : (options.encoding ?? 'utf8')
      return (await getSftp()).read(String(arg(0) ?? ''), encoding)
    }
    case 'sftp.write':
      await (await getSftp()).write(String(arg(0) ?? ''), arg(1) as string | Uint8Array)
      return undefined
    case 'sftp.exists':
      return (await getSftp()).exists(String(arg(0) ?? ''))

    default:
      throw new AutomationFailure('INVALID', `脚本调用了未知的宿主接口：${msg.method}`)
  }
}

function asWaitOptions(raw: unknown): WaitOptions {
  if (!raw || typeof raw !== 'object') return {}
  const source = raw as { timeoutMs?: unknown; regex?: unknown }
  const out: WaitOptions = {}
  const timeout = Number(source.timeoutMs)
  if (Number.isFinite(timeout) && timeout > 0) out.timeoutMs = timeout
  if (source.regex === true) out.regex = true
  return out
}

function asStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v))
  if (raw === undefined || raw === null) return []
  return [String(raw)]
}

/** 错误转成可结构化克隆的纯对象（Error 实例本身跨线程序列化会丢字段） */
function shapeError(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof AutomationFailure) {
    return { name: 'AutomationFailure', message: err.message, code: err.code }
  }
  if (err instanceof Error) {
    const out: { name: string; message: string; code?: string } = {
      name: err.name,
      message: err.message,
    }
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') out.code = code
    return out
  }
  return { name: 'Error', message: String(err) }
}

/** 只取栈的前几帧，避免把整棵调用栈灌进错误提示 */
function firstFrames(stack: string): string {
  return stack
    .split('\n')
    .slice(0, 4)
    .map((line) => line.trim())
    .join('\n')
}

/**
 * 宿主能力（require / process / fs …）在沙箱里是**有意**不存在的。
 * 若不单独归类，脚本一碰它们就报「ReferenceError: require is not defined」，
 * 混在一堆普通运行错误里，用户很难分清「我逻辑写错了」和「这个能力被关掉了」。
 */
const SANDBOX_BLOCKED_GLOBALS = [
  'require',
  'process',
  'module',
  'exports',
  'global',
  'globalThis',
  '__dirname',
  '__filename',
  'Buffer',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'fetch',
]

function classifySandboxError(err: {
  name: string
  message: string
  code?: string
}): AutomationFailure | undefined {
  const notDefined = /^(\w+) is not defined$/.exec(err.message)
  if (err.name === 'ReferenceError' && notDefined) {
    const name = notDefined[1] ?? ''
    if (SANDBOX_BLOCKED_GLOBALS.includes(name)) {
      return new AutomationFailure(
        'SANDBOX',
        `脚本沙箱不提供 ${name}`,
        `沙箱内没有 Node 的模块系统与进程对象。可用全局：${SCRIPT_GLOBAL_NAMES.join('、')}。`,
      )
    }
  }
  // codeGeneration.strings = false 会让 eval / new Function 直接失败
  if (/Code generation from strings disallowed/i.test(err.message)) {
    return new AutomationFailure(
      'SANDBOX',
      '脚本沙箱禁止动态执行代码（eval / new Function）',
      '这是有意关闭的，否则沙箱形同虚设。',
    )
  }
  return undefined
}
