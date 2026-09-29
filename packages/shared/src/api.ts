/**
 * REST 接口的请求 / 响应契约。
 * 阶段 1 新增：连接探测与终端会话创建。
 * 阶段 4 新增：Telnet（按 protocol 判别的会话配置）。
 */
import type { ConnectionProtocol } from './constants.js'
import { DEFAULT_PORTS } from './constants.js'

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

/**
 * Telnet 目标。
 *
 * 与 SSH 的关键差异：Telnet 没有认证阶段，用户名与口令都是连接建立之后
 * 由设备在终端里逐行索要的普通文本。因此这里**不带任何凭据字段** ——
 * 让用户把口令交给一个连加密都没有的协议去传输，本来就已经是权衡后的选择，
 * 更不该把它写进配置或落盘。登录过程完全在终端里交互完成。
 */
export interface TelnetTarget {
  host: string
  port: number
}

/** 终端外观与编码设置 */
export interface TerminalOptions {
  cols: number
  rows: number
  /** 远端字节流的字符编码 */
  encoding: 'utf8' | 'gbk' | 'gb18030' | 'big5' | 'latin1'
  /** 传给远端的 TERM 环境变量值（Telnet 下通过 TERMINAL-TYPE 选项上报） */
  term: string
}

/** 算法兼容策略，仅 SSH 有意义 */
export type LegacyCompat = 'auto' | 'always' | 'never'

/**
 * 会话配置按协议判别。
 *
 * 之所以用判别联合而不是「一堆可选字段」：两者的连接参数形状确实不同
 * （SSH 要用户名与凭据，Telnet 只要主机端口），用可选字段会让
 * 「telnet 却带了私钥」「ssh 却没带用户名」这类非法组合在类型上无法被发现。
 */
export interface SshSessionConfig {
  protocol: 'ssh'
  target: SshTarget
  terminal: TerminalOptions
  /**
   * 是否启用 legacy 算法兼容。
   * auto = 先试现代算法，失败后自动降级（推荐，适配老网络设备）
   * always = 直接使用 legacy 档案
   * never = 只用现代算法，协商失败即报错
   */
  legacyCompat?: LegacyCompat
}

export interface TelnetSessionConfig {
  protocol: 'telnet'
  target: TelnetTarget
  terminal: TerminalOptions
}

export type SessionConfig = SshSessionConfig | TelnetSessionConfig

/** 判别联合的类型收窄助手：缺省视为 ssh（兼容旧数据与旧脚本） */
export function protocolOf(config: { protocol?: ConnectionProtocol }): ConnectionProtocol {
  return config.protocol ?? 'ssh'
}

/** 展示用登录名：Telnet 没有登录名这一层，恒为空串 */
export function targetUsername(config: SessionConfig): string {
  return config.protocol === 'telnet' ? '' : config.target.username
}

/**
 * 由连接配置推导一个默认标题，前后端共用同一份规则，避免标签上出现两种格式。
 * SSH：`user@host`（22 端口省略）；Telnet：`host`（23 端口省略，没有用户名可显示）。
 */
export function targetLabel(config: SessionConfig): string {
  const { host, port } = config.target
  if (config.protocol === 'telnet') {
    return port === DEFAULT_PORTS.telnet ? host : `${host}:${port}`
  }
  const suffix = port === DEFAULT_PORTS.ssh ? '' : `:${port}`
  return `${config.target.username}@${host}${suffix}`
}

/* ------------------------------------------------------------------ */
/* POST /api/sessions/probe —— 只做连接与认证，不开会话，用于「测试连接」 */
/* ------------------------------------------------------------------ */

export interface ProbeSessionRequest {
  /** 快速连接时直传目标；与 sessionId 二选一 */
  target?: SshTarget | TelnetTarget
  /** 引用会话库中的会话 */
  sessionId?: string
  /** 仅 SSH 模式生效 */
  legacyCompat?: LegacyCompat
  /** 目标协议；缺省 ssh */
  protocol?: ConnectionProtocol
}

/** SSH 探测得到的算法协商详情；Telnet 无此信息 */
export interface ProbeSshNegotiation {
  kex: string
  hostKeyAlgorithm: string
  cipher: string
  mac: string
  profile: string
  legacy: boolean
}

export interface ProbeSessionResponse {
  ok: boolean
  /** 实际使用的协议 */
  protocol: ConnectionProtocol
  /** 握手与认证耗时（毫秒） */
  elapsedMs: number
  /** 服务端标识串（SSH 为版本串；Telnet 通常为空） */
  serverIdent: string
  /** 命中认证方式，如 password；Telnet 恒为 none */
  authMethod: string
  /** 仅 SSH 存在 */
  negotiation?: ProbeSshNegotiation
  /** 仅 SSH 存在：主机密钥指纹（SHA256:base64） */
  hostKeyFingerprint?: string
  /** Telnet 探测时读到的欢迎语（可能为空） */
  banner?: string
  /** 探测过程中发现的限制（如远端拒绝开启会话），非致命 */
  warnings: string[]
}


/* ------------------------------------------------------------------ */
/* /api/terminals —— 终端会话生命周期                                   */
/* ------------------------------------------------------------------ */

