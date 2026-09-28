/**
 * 终端会话：把一条 SSH PTY 通道与一个 WebSocket 连接绑定起来。
 *
 * 生命周期：
 *   POST /api/terminals  → 建立 SSH 连接 + 申请 PTY + 打开 shell（此时已可确定成败）
 *   WS   /ws/terminal/:id → 附加浏览器，开始双向转发
 *
 * 为什么把「建立 SSH 连接」放在 REST 阶段而不是 WebSocket 阶段：
 * 这样认证失败、算法不兼容、远端拒绝会话等错误能以标准的 HTTP 状态码 + 错误码返回，
 * 前端可以在弹窗里直接提示用户，而不必先连上 WS 再从控制消息里读错误。
 *
 * 背压控制（防内存打爆）：
 * 采用「双信号」判断，任一超标即暂停读取远端：
 *   a) 客户端未确认字节数 unackedBytes —— 反映浏览器的渲染消费速度
 *   b) WebSocket 发送缓冲 bufferedAmount —— 反映网络与内核缓冲的拥塞程度
 * 只靠 (b) 无法覆盖「浏览器收到但渲染不过来」的情况；
 * 只靠 (a) 无法覆盖「客户端一直不回 ACK」的恶意/异常场景。两者互补。
 */
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import type { Client, ClientChannel } from 'ssh2'
import {
  BACKPRESSURE_CHECK_INTERVAL_MS,
  BACKPRESSURE_HIGH_WATER_MARK,
  BACKPRESSURE_LOW_WATER_MARK,
  type ClientControlMessage,
  type ServerControlMessage,
  type SessionConfig,
  type SshTarget,
  type SupportedEncoding,
  type TerminalErrorCode,
  type TerminalNegotiationInfo,
} from '@webterm/shared'
import {
  establishConnection,
  establishConnectionChain,
  type EstablishedConnection,
} from '../ssh/connection.js'
import { classifySshError, SshError } from '../ssh/errors.js'
import type { KnownHostsStore } from '../ssh/known-hosts.js'
import { createEncodingBridge, type EncodingBridge } from './encoding.js'

export interface TerminalSessionOptions {
  id: string
  attachToken: string
  title: string
  config: SessionConfig
  /** 跳板链（已解密为明文 target，按连接顺序）；最后一跳之后才是 config.target */
  jumpChain?: SshTarget[]
  knownHosts: KnownHostsStore
  acceptHostKeyMismatch?: boolean
  logger: TerminalLogger
}

export interface TerminalLogger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export type TerminalState = 'connecting' | 'ready' | 'closed'

export interface TerminalSessionEvents {
  /** 会话彻底结束（SSH 断开或主动关闭），manager 据此清理 */
  closed: [reason: string]
  /** 终端进程退出 */
  exit: [payload: { code: number | null; signal: string | null; reason: string }]
}

/** 单条 WS 消息的最大字节数，防止异常客户端发超大帧 */
const MAX_INPUT_FRAME_BYTES = 1024 * 1024

export class TerminalSession extends EventEmitter<TerminalSessionEvents> {
  readonly id: string
  readonly attachToken: string
  readonly title: string
  readonly config: SessionConfig
  readonly createdAt = new Date()

  /** 最近一次客户端断开的时间戳；用于回收「断开后长期未重连」的终端 */
  lastDetachedAt: number | undefined

  private readonly opts: TerminalSessionOptions
  private readonly encoding: EncodingBridge
  private readonly logger: TerminalLogger

  private state: TerminalState = 'connecting'
  private conn: EstablishedConnection | undefined
  /** 跳板链上的中间连接；会话关闭时需一并释放 */
  private intermediateConns: EstablishedConnection[] = []
  private stream: ClientChannel | undefined
  private ws: WebSocket | undefined

  /** 已建立连接、但尚无 WS 客户端时暂存的输出 */
  private pending: Buffer[] = []
  private pendingBytes = 0

  private cols: number
  private rows: number

  /** 已发给客户端但尚未被确认的字节数 */
  private unackedBytes = 0
  /** 是否因背压暂停了远端读取 */
  private paused = false
  private backpressureTimer: NodeJS.Timeout | undefined

  /** 最近一次协商信息，附加上终端尺寸后即为回传给前端的完整信息 */
  private negotiation: TerminalNegotiationInfo | undefined
  private serverIdent = ''

  constructor(opts: TerminalSessionOptions) {
    super()
    this.opts = opts
    this.id = opts.id
    this.attachToken = opts.attachToken
    this.title = opts.title
    this.config = opts.config
    this.logger = opts.logger
    this.cols = opts.config.terminal.cols
    this.rows = opts.config.terminal.rows
    this.encoding = createEncodingBridge(opts.config.terminal.encoding as SupportedEncoding)
  }

