/**
 * 全局事件 WebSocket 端点：/ws/events（阶段 9）。
 *
 * 与终端 WS 的差别（这个差别决定了它必须单独存在）：
 * - 终端 WS 是**点对点**的，路径里带 terminalId，还要附加令牌鉴权；
 * - 这里是**广播**的，一个页面一条连接，只跑低频 JSON 事件。
 *
 * 鉴权：与终端 WS 不同，本端点**不要求令牌** —— 它只推「插件发了条通知」
 * 这类不含会话数据的消息，且服务端默认只监听 127.0.0.1。
 * 真要暴露到局域网时要靠外层（反向代理的认证，或干脆别暴露）来把关，
 * 而不是在这里再造一个令牌体系 —— 本端点没有任何「能拿到就会泄露什么」的能力。
 *
 * 保活：每 30 秒发一个协议级 ping 帧。浏览器 WebSocket 会自动回 pong，
 * 前端一行代码都不用写 —— 这是最省事的「别让中间设备把空闲连接掐了」方案。
 */
import type { FastifyPluginAsync } from 'fastify'
import { WS_HEARTBEAT_INTERVAL_MS } from '@webterm/shared'

export const eventWsRoutes: FastifyPluginAsync = async (app) => {
  const hub = app.events

  app.get('/events', { websocket: true }, (socket, request) => {
    const remove = hub.add(socket)
    app.log.debug({ client: request.ip, clients: hub.size }, '全局事件通道已连接')

    const keepalive = setInterval(() => {
      try {
        socket.ping()
      } catch {
        remove()
        clearInterval(keepalive)
      }
    }, WS_HEARTBEAT_INTERVAL_MS)
    keepalive.unref?.()

    const cleanup = (): void => {
      clearInterval(keepalive)
      remove()
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })
}
