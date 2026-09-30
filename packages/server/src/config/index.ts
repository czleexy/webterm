import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '@webterm/shared'

const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
])

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  WEBTERM_HOST: z.string().min(1).default(DEFAULT_SERVER_HOST),
  WEBTERM_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_SERVER_PORT),
  WEBTERM_DATA_DIR: z.string().min(1).default('./data'),
  WEBTERM_LOG_LEVEL: LogLevelSchema.default('info'),
  WEBTERM_ALLOW_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173'),
  /**
   * 文件面板中「本地」一侧允许访问的根目录。
   * 缺省为用户家目录：既能满足绝大多数上传下载需求，又不会让浏览器端
   * 意外获得整机文件系统的访问能力。
   */
  WEBTERM_LOCAL_ROOT: z.string().min(1).optional(),
  /** SFTP 传输并发上限 */
  WEBTERM_SFTP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  /**
   * 前端产物目录。
   *
   * 不填时按「相对本文件向上两级找 web/dist」推断 —— 这在源码仓库里成立，
   * 但发布形态（npm 包 / 便携目录 / Docker 镜像）里目录结构是自己定的，
   * 那套推断会落空。与其要求打包脚本去迎合源码布局，不如给一个显式的旋钮。
   */
  WEBTERM_WEB_DIR: z.string().min(1).optional(),
  /**
   * 确认「我知道开放局域网当前没有内置认证」。
   *
   * WebTerm 的访问控制目前只有两条：默认只监听回环地址、以及保险库主密码
   * （那个保护的是**凭据**，不是 HTTP 访问）。也就是说一旦绑到 0.0.0.0，
   * 同网段任何人都能打开界面并以本机身份发起 SSH 连接 —— 需求文档里的
   * 服务访问密码（F7.4）尚未实现。
   *
   * 与其在文档里写一句「请先设置访问密码」而程序照绑不误，不如让这件事
   * **必须被显式确认**：绑非回环地址而没设这个开关，直接拒绝启动。
   * 这不是认证，它是把「悄悄不安全」变成「明确的不安全」。
   */
  WEBTERM_ALLOW_INSECURE_LAN: z
    .enum(['0', '1', 'true', 'false'])
    .default('false')
    .transform((v) => v === '1' || v === 'true'),
})

export interface AppConfig {
  host: string
  port: number
  isDev: boolean
  logLevel: z.infer<typeof LogLevelSchema>
  /** 数据根目录（绝对路径） */
  dataDir: string
  logDir: string
  keyDir: string
  tmpDir: string
  dbFile: string
  /** 插件根目录（绝对路径）：放进去一个目录就等于装了一个插件 */
  pluginDir: string
  /** WebSocket / CORS 允许的来源白名单 */
  allowOrigins: string[]
  /** 文件面板「本地」侧允许访问的根目录（绝对路径） */
  localRoot: string
  /** SFTP 传输并发上限 */
  sftpConcurrency: number
  /** 前端产物目录（绝对路径）；未显式配置时为 undefined，由 app.ts 按源码布局推断 */
  webDir?: string
  /** 是否已显式确认「开放局域网、当前无内置认证」 */
  allowInsecureLan: boolean
  /** 监听地址是否为回环（决定启动时要不要打安全警告） */
  isLoopbackHost: boolean
}

/** 回环地址判定：只认回环就够，不需要完整的地址解析 */
function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '127.0.0.1' ||
    host.startsWith('127.')
  )
}

/**
 * 读取并校验环境变量。校验失败直接抛错，避免带着错误配置启动。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`环境变量校验失败：\n${detail}`)
  }

  const e = parsed.data
  const dataDir = path.resolve(e.WEBTERM_DATA_DIR)
  const localRoot = path.resolve(e.WEBTERM_LOCAL_ROOT ?? homedir())

  if (!existsSync(localRoot)) {
    throw new Error(
      `WEBTERM_LOCAL_ROOT 指向的目录不存在：${localRoot}\n` +
        '该目录是文件面板「本地」一侧的根，必须是已存在的目录。',
    )
  }

  // 开放局域网 = 把「能通过这台机器 SSH 到任何地方」的能力交给整个网段。
  // 当前版本没有内置的 HTTP 访问认证（需求 F7.4 未实现），所以这一步不能是默认行为。
  const loopback = isLoopbackHost(e.WEBTERM_HOST)
  if (!loopback && !e.WEBTERM_ALLOW_INSECURE_LAN) {
    throw new Error(
      `拒绝启动：WEBTERM_HOST=${e.WEBTERM_HOST} 会让本服务对整个网络可见，而当前版本**没有内置的访问认证**。\n\n` +
        '这意味着同网段的任何人都能打开界面、并以这台机器的身份发起 SSH / SFTP / 隧道操作。\n' +
        '保险库主密码保护的是「保存的凭据」，不是对网页的访问。\n\n' +
        '想继续，请二选一：\n' +
        '  1.（推荐）保持监听 127.0.0.1，需要远程访问就用 SSH 端口转发：\n' +
        '       ssh -L 8080:127.0.0.1:8080 你的用户名@这台机器\n' +
        '  2.（确认风险）在反向代理后面启用认证，或确认这台机器处在你完全信任的网络里，\n' +
        '     然后显式设置 WEBTERM_ALLOW_INSECURE_LAN=1 重新启动。\n',
    )
  }

  return {
    host: e.WEBTERM_HOST,
    port: e.WEBTERM_PORT,
    isDev: e.NODE_ENV !== 'production',
    logLevel: e.WEBTERM_LOG_LEVEL,
    dataDir,
    logDir: path.join(dataDir, 'logs'),
    keyDir: path.join(dataDir, 'keys'),
    tmpDir: path.join(dataDir, 'tmp'),
    dbFile: path.join(dataDir, 'webterm.db'),
    pluginDir: path.join(dataDir, 'plugins'),
    allowOrigins: e.WEBTERM_ALLOW_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    localRoot,
    sftpConcurrency: e.WEBTERM_SFTP_CONCURRENCY,
    webDir: e.WEBTERM_WEB_DIR ? path.resolve(e.WEBTERM_WEB_DIR) : undefined,
    allowInsecureLan: e.WEBTERM_ALLOW_INSECURE_LAN,
    isLoopbackHost: loopback,
  }
}

/** 确保运行时目录存在。幂等，可重复调用。 */
export function ensureDataDirs(config: AppConfig): void {
  // pluginDir 一起建出来：用户装了 WebTerm 之后要做的第一件事就是往这里放插件，
  // 「目录不存在，请先手动创建」是最没必要的一道门槛
  for (const dir of [config.dataDir, config.logDir, config.keyDir, config.tmpDir, config.pluginDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
