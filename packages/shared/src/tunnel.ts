/**
 * 端口转发与隧道的共享契约。
 *
 * 三类转发对应 OpenSSH 的三个开关，语义完全对齐，方便用户把已有的
 * `ssh -L/-R/-D` 经验直接搬过来：
 *
 * | 类型 | 等价命令 | 监听方 |
 * | --- | --- | --- |
 * | local | `ssh -L [bind:]port:host:hostport` | 本机（WebTerm 服务端所在机器） |
 * | remote | `ssh -R [bind:]port:host:hostport` | 远端 SSH 服务器 |
 * | dynamic | `ssh -D [bind:]port` | 本机，作为 SOCKS5 代理 |
 *
 * 为什么用判别联合而不是「一堆可选字段」：
 * dynamic 根本没有 targetHost / targetPort，「目标端口」在一次 SOCKS5 会话里
 * 由客户端逐次指定。写成可选字段会让「dynamic 却带了目标端口」这类矛盾配置
 * 在类型上无法被发现。
 */

/** 支持的转发类型 */
export const TUNNEL_TYPES = ['local', 'remote', 'dynamic'] as const
export type TunnelType = (typeof TUNNEL_TYPES)[number]

/** 本地转发：本机监听，流量经 SSH 连接送到远端网络里的目标 */
export interface LocalForwardSpec {
  type: 'local'
  /** 本机监听地址；默认 127.0.0.1（仅本机可用） */
  bindHost: string
  /** 本机监听端口 */
  bindPort: number
  /** 目标主机：从远端 SSH 服务器视角解析 */
  targetHost: string
  targetPort: number
}

/** 远程转发：远端监听，流量经 SSH 连接送回到本机目标 */
export interface RemoteForwardSpec {
  type: 'remote'
  /** 远端监听地址；默认 127.0.0.1（只有远端机器自己可连） */
  bindHost: string
  /** 远端监听端口；填 0 表示由远端分配一个空闲端口 */
  bindPort: number
  /** 目标主机：从本机（WebTerm 服务端所在机器）视角解析 */
  targetHost: string
  targetPort: number
}

/** 动态转发：本机监听一个 SOCKS5 代理，目标地址由 SOCKS5 客户端逐次指定 */
export interface DynamicForwardSpec {
  type: 'dynamic'
  bindHost: string
  bindPort: number
}

export type TunnelSpec = LocalForwardSpec | RemoteForwardSpec | DynamicForwardSpec

/** 需要目标地址的隧道类型（本地 / 远程转发） */
export type TargetedTunnelSpec = LocalForwardSpec | RemoteForwardSpec

export function isTargeted(spec: TunnelSpec): spec is TargetedTunnelSpec {
  return spec.type === 'local' || spec.type === 'remote'
}

/** 隧道运行状态 */
export type TunnelStatus = 'starting' | 'active' | 'stopped' | 'error'

/** 隧道运行时信息（GET /api/tunnels 的返回单元） */
export interface TunnelInfo {
  id: string
  /** 宿主终端：隧道的生命周期与会话强绑定 */
  terminalId: string
  /** 宿主终端标题，面板里用来区分「这条隧道挂在谁身上」 */
  terminalTitle: string
  spec: TunnelSpec
  status: TunnelStatus
  /** status = 'error' 时的原因（端口占用等） */
  error?: string
  /** 实际生效的监听地址（远程转发可能由远端改写） */
  boundHost?: string
  /** 实际生效的监听端口（远程转发 bindPort=0 时由远端分配） */
  boundPort?: number
  /** 当前活跃连接数 */
  activeConnections: number
  /** 累计接入的连接数 */
  totalConnections: number
  /** 本地 → 远端 的累计字节数 */
  bytesUp: number
  /** 远端 → 本地 的累计字节数 */
  bytesDown: number
  startedAt?: string
  /** 是否由会话配置在连接建立时自动启动 */
  autoStarted?: boolean
}

/* ------------------------------------------------------------------ */
/* 请求 / 响应                                                          */
/* ------------------------------------------------------------------ */

export interface CreateTunnelRequest {
  /** 宿主终端 id；隧道挂在它的 SSH 连接上 */
  terminalId: string
  spec: TunnelSpec
}

