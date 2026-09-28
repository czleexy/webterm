/**
 * SFTP 与本地文件系统操作的错误模型。
 *
 * 与 ssh/errors.ts 分开的原因：SFTP 的失败绝大多数是「目标路径层面的问题」
 * （不存在、无权限、已存在、目录非空），需要一一对应到不同的 HTTP 状态码与
 * 前端提示，而 SSH 层错误关心的是连接与认证。两者混在一个枚举里会让
 * 前端不得不为「路径不存在」去匹配 SSH 的错误码。
 */

export type SftpErrorCode =
  /** 路径格式非法（相对路径、含 NUL 等） */
  | 'INVALID_PATH'
  /** 本地侧路径越出受限根目录（防 `..` 逃逸） */
  | 'PATH_ESCAPE'
  /** 目标不存在 */
  | 'NOT_FOUND'
  /** 目标已存在 */
  | 'ALREADY_EXISTS'
  /** 期望目录却拿到文件，或反之 */
  | 'WRONG_TYPE'
  /** 权限不足 */
  | 'PERMISSION_DENIED'
  /** 目录非空（不允许递归删除时） */
  | 'NOT_EMPTY'
  /** 远端文件在编辑期间被改动，拒绝覆盖 */
  | 'CONFLICT'
  /** 文件过大 / 请求体超限 */
  | 'TOO_LARGE'
  /** 远端不支持该操作（SFTP 扩展缺失） */
  | 'UNSUPPORTED'
  /** 远端或磁盘 I/O 失败 */
  | 'IO'
  /** SFTP 会话不存在或已关闭 */
  | 'SESSION_NOT_FOUND'
  /** 传输任务不存在 */
  | 'TRANSFER_NOT_FOUND'
  /** 服务端内部错误 */
  | 'INTERNAL'

export class SftpError extends Error {
  readonly code: SftpErrorCode
  /** 面向用户的中文建议 */
  readonly hint?: string

  constructor(code: SftpErrorCode, message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message)
    this.name = 'SftpError'
    this.code = code
    this.hint = options.hint
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** 错误码 → HTTP 状态码 */
export const SFTP_STATUS_BY_CODE: Record<SftpErrorCode, number> = {
  INVALID_PATH: 400,
  PATH_ESCAPE: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  WRONG_TYPE: 400,
  PERMISSION_DENIED: 403,
  NOT_EMPTY: 409,
  CONFLICT: 409,
  TOO_LARGE: 413,
  UNSUPPORTED: 400,
  IO: 502,
  SESSION_NOT_FOUND: 404,
  TRANSFER_NOT_FOUND: 404,
  INTERNAL: 500,
}

export const SFTP_ERROR_DESCRIPTION: Record<SftpErrorCode, string> = {
  INVALID_PATH: '路径非法',
  PATH_ESCAPE: '路径越界',
  NOT_FOUND: '目标不存在',
  ALREADY_EXISTS: '目标已存在',
  WRONG_TYPE: '类型不匹配',
  PERMISSION_DENIED: '权限不足',
  NOT_EMPTY: '目录非空',
  CONFLICT: '文件已被修改',
  TOO_LARGE: '文件过大',
  UNSUPPORTED: '远端不支持该操作',
  IO: '读写失败',
  SESSION_NOT_FOUND: 'SFTP 会话不存在',
  TRANSFER_NOT_FOUND: '传输任务不存在',
  INTERNAL: '服务端内部错误',
}

/** SFTP 协议状态码（RFC draft-ietf-secsh-filexfer-02） */
const STATUS_OK = 0
const STATUS_EOF = 1
const STATUS_NO_SUCH_FILE = 2
const STATUS_PERMISSION_DENIED = 3
const STATUS_FAILURE = 4
const STATUS_OP_UNSUPPORTED = 8

/**
 * 把 ssh2 抛出的 SFTP 错误归一为 SftpError。
 *
 * ssh2 在 status 响应上构造的 Error 会把协议状态码放在 `err.code`（数字），
 * 但部分路径（如管道中断）抛的是普通的 Node 错误，因此这里两条线索都要看。
 */
export function classifySftpError(err: unknown, fallbackMessage = '文件操作失败'): SftpError {
  if (err instanceof SftpError) return err

  const code = typeof err === 'object' && err !== null && 'code' in err
    ? (err as { code?: unknown }).code
    : undefined
  const message = err instanceof Error && err.message ? err.message : fallbackMessage

  if (typeof code === 'number') {
    switch (code) {
      case STATUS_NO_SUCH_FILE:
        return new SftpError('NOT_FOUND', message, { cause: err })
      case STATUS_PERMISSION_DENIED:
        return new SftpError('PERMISSION_DENIED', message, {
          hint: '请确认该账号对目标路径具有相应权限。',
          cause: err,
        })
      case STATUS_OP_UNSUPPORTED:
        return new SftpError('UNSUPPORTED', message, {
          hint: '远端 SFTP 服务未实现该操作（常见于老设备或受限的子系统）。',
          cause: err,
        })
      case STATUS_FAILURE:
        // FAILURE 是「其它原因」，需要靠消息进一步分辨
        break
      case STATUS_OK:
      case STATUS_EOF:
        break
      default:
        break
    }
  }

  // Node 侧的本地文件系统错误码（本地侧操作会走到这里）
  if (typeof code === 'string') {
    switch (code) {
      case 'ENOENT':
        return new SftpError('NOT_FOUND', message, { cause: err })
      case 'EACCES':
      case 'EPERM':
        return new SftpError('PERMISSION_DENIED', message, { cause: err })
      case 'EEXIST':
        return new SftpError('ALREADY_EXISTS', message, { cause: err })
      case 'EISDIR':
        return new SftpError('WRONG_TYPE', message, { cause: err })
      case 'ENOTDIR':
        return new SftpError('WRONG_TYPE', message, { cause: err })
      case 'ENOTEMPTY':
        return new SftpError('NOT_EMPTY', message, { cause: err })
      case 'ENOSPC':
        return new SftpError('IO', `${message}（目标磁盘空间不足）`, { cause: err })
      default:
        break
    }
  }

  const lower = message.toLowerCase()
  if (lower.includes('no such file') || lower.includes('not exist')) {
    return new SftpError('NOT_FOUND', message, { cause: err })
  }
  if (lower.includes('permission denied')) {
    return new SftpError('PERMISSION_DENIED', message, { cause: err })
  }
  if (lower.includes('failure')) {
    return new SftpError('IO', message, { cause: err })
  }

  return new SftpError('IO', message, { cause: err })
}
