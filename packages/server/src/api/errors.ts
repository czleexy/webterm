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
import { TelnetError } from '../telnet/errors.js'

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

/** 错误码 → HTTP 状态码（两种协议共用一套映射） */
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

/** 带上 code 与中文说明的终端错误 */
interface TerminalErrorLike {
  code: TerminalErrorCode
  message: string
  hint?: string
}

/**
 * 终端类错误的统一出口。
 * SSH 与 Telnet 的 error 对象形状一致（code / message / hint），
 * 因此这里做一次结构判别就够，不必让每个调用方分别处理两种类型。
 */
export function sendTerminalError(reply: FastifyReply, err: unknown): FastifyReply {
  const normalized: TerminalErrorLike =
    err instanceof SshError || err instanceof TelnetError
      ? err
      : {
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        }

  const body: ApiError = {
    error: normalized.code,
    // 把错误码的中文含义与原始消息都带上，前端提示与排障都够用
    message: normalized.hint
      ? `${ERROR_CODE_DESCRIPTION[normalized.code]}：${normalized.message}\n\n${normalized.hint}`
      : `${ERROR_CODE_DESCRIPTION[normalized.code]}：${normalized.message}`,
  }

  return reply.code(STATUS_BY_CODE[normalized.code] ?? 500).send(body)
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error, message } satisfies ApiError)
}
