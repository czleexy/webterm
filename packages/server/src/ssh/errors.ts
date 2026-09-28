/**
 * SSH 错误分类。
 *
 * 目的：把 ssh2 五花八门的错误消息归一到有限的错误码上，让前端能给出
 * 有针对性的提示，也让「是否值得降级重试」有明确判据（见 isAlgorithmError）。
 *
 * ssh2 的错误对象形态不统一，可能带 level / code / message，且部分错误的
 * message 是英文自由文本，因此这里以 message 特征匹配为主、字段匹配为辅。
 */
import type { TerminalErrorCode } from '@webterm/shared'

export class SshError extends Error {
  readonly code: TerminalErrorCode
  /** 原始 ssh2 错误的 level，排障用 */
  readonly level?: string
  /** 是否致命（前端是否需要终止重试） */
  readonly fatal: boolean
  /** 面向用户的中文建议 */
  readonly hint?: string

  constructor(
    code: TerminalErrorCode,
    message: string,
    options: { level?: string; fatal?: boolean; hint?: string; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'SshError'
    this.code = code
    this.level = options.level
    this.fatal = options.fatal ?? true
    this.hint = options.hint
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** 从任意抛出物中提取可读消息 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

function levelOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'level' in err) {
    const level = (err as { level?: unknown }).level
    if (typeof level === 'string') return level
  }
  return undefined
}

/**
 * 判断是否为「算法协商类」错误。
 * 只有这类错误才值得换更宽松的算法档案重试 —— 认证失败重试没有意义。
 */
export function isAlgorithmError(err: unknown): boolean {
  const msg = messageOf(err).toLowerCase()
  return (
    msg.includes('no matching key exchange') ||
    msg.includes('no matching cipher') ||
    msg.includes('no matching mac') ||
    msg.includes('no matching host key') ||
    msg.includes('no matching compression') ||
    // 老设备主机密钥签名不规范，降级换算法可能绕过
    msg.includes('signature verification failed') ||
    msg.includes('unsupported algorithm') ||
    msg.includes('is not supported')
  )
}

/**
 * 把 ssh2 抛出的错误归一为 SshError。
 */
export function classifySshError(err: unknown): SshError {
  if (err instanceof SshError) return err

  const msg = messageOf(err)
  const lower = msg.toLowerCase()
  const level = levelOf(err)

  // 算法协商失败
  if (isAlgorithmError(err)) {
    return new SshError('ALGORITHM_MISMATCH', msg, {
      level,
      hint: '目标设备的算法过于老旧，已尝试自动降级仍失败。可在新建连接时把「算法兼容」设为「总是使用 legacy」。',
      cause: err,
    })
  }

  // 认证失败
  if (
    lower.includes('all configured authentication methods failed') ||
    lower.includes('authentication failed') ||
    lower.includes('permission denied')
  ) {
    return new SshError('AUTH_FAILED', msg, {
      level,
      hint: '请检查用户名、口令或私钥是否正确，以及该账号是否被允许从本机登录。',
      cause: err,
    })
  }

  // 认证方式不被接受
  if (lower.includes('authentication methods') && lower.includes('failed')) {
    return new SshError('AUTH_METHOD_UNSUPPORTED', msg, {
      level,
      hint: '服务端不接受当前认证方式，请更换为口令或密钥。',
      cause: err,
    })
  }

  // 主机密钥被拒
  if (lower.includes('host key') || lower.includes('hostkey')) {
    return new SshError('HOST_KEY_REJECTED', msg, {
      level,
      fatal: true,
      hint: '主机密钥校验未通过。若确认目标可信，请在本机清除该主机的指纹记录后重连。',
      cause: err,
    })
  }

  // 超时
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new SshError('TIMEOUT', msg, {
      level,
      hint: '连接或认证超时，请确认网络可达且目标 SSH 服务正常响应。',
      cause: err,
    })
  }

  // 网络不可达
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('etimedout') ||
    lower.includes('getaddrinfo') ||
    lower.includes('enotfound')
  ) {
    return new SshError('UNREACHABLE', msg, {
      level,
      hint: '无法建立 TCP 连接，请确认主机地址、端口与网络连通性。',
      cause: err,
    })
  }

  // 远端拒绝开启会话通道（设备侧限制）
  if (
    lower.includes('unable to open shell') ||
    lower.includes('unable to exec') ||
    lower.includes('unable to start subsystem') ||
    lower.includes('channel open failure')
  ) {
    return new SshError('CHANNEL_REJECTED', msg, {
      level,
      hint: '远端接受了连接与 PTY 申请，但拒绝开启会话。常见原因：该账号无 CLI 登录权限、VTY 线路被占满，或设备仅开放了受限服务。请在设备侧确认账号权限。',
      cause: err,
    })
  }

  // PTY 分配失败
  if (lower.includes('pty')) {
    return new SshError('PTY_FAILED', msg, {
      level,
      hint: '远端拒绝分配伪终端，可尝试更换 TERM 类型或在设备侧放开 PTY 支持。',
      cause: err,
    })
  }

  // 连接被对端关闭
  if (lower.includes('connection is closed by ssh server') || lower.includes('closed by ssh server')) {
    return new SshError('TRANSPORT', msg, {
      level,
      hint: '远端主动关闭了连接，通常意味着服务端策略拒绝了本次会话请求。',
      cause: err,
    })
  }

  return new SshError('TRANSPORT', msg, { level, cause: err })
}

/** 给错误码配一句通用中文说明，用于 REST 层返回 */
export const ERROR_CODE_DESCRIPTION: Record<TerminalErrorCode, string> = {
  UNREACHABLE: '主机不可达',
  ALGORITHM_MISMATCH: '算法协商失败',
  HOST_KEY_REJECTED: '主机密钥校验未通过',
  AUTH_FAILED: '认证失败',
  AUTH_METHOD_UNSUPPORTED: '认证方式不被支持',
  TIMEOUT: '连接超时',
  CHANNEL_REJECTED: '远端拒绝开启会话',
  PTY_FAILED: 'PTY 分配失败',
  TRANSPORT: '传输层错误',
  INVALID_CONFIG: '请求参数非法',
  FORWARD_REJECTED: '跳板机拒绝转发',
  FORWARD_TIMEOUT: '跳板机转发超时',
  INTERNAL: '服务端内部错误',
}
