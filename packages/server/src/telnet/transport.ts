/**
 * Telnet 运输层：一条裸 TCP 连接 + 选项协商 + 本地回显兜底。
 *
 * 与 SSH 的关键差异（决定了这里的形态）：
 *
 * - **没有通道概念**。SSH 是「连接上再开一条 PTY 通道」，Telnet 连上就是数据流，
 *   因此不需要 `openShell` 那一步，也就不存在「认证成功但拒绝开会话」这种中间态。
 * - **没有认证阶段**。用户名与口令是连接建立之后由设备在终端里索要的普通文本，
 *   本层完全不参与，也就无从加密（见 README 的安全说明）。
 * - **回显是谁的责任需要协商**。设备说 WILL ECHO 时由它回显；说不（WONT ECHO）时，
 *   如果我们老老实实等，用户就会「打字看不见」——这在老设备上很常见。
 *   所以这里在「对端不回显」时接管本地回显：自造一份回显字节投给终端。
 *   注意这只影响视觉，输入字节本身照常送出。
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { TelnetNegotiationSummary } from '@webterm/shared'
import { TELNET_CONNECT_TIMEOUT_MS } from '@webterm/shared'
import { TelnetNegotiator } from './negotiation.js'
import { classifyTelnetError, TelnetError } from './errors.js'

/** 退格键的回显序列：退一格、抹掉、再退一格 */
const BACKSPACE_ECHO = Buffer.from('\b \b', 'utf8')
const CRLF = Buffer.from('\r\n', 'utf8')

export interface TelnetTransportOptions {
  host: string
  port: number
  term: string
  cols: number
  rows: number
}

export interface TelnetTransportEvents {
  /** 剥离控制序列后的用户数据 */
  data: [chunk: Buffer]
  /** 对端关闭或本端主动关闭；reason 面向用户 */
  close: [reason: string]
  /** 传输层错误（已分类） */
  error: [err: TelnetError]
  /** 选项协商结果发生变化 */
  negotiation: []
}

export class TelnetTransport extends EventEmitter<TelnetTransportEvents> {
  private readonly socket: net.Socket
  private readonly negotiator: TelnetNegotiator
  private readonly host: string
  private readonly port: number

  /** 是否由本端负责回显（对端未声明 WILL ECHO） */
  private localEcho = true
  /** 本地回显已在本行输出的字符数，用于判断退格是否能真的退掉东西 */
  private echoedSinceLineStart = 0
  private closed = false
  private connectError: TelnetError | undefined

  private constructor(opts: TelnetTransportOptions, socket: net.Socket) {
    super()
    this.host = opts.host
    this.port = opts.port
    this.socket = socket
    this.negotiator = new TelnetNegotiator({
      term: opts.term,
      cols: opts.cols,
      rows: opts.rows,
    })
  }

  /**
   * 建立连接。TCP 层连通即 resolve —— Telnet 没有后续握手，
   * 连不上就是连不上，不会出现 SSH 那种「连上了但认证失败」的分支。
   */
  static connect(opts: TelnetTransportOptions): Promise<TelnetTransport> {
    return new Promise<TelnetTransport>((resolve, reject) => {
      const socket = net.connect({ host: opts.host, port: opts.port })
      socket.setTimeout(TELNET_CONNECT_TIMEOUT_MS)

      let settled = false

      const cleanup = (): void => {
        socket.setTimeout(0)
        socket.off('connect', onConnect)
        socket.off('timeout', onTimeout)
        socket.off('error', onErrorBeforeConnect)
      }

      const onConnect = (): void => {
        if (settled) return
        settled = true
        cleanup()
        const transport = new TelnetTransport(opts, socket)
        transport.bind()
        resolve(transport)
      }

      const onTimeout = (): void => {
        if (settled) return
        settled = true
        cleanup()
        socket.destroy()
        reject(
          new TelnetError('TIMEOUT', `连接 ${opts.host}:${opts.port} 超时`, {
            hint: '目标端口没有响应。请确认设备已开启 Telnet 服务，且中间网络未过滤该端口。',
          }),
        )
      }

      const onErrorBeforeConnect = (err: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        socket.destroy()
        reject(classifyTelnetError(err))
      }

      socket.once('connect', onConnect)
      socket.once('timeout', onTimeout)
      socket.once('error', onErrorBeforeConnect)
    })
  }

