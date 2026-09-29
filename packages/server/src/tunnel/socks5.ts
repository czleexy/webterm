/**
 * 最小 SOCKS5 服务端（RFC 1928），只实现 CONNECT。
 *
 * 为什么只做 CONNECT：
 * 用户开 `-D` 的目的是「让浏览器 / 命令行工具通过这条 SSH 连接访问远端内网」，
 * 那需要的正是 CONNECT。BIND 与 UDP ASSOCIATE 在 SSH 端口转发里没有对应能力
 * （SSH 的 direct-tcpip 只能建 TCP 通道），与其返回一个永远失败的实现，
 * 不如按协议规范明确回「命令不支持」（REP=0x07），让客户端立刻给出准确报错。
 *
 * 认证：只支持「无需认证」（METHOD 0x00）。SOCKS5 的口令认证是明文放在
 * SOCKS 层里的，加它反而会给人一种「有加密」的错觉；真正的保护来自 SSH 隧道本身。
 *
 * 报文可能被 TCP 拆包，因此这里实现成可累积的状态机，而不是假设一次 read
 * 就能拿到完整请求 —— 这是手写 SOCKS5 最常见的翻车点。
 */
import { SOCKS5_NO_AUTH } from '@webterm/shared'

export const SOCKS5_VERSION = 0x05

/** 认证方式 */
export const SOCKS5_METHOD_NONE = 0x00
export const SOCKS5_METHOD_NO_ACCEPTABLE = 0xff

/** 请求命令 */
export const SOCKS5_CMD_CONNECT = 0x01
export const SOCKS5_CMD_BIND = 0x02
export const SOCKS5_CMD_UDP_ASSOCIATE = 0x03

/** 地址类型 */
export const SOCKS5_ATYP_IPV4 = 0x01
export const SOCKS5_ATYP_DOMAIN = 0x03
export const SOCKS5_ATYP_IPV6 = 0x04

/** 应答码 */
export const SOCKS5_REP_SUCCESS = 0x00
export const SOCKS5_REP_GENERAL_FAILURE = 0x01
export const SOCKS5_REP_NOT_ALLOWED = 0x02
export const SOCKS5_REP_NETWORK_UNREACHABLE = 0x03
export const SOCKS5_REP_HOST_UNREACHABLE = 0x04
export const SOCKS5_REP_CONNECTION_REFUSED = 0x05
export const SOCKS5_REP_TTL_EXPIRED = 0x06
export const SOCKS5_REP_COMMAND_UNSUPPORTED = 0x07
export const SOCKS5_REP_ADDRESS_UNSUPPORTED = 0x08

export interface Socks5ConnectRequest {
  host: string
  port: number
}

export type Socks5Step =
  /** 已回完认证方式选择，继续等请求 */
  | { kind: 'greeting-accepted' }
  /** 认证方式无法满足，连接应当关闭 */
  | { kind: 'greeting-rejected' }
  /** 解析出 CONNECT 请求 */
  | { kind: 'connect'; request: Socks5ConnectRequest }
  /** 命令/地址类型不支持，已回错误应答，连接应当关闭 */
  | { kind: 'unsupported'; reply: Buffer; reason: string }
  /** 数据还不够，继续喂 */
  | { kind: 'need-more' }
  /** 报文格式非法，连接应当关闭 */
  | { kind: 'malformed'; reason: string }

/** 认证方式协商应答：VER + METHOD */
export function methodReply(method: number): Buffer {
  return Buffer.from([SOCKS5_VERSION, method])
}

/**
 * 请求应答：VER REP RSV ATYP BND.ADDR BND.PORT
 *
 * BND 填 0.0.0.0:0 —— 转发场景下「服务端绑定的地址」对客户端没有实际意义
 * （客户端要连的是它自己指定的目标），RFC 1928 也允许这样填。
 * curl / Chrome / ssh 自带的 SOCKS 支持都只校验 REP，不解析 BND。
 */
