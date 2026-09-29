/**
 * 隧道的错误类型与 errno 映射。
 *
 * 隧道失败的原因大多来自操作系统，用户看到的不该是 `listen EADDRINUSE`，
 * 而该是「端口 13306 已被占用」。这一层负责把 errno 翻成错误码 + 中文建议。
 */
import type { TerminalErrorCode } from '@webterm/shared'

export class TunnelError extends Error {
  readonly code: TerminalErrorCode
  /** 是否致命（隧道会进入 error 状态，需要用户处理） */
  readonly fatal: boolean
  /** 面向用户的中文建议 */
  readonly hint?: string

  constructor(
    code: TerminalErrorCode,
    message: string,
    options: { fatal?: boolean; hint?: string; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'TunnelError'
    this.code = code
    this.fatal = options.fatal ?? true
    this.hint = options.hint
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 把绑定/转发过程中的原始错误分类。
 *
 * 三类绑定失败被单独拎出来，因为它们的处置方式完全不同：
 * 端口被占 → 换端口；端口没权限 → 换高端口或提权；地址不可用 → 检查监听地址
 * （bindHost 写了别的机器的 IP 是最常见的误操作）。
 */
export function classifyTunnelError(err: unknown, context?: { bindHost?: string; bindPort?: number }): TunnelError {
  if (err instanceof TunnelError) return err

  const msg = messageOf(err)
  const errno = errnoOf(err)
  const where =
    context?.bindHost !== undefined && context.bindPort !== undefined
      ? `${context.bindHost}:${context.bindPort}`
      : undefined

  if (errno === 'EADDRINUSE') {
    return new TunnelError('PORT_IN_USE', `监听端口已被占用${where ? `：${where}` : ''}`, {
      hint: '换一个监听端口，或先关闭正在占用该端口的程序。远程转发出现此提示时，通常是对端服务器上已有服务在监听该端口。',
      cause: err,
    })
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new TunnelError('PORT_DENIED', `无权监听${where ? ` ${where}` : '该端口'}`, {
      hint: '1024 以下的端口在多数系统上需要管理员权限，建议改用 1024 以上的端口。',
      cause: err,
    })
  }
  if (errno === 'EADDRNOTAVAIL') {
    return new TunnelError('PORT_DENIED', `监听地址不可用${where ? `：${where}` : ''}`, {
      hint: `监听地址必须是本机拥有的地址。想只让本机访问就填 127.0.0.1；想开放给局域网需要填 0.0.0.0 并确认这台机器确实有该网卡的地址。`,
      cause: err,
    })
  }
  if (errno === 'ETIMEDOUT') {
    return new TunnelError('FORWARD_TIMEOUT', `建立转发通道超时${where ? `：${where}` : ''}`, {
      hint: '目标地址可能不可达（防火墙丢包）。',
      cause: err,
    })
  }
  if (errno === 'ECONNREFUSED') {
    return new TunnelError('FORWARD_REJECTED', `目标拒绝连接${where ? `：${where}` : ''}`, {
      hint: '目标端口上没有服务在监听，或对端防火墙明确拒绝。',
      cause: err,
    })
  }

  // ssh2 在远端拒绝 forwardIn / forwardOut 时给的是这类消息
  const lower = msg.toLowerCase()
  if (lower.includes('administratively prohibited')) {
    return new TunnelError('FORWARD_REJECTED', msg, {
      hint: '远端 SSH 服务器禁止端口转发（sshd 配置里通常是 AllowTcpForwarding no）。这是服务端策略，客户端无法绕过。',
      cause: err,
    })
  }
  if (lower.includes('channel open failure') || lower.includes('forward')) {
    return new TunnelError('FORWARD_REJECTED', msg, { cause: err })
  }

  return new TunnelError('TRANSPORT', msg, { cause: err })
}
