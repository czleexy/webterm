/**
 * 全项目共享常量。前后端均从此处取值，避免硬编码漂移。
 */

export const APP_NAME = 'WebTerm'

export const APP_VERSION = '0.1.0'

/** REST 接口统一前缀 */
export const API_PREFIX = '/api'

/** 终端 WebSocket 端点 */
export const WS_PATH = '/ws'

/** 服务端默认监听端口 */
export const DEFAULT_SERVER_PORT = 8080

/** 开发态前端端口（与 vite.config.ts 保持一致） */
export const DEFAULT_WEB_PORT = 5173

/** 服务端默认监听地址；局域网访问需显式覆盖 */
export const DEFAULT_SERVER_HOST = '127.0.0.1'

/** 终端默认滚动缓冲行数 */
export const DEFAULT_SCROLLBACK = 10_000

/** 支持的字符编码白名单 */
export const SUPPORTED_ENCODINGS = [
  'utf8',
  'gbk',
  'gb18030',
  'big5',
  'latin1',
] as const

export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number]