export function replyBuffer(rep: number): Buffer {
  return Buffer.from([SOCKS5_VERSION, rep, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

/** 把「客户端可达性」的错误映射成 SOCKS5 应答码，让调用方看到准确的失败原因 */
export function replyCodeForError(errno: string | undefined): number {
  switch (errno) {
    case 'ECONNREFUSED':
      return SOCKS5_REP_CONNECTION_REFUSED
    case 'EHOSTUNREACH':
      return SOCKS5_REP_HOST_UNREACHABLE
    case 'ENETUNREACH':
      return SOCKS5_REP_NETWORK_UNREACHABLE
    case 'ETIMEDOUT':
      return SOCKS5_REP_TTL_EXPIRED
    default:
      return SOCKS5_REP_GENERAL_FAILURE
  }
}

/**
 * SOCKS5 握手状态机。
 *
 * 用法：把每个数据块喂进 `consume()`，按返回的 step 决定下一步；
 * `unsupported` / `malformed` / `greeting-rejected` 都应立即关闭连接。
 */
export class Socks5Negotiator {
  private buffer: Buffer = Buffer.alloc(0)
  private stage: 'greeting' | 'request' | 'done' = 'greeting'

  get finished(): boolean {
    return this.stage === 'done'
  }

  consume(chunk: Buffer): Socks5Step {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    if (this.stage === 'greeting') {
      const step = this.tryGreeting()
      if (step) return step
      return { kind: 'need-more' }
    }
    if (this.stage === 'request') {
      const step = this.tryRequest()
      if (step) return step
      return { kind: 'need-more' }
    }
    return { kind: 'malformed', reason: '握手已结束，收到多余数据' }
  }

  /** 认证方式协商：请求可能被拆包，长度不够就等下一块 */
  private tryGreeting(): Socks5Step | null {
    if (this.buffer.length < 2) return null
    const ver = this.buffer[0]
    const nMethods = this.buffer[1] ?? 0
    if (ver !== SOCKS5_VERSION) {
      return { kind: 'malformed', reason: `不支持的 SOCKS 版本：${ver}` }
    }
    if (this.buffer.length < 2 + nMethods) return null

    const methods = this.buffer.subarray(2, 2 + nMethods)
    this.buffer = this.buffer.subarray(2 + nMethods)
    this.stage = 'request'

    // 只要客户端支持「无需认证」就接受，否则按规范回 0xFF 让客户端换方式/放弃
    if (methods.includes(SOCKS5_NO_AUTH)) {
      return { kind: 'greeting-accepted' }
    }
    this.stage = 'done'
    return { kind: 'greeting-rejected' }
  }

  /** CONNECT 请求解析 */
  private tryRequest(): Socks5Step | null {
    if (this.buffer.length < 4) return null
    const ver = this.buffer[0] ?? 0
    const cmd = this.buffer[1] ?? 0
    const atyp = this.buffer[3] ?? 0

    if (ver !== SOCKS5_VERSION) {
      this.stage = 'done'
      return { kind: 'malformed', reason: `不支持的 SOCKS 版本：${ver}` }
    }

    const address = this.readAddress(atyp)
    if (address === 'incomplete') return null
    if (address === 'unsupported') {
      this.stage = 'done'
      return {
        kind: 'unsupported',
        reply: replyBuffer(SOCKS5_REP_ADDRESS_UNSUPPORTED),
        reason: `不支持的地址类型：${atyp}`,
      }
    }

    this.stage = 'done'

    if (cmd !== SOCKS5_CMD_CONNECT) {
      const label = cmd === SOCKS5_CMD_BIND ? 'BIND' : cmd === SOCKS5_CMD_UDP_ASSOCIATE ? 'UDP ASSOCIATE' : `未知命令 ${cmd}`
      return {
        kind: 'unsupported',
        reply: replyBuffer(SOCKS5_REP_COMMAND_UNSUPPORTED),
        reason: `${label} 不支持（SSH 隧道只能建 TCP 通道，请使用 CONNECT）`,
      }
    }

    return { kind: 'connect', request: { host: address.host, port: address.port } }
  }

  /** 按类型读地址：IPv4 / 域名 / IPv6；不足则返回 incomplete */
  private readAddress(atyp: number): { host: string; port: number } | 'incomplete' | 'unsupported' {
    const buf = this.buffer

    if (atyp === SOCKS5_ATYP_IPV4) {
      if (buf.length < 4 + 4 + 2) return 'incomplete'
      const host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
      const port = buf.readUInt16BE(8)
      this.buffer = buf.subarray(10)
      return { host, port }
    }

    if (atyp === SOCKS5_ATYP_DOMAIN) {
      if (buf.length < 5) return 'incomplete'
      const len = buf[4] ?? 0
      if (buf.length < 5 + len + 2) return 'incomplete'
      const host = buf.subarray(5, 5 + len).toString('utf8')
      const port = buf.readUInt16BE(5 + len)
      this.buffer = buf.subarray(5 + len + 2)
      return { host, port }
    }

    if (atyp === SOCKS5_ATYP_IPV6) {
      if (buf.length < 4 + 16 + 2) return 'incomplete'
      const parts: string[] = []
      for (let i = 0; i < 8; i += 1) {
        parts.push(buf.readUInt16BE(4 + i * 2).toString(16))
      }
      const port = buf.readUInt16BE(20)
      this.buffer = buf.subarray(22)
      // IPv6 字面量必须带方括号，否则 ssh2 转发时会当成主机名解析失败
      return { host: `[${parts.join(':')}]`, port }
    }

    return 'unsupported'
  }
}