export interface ListTunnelsResponse {
  tunnels: TunnelInfo[]
}

/* ------------------------------------------------------------------ */
/* 常量与展示助手                                                        */
/* ------------------------------------------------------------------ */

/**
 * 默认监听地址。
 * 刻意用回环地址而不是 0.0.0.0：`ssh -L 0.0.0.0:...` 会把内网服务暴露给
 * 整个局域网，用户必须显式写出 0.0.0.0 才生效 —— 默认安全，显式放行。
 */
export const DEFAULT_TUNNEL_BIND_HOST = '127.0.0.1'

/** 单个会话允许的隧道数量上限，防止误配置把端口资源吃光 */
export const MAX_TUNNELS_PER_SESSION = 32

/** 单条隧道的累计统计刷新节流（毫秒）。字节数变化不会触发事件，只能轮询 */
export const TUNNEL_STATS_POLL_MS = 2_000

/** 建立转发通道（forwardOut / forwardIn）的超时 */
export const TUNNEL_CHANNEL_TIMEOUT_MS = 20_000

/** SOCKS5 代理可接受的认证方式：仅无认证（RFC 1928 METHOD 0x00） */
export const SOCKS5_NO_AUTH = 0x00

export const TUNNEL_TYPE_LABEL: Record<TunnelType, string> = {
  local: '本地转发',
  remote: '远程转发',
  dynamic: '动态转发',
}

/** 面板里的一句话说明，降低「-L/-R 到底谁连谁」的理解成本 */
export const TUNNEL_TYPE_DESC: Record<TunnelType, string> = {
  local: '本机监听一个端口，连接经由 SSH 送到远端网络里的目标',
  remote: '远端监听一个端口，连接经由 SSH 送回本机的目标',
  dynamic: '本机起一个 SOCKS5 代理，目标地址由客户端每次指定',
}

/** 面板里的命令行示例，等价于 OpenSSH 的写法 */
export const TUNNEL_TYPE_EXAMPLE: Record<TunnelType, string> = {
  local: 'ssh -L 13306:10.0.0.5:3306 user@host',
  remote: 'ssh -R 8080:127.0.0.1:80 user@host',
  dynamic: 'ssh -D 1080 user@host',
}

/** 监听端的展示串，如 `127.0.0.1:13306`；端口待分配时为 `127.0.0.1:自动分配` */
export function bindLabel(spec: TunnelSpec, boundPort?: number, boundHost?: string): string {
  const port = boundPort ?? spec.bindPort
  return `${boundHost || spec.bindHost}:${port === 0 ? '自动分配' : port}`
}

/** 目标端的展示串；dynamic 没有目标，返回 null */
export function targetLabelOf(spec: TunnelSpec): string | null {
  return isTargeted(spec) ? `${spec.targetHost}:${spec.targetPort}` : null
}

/**
 * 生成等价的 OpenSSH 命令行。
 * 保留这个函数是为了让熟悉命令行的用户能一眼确认「我配的到底是哪一条」——
 * 对齐既有心智模型，比让人重新学一套表单更省事。
 */
export function tunnelCommand(spec: TunnelSpec, sshTarget = 'user@host'): string {
  const bind = `${spec.bindHost}:${spec.bindPort}`
  if (spec.type === 'local') {
    return `ssh -L ${bind}:${spec.targetHost}:${spec.targetPort} ${sshTarget}`
  }
  if (spec.type === 'remote') {
    return `ssh -R ${bind}:${spec.targetHost}:${spec.targetPort} ${sshTarget}`
  }
  return `ssh -D ${bind} ${sshTarget}`
}

/**
 * 结构指纹：用于「同一会话里是否已存在等价隧道」的去重判断。
 * 不含 id 与运行时字段，两条语义相同的配置必须得到同一个指纹。
 */
export function specFingerprint(spec: TunnelSpec): string {
  if (spec.type === 'dynamic') return `dynamic|${spec.bindHost}|${spec.bindPort}`
  return `${spec.type}|${spec.bindHost}|${spec.bindPort}|${spec.targetHost}|${spec.targetPort}`
}
