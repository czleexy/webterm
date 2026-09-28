/**
 * REST 层的统一错误响应。
 *
 * 约定：所有失败响应体都是 `{ error, message, details? }`（见 shared/api.ts 的 ApiError），
 * 前端只需一处解析逻辑。SSH 特有的错误码放在 `error` 字段里，
 * 便于前端按码给出针对性提示，而不是去正则匹配 message。
 */
import type { FastifyReply } from 'fastify'
import type { ApiError, TerminalErrorCode } from '@webterm/shared'
import type { ZodError } from 'zod'
import { ERROR_CODE_DESCRIPTION, SshError } from '../ssh/errors.js'

export function sendValidationError(reply: FastifyReply, error: ZodError): FastifyReply {
  const body: ApiError = {
    error: 'VALIDATION_FAILED',
    message: '请求参数校验失败',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  }
  return reply.code(400).send(body)
}

/** SSH 错误码 → HTTP 状态码 */
const STATUS_BY_CODE: Record<TerminalErrorCode, number> = {
  // 参数/环境问题
  UNREACHABLE: 502,
  ALGORITHM_MISMATCH: 502,
  HOST_KEY_REJECTED: 409,
  AUTH_FAILED: 401,
  AUTH_METHOD_UNSUPPORTED: 401,
  TIMEOUT: 504,
  CHANNEL_REJECTED: 502,
  PTY_FAILED: 502,
  TRANSPORT: 502,
  INVALID_CONFIG: 400,
  FORWARD_REJECTED: 502,
  FORWARD_TIMEOUT: 504,
  INTERNAL: 500,
}

export function sendSshError(reply: FastifyReply, err: unknown): FastifyReply {
  const sshErr =
    err instanceof SshError
      ? err
      : new SshError('INTERNAL', err instanceof Error ? err.message : String(err))

  const body: ApiError = {
    error: sshErr.code,
    // 把错误码的中文含义与原始消息都带上，前端提示与排障都够用
    message: sshErr.hint
      ? `${ERROR_CODE_DESCRIPTION[sshErr.code]}：${sshErr.message}\n\n${sshErr.hint}`
      : `${ERROR_CODE_DESCRIPTION[sshErr.code]}：${sshErr.message}`,
  }

  return reply.code(STATUS_BY_CODE[sshErr.code] ?? 500).send(body)
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error, message } satisfies ApiError)
}
