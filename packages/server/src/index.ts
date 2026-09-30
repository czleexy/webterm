import { buildApp } from './app.js'
import { ensureDataDirs, loadConfig } from './config/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  ensureDataDirs(config)

  const { app } = await buildApp(config)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`收到 ${signal}，正在优雅关闭…`)
    try {
      // app.close 会触发 onClose 钩子，进而关闭所有 SSH 终端会话
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

  // 非回环监听时每次都提醒一次：这条警告的价值在于「换台机器部署时能立刻看到」，
  // 只写在文档里没人会去翻。
  if (!config.isLoopbackHost) {
    app.log.warn(
      `正在监听 ${config.host}:${config.port} —— 本服务当前**没有内置访问认证**，` +
        '同网段任何人都能使用它发起连接。请确保这台机器处在受信任的网络里，' +
        '或在前面放一层带认证的反向代理。',
    )
  }

  if (!config.isDev) {
    app.log.info(`打开浏览器访问 http://${config.isLoopbackHost ? 'localhost' : config.host}:${config.port}`)
  }
}

main().catch((err: unknown) => {
  console.error('[webterm] 服务启动失败：', err)
  process.exit(1)
})
