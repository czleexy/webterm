/**
 * Telnet 错误分类。
 *
 * Telnet 比 SSH 简单得多：没有握手、没有认证、没有算法协商，
 * 因此错误基本集中在 TCP 层。这里把 Node 的 errno 归类到与 SSH 同一套
 * TerminalErrorCode 上，前端不必区分协议就能给出针对性提示。
 */
import type { TerminalErrorCode } from '@webterm/shared'

export class TelnetError extends Error {
  readonly code: TerminalErrorCode
  readonly fatal: boolean
  readonly hint?: string

  constructor(
    code: TerminalErrorCode,
    message: string,
    options: { fatal?: boolean; hint?: string; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'TelnetError'
    this.code = code
    this.fatal = options.fatal ?? true
    this.hint = options.hint
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function errnoOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code.toUpperCase()
  }
  return ''
}

export function classifyTelnetError(err: unknown): TelnetError {
  if (err instanceof TelnetError) return err

  const errno = errnoOf(err)
  const message = err instanceof Error ? err.message : String(err)

  if (errno === 'ETIMEDOUT' || /timed?\s*out/i.test(message)) {
    return new TelnetError('TIMEOUT', message, {
      hint: '目标端口没有在超时时间内响应。请确认设备已开启 Telnet 服务，且没有被防火墙静默丢包。',
      cause: err,
    })
  }

  if (
    errno === 'ECONNREFUSED' ||
    errno === 'ECONNRESET' ||
    errno === 'EHOSTUNREACH' ||
    errno === 'ENETUNREACH' ||
    errno === 'ENOTFOUND' ||
    errno === 'EAI_AGAIN'
  ) {
    const hintByErrno: Record<string, string> = {
      ECONNREFUSED:
        '目标主机拒绝了连接。多数设备默认关闭 Telnet，需要在设备上显式开启（如 Cisco 的 `transport input telnet`、华为的 `telnet server enable`）。',
      ECONNRESET: '连接被对端重置，设备可能达到了最大并发登录数或主动断开了空闲会话。',
      ENOTFOUND: '域名无法解析，请检查主机地址拼写或本机 DNS 配置。',
      EAI_AGAIN: 'DNS 解析暂时失败，请稍后重试或改用 IP 地址。',
    }
    return new TelnetError('UNREACHABLE', message, {
      hint: hintByErrno[errno] ?? '无法建立 TCP 连接，请确认主机地址、端口与网络连通性。',
      cause: err,
    })
  }

  return new TelnetError('TRANSPORT', message, { cause: err })
}
