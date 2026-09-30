/**
 * SFTP WebSocket 端点：/ws/sftp/:sftpId?token=<attachToken>
 *
 * 职责很窄 —— 只推送传输队列的状态变化。目录列举与文件操作全部走 REST，
 * 因为它们都需要明确的成败返回、也天然适合 HTTP 语义；
 * 而传输进度是「服务端主动、持续、高频」的事件流，用 WebSocket 最合适。
 *
 * 附加时先下发一次全量快照，再推增量：这样断线重连后不会因为漏掉
 * 若干条增量事件而让界面上的进度永久停在错误的位置。
 */
import type { FastifyPluginAsync } from 'fastify'
import { parseSftpClientControl, type TransferTask } from '@webterm/shared'
import { sendError } from '../errors.js'

interface SftpParams {
  sftpId: string
}

interface SftpQuery {
  token?: string
}

const CLOSE_UNAUTHORIZED = 4401
const CLOSE_NOT_FOUND = 4404

export const sftpWsRoutes: FastifyPluginAsync = async (app) => {
  const manager = app.sftp

  app.get<{ Params: SftpParams; Querystring: SftpQuery }>(
    '/:sftpId',
    { websocket: true },
    (socket, request) => {
      const { sftpId } = request.params
      const token = request.query.token

      if (!token) {
        socket.send(
          JSON.stringify({ t: 'error', code: 'SESSION_NOT_FOUND', message: '缺少附加令牌', fatal: true }),
        )
        socket.close(CLOSE_UNAUTHORIZED, 'missing attach token')
        return
      }

      const entry = manager.verifyToken(sftpId, token)
      if (!entry) {
        const exists = manager.get(sftpId) !== undefined
        socket.send(
          JSON.stringify({
            t: 'error',
            code: 'SESSION_NOT_FOUND',
            message: exists ? '附加令牌无效' : 'SFTP 会话不存在或已关闭',
            fatal: true,
          }),
        )
        socket.close(exists ? CLOSE_UNAUTHORIZED : CLOSE_NOT_FOUND, 'unauthorized')
        return
      }

      const { session, queue } = entry
      // 阶段 7：WS 附加也更新来源 IP（传输虽走 REST 创建，IP 以最近一次交互为准）
      entry.clientIp = request.ip || '—'
      app.log.info({ sftpId }, 'SFTP WebSocket 已附加')

      const send = (payload: unknown): void => {
        try {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
        } catch (err) {
          app.log.warn({ sftpId, err: String(err) }, '推送 SFTP 事件失败')
        }
      }

      send({
        t: 'ready',
        sftpId: session.id,
        remoteHome: session.remoteHome,
        localRoot: session.localRoot,
      })
      send({ t: 'transfers', tasks: queue.list() })

      const onUpdate = (task: TransferTask): void => send({ t: 'transfer', task })
      const onRemoved = (taskId: string): void => send({ t: 'removed', taskId })
      const onClosed = (reason: string): void => {
        send({ t: 'error', code: 'SESSION_NOT_FOUND', message: reason, fatal: true })
        try {
          socket.close(1000, 'session closed')
        } catch {
          /* 忽略 */
        }
      }

      queue.on('update', onUpdate)
      queue.on('removed', onRemoved)
      session.on('closed', onClosed)

      const detach = (): void => {
        queue.off('update', onUpdate)
        queue.off('removed', onRemoved)
        session.off('closed', onClosed)
      }

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        try {
          if (isBinary) return // SFTP 通道没有二进制上行
          const text = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8')
          const msg = parseSftpClientControl(text)
          if (msg?.t === 'ping') send({ t: 'pong' })
        } catch (err) {
          app.log.warn({ sftpId, err: String(err) }, '处理 SFTP WebSocket 消息失败')
        }
      })

      socket.on('close', (code: number) => {
        app.log.info({ sftpId, code }, 'SFTP WebSocket 已断开')
        detach()
      })
      socket.on('error', (err: Error) => {
        app.log.warn({ sftpId, err: err.message }, 'SFTP WebSocket 发生错误')
        detach()
      })
    },
  )

  // 便于开发态确认端点已注册
  app.get<{ Params: SftpParams }>('/:sftpId/status', async (request, reply) => {
    const entry = manager.entry(request.params.sftpId)
    if (!entry) return sendError(reply, 404, 'SESSION_NOT_FOUND', 'SFTP 会话不存在或已关闭')
    return reply.send({
      sftpId: entry.session.id,
      closed: entry.session.closed,
      reusedConnection: entry.session.reusedConnection,
      remoteHome: entry.session.remoteHome,
      localRoot: entry.session.localRoot,
      transfers: entry.queue.list().length,
    })
  })
}
