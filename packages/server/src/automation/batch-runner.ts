/**
 * 批量执行：把同一条命令并发地送到多台主机，收成一张表。
 *
 * 为什么用 exec 通道而不是「在已有 shell 里敲命令」：
 * 退出码。靠提示符或哨兵字符串去猜「命令跑完了没有」，在设备差异面前毫无可靠性
 * （有的提示符带颜色、有的会被分页截断），而 `exec` 通道由协议层直接给出
 * `exit-status`，stdout / stderr 也是分开的。这也是批量执行只支持 SSH 的原因。
 *
 * 两种连接来源（见 shared 的 BatchTarget 注释）：
 * - `terminalId`：借用已登录的 SSH 连接另开 exec 通道，不额外占用 VTY 线路
 * - `sessionId`：按会话库配置独立建连，跑完即断
 *
 * 单项失败绝不影响其他项：每个目标都在自己的 try 里跑，失败变成结果表里的一行
 * （`ok: false` + `error`），而不是让整次批量执行 500。
 */
import iconv from 'iconv-lite'
import type { Client } from 'ssh2'
import type {
  BatchResult,
  BatchTarget,
  ConnectionProtocol,
  RunBatchRequest,
  RunBatchResponse,
  SshTarget,
  SupportedEncodingLiteral,
} from '@webterm/shared'
import {
  BATCH_DEFAULT_CONCURRENCY,
  BATCH_DEFAULT_TIMEOUT_MS,
  BATCH_MAX_CONCURRENCY,
  BATCH_MAX_OUTPUT_BYTES,
  BATCH_MAX_TIMEOUT_MS,
} from '@webterm/shared'
import { establishConnection, establishConnectionChain } from '../ssh/connection.js'
import { classifySshError } from '../ssh/errors.js'
import type { KnownHostsStore } from '../ssh/known-hosts.js'
import { AutomationFailure } from './errors.js'

export interface BatchTerminalView {
  terminalId: string
  /** 存活会话的连接；已关闭时为 undefined */
  client: Client | undefined
  protocol: ConnectionProtocol
  host: string
  port: number
  username: string
  title: string
  encoding: SupportedEncodingLiteral
}

export interface BatchSessionPlan {
  sessionId: string
  title: string
  protocol: ConnectionProtocol
  target: SshTarget
  jumpChain: SshTarget[]
  encoding: SupportedEncodingLiteral
}

export interface BatchRunnerDeps {
  logger: {
    debug: (obj: unknown, msg?: string) => void
    info: (obj: unknown, msg?: string) => void
    warn: (obj: unknown, msg?: string) => void
  }
  knownHosts: KnownHostsStore
  /** 取存活终端视图 */
  getTerminal: (terminalId: string) => BatchTerminalView | undefined
  /** 按会话库节点解析连接计划（凭据解密在此完成） */
  resolveSession: (sessionId: string) => BatchSessionPlan
}

export async function runBatch(
  req: RunBatchRequest,
  deps: BatchRunnerDeps,
): Promise<RunBatchResponse> {
  const started = Date.now()
  const concurrency = clamp(req.concurrency ?? BATCH_DEFAULT_CONCURRENCY, 1, BATCH_MAX_CONCURRENCY)
  const timeoutMs = clamp(req.timeoutMs ?? BATCH_DEFAULT_TIMEOUT_MS, 1000, BATCH_MAX_TIMEOUT_MS)

  const results = await mapWithConcurrency(req.targets, concurrency, async (target) => {
    const targetStarted = Date.now()
    try {
      return await runOne(target, req.command, timeoutMs, deps, targetStarted)
    } catch (err) {
      return failureResult(target, err, deps, Date.now() - targetStarted)
    }
  })

  const succeeded = results.filter((r) => r.ok).length
  return {
    results,
    elapsedMs: Date.now() - started,
    succeeded,
    failed: results.length - succeeded,
  }
}

/* ------------------------------------------------------------------ */

async function runOne(
  target: BatchTarget,
  command: string,
  timeoutMs: number,
  deps: BatchRunnerDeps,
  startedAt: number,
): Promise<BatchResult> {
  if (target.terminalId) {
    const view = deps.getTerminal(target.terminalId)
    if (!view) {
      throw new AutomationFailure('NOT_FOUND', `终端不存在或已关闭：${target.terminalId}`)
    }
    if (view.protocol !== 'ssh') {
      throw new AutomationFailure(
        'UNSUPPORTED',
        'Telnet 会话没有 exec 通道，无法批量执行',
        '请在会话库里选择 SSH 会话作为批量目标。',
      )
    }
    if (!view.client) {
      throw new AutomationFailure('SESSION_CLOSED', '该终端的 SSH 连接已关闭')
    }
    const outcome = await execOn(view.client, command, timeoutMs)
    return {
      target: target.label ?? view.title ?? view.host,
      terminalId: view.terminalId,
      protocol: 'ssh',
      ok: outcome.exitCode === 0 && !outcome.timedOut,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      elapsedMs: Date.now() - startedAt,
      ...(outcome.timedOut
        ? { error: `执行超时（${timeoutMs}ms），通道已关闭` }
        : outcome.error
          ? { error: outcome.error }
          : {}),
      ...(outcome.truncated ? { truncated: true } : {}),
    }
  }

  if (target.sessionId) {
    const plan = deps.resolveSession(target.sessionId)
    if (plan.protocol !== 'ssh') {
      throw new AutomationFailure(
        'UNSUPPORTED',
        'Telnet 会话没有 exec 通道，无法批量执行',
        '请在会话库里选择 SSH 会话作为批量目标。',
      )
    }

    const chain =
      plan.jumpChain.length > 0
        ? await establishConnectionChain(
            [...plan.jumpChain.map((t) => ({ target: t })), { target: plan.target, legacyCompat: 'auto' as const }],
            { knownHosts: deps.knownHosts, logger: deps.logger },
          )
        : {
            connection: await establishConnection({
              target: plan.target,
              legacyCompat: 'auto',
              knownHosts: deps.knownHosts,
              keyboardInteractivePassword: plan.target.password,
              logger: deps.logger,
            }),
            intermediate: [],
          }

    try {
      const outcome = await execOn(chain.connection.client, command, timeoutMs, plan.encoding)
      return {
        target: target.label ?? plan.title ?? plan.target.host,
        sessionId: plan.sessionId,
        protocol: 'ssh',
        ok: outcome.exitCode === 0 && !outcome.timedOut,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        elapsedMs: Date.now() - startedAt,
        ...(outcome.timedOut
          ? { error: `执行超时（${timeoutMs}ms），通道已关闭` }
          : outcome.error
            ? { error: outcome.error }
            : {}),
        ...(outcome.truncated ? { truncated: true } : {}),
      }
    } finally {
      // 独立建连的必须自己收尾，否则每跑一次批量就漏一批连接
      chain.connection.client.end()
      for (const conn of chain.intermediate) conn.client.end()
    }
  }

  throw new AutomationFailure('INVALID', '批量目标必须指定 sessionId 或 terminalId')
}

