/**
 * 终端会话管理接口。
 *
 * 注意分工：REST 负责「建立与销毁」终端（此时连接已真实建立，
 * 因此认证失败、算法不兼容、端口不通等错误能以标准 HTTP 状态码返回），
 * WebSocket 只负责「附加渲染端并转发字节流」。
 *
 * SSH 与 Telnet 共用这一组接口：两者的差异被收敛在 SessionConfig 的判别联合里，
 * 装配路径只需要处理「凭据从哪来」这一件事。
 */
import type { FastifyPluginAsync } from 'fastify'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  ListTerminalsResponse,
  SessionConfig,
  SshTarget,
  TerminalListItem,
} from '@webterm/shared'
import {
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
  WS_PATH,
  protocolOf,
  targetLabel,
  targetUsername,
} from '@webterm/shared'
import { LibraryError } from '../../db/library.js'
import { VaultError } from '../../security/vault.js'
import { CreateTerminalRequestSchema } from '../schemas.js'
import { sendError, sendTerminalError, sendValidationError } from '../errors.js'

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  const manager = app.terminals
  const resolver = app.sessionResolver

  app.get('/terminals', async (): Promise<ListTerminalsResponse> => {
    return { terminals: manager.list() }
  })

  app.post('/terminals', async (request, reply) => {
    const parsed = CreateTerminalRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    const input: CreateTerminalRequest = parsed.data

    // 两条装配路径：sessionId（会话库引用，服务端解密凭据 + 组装跳板链）
    // 或 config（快速连接，前端直传，不落库）
    let config: SessionConfig | undefined = input.config
    let jumpChain: SshTarget[] | undefined

    if (input.sessionId) {
      try {
        const { record } = app.library.getSessionRecord(input.sessionId)
        const protocol = protocolOf(record)
        const terminal = {
          cols: input.config?.terminal.cols ?? DEFAULT_TERM_COLS,
          rows: input.config?.terminal.rows ?? DEFAULT_TERM_ROWS,
          encoding: record.encoding,
          term: record.term,
        }

        if (protocol === 'telnet') {
          // Telnet 会话没有凭据可解、也没有跳板链可组装
          config = {
            protocol: 'telnet',
            target: { host: record.host, port: record.port },
            terminal,
          }
        } else {
          const plan = resolver.resolve(record)
          config = {
            protocol: 'ssh',
            target: plan.target,
            terminal,
            legacyCompat: record.legacyCompat ?? 'auto',
          }
          jumpChain = plan.jumpChain.length > 0 ? plan.jumpChain : undefined
        }
      } catch (err) {
        if (err instanceof VaultError) {
          return sendError(reply, 423, err.code, err.message)
        }
        if (err instanceof LibraryError) {
          const status = err.code === 'NOT_FOUND' ? 404 : 400
          return sendError(reply, status, err.code, err.message)
        }
        app.log.error({ err }, '解析会话配置失败')
        return sendError(reply, 500, 'INTERNAL', '解析会话配置失败')
      }
    }

    if (!config) {
      return sendError(reply, 400, 'INVALID_CONFIG', '缺少连接参数')
    }

    let session
    try {
      session = await manager.create({
        config,
        jumpChain,
        title: input.title ?? targetLabel(config),
      })
    } catch (err) {
      // SshError 与 TelnetError 都走同一条响应路径（结构一致）
      return sendTerminalError(reply, err)
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
      protocol: protocolOf(session.config),
      host: session.config.target.host,
      port: session.config.target.port,
      username: targetUsername(session.config),
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
