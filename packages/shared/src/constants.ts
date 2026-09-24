/**
 * 全项目共享常量。前后端均从此处取值，避免硬编码漂移。
 */

export const APP_NAME = 'WebTerm'

export const APP_VERSION = '0.2.0'

/** REST 接口统一前缀 */
export const API_PREFIX = '/api'

/** 终端 WebSocket 端点前缀；实际路径为 /ws/terminal/:terminalId */
export const WS_PATH = '/ws'

/** 服务端默认监听端口 */
export const DEFAULT_SERVER_PORT = 8080

/** 开发态前端端口（与 vite.config.ts 保持一致） */
export const DEFAULT_WEB_PORT = 5173

/** 服务端默认监听地址；局域网访问需显式覆盖 */
export const DEFAULT_SERVER_HOST = '127.0.0.1'

/** 终端默认滚动缓冲行数 */
export const DEFAULT_SCROLLBACK = 10_000

/** 终端默认尺寸（新建标签时的初始值） */
export const DEFAULT_TERM_COLS = 120
export const DEFAULT_TERM_ROWS = 30

/** 默认 TERM 环境变量值 */
export const DEFAULT_TERM = 'xterm-256color'

/** 终端输出背压水位（字节）。
 * 服务端缓冲超过 HIGH 时暂停读取远端，回落到 LOW 以下再恢复，
 * 避免 `cat` 大文件时把 Node 进程内存打爆。 */
export const BACKPRESSURE_HIGH_WATER_MARK = 64 * 1024
export const BACKPRESSURE_LOW_WATER_MARK = 16 * 1024

/** 背压状态检查间隔（毫秒） */
export const BACKPRESSURE_CHECK_INTERVAL_MS = 50

/** SSH 连接与认证超时（毫秒） */
export const SSH_READY_TIMEOUT_MS = 20_000

/** 终端 WebSocket 心跳间隔（毫秒） */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000

/** 终端空闲回收时间（毫秒）。客户端断开后超过该时长仍未重连则关闭 SSH 连接 */
export const TERMINAL_IDLE_TIMEOUT_MS = 5 * 60_000

/** 终端在未附加状态下允许存活的时间（毫秒）——创建后需尽快附加 */
export const TERMINAL_ATTACH_GRACE_MS = 30_000

/** 状态码：终端未找到 */
export const TERMINAL_NOT_FOUND_CODE = 'TERMINAL_NOT_FOUND'

/** 支持的字符编码白名单 */
export const SUPPORTED_ENCODINGS = [
  'utf8',
  'gbk',
  'gb18030',
  'big5',
  'latin1',
] as const

export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number]

/** 认证方式白名单 */
export const AUTH_METHODS = ['password', 'privateKey'] as const

export type AuthMethodName = (typeof AUTH_METHODS)[number]
