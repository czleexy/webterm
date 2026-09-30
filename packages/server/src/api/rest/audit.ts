/**
 * 审计查询接口。写入分散在各业务动作里（终端路由 / SFTP / 自动化路由），
 * 这里只负责读 —— 事件类型、时间区间过滤与分页。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { AuditEventType, QueryAuditResponse } from '@webterm/shared'
import { AUDIT_EVENTS } from '@webterm/shared'
import { sendError } from '../errors.js'

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/audit',
    async (request, reply): Promise<QueryAuditResponse | FastifyReply> => {
      const q = request.query
      const event = q.event
      if (event && !AUDIT_EVENTS.includes(event as AuditEventType)) {
        return sendError(reply, 400, 'INVALID_PARAM', `未知的事件类型：${event}`)
      }
      // ISO 8601 / YYYY-MM-DD 都接受；非法格式交给字符串比较自然为空
      const from = q.from || undefined
      const to = q.to || undefined
      const page = Number.parseInt(q.page ?? '1', 10)
      const pageSize = Number.parseInt(q.pageSize ?? '50', 10)

      return app.logging.queryAudit({
        event: (event as AuditEventType) || undefined,
        from,
        to,
        page: Number.isInteger(page) ? page : 1,
        pageSize: Number.isInteger(pageSize) ? pageSize : 50,
      })
    },
  )
}
