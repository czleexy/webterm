import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { API_PREFIX, APP_NAME, APP_VERSION, WS_PATH } from '@webterm/shared'
import type { AppConfig } from './config/index.js'
import { healthRoutes } from './api/rest/health.js'
import { sessionRoutes } from './api/rest/sessions.js'
import { terminalRoutes } from './api/rest/terminals.js'
import { capabilityRoutes } from './api/rest/capabilities.js'
import { vaultRoutes } from './api/rest/vault.js'
import { credentialRoutes } from './api/rest/credentials.js'
import { libraryRoutes } from './api/rest/library.js'
import { terminalWsRoutes } from './api/ws/terminal.js'
import { KnownHostsStore } from './ssh/known-hosts.js'
import { TerminalManager } from './terminal/terminal-manager.js'
import { Vault } from './security/vault.js'
import { CredentialStore } from './security/credential-store.js'
import { LibraryStore } from './db/library.js'
import { openDatabase } from './db/index.js'
import { SessionResolver } from './api/resolver.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// 让各路由插件能通过 app.terminals / app.vault 等访问共享状态，
// 避免把依赖一层层往下传参
declare module 'fastify' {
  interface FastifyInstance {
    terminals: TerminalManager
    knownHosts: KnownHostsStore
    vault: Vault
    credentials: CredentialStore
    library: LibraryStore
    sessionResolver: SessionResolver
  }
}

export interface BuiltApp {
  app: FastifyInstance
  terminals: TerminalManager
}

/**
 * 装配 Fastify 实例。
 * 开发态只提供 API；生产态额外托管 packages/web/dist 静态产物。
 */
export async function buildApp(config: AppConfig): Promise<BuiltApp> {
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
    // 终端上行是二进制帧，单帧最大 1 MiB 足够（粘贴大段文本时的上限）
    bodyLimit: 1024 * 1024,
  })

  const knownHosts = new KnownHostsStore(config.dataDir)
  const terminals = new TerminalManager(knownHosts, app.log)

  // 阶段 2：持久化与凭据保险库
  const db = openDatabase(config.dbFile)
  const vault = new Vault(db)
  const credentials = new CredentialStore(db, vault)
  const library = new LibraryStore(db, credentials)
  const sessionResolver = new SessionResolver(credentials)

  app.decorate('knownHosts', knownHosts)
  app.decorate('terminals', terminals)
  app.decorate('vault', vault)
  app.decorate('credentials', credentials)
  app.decorate('library', library)
  app.decorate('sessionResolver', sessionResolver)
  // 进程退出时统一关闭所有 SSH 连接，避免留下悬挂会话占用远端 VTY；
  // 保险库清零内存密钥，数据库正常关闭（WAL checkpoint）
  app.addHook('onClose', async () => {
    terminals.dispose()
    vault.lock()
    db.close()
  })

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 1024 * 1024,
      // 终端上行数据量小，但为了防止恶意客户端占用内存，仍设上限
      clientTracking: true,
    },
  })

  await app.register(healthRoutes, { prefix: API_PREFIX })
  await app.register(capabilityRoutes, { prefix: API_PREFIX })
  await app.register(vaultRoutes, { prefix: API_PREFIX })
  await app.register(credentialRoutes, { prefix: API_PREFIX })
  await app.register(libraryRoutes, { prefix: API_PREFIX })
  await app.register(sessionRoutes, { prefix: API_PREFIX })
  await app.register(terminalRoutes, { prefix: API_PREFIX })
  await app.register(terminalWsRoutes, { prefix: WS_PATH })

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
    if (request.url.startsWith(API_PREFIX) || request.url.startsWith(WS_PATH)) {
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
      message: '前端产物尚未构建，请先执行 npm run build',
    })
  })

  // 有前端产物时由 @fastify/static 直接返回 index.html，此处不再注册 `/`，避免路由冲突
  if (!serveWeb) {
    app.get('/', async (_request, reply) => {
      return reply.type('text/plain; charset=utf-8').send(
        `${APP_NAME} ${APP_VERSION} 服务运行中\n` +
          `API 前缀：${API_PREFIX}\n` +
          `终端端点：${WS_PATH}/terminal/:terminalId\n` +
          `前端地址：${config.isDev ? `http://localhost:5173（Vite 开发服务器）` : '未构建，请执行 npm run build'}\n`,
      )
    })
  }

  return { app, terminals }
}
