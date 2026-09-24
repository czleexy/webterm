/**
 * 终端会话管理接口。
 *
 * 注意分工：REST 负责「建立与销毁」终端（此时 SSH 连接已真实建立，
 * 因此认证失败、算法不兼容等错误能以标准 HTTP 状态码返回），
 * WebSocket 只负责「附加渲染端并转发字节流」。
 */
import type { FastifyPluginAsync } from 'fastify'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  ListTerminalsResponse,
  TerminalListItem,
} from '@webterm/shared'
import { WS_PATH } from '@webterm/shared'
import { SshError } from '../../ssh/errors.js'
import { CreateTerminalRequestSchema } from '../schemas.js'
import { sendError, sendSshError, sendValidationError } from '../errors.js'

/** 由配置推导一个默认标题，避免前端不传 title 时标签上出现空白 */
function defaultTitle(host: string, port: number, username: string): string {
  const suffix = port === 22 ? '' : `:${port}`
  return `${username}@${host}${suffix}`
}

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  const manager = app.terminals

  app.get('/terminals', async (): Promise<ListTerminalsResponse> => {
    return { terminals: manager.list() }
  })

  app.post('/terminals', async (request, reply) => {
    const parsed = CreateTerminalRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    const input: CreateTerminalRequest = parsed.data
    const { target, terminal, legacyCompat } = input.config

    let session
    try {
      session = await manager.create({
        config: {
          target,
          terminal,
          legacyCompat: legacyCompat ?? 'auto',
        },
        title: input.title ?? defaultTitle(target.host, target.port, target.username),
      })
    } catch (err) {
      if (err instanceof SshError) return sendSshError(reply, err)
      app.log.error({ err }, '创建终端失败')
      return sendError(reply, 500, 'INTERNAL', '创建终端时发生内部错误')
    }

    const info = session.negotiationInfo
    const response: CreateTerminalResponse = {
      terminalId: session.id,
      attachToken: session.attachToken,
      wsPath: `${WS_PATH}/terminal/${session.id}`,
      title: session.title,
      negotiation: info
        ? {
            serverIdent: info.serverIdent,
            kex: info.kex,
            hostKeyAlgorithm: info.hostKeyAlgorithm,
            cipher: info.cipherC2s,
            mac: info.mac,
            profile: info.profile,
            legacy: info.legacy,
          }
        : {
            serverIdent: session.serverVersionString,
            kex: 'unknown',
            hostKeyAlgorithm: 'unknown',
            cipher: 'unknown',
            mac: 'unknown',
            profile: 'unknown',
            legacy: false,
          },
    }

    return reply.code(201).send(response)
  })

  app.get<{ Params: { id: string } }>('/terminals/:id', async (request, reply) => {
    const session = manager.get(request.params.id)
    if (!session) {
      return sendError(reply, 404, 'TERMINAL_NOT_FOUND', '终端不存在或已关闭')
    }
    const item: TerminalListItem = {
      terminalId: session.id,
      title: session.title,
      host: session.config.target.host,
      port: session.config.target.port,
      username: session.config.target.username,
      attached: session.attached,
      createdAt: session.createdAt.toISOString(),
      cols: session.dimensions.cols,
      rows: session.dimensions.rows,
      encoding: session.config.terminal.encoding,
    }
    return reply.send({ terminal: item, negotiation: session.negotiationInfo ?? null })
  })

  app.delete<{ Params: { id: string } }>('/terminals/:id', async (request, reply) => {
    const closed = manager.close(request.params.id)
    if (!closed) {
      return sendError(reply, 404, 'TERMINAL_NOT_FOUND', '终端不存在或已关闭')
    }
    return reply.code(204).send()
  })
}
