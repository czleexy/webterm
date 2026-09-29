/**
 * 端口转发（隧道）接口。
 *
 * 隧道挂在终端会话的 SSH 连接上，因此所有写操作都以 `terminalId` 指认宿主；
 * 列出接口则是全局的 —— 用户关心的是「我开了哪些隧道」，而不是
 * 「这台设备上开了哪些」，面板里一眼看到全部才能统一收拾。
 *
 * 关于状态码：
 *   端口被占用 → 409（与主机密钥冲突一样属于「资源冲突」，不是参数写错）
 *   无权限监听 → 403
 *   目标不可达 / 远端拒绝转发 → 502（链路问题，不是请求问题）
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { CreateTunnelRequest, ListTunnelsResponse, TunnelInfo } from '@webterm/shared'
import { ERROR_CODE_DESCRIPTION } from '../../ssh/errors.js'
import { TunnelError } from '../../tunnel/errors.js'
import type { TunnelBase } from '../../tunnel/tunnel-base.js'
import type { TunnelManager } from '../../tunnel/tunnel-manager.js'
import type { TerminalManager } from '../../terminal/terminal-manager.js'
import { CreateTunnelRequestSchema } from '../schemas.js'
import { sendError, sendValidationError } from '../errors.js'

/** 隧道错误码 → HTTP 状态码 */
const STATUS_BY_TUNNEL_CODE: Record<string, number> = {
  PORT_IN_USE: 409,
  PORT_DENIED: 403,
  FORWARD_REJECTED: 502,
  FORWARD_TIMEOUT: 504,
  INVALID_CONFIG: 400,
  TRANSPORT: 502,
  INTERNAL: 500,
}

/** 把 TunnelError 转成统一错误响应（含错误码的中文含义与处置建议） */
function sendTunnelError(reply: FastifyReply, err: unknown): FastifyReply {
  const tunnelErr =
    err instanceof TunnelError
      ? err
      : new TunnelError('INTERNAL', err instanceof Error ? err.message : String(err))
  const description = ERROR_CODE_DESCRIPTION[tunnelErr.code] ?? '端口转发失败'
  const message = tunnelErr.hint
    ? `${description}：${tunnelErr.message}\n\n${tunnelErr.hint}`
    : `${description}：${tunnelErr.message}`
  return sendError(reply, STATUS_BY_TUNNEL_CODE[tunnelErr.code] ?? 500, tunnelErr.code, message)
}

interface TunnelRef {
  manager: TunnelManager
  tunnel: TunnelBase
}

/** 按隧道 id 反查（隧道可能挂在某个前端已关掉标签、服务端仍存活的会话上） */
function findTunnel(manager: TerminalManager, tunnelId: string): TunnelRef | undefined {
  for (const session of manager.all()) {
    const tunnelManager = session.tunnelManager
    if (!tunnelManager) continue
    const tunnel = tunnelManager.get(tunnelId)
    if (tunnel) return { manager: tunnelManager, tunnel }
  }
  return undefined
}

/** 取会话的隧道管理器；不可用时给出针对性说明 */
function tunnelManagerOf(
  manager: TerminalManager,
  terminalId: string,
): { ok: true; tunnels: TunnelManager } | { ok: false; status: number; code: string; message: string } {
  const session = manager.get(terminalId)
  if (!session) {
    return { ok: false, status: 404, code: 'TERMINAL_NOT_FOUND', message: '终端不存在或已关闭' }
  }
  const tunnelManager = session.tunnelManager
  if (!tunnelManager) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CONFIG',
      message:
        '该会话不支持端口转发：只有已建立 SSH 连接的会话才有可承载转发通道的协议层（Telnet 没有）',
    }
  }
  return { ok: true, tunnels: tunnelManager }
}

export const tunnelRoutes: FastifyPluginAsync = async (app) => {
  const manager = app.terminals

  /** 全局隧道列表 */
  app.get('/tunnels', async (): Promise<ListTunnelsResponse> => {
    const tunnels: TunnelInfo[] = []
    for (const session of manager.all()) {
      const tunnelManager = session.tunnelManager
      if (!tunnelManager) continue
      tunnels.push(...tunnelManager.list())
    }
    // 活跃的排前面；同状态保持创建顺序
    const rank = (t: TunnelInfo): number =>
      t.status === 'active' ? 0 : t.status === 'error' ? 1 : 2
    tunnels.sort((a, b) => rank(a) - rank(b))
    return { tunnels }
  })

  /** 某个终端的隧道 */
  app.get<{ Params: { id: string } }>('/terminals/:id/tunnels', async (request, reply) => {
    const found = tunnelManagerOf(manager, request.params.id)
    if (!found.ok) return sendError(reply, found.status, found.code, found.message)
    return reply.send({ tunnels: found.tunnels.list() } satisfies ListTunnelsResponse)
  })

  /** 创建并立即启动 */
  app.post('/tunnels', async (request, reply) => {
    const parsed = CreateTunnelRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    const input: CreateTunnelRequest = parsed.data
    const found = tunnelManagerOf(manager, input.terminalId)
    if (!found.ok) return sendError(reply, found.status, found.code, found.message)

    try {
      const tunnel = await found.tunnels.create(input.spec)
      return reply.code(201).send({ tunnel: tunnel.snapshot() })
    } catch (err) {
      return sendTunnelError(reply, err)
    }
  })

  /** 启动 / 重启一条已停止的隧道 */
  app.post<{ Params: { id: string } }>('/tunnels/:id/start', async (request, reply) => {
    const found = findTunnel(manager, request.params.id)
    if (!found) return sendError(reply, 404, 'TUNNEL_NOT_FOUND', '隧道不存在')
    try {
      await found.tunnel.start()
      return reply.send({ tunnel: found.tunnel.snapshot() })
    } catch (err) {
      return sendTunnelError(reply, err)
    }
  })

  /** 停止（保留定义，可再次启动；与「删除」区分开） */
  app.post<{ Params: { id: string } }>('/tunnels/:id/stop', async (request, reply) => {
    const found = findTunnel(manager, request.params.id)
    if (!found) return sendError(reply, 404, 'TUNNEL_NOT_FOUND', '隧道不存在')
    await found.tunnel.stop()
    return reply.send({ tunnel: found.tunnel.snapshot() })
  })

  /** 停止并移除 */
  app.delete<{ Params: { id: string } }>('/tunnels/:id', async (request, reply) => {
    const found = findTunnel(manager, request.params.id)
    if (!found) return sendError(reply, 404, 'TUNNEL_NOT_FOUND', '隧道不存在')
    await found.manager.remove(request.params.id)
    return reply.code(204).send()
  })
}
