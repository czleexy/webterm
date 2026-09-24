import { buildApp } from './app.js'
import { ensureDataDirs, loadConfig } from './config/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  ensureDataDirs(config)

  const app = await buildApp(config)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`收到 ${signal}，正在优雅关闭…`)
    try {
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error(err, '关闭过程出错')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: config.host, port: config.port })

  if (!config.isDev) {
    app.log.info(`打开浏览器访问 http://${config.host}:${config.port}`)
  }
}

main().catch((err: unknown) => {
  console.error('[webterm] 服务启动失败：', err)
  process.exit(1)
})