  get attached(): boolean {
    return this.ws !== undefined
  }

  get closed(): boolean {
    return this.state === 'closed'
  }

  get negotiationInfo(): TerminalNegotiationInfo | undefined {
    return this.negotiation
  }

  get serverVersionString(): string {
    return this.serverIdent
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  /**
   * 建立 SSH 连接并打开 PTY shell。
   * 任何失败都会抛出 SshError，由 REST 层转成 HTTP 错误。
   */
  async start(): Promise<TerminalNegotiationInfo> {
    const { target, terminal, legacyCompat } = this.config
    const jumpChain = this.opts.jumpChain ?? []

    // 有跳板链时逐跳 forwardOut 打通；否则直连
    const chain = await (jumpChain.length > 0
      ? establishConnectionChain(
          [...jumpChain.map((t) => ({ target: t })), { target, legacyCompat: legacyCompat ?? 'auto' }],
          { knownHosts: this.opts.knownHosts, logger: this.logger },
        )
      : Promise.resolve({
          connection: await establishConnection({
            target,
            legacyCompat: legacyCompat ?? 'auto',
            knownHosts: this.opts.knownHosts,
            acceptHostKeyMismatch: this.opts.acceptHostKeyMismatch === true,
            keyboardInteractivePassword: target.password,
            logger: this.logger,
          }),
          intermediate: [] as EstablishedConnection[],
        }))

    const conn = chain.connection
    this.intermediateConns = chain.intermediate

    this.conn = conn
    this.serverIdent = conn.serverIdent

    // 连接建立后若被提前关闭（例如上层已取消），直接放弃
    if (this.state === 'closed') {
      conn.client.end()
      throw new SshError('INTERNAL', '会话在建立过程中被取消')
    }

    conn.client.on('error', (err: unknown) => {
      this.logger.warn({ terminalId: this.id, err: String(err) }, 'SSH 连接发生错误')
      this.fail(err)
    })
    conn.client.on('close', () => {
      this.logger.debug({ terminalId: this.id }, 'SSH 连接已关闭')
      this.shutdown('SSH 连接已关闭')
    })

    const stream = await this.openShell(conn.client)
    this.stream = stream

    const info: TerminalNegotiationInfo = {
      host: target.host,
      port: target.port,
      username: target.username,
      serverIdent: conn.serverIdent,
      kex: conn.negotiation.kex,
      hostKeyAlgorithm: conn.negotiation.hostKeyAlgorithm,
      cipherC2s: conn.negotiation.cipherC2s,
      cipherS2c: conn.negotiation.cipherS2c,
      mac: conn.negotiation.mac,
      profile: conn.profile.name,
      legacy: conn.profile.legacy,
      encoding: terminal.encoding,
      cols: this.cols,
      rows: this.rows,
    }
    this.negotiation = info
    this.state = 'ready'

    this.attachStreamHandlers(stream)
    return info
  }

  /** 打开 PTY shell；失败时抛出携带细分错误码的 SshError */
  private openShell(client: Client): Promise<ClientChannel> {
    const { terminal } = this.config
    return new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        {
          term: terminal.term,
          cols: this.cols,
          rows: this.rows,
        },
        (err, stream) => {
          if (err) {
            reject(classifySshError(err))
            return
          }
          resolve(stream)
        },
      )
    })
  }

  private attachStreamHandlers(stream: ClientChannel): void {
    stream.on('data', (chunk: Buffer) => {
      this.deliver(this.encoding.toClient(chunk))
    })

    // shell 场景下 stderr 与 stdout 共用同一终端，直接合并输出
    stream.stderr.on('data', (chunk: Buffer) => {
      this.deliver(this.encoding.toClient(chunk))
    })

    stream.on('exit', (code: number | null, signal: string | null) => {
      this.logger.debug({ terminalId: this.id, code, signal }, '远端进程已退出')
    })

    stream.on('close', (code: number | null, signal: string | null) => {
      const tail = this.encoding.flush()
      if (tail.length > 0) this.deliver(tail)

      const reason = this.describeExit(code, signal)
      this.emit('exit', { code, signal, reason })
      this.sendControl({ t: 'exit', code, signal, reason })
      this.shutdown(reason)
    })

    stream.on('error', (err: unknown) => {
      this.fail(err)
    })
  }

  private describeExit(code: number | null, signal: string | null): string {
    if (signal) return `远端进程被信号 ${signal} 终止`
    if (code === null || code === undefined) return '远端会话已结束'
    if (code === 0) return '远端会话正常结束'
    return `远端进程退出，退出码 ${code}`
  }

  /* ------------------------------------------------------------------ */
  /* WebSocket 附加                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 附加一个 WebSocket 客户端。
   * 若已有客户端附加，旧连接会被顶掉（同一终端同时只允许一个渲染端，
   * 否则两边都会收到输出，终端状态会互相污染）。
   */
  attach(ws: WebSocket): void {
    if (this.state === 'closed') {
      this.sendToWs(ws, { t: 'error', code: 'INTERNAL', message: '会话已结束', fatal: true })
      ws.close(1011, 'session closed')
      return
    }

    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.logger.warn({ terminalId: this.id }, '同一终端被重复附加，顶掉旧连接')
      this.ws.close(4000, 'superseded by a new attachment')
    }

    this.ws = ws
    this.unackedBytes = 0

    this.sendControl({
      t: 'ready',
      terminalId: this.id,
      info: this.negotiation ?? this.buildFallbackInfo(),
    })

    // 冲刷暂存输出
    if (this.pending.length > 0) {
      const chunks = this.pending
      this.pending = []
      this.pendingBytes = 0
      for (const chunk of chunks) this.deliver(chunk)
    }

    this.recomputeBackpressure()
  }

  /** 客户端断开 */
  detach(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.ws = undefined
    this.unackedBytes = 0
    this.lastDetachedAt = Date.now()
    // 没有渲染端时不再需要向远端施压，恢复读取避免远端阻塞
    this.pending = []
    this.pendingBytes = 0
    this.resumeStream()
    this.logger.debug({ terminalId: this.id }, 'WebSocket 客户端已断开，终端保持存活等待重连')
  }

  /** 处理客户端控制消息 */
  handleControl(msg: ClientControlMessage): void {
    switch (msg.t) {
      case 'resize': {
        this.cols = msg.cols
        this.rows = msg.rows
        if (this.negotiation) {
          this.negotiation.cols = msg.cols
          this.negotiation.rows = msg.rows
        }
        try {
          // 窗口尺寸变化只需告知远端 PTY，不必重启会话
          this.stream?.setWindow(msg.rows, msg.cols, 0, 0)
        } catch (err) {
          this.logger.warn({ terminalId: this.id, err: String(err) }, '设置窗口尺寸失败')
        }
        break
      }
      case 'ping':
        this.sendControl({ t: 'pong' })
        break
      case 'ack':
        this.unackedBytes = Math.max(0, this.unackedBytes - msg.bytes)
        this.recomputeBackpressure()
        break
    }
  }

  /** 处理客户端二进制帧（键盘输入） */
  handleInput(chunk: Buffer): void {
    if (chunk.length === 0) return
    if (chunk.length > MAX_INPUT_FRAME_BYTES) {
      this.logger.warn({ terminalId: this.id, size: chunk.length }, '输入帧过大，已丢弃')
      return
    }
    if (!this.stream || this.state !== 'ready') return

    const payload = this.encoding.toRemote(chunk)
    if (payload.length === 0) return

    // write 返回 false 表示远端窗口已满，此处无需额外处理：
    // ssh2 内部会缓冲并保证顺序，终端交互量级远小于输出量
    this.stream.write(payload)
  }

  /* ------------------------------------------------------------------ */
  /* 输出投递与背压                                                       */
  /* ------------------------------------------------------------------ */

  private deliver(buf: Buffer): void {
    if (buf.length === 0 || this.state === 'closed') return

    const ws = this.ws
    if (!ws || ws.readyState !== ws.OPEN) {
      // 尚无渲染端：暂存（上限由背压保证，超限时会暂停远端读取）
      this.pending.push(buf)
      this.pendingBytes += buf.length
      this.recomputeBackpressure()
      return
    }

    ws.send(buf)
    this.unackedBytes += buf.length
    this.recomputeBackpressure()
  }

  private sendControl(msg: ServerControlMessage): void {
    const ws = this.ws
    if (!ws || ws.readyState !== ws.OPEN) return
    this.sendToWs(ws, msg)
  }

  private sendToWs(ws: WebSocket, msg: ServerControlMessage): void {
    if (ws.readyState !== ws.OPEN) return
    try {
      ws.send(JSON.stringify(msg))
    } catch (err) {
      this.logger.warn({ terminalId: this.id, err: String(err) }, '发送控制消息失败')
    }
  }

  /** 是否需要暂停远端读取 */
  private shouldPause(): boolean {
    if (!this.stream) return false
    if (this.unackedBytes >= BACKPRESSURE_HIGH_WATER_MARK) return true
    if (this.pendingBytes >= BACKPRESSURE_HIGH_WATER_MARK) return true
    const ws = this.ws
    if (ws && ws.bufferedAmount >= BACKPRESSURE_HIGH_WATER_MARK) return true
    return false
  }

  /** 是否可以恢复远端读取（必须两个信号都回落到低水位以下） */
  private canResume(): boolean {
    if (this.unackedBytes >= BACKPRESSURE_LOW_WATER_MARK) return false
    if (this.pendingBytes >= BACKPRESSURE_LOW_WATER_MARK) return false
    const ws = this.ws
    if (ws && ws.bufferedAmount >= BACKPRESSURE_LOW_WATER_MARK) return false
    return true
  }

  private recomputeBackpressure(): void {
    if (!this.stream) return

    if (!this.paused && this.shouldPause()) {
      this.paused = true
      try {
        this.stream.pause()
      } catch {
        /* 通道可能已关闭，忽略 */
      }
      this.sendControl({ t: 'flow', action: 'pause' })
      this.logger.debug({ terminalId: this.id, unacked: this.unackedBytes }, '背压触发，暂停远端读取')
      this.startBackpressureTimer()
      return
    }

    if (this.paused && this.canResume()) {
      this.paused = false
      this.stopBackpressureTimer()
      try {
        this.stream.resume()
      } catch {
        /* 通道可能已关闭，忽略 */
      }
      this.sendControl({ t: 'flow', action: 'resume' })
      this.logger.debug({ terminalId: this.id }, '背压缓解，恢复远端读取')
    }
  }

  /**
   * 暂停后需要周期性重新评估：
   * `bufferedAmount` 的下降不会触发任何事件，只能轮询。
   */
  private startBackpressureTimer(): void {
    if (this.backpressureTimer) return
    this.backpressureTimer = setInterval(() => {
      this.recomputeBackpressure()
    }, BACKPRESSURE_CHECK_INTERVAL_MS)
    this.backpressureTimer.unref?.()
  }

  private stopBackpressureTimer(): void {
    if (!this.backpressureTimer) return
    clearInterval(this.backpressureTimer)
    this.backpressureTimer = undefined
  }

  private resumeStream(): void {
    if (!this.paused) return
    this.paused = false
    this.stopBackpressureTimer()
    try {
      this.stream?.resume()
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 错误处理与关闭                                                       */
  /* ------------------------------------------------------------------ */

  private fail(err: unknown): void {
    // 会话关闭后连接拆除会产生一连串衍生错误，这些不是新问题，只记 debug
    if (this.state === 'closed') {
      this.logger.debug({ terminalId: this.id, err: String(err) }, '会话已关闭，忽略后续错误')
      return
    }

    const classified = classifySshError(err)
    this.logger.warn(
      { terminalId: this.id, code: classified.code, err: classified.message },
      '终端会话发生错误',
    )
    this.sendControl({
      t: 'error',
      code: classified.code,
      message: classified.hint ? `${classified.message}\n\n${classified.hint}` : classified.message,
      fatal: classified.fatal,
    })
    if (classified.fatal) this.shutdown(classified.message)
  }

  /** 主动写入一段提示文本（如连接失败的说明），让用户在前端看到原因 */
  writeNotice(lines: string[], code: TerminalErrorCode = 'TRANSPORT'): void {
    const text = lines.map((l) => `\r\n${l}`).join('')
    // 提示文本统一以 \r\n 结尾，避免与后续 shell 提示符粘连
    this.deliver(Buffer.from(`${text}\r\n`, 'utf8'))
    this.sendControl({ t: 'error', code, message: lines.join('\n'), fatal: false })
  }

  private buildFallbackInfo(): TerminalNegotiationInfo {
    const { target, terminal } = this.config
    return {
      host: target.host,
      port: target.port,
      username: target.username,
      serverIdent: this.serverIdent,
      kex: 'unknown',
      hostKeyAlgorithm: 'unknown',
      cipherC2s: 'unknown',
      cipherS2c: 'unknown',
      mac: 'unknown',
      profile: 'unknown',
      legacy: false,
      encoding: terminal.encoding,
      cols: this.cols,
      rows: this.rows,
    }
  }

  /** 关闭会话（幂等） */
  shutdown(reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'

    this.stopBackpressureTimer()

    try {
      this.stream?.end()
    } catch {
      /* 忽略 */
    }
    try {
      this.stream?.destroy()
    } catch {
      /* 忽略 */
    }
    try {
      this.conn?.client.end()
    } catch {
      /* 忽略 */
    }
    // 释放跳板链上的全部中间连接，避免占用远端转发资源
    for (const conn of this.intermediateConns) {
      try {
        conn.client.end()
      } catch {
        /* 忽略 */
      }
    }
    this.intermediateConns = []

    const ws = this.ws
    if (ws && ws.readyState === ws.OPEN) {
      // 正常关闭码；会话结束不是错误
      ws.close(1000, 'terminal closed')
    }
    this.ws = undefined
    this.pending = []
    this.pendingBytes = 0

    this.logger.info({ terminalId: this.id, reason }, '终端会话已关闭')
    this.emit('closed', reason)
  }
}