  get serverIdent(): string {
    // Telnet 协议本身没有版本串；这里给出目标地址，排障面板不至于空着
    return `${this.host}:${this.port}`
  }

  get negotiationSummary(): TelnetNegotiationSummary {
    return this.negotiator.summary
  }

  /** 当前是否由本端做本地回显 */
  get localEchoActive(): boolean {
    return this.localEcho
  }

  private bind(): void {
    const socket = this.socket

    // 建连后主动声明「抑制继续」，让设备进入全双工
    const initial = this.negotiator.initialReplies()
    if (initial.length > 0) socket.write(initial)

    socket.on('data', (chunk: Buffer) => {
      const { data, replies } = this.negotiator.process(chunk)
      if (replies.length > 0) socket.write(replies)
      this.syncEchoMode()
      if (data.length > 0) this.emit('data', data)
    })

    socket.on('error', (err: unknown) => {
      if (this.closed) return
      this.connectError = classifyTelnetError(err)
      this.socket.destroy()
      this.emit('error', this.connectError)
    })

    socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      const reason = this.connectError ? '连接出错' : '远端主机已关闭连接'
      this.emit('close', reason)
    })
  }

  /** 跟随协商结果切换回显归属 */
  private syncEchoMode(): void {
    const remoteEcho = this.negotiator.summary.remoteEcho
    const nextLocalEcho = !remoteEcho
    if (nextLocalEcho === this.localEcho) return
    this.localEcho = nextLocalEcho
    // 切换瞬间清掉计数，避免用旧状态判断退格
    this.echoedSinceLineStart = 0
    this.emit('negotiation')
  }

  /**
   * 写入用户输入。
   * 需要本地回显时，先造一份回显字节投给终端，再把真实字节转义后送出。
   */
  write(data: Buffer): void {
    if (this.closed || data.length === 0) return

    if (this.localEcho) {
      const echo = this.buildLocalEcho(data)
      if (echo.length > 0) this.emit('data', echo)
    }

    this.socket.write(TelnetNegotiator.escape(data))
  }

  /**
   * 本地回显。
   *
   * 只处理最朴素的编辑行为：可见字符原样回显、回车换行、退格删掉一个已显示的字符。
   * 不做行缓冲，也不模拟方向键 —— 一旦远端开启 ECHO，这条路就走不到了；
   * 而设备真的不支持回显时，用户需要的是「能看见自己打了什么」，
   * 而不是一个功能完整的行编辑器。
   */
  private buildLocalEcho(data: Buffer): Buffer {
    const out: number[] = []
    for (const byte of data) {
      if (byte === 0x0d || byte === 0x0a) {
        out.push(0x0d, 0x0a)
        this.echoedSinceLineStart = 0
        continue
      }
      if (byte === 0x7f || byte === 0x08) {
        if (this.echoedSinceLineStart > 0) {
          out.push(...BACKSPACE_ECHO)
          this.echoedSinceLineStart -= 1
        }
        continue
      }
      if (byte === 0x03 || byte === 0x04 || byte === 0x1a) {
        // Ctrl-C / Ctrl-D / Ctrl-Z：终端会把它们渲染成 ^C 之类，不需要我们回显
        out.push(0x0d, 0x0a)
        this.echoedSinceLineStart = 0
        continue
      }
      if (byte < 0x20 || byte === 0x7f) continue
      out.push(byte)
      this.echoedSinceLineStart += 1
    }
    return out.length > 0 ? Buffer.from(out) : Buffer.alloc(0)
  }

  /** 窗口尺寸变化（会话侧收到 resize 控制消息时调用） */
  setWindow(cols: number, rows: number): void {
    if (this.closed) return
    const payload = this.negotiator.setSize(cols, rows)
    if (payload.length > 0) this.socket.write(payload)
  }

  pause(): void {
    if (this.closed) return
    this.socket.pause()
  }

  resume(): void {
    if (this.closed) return
    this.socket.resume()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
  }

  /** 心跳/存活判断 */
  get alive(): boolean {
    return !this.closed && !this.socket.destroyed
  }

  /** 当前是否处于「半关闭」（对端已发 FIN） */
  get readable(): boolean {
    return this.socket.readable
  }

  /** CRLF 常量导出给测试用，避免测试里再写一遍魔术字节 */
  static get lineEnding(): Buffer {
    return CRLF
  }
}