interface ExecOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  signal?: string
  timedOut: boolean
  truncated: boolean
  error?: string
}

/**
 * 在给定连接上执行一条命令并收全输出。
 * 超时会主动 `close()` 通道 —— 否则远端命令继续跑、本端一直等，比超时本身更糟。
 */
function execOn(
  client: Client,
  command: string,
  timeoutMs: number,
  encoding: SupportedEncodingLiteral = 'utf8',
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    let settled = false
    const out = new LimitedCollector()
    const err = new LimitedCollector()

    const finish = (value: ExecOutcome): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    client.exec(command, { pty: false }, (error, stream) => {
      if (error) {
        const classified = classifySshError(error)
        finish({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          truncated: false,
          error: classified.message,
        })
        return
      }

      const timer = setTimeout(() => {
        try {
          stream.close()
        } catch {
          /* 通道可能已关闭 */
        }
        finish({
          stdout: out.toString(encoding),
          stderr: err.toString(encoding),
          exitCode: null,
          timedOut: true,
          truncated: out.truncated || err.truncated,
        })
      }, timeoutMs)
      timer.unref?.()

      stream.on('data', (chunk: Buffer) => out.push(chunk))
      stream.stderr.on('data', (chunk: Buffer) => err.push(chunk))

      stream.on('close', (code: number | null, signal: string | undefined) => {
        clearTimeout(timer)
        finish({
          stdout: out.toString(encoding),
          stderr: err.toString(encoding),
          exitCode: code ?? null,
          ...(signal ? { signal } : {}),
          timedOut: false,
          truncated: out.truncated || err.truncated,
        })
      })

      stream.on('error', (streamError: Error) => {
        clearTimeout(timer)
        finish({
          stdout: out.toString(encoding),
          stderr: err.toString(encoding),
          exitCode: null,
          timedOut: false,
          truncated: out.truncated || err.truncated,
          error: streamError.message,
        })
      })
    })
  })
}

/** 带上限的字节收集器：一台机器 `cat` 一个大文件不该把整次响应撑爆 */
class LimitedCollector {
  private readonly chunks: Buffer[] = []
  private size = 0
  truncated = false

  push(chunk: Buffer): void {
    if (this.size >= BATCH_MAX_OUTPUT_BYTES) {
      this.truncated = true
      return
    }
    const remaining = BATCH_MAX_OUTPUT_BYTES - this.size
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.size = BATCH_MAX_OUTPUT_BYTES
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
  }

  toString(encoding: SupportedEncodingLiteral): string {
    if (this.chunks.length === 0) return ''
    const buffer = Buffer.concat(this.chunks)
    // exec 的输出编码跟随会话配置：老设备常常是 GBK
    if (encoding === 'utf8') return buffer.toString('utf8')
    try {
      return iconv.decode(buffer, encoding)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

function failureResult(
  target: BatchTarget,
  err: unknown,
  deps: BatchRunnerDeps,
  elapsedMs: number,
): BatchResult {
  const message =
    err instanceof AutomationFailure
      ? err.hint
        ? `${err.message}（${err.hint}）`
        : err.message
      : err instanceof Error
        ? err.message
        : String(err)

  deps.logger.warn({ target, err: message }, '批量执行单个目标失败')

  let label = target.label
  let protocol: ConnectionProtocol = 'ssh'
  if (!label && target.terminalId) {
    const view = deps.getTerminal(target.terminalId)
    label = view?.title ?? view?.host
    if (view) protocol = view.protocol
  }
  if (!label && target.sessionId) {
    try {
      label = deps.resolveSession(target.sessionId).title
    } catch {
      /* 解析也失败时退回 id */
    }
  }

  const result: BatchResult = {
    target: label ?? target.terminalId ?? target.sessionId ?? '（未知目标）',
    protocol,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    elapsedMs,
    error: message,
  }
  if (target.sessionId) result.sessionId = target.sessionId
  if (target.terminalId) result.terminalId = target.terminalId
  return result
}

/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 固定并发的任务池：保持结果顺序与输入一致，便于界面按原顺序展示 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner())
  await Promise.all(workers)
  return results
}
