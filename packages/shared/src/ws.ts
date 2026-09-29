/**
 * 终端 WebSocket 双工协议。
 *
 * 传输约定（关键设计决策）：
 * - **二进制帧** = 终端原始字节流。客户端→服务端为键盘输入，服务端→客户端为 PTY 输出。
 *   直接用字节而非 JSON/base64，避免 base64 带来的 33% 体积膨胀与额外的解码开销。
 * - **文本帧** = JSON 控制消息。仅用于建连握手、窗口尺寸变更、退出通知等低频事件。
 *
 * 因此前端不需要解析二进制帧的内容，直接写入 xterm；控制消息才走 JSON。
 */
import type { ConnectionProtocol } from './constants.js'

/** 客户端 → 服务端的控制消息 */
export type ClientControlMessage =
  /** 终端窗口尺寸变化（用户拖拽面板、切换分屏时触发） */
  | { t: 'resize'; cols: number; rows: number }
  /** 应用层心跳，用于探测链路是否仍存活 */
  | { t: 'ping' }
  /** 客户端确认已消费的输出字节数，用于服务端背压腾出缓冲 */
  | { t: 'ack'; bytes: number }

/** 服务端 → 客户端的控制消息 */
export type ServerControlMessage =
  /** 建连成功，终端已就绪（此时才允许写入） */
  | {
      t: 'ready'
      terminalId: string
      /** 协商结果摘要，便于前端展示与排障 */
      info: TerminalNegotiationInfo
    }
  /** 终端进程结束（远端退出 / 通道关闭） */
  | {
      t: 'exit'
      code: number | null
      signal: string | null
      /** 结束原因的人类可读描述 */
      reason: string
    }
  /** 发生错误。fatal 为 true 时连接随即关闭 */
  | {
      t: 'error'
      code: TerminalErrorCode
      message: string
      fatal: boolean
    }
  /** 心跳响应 */
  | { t: 'pong' }
  /** 服务端进入背压保护，暂停向本连接推送输出 */
  | { t: 'flow'; action: 'pause' | 'resume' }

/** 终端错误码，前端据此给出针对性的提示文案 */
export type TerminalErrorCode =
  /** 主机不可达 / 端口不通 */
  | 'UNREACHABLE'
  /** 算法协商失败（老设备常需开启 legacy 算法） */
  | 'ALGORITHM_MISMATCH'
  /** 主机密钥校验未通过 */
  | 'HOST_KEY_REJECTED'
  /** 认证失败（用户名/口令/密钥错误） */
  | 'AUTH_FAILED'
  /** 认证方式不被服务端接受 */
  | 'AUTH_METHOD_UNSUPPORTED'
  /** 连接超时 */
  | 'TIMEOUT'
  /** 远端拒绝开启会话（设备侧限制，如无 CLI 权限或 VTY 线路耗尽） */
  | 'CHANNEL_REJECTED'
  /** PTY 分配失败 */
  | 'PTY_FAILED'
  /** 传输层错误 */
  | 'TRANSPORT'
  /** 请求参数非法（如跳板链层级超限） */
  | 'INVALID_CONFIG'
  /** 跳板机拒绝建立转发通道 */
  | 'FORWARD_REJECTED'
  /** 跳板机转发通道建立超时 */
  | 'FORWARD_TIMEOUT'
  /** 服务端内部错误 */
  | 'INTERNAL'

/** 建连后回传给前端的协商信息，用于「连接信息」面板展示 */
export interface TerminalNegotiationInfo {
  /** 连接协议；telnet 时下方 SSH 专有字段统一为 '—' */
  protocol: ConnectionProtocol
  host: string
  port: number
  /** Telnet 无登录名，恒为空串 */
  username: string
  /** 服务端软件标识串，如 SSH-2.0-OpenSSH_9.5；Telnet 通常为空 */
  serverIdent: string
  /** 实际协商出的密钥交换算法 */
  kex: string
  /** 实际使用的主机密钥算法 */
  hostKeyAlgorithm: string
  /** 客户端→服务端加密算法 */
  cipherC2s: string
  /** 服务端→客户端加密算法 */
  cipherS2c: string
  /** MAC 算法 */
  mac: string
  /** 使用的算法档案名（modern / legacy，用于排障） */
  profile: string
  /** 是否启用了 legacy 兼容算法 */
  legacy: boolean
  /** 终端编码 */
  encoding: string
  cols: number
  rows: number
  /**
   * Telnet 选项协商结果，仅 telnet 存在；用于排障
   * （例如「设备没打开回显」导致看起来像键盘失灵）
   */
  telnetOptions?: TelnetNegotiationSummary
}

/** Telnet 协商结果摘要 */
export interface TelnetNegotiationSummary {
  /** 远端是否负责回显（WILL ECHO）——为 false 时由本端做本地回显 */
  remoteEcho: boolean
  /** 是否协商成功「抑制继续」 */
  suppressGoAhead: boolean
  /** 远端是否索要了终端类型 */
  terminalTypeRequested: boolean
  /** 是否上报了窗口尺寸（NAWS） */
  windowSizeReported: boolean
  /** 协商中被双方确认启用的远端选项名列表，排障用 */
  remoteOptions: string[]
  /** 协商中被双方确认启用的本端选项名列表，排障用 */
  localOptions: string[]
}

/** 运行时校验：判断文本帧内容是否为合法的服务端控制消息 */
export function parseClientControl(raw: string): ClientControlMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const t = (parsed as { t?: unknown }).t
    if (t === 'resize') {
      const { cols, rows } = parsed as { cols?: unknown; rows?: unknown }
      if (typeof cols !== 'number' || typeof rows !== 'number') return null
      // 尺寸必须在合理范围内，避免恶意大值撑爆 PTY 内存
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null
      if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null
      return { t: 'resize', cols, rows }
    }
    if (t === 'ping') return { t: 'ping' }
    if (t === 'ack') {
      const { bytes } = parsed as { bytes?: unknown }
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
      return { t: 'ack', bytes }
    }
    return null
  } catch {
    return null
  }
}
