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
import type { ScriptLogLevel, TriggerUiAction } from './automation.js'
import type { PluginLogLevel } from './plugin.js'

/** 客户端 → 服务端的控制消息 */
export type ClientControlMessage =
  /** 终端窗口尺寸变化（用户拖拽面板、切换分屏时触发） */
  | { t: 'resize'; cols: number; rows: number }
  /** 应用层心跳，用于探测链路是否仍存活 */
  | { t: 'ping' }
  /** 客户端确认已消费的输出字节数，用于服务端背压腾出缓冲 */
  | { t: 'ack'; bytes: number }
  /**
   * HTML 日志快照分片（阶段 7）。
   *
   * 前端用 SerializeAddon 序列化**整份**终端缓冲后按 LOG_HTML_CHUNK_BYTES
   * 切片上传；`final = true` 时服务端把装配好的快照原子写入当天的
   * `{date}.html`（整份替换，不是追加 —— 文件里永远是完整可回放的转录）。
   * 单帧受 WS maxPayload 约束，分片本身不会超过 1 MiB。
   */
  | { t: 'log-html'; seq: number; final: boolean; data: string }

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
  /**
   * 触发器命中（阶段 6）。
   *
   * 只有「需要渲染端配合」的动作才在这里出现：自动应答与执行脚本都在服务端
   * 就地完成了，前端收到这条消息是为了高亮那一行、弹通知、打标签，
   * 以及把「已自动应答 yes」这类事实回显给用户 —— 否则用户只看到屏幕自己动了，
   * 完全不知道是谁按的。
   */
  | {
      t: 'trigger'
      ruleId: string
      ruleName: string
      /** 命中的整行（已剥离 ANSI 控制序列） */
      line: string
      /** 行内实际匹配到的片段 */
      matched: string
      at: string
      /** 需要前端配合的动作 */
      ui: TriggerUiAction[]
      /** 已在服务端完成的动作摘要 */
      performed: string[]
    }
  /**
   * 脚本运行事件（阶段 6）。
   * 一次运行会先来一条 `start`，随后若干条 `log`，最后以 `done` / `error` / `timeout` 收尾。
   */
  | {
      t: 'script'
      runId: string
      scriptName: string
      phase: 'start' | 'log' | 'done' | 'error' | 'timeout'
      level?: ScriptLogLevel
      message?: string
      /** 脚本 return 的值（可 JSON 序列化时） */
      result?: unknown
      error?: string
      elapsedMs?: number
      at: string
    }
  /** 宏执行进度（阶段 6） */
  | {
      t: 'macro'
      runId: string
      macroName: string
      phase: 'start' | 'step' | 'done' | 'error'
      /** phase = step 时的当前步序号，从 1 开始 */
      stepIndex?: number
      stepCount?: number
      detail?: string
      error?: string
      at: string
    }

/* ------------------------------------------------------------------ */
/* 全局事件通道（/ws/events，阶段 9）                                   */
/* ------------------------------------------------------------------ */

/**
 * 全局事件通道只跑**低频、不属于任何单个终端**的消息。
 * 车道上不放终端字节流：那条路已经被终端 WS 的点对点连接占满了。
 */
export type ServerEventMessage =
  /** 插件发起的通知：前端弹 Toast（页面不在前台时按设置转桌面通知） */
  | {
      t: 'plugin-notify'
      pluginId: string
      pluginName: string
      title: string
      body: string
      /**
       * 插件自己标注的级别。目前只有 info / warn / error 三种语义 ——
       * debug 不发通知（那是日志的事），error 在界面上会带红色左边框
       */
      level: Exclude<PluginLogLevel, 'debug'>
      at: string
    }
  /** 插件集合发生变化（启停 / 重载 / 文件改动）：前端据此刷新插件列表 */
  | { t: 'plugins-changed'; reason: 'enabled' | 'disabled' | 'reloaded' | 'discovered' }

/** 运行时校验：把文本帧解析成全局事件消息，非本通道消息返回 null */
export function parseServerEvent(raw: string): ServerEventMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const t = (parsed as { t?: unknown }).t
    if (t === 'plugins-changed') {
      const reason = (parsed as { reason?: unknown }).reason
      if (reason !== 'enabled' && reason !== 'disabled' && reason !== 'reloaded' && reason !== 'discovered') {
        return null
      }
      return { t: 'plugins-changed', reason }
    }
    if (t === 'plugin-notify') {
      const msg = parsed as Partial<Record<string, unknown>>
      if (
        typeof msg.pluginId !== 'string' ||
        typeof msg.pluginName !== 'string' ||
        typeof msg.title !== 'string' ||
        typeof msg.body !== 'string' ||
        typeof msg.at !== 'string'
      ) {
        return null
      }
      const level = msg.level
      if (level !== 'info' && level !== 'warn' && level !== 'error') return null
      return {
        t: 'plugin-notify',
        pluginId: msg.pluginId,
        pluginName: msg.pluginName,
        title: msg.title,
        body: msg.body,
        level,
        at: msg.at,
      }
    }
    return null
  } catch {
    return null
  }
}

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
  /** 监听端口已被占用（阶段 5 端口转发） */
  | 'PORT_IN_USE'
  /** 无权监听该地址/端口（如 1024 以下的特权端口） */
  | 'PORT_DENIED'
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
    if (t === 'log-html') {
      const { seq, final, data } = parsed as {
        seq?: unknown
        final?: unknown
        data?: unknown
      }
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
      if (typeof final !== 'boolean') return null
      if (typeof data !== 'string') return null
      return { t: 'log-html', seq, final, data }
    }
    return null
  } catch {
    return null
  }
}
