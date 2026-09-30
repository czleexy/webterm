/**
 * 会话日志接口：列表 / 行窗口预览 / 下载 / 删除 / 全局设置。
 *
 * 预览按行窗口随机访问（服务端有行偏移索引），前端做虚拟滚动；
 * 下载直接流式回传原始文件。文件 id 是相对日志根目录的 POSIX 路径，
 * 服务端校验它不会越出根目录（`..` 与绝对路径一律拒绝）。
 */
import { createReadStream } from 'node:fs'
import path from 'node:path'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type {
  ListLogFilesResponse,
  LogPreviewResponse,
  LoggingSettings,
} from '@webterm/shared'
import { LOG_PREVIEW_MAX_LINES } from '@webterm/shared'
import { LogStoreError } from '../../logging/log-store.js'
import { UpdateLoggingSettingsSchema } from '../schemas.js'
import { sendError, sendValidationError } from '../errors.js'

function sendLogError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LogStoreError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400
    return sendError(reply, status, err.code, err.message)
  }
  return sendError(reply, 500, 'INTERNAL', err instanceof Error ? err.message : String(err))
}

export const logRoutes: FastifyPluginAsync = async (app) => {
  const logging = app.logging

  /* ---------------- 设置 ---------------- */

  app.get('/logs/settings', async (): Promise<LoggingSettings> => {
    return logging.getSettings()
  })

  app.put('/logs/settings', async (request, reply) => {
    const parsed = UpdateLoggingSettingsSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    // 未带 id 的规则补一个（前端编辑器新增的行）；已有一律保留
    const settings = logging.updateSettings(
      {
        retentionDays: parsed.data.retentionDays,
        redactionRules: parsed.data.redactionRules?.map((rule, index) => ({
          id: rule.id ?? `rule_${Date.now()}_${index}`,
          name: rule.name,
          pattern: rule.pattern,
          replacement: rule.replacement,
          enabled: rule.enabled,
        })),
      },
      { ip: request.ip || '—' },
    )
    return { settings }
  })

  /* ---------------- 文件列表 ---------------- */

  app.get<{ Querystring: { sessionId?: string; date?: string } }>(
    '/logs/files',
    async (request): Promise<ListLogFilesResponse> => {
      const files = logging.listFiles({
        sessionId: request.query.sessionId || undefined,
        date: request.query.date || undefined,
      })
      // 文件总量受保留期约束，列表不分页；给前端一个恒真的分页形状以便扩展
      return { files, total: files.length, page: 1, pageSize: Math.max(files.length, 1) }
    },
  )

  /* ---------------- 预览 ---------------- */

  app.get<{ Params: { id: string }; Querystring: { start?: string; count?: string } }>(
    '/logs/files/:id/preview',
    async (request, reply): Promise<LogPreviewResponse | FastifyReply> => {
      const id = decodeURIComponent(request.params.id)
      const start = Number.parseInt(request.query.start ?? '0', 10)
      const count = Number.parseInt(request.query.count ?? String(LOG_PREVIEW_MAX_LINES), 10)
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1) {
        return sendError(reply, 400, 'INVALID_PARAM', 'start 与 count 必须是非负整数')
      }
      try {
        return await logging.preview(id, start, count)
      } catch (err) {
        return sendLogError(reply, err)
      }
    },
  )

  /* ---------------- 下载 ---------------- */

  app.get<{ Params: { id: string } }>(
    '/logs/files/:id/download',
    async (request, reply): Promise<FastifyReply> => {
      const id = decodeURIComponent(request.params.id)
      // 先走一次安全校验（NOT_FOUND / 越界都在这里暴露）
      try {
        await logging.preview(id, 0, 1)
      } catch (err) {
        return sendLogError(reply, err)
      }
      const absolute = logging.resolveFile(id)
      const basename = path.posix.basename(id)
      return reply
        .header('content-type', 'application/octet-stream')
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(basename)}`,
        )
        .send(createReadStream(absolute))
    },
  )

  /* ---------------- 删除 ---------------- */

  app.delete<{ Params: { id: string } }>(
    '/logs/files/:id',
    async (request, reply): Promise<{ ok: true }> => {
      const id = decodeURIComponent(request.params.id)
      try {
        await logging.removeFile(id)
      } catch (err) {
        return sendLogError(reply, err)
      }
      logging.recordAudit('log_delete', '会话日志', request.ip || '—', { files: 1 })
      return { ok: true }
    },
  )

  app.delete<{ Params: { dir: string } }>(
    '/logs/sessions/:dir',
    async (request, reply): Promise<{ ok: true; files: number } | FastifyReply> => {
      const dir = decodeURIComponent(request.params.dir)
      try {
        const files = await logging.removeSession(dir)
        logging.recordAudit('log_delete', `会话日志目录 ${dir}`, request.ip || '—', {
          files,
        })
        return { ok: true, files }
      } catch (err) {
        return sendLogError(reply, err)
      }
    },
  )
}
