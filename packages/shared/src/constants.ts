/**
 * 全项目共享常量。前后端均从此处取值，避免硬编码漂移。
 */

export const APP_NAME = 'WebTerm'

export const APP_VERSION = '0.2.0'

/** REST 接口统一前缀 */
export const API_PREFIX = '/api'

/** 终端 WebSocket 端点前缀；实际路径为 /ws/terminal/:terminalId */
export const WS_PATH = '/ws'

/** SFTP WebSocket 端点：/ws/sftp/:sftpId */
export const WS_SFTP_PATH = `${WS_PATH}/sftp`

/**
 * 全局事件通道端点：/ws/events（阶段 9）。
 *
 * 与终端 WS 的区别：终端 WS 是**点对点**的（一条连接对一个终端，二进制帧跑数据），
 * 这里是**广播**的（一个页面一条连接，只跑低频 JSON 事件）。
 * 插件通知、插件列表变更这类「不属于任何单个终端」的消息走这里 ——
 * 挂在终端 WS 上会有一个尴尬的后果：没开终端就看不了通知。
 */
export const WS_EVENTS_PATH = `${WS_PATH}/events`

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

/* ------------------------------------------------------------------ */
/* 阶段 4：Telnet（明文终端协议）                                       */
/* ------------------------------------------------------------------ */

/** 支持的连接协议 */
export const CONNECTION_PROTOCOLS = ['ssh', 'telnet'] as const

export type ConnectionProtocol = (typeof CONNECTION_PROTOCOLS)[number]

/** 各协议的默认端口：SSH 22 / Telnet 23 */
export const DEFAULT_PORTS: Record<ConnectionProtocol, number> = {
  ssh: 22,
  telnet: 23,
}

export const PROTOCOL_LABEL: Record<ConnectionProtocol, string> = {
  ssh: 'SSH',
  telnet: 'Telnet',
}

/** Telnet 建连超时（毫秒）。Telnet 没有握手往返，超时给短一些 */
export const TELNET_CONNECT_TIMEOUT_MS = 12_000

/** Telnet 探测时读取欢迎语（banner）的最长等待（毫秒） */
export const TELNET_BANNER_WAIT_MS = 800

/** Telnet 探测时 banner 的截断长度，避免把设备的大量输出灌进响应 */
export const TELNET_BANNER_MAX_CHARS = 512

/** 认证方式白名单 */
export const AUTH_METHODS = ['password', 'privateKey'] as const

export type AuthMethodName = (typeof AUTH_METHODS)[number]

/* ------------------------------------------------------------------ */
/* 阶段 3：SFTP                                                         */
/* ------------------------------------------------------------------ */

/** 传输队列默认并发数（同目录同文件会被强制串行化，避免互相覆盖） */
export const SFTP_DEFAULT_CONCURRENCY = 3

/** 传输进度上报节流（毫秒）。太密会淹没 WebSocket，太疏则进度条卡顿 */
export const SFTP_PROGRESS_INTERVAL_MS = 250

/** 单次读写的块大小。SFTP 逐包确认，过大反而降低吞吐 */
export const SFTP_CHUNK_BYTES = 128 * 1024

/** 传输任务在终态保留的时长，之后从内存中清理 */
export const SFTP_TRANSFER_RETENTION_MS = 30 * 60_000

/** 速度滑动平均的采样窗口（样本数） */
export const SFTP_SPEED_WINDOW = 8

/** 状态码：SFTP 会话不存在 */
export const SFTP_NOT_FOUND_CODE = 'SFTP_NOT_FOUND'