/** POST /api/terminals */
export interface CreateTerminalRequest {
  /** 直接指定连接参数（快速连接，不落库）；与 sessionId 二选一 */
  config?: SessionConfig
  /** 引用会话库中已保存的会话；服务端负责解析凭据与跳板链 */
  sessionId?: string
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
  protocol: ConnectionProtocol
  host: string
  port: number
  /** Telnet 无登录名，恒为空串 */
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

/* ================================================================== */
/* 阶段 2：主密码保险库（Vault）与会话库（Library）                     */
/* ================================================================== */

/** GET /api/vault/status */
export interface VaultStatusResponse {
  /** 是否已设置主密码 */
  initialized: boolean
  /** 主密钥当前是否已解锁（重启服务后为 false） */
  unlocked: boolean
  /** 已保存的凭据数量（未解锁时为 undefined，避免泄露存在性） */
  credentialCount?: number
}

/** POST /api/vault/setup —— 首次设置主密码 */
export interface SetupVaultRequest {
  masterPassword: string
}

export interface VaultOkResponse {
  ok: boolean
}

/* ------------------------------------------------------------------ */
/* 凭据 —— 读接口永不返回明文                                          */
/* ------------------------------------------------------------------ */

/** 凭据摘要（列表 / 引用展示用，绝无秘密字段） */
export interface CredentialSummary {
  id: string
  name: string
  type: AuthMethod
  /** privateKey 凭据是否设置了口令 */
  hasPassphrase?: boolean
  createdAt: string
  updatedAt: string
}

export interface ListCredentialsResponse {
  credentials: CredentialSummary[]
}

/** POST /api/credentials */
export interface CreateCredentialRequest {
  name: string
  type: AuthMethod
  /** type = password 时必填 */
  password?: string
  /** type = privateKey 时必填：PEM / OpenSSH 私钥内容 */
  privateKey?: string
  /** 私钥口令（可选） */
  passphrase?: string
}

/** PATCH /api/credentials/:id —— 所有字段可选，未提供的保持不变 */
export interface UpdateCredentialRequest {
  name?: string
  password?: string
  privateKey?: string
  /** 显式传空字符串表示清除私钥口令 */
  passphrase?: string
}

/* ------------------------------------------------------------------ */
/* 会话库 —— 文件夹 + 会话记录的树                                     */
/* ------------------------------------------------------------------ */

/** 跳板链中的一跳；认证信息通过 credentialId 引用保险库 */
export interface JumpHop {
  host: string
  port: number
  username: string
  credentialId: string
  legacyCompat?: 'auto' | 'always' | 'never'
}

/**
 * 会话节点的可连接配置。
 *
 * 用「扁平 + 按协议可缺省」而不是判别联合：这份结构会整块 JSON 落进 SQLite，
 * 还要兼容阶段 2 之前写入的、完全没有 protocol 字段的旧记录，
 * 联合类型在读取老数据时反而要写一堆类型断言。协议相关的必填性由 zod 在写入时把关。
 */
export interface SessionRecord {
  /** 连接协议；旧记录缺省视为 ssh */
  protocol?: ConnectionProtocol
  host: string
  port: number
  /** 仅 SSH 必填；Telnet 的登录名在终端里交互输入 */
  username?: string
  /** 仅 SSH 必填：认证凭据引用（保险库中的凭据 id） */
  credentialId?: string
  encoding: SupportedEncodingLiteral
  term: string
  /** 仅 SSH 有意义 */
  legacyCompat?: 'auto' | 'always' | 'never'
  /** 仅 SSH 有意义：跳板链，按连接顺序排列；最后一跳之后连接 record.host */
  jumpChain?: JumpHop[]
}

export type SupportedEncodingLiteral = 'utf8' | 'gbk' | 'gb18030' | 'big5' | 'latin1'

/** 会话库树节点（GET /api/library） */
export interface LibraryNode {
  id: string
  kind: 'folder' | 'session'
  name: string
  parentId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  /** kind = session 时存在 */
  session?: SessionRecord
}

export interface LibraryTreeResponse {
  nodes: LibraryNode[]
}

/** POST /api/library —— 新建文件夹或会话 */
export interface CreateLibraryNodeRequest {
  kind: 'folder' | 'session'
  name: string
  parentId?: string | null
  sortOrder?: number
  /** kind = session 时必填 */
  session?: SessionRecord
}

/** PATCH /api/library/:id —— 部分更新 */
export interface UpdateLibraryNodeRequest {
  name?: string
  parentId?: string | null
  sortOrder?: number
  session?: SessionRecord
}

/* ------------------------------------------------------------------ */
/* CreateTerminal / Probe 的会话库引用形态                             */
/* ------------------------------------------------------------------ */

export interface CapabilitiesResponse {
  /** ssh2 版本 */
  ssh2Version: string
  /** 本机 Node 版本 */
  nodeVersion: string
  /** 可用算法档案（按尝试顺序） */
  profiles: AlgorithmProfileInfo[]
  supportedEncodings: string[]
  /** 支持的连接协议（ssh + telnet） */
  supportedProtocols: ConnectionProtocol[]
  /** 单条终端输出的背压水位（字节） */
  backpressureHighWaterMark: number
  backpressureLowWaterMark: number
}
