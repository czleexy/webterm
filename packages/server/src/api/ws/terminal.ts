/**
 * 终端 WebSocket 端点。
 *
 * 路径：/ws/terminal/:terminalId?token=<attachToken>
 *
 * 鉴权说明：终端在 REST 阶段创建时生成一次性附加令牌，WS 建连必须携带。
 * 这样即使 terminalId 被猜到，没有令牌也无法接管别人的终端。
 * 令牌使用固定时间比较，避免时序侧信道。
 *
 * 帧约定见 shared/ws.ts：二进制帧是终端字节流，文本帧是 JSON 控制消息。
 */
import type { FastifyPluginAsync } from 'fastify'
import { parseClientControl } from '@webterm/shared'
import { sendError } from '../errors.js'

interface TerminalParams {
  terminalId: string
}

interface TerminalQuery {
  token?: string
}

/** 自定义关闭码：令牌无效（4000-4999 为应用自定义区间） */
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_NOT_FOUND = 4404

export const terminalWsRoutes: FastifyPluginAsync = async (app) => {
  const manager = app.terminals

  app.get<{ Params: TerminalParams; Querystring: TerminalQuery }>(
    '/terminal/:terminalId',
    { websocket: true },
    (socket, request) => {
      const { terminalId } = request.params
      const token = request.query.token

      if (!token) {
        // 关闭前先发一条 JSON，让前端能给出明确提示而不是只看到连接断开
        socket.send(
          JSON.stringify({
            t: 'error',
            code: 'INTERNAL',
            message: '缺少附加令牌',
            fatal: true,
          }),
        )
        socket.close(CLOSE_UNAUTHORIZED, 'missing attach token')
        return
      }

      const session = manager.verifyToken(terminalId, token)
      if (!session) {
        const exists = manager.get(terminalId) !== undefined
        socket.send(
          JSON.stringify({
            t: 'error',
            code: 'INTERNAL',
            message: exists ? '附加令牌无效' : '终端不存在或已关闭',
            fatal: true,
          }),
        )
        socket.close(exists ? CLOSE_UNAUTHORIZED : CLOSE_NOT_FOUND, 'unauthorized')
        return
      }

      app.log.info({ terminalId }, '终端 WebSocket 已附加')

      session.attach(socket)

      // 文本帧：JSON 控制消息
      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        try {
          if (isBinary) {
            // 二进制帧：终端键盘输入，原样交给会话处理
            const buf = Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.isBuffer(data)
                ? data
                : Buffer.from(data)
            session.handleInput(buf)
            return
          }

          const text = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8')
          const msg = parseClientControl(text)
          if (msg) {
            session.handleControl(msg)
          } else {
            app.log.debug({ terminalId, text: text.slice(0, 120) }, '收到无法解析的控制消息，已忽略')
          }
        } catch (err) {
          app.log.warn({ terminalId, err: String(err) }, '处理 WebSocket 消息失败')
        }
      })

      socket.on('close', (code: number) => {
        app.log.info({ terminalId, code }, '终端 WebSocket 已断开')
        session.detach(socket)
      })

      socket.on('error', (err: Error) => {
        app.log.warn({ terminalId, err: err.message }, '终端 WebSocket 发生错误')
        session.detach(socket)
      })
    },
  )

  // 便于前端在开发态确认端点已注册
  app.get<{ Params: TerminalParams }>('/terminal/:terminalId/status', async (request, reply) => {
    const session = manager.get(request.params.terminalId)
    if (!session) {
      return sendError(reply, 404, 'TERMINAL_NOT_FOUND', '终端不存在或已关闭')
    }
    return reply.send({
      terminalId: session.id,
      attached: session.attached,
      closed: session.closed,
      dimensions: session.dimensions,
    })
  })
}
