import path from 'node:path'
import { mkdirSync } from 'node:fs'
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
  }
}

/** 确保运行时目录存在。幂等，可重复调用。 */
export function ensureDataDirs(config: AppConfig): void {
  for (const dir of [config.dataDir, config.logDir, config.keyDir, config.tmpDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
