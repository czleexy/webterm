import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { API_PREFIX, APP_NAME, APP_VERSION } from '@webterm/shared'
import type { AppConfig } from './config/index.js'
import { healthRoutes } from './api/rest/health.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 装配 Fastify 实例。
 * 开发态只提供 API；生产态额外托管 packages/web/dist 静态产物。
 */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isDev
      ? {
          level: config.logLevel,
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
              messageFormat: '{msg}',
            },
          },
        }
      : { level: config.logLevel },
    trustProxy: false,
  })

  await app.register(healthRoutes, { prefix: API_PREFIX })

  // dist 相对本文件定位：src/app.ts -> ../../web/dist，dist/app.js -> ../../web/dist
  const webDist = path.resolve(here, '../../web/dist')
  // 仅生产模式托管静态产物：开发态由 Vite 提供前端，避免误访问到过期的构建结果
  const serveWeb = !config.isDev && existsSync(path.join(webDist, 'index.html'))

  if (serveWeb) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })
    app.log.info(`已挂载前端静态资源：${webDist}`)
  } else if (config.isDev) {
    app.log.info('开发模式：前端由 Vite 开发服务器提供，本进程仅提供 API')
  } else {
    app.log.warn(
      `未找到前端产物（${webDist}），当前仅提供 API 服务；请先执行 npm run build`,
    )
  }

  app.setNotFoundHandler((request, reply) => {
    // 接口路径统一返回 JSON 错误，不做 SPA 回退
    if (request.url.startsWith(API_PREFIX)) {
      return reply.code(404).send({
        error: 'NOT_FOUND',
        message: `接口不存在：${request.method} ${request.url}`,
      })
    }
    if (serveWeb) {
      // 非接口路径回退到 index.html，支持前端路由（hash 之外的路径形式）
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({
      error: 'NOT_FOUND',
      message: '前端产物未构建，请先执行 npm run build',
    })
  })

  // 有前端产物时由 @fastify/static 直接返回 index.html，此处不再注册 `/`，避免路由冲突
  if (!serveWeb) {
    app.get('/', async (_request, reply) => {
      return reply.type('text/plain; charset=utf-8').send(
        `${APP_NAME} ${APP_VERSION} 服务运行中\n` +
          `API 前缀：${API_PREFIX}\n` +
          `前端地址：${config.isDev ? `http://localhost:5173（Vite 开发服务器）` : '未构建，请执行 npm run build'}\n`,
      )
    })
  }

  return app
}
