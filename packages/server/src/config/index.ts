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
  /** WebSocket / CORS 允许的来源白名单 */
  allowOrigins: string[]
  /** 文件面板「本地」侧允许访问的根目录（绝对路径） */
  localRoot: string
  /** SFTP 传输并发上限 */
  sftpConcurrency: number
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
    allowOrigins: e.WEBTERM_ALLOW_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    localRoot,
    sftpConcurrency: e.WEBTERM_SFTP_CONCURRENCY,
  }
}

/** 确保运行时目录存在。幂等，可重复调用。 */
export function ensureDataDirs(config: AppConfig): void {
  for (const dir of [config.dataDir, config.logDir, config.keyDir, config.tmpDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
