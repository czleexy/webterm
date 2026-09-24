import type { FastifyPluginAsync } from 'fastify'
import { APP_NAME, APP_VERSION, type HealthResponse } from '@webterm/shared'

/** 进程启动时刻：由 uptime 反推，避免额外维护全局状态 */
const startedAtMs = Date.now() - process.uptime() * 1000

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      ok: true,
      name: APP_NAME,
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      startedAt: new Date(startedAtMs).toISOString(),
      // 当前存活的终端数（含尚未被 WebSocket 附加的）
      activeTabs: app.terminals.count,
    }
  })
}
