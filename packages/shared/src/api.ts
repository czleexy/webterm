/**
 * REST 接口的请求 / 响应契约。
 * 阶段 1 新增：连接探测与终端会话创建。
 */

/** 统一错误响应体 */
export interface ApiError {
  error: string
  message: string
  /** 可选的字段级校验错误 */
  details?: Array<{ path: string; message: string }>
}

/** GET /api/health */
export interface HealthResponse {
  ok: boolean
  name: string
  version: string
  /** 进程已运行秒数 */
  uptimeSec: number
  /** 如 v22.22.2 */
  nodeVersion: string
  /** ISO 8601 */
  startedAt: string
  /** 当前活跃终端标签数 */
  activeTabs: number
}

/** 认证方式 */
export type AuthMethod = 'password' | 'privateKey'

/**
 * 建立 SSH 连接所需的参数。
 * 阶段 1 由前端每次传入；阶段 2 起改为引用加密凭据库中的 credential_id。
 */
export interface SshTarget {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** authMethod = password 时必填 */
  password?: string
  /** authMethod = privateKey 时必填：PEM/OpenSSH 私钥内容 */
  privateKey?: string
  /** 私钥口令（若私钥已加密） */
  passphrase?: string
}

/** 终端外观与编码设置 */
export interface TerminalOptions {
  cols: number
  rows: number
  /** 远端字节流的字符编码 */
  encoding: 'utf8' | 'gbk' | 'gb18030' | 'big5' | 'latin1'
  /** 传给远端的 TERM 环境变量值 */
  term: string
}

export interface SessionConfig {
  target: SshTarget
  terminal: TerminalOptions
  /**
   * 是否启用 legacy 算法兼容。
   * auto = 先试现代算法，失败后自动降级（推荐，适配老网络设备）
   * always = 直接使用 legacy 档案
   * never = 只用现代算法，协商失败即报错
   */
  legacyCompat?: 'auto' | 'always' | 'never'
}

/* ------------------------------------------------------------------ */
/* POST /api/sessions/probe —— 只做连接与认证，不开会话，用于「测试连接」 */
/* ------------------------------------------------------------------ */

export interface ProbeSessionRequest {
  target: SshTarget
  legacyCompat?: 'auto' | 'always' | 'never'
}

export interface ProbeSessionResponse {
  ok: boolean
  /** 握手与认证耗时（毫秒） */
  elapsedMs: number
  /** 服务端标识串 */
  serverIdent: string
  /** 命中认证方式，如 password */
  authMethod: string
  /** 实际协商算法摘要 */
  negotiation: {
    kex: string
    hostKeyAlgorithm: string
    cipher: string
    mac: string
    profile: string
    legacy: boolean
  }
  /** 主机密钥指纹（SHA256:base64） */
  hostKeyFingerprint: string
  /** 探测过程中发现的限制（如远端拒绝开启会话），非致命 */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* /api/terminals —— 终端会话生命周期                                   */
/* ------------------------------------------------------------------ */

/** POST /api/terminals */
export interface CreateTerminalRequest {
  config: SessionConfig
  /** 用于在标签上显示的标题，缺省时由 host 推导 */
  title?: string
}

export interface CreateTerminalResponse {
  terminalId: string
  /** 一次性附加令牌，WebSocket 建连时必须携带 */
  attachToken: string
  /** 建议的 WebSocket 路径（不含协议与主机） */
  wsPath: string
  title: string
  /** 建连后的协商信息 */
  negotiation: TerminalNegotiationSummary
}

/** 协商摘要（与 shared/ws.ts 的 TerminalNegotiationInfo 保持一致但更精简） */
export interface TerminalNegotiationSummary {
  serverIdent: string
  kex: string
  hostKeyAlgorithm: string
  cipher: string
  mac: string
  profile: string
  legacy: boolean
}

/** GET /api/terminals —— 当前服务端存活的终端列表 */
export interface TerminalListItem {
  terminalId: string
  title: string
  host: string
  port: number
  username: string
  /** 是否已有 WebSocket 客户端附加 */
  attached: boolean
  createdAt: string
  cols: number
  rows: number
  encoding: string
}

export interface ListTerminalsResponse {
  terminals: TerminalListItem[]
}

/* ------------------------------------------------------------------ */
/* GET /api/capabilities —— 服务端能力与算法档案，供前端展示与排障       */
/* ------------------------------------------------------------------ */

export interface AlgorithmProfileInfo {
  name: string
  description: string
  legacy: boolean
  kex: string[]
  serverHostKey: string[]
  cipher: string[]
  mac: string[]
  compress: string[]
}

export interface CapabilitiesResponse {
  /** ssh2 版本 */
  ssh2Version: string
  /** 本机 Node 版本 */
  nodeVersion: string
  /** 可用算法档案（按尝试顺序） */
  profiles: AlgorithmProfileInfo[]
  supportedEncodings: string[]
  /** 单条终端输出的背压水位（字节） */
  backpressureHighWaterMark: number
  backpressureLowWaterMark: number
}
