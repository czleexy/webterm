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
  protocolOf,
  type ClientControlMessage,
  type ServerControlMessage,
  type SessionConfig,
  type SshTarget,
  type SupportedEncoding,
  type TelnetTarget,
  type TerminalErrorCode,
  type TerminalNegotiationInfo,
  type TunnelSpec,
} from '@webterm/shared'
import {
  establishConnection,
  establishConnectionChain,
  type EstablishedConnection,
} from '../ssh/connection.js'
import { classifySshError, SshError } from '../ssh/errors.js'
import type { KnownHostsStore } from '../ssh/known-hosts.js'
import { TelnetTransport } from '../telnet/transport.js'
import { classifyTelnetError, TelnetError } from '../telnet/errors.js'
import { TunnelManager } from '../tunnel/tunnel-manager.js'
import { createEncodingBridge, type EncodingBridge } from './encoding.js'

export interface TerminalSessionOptions {
  id: string
  attachToken: string
  title: string
  config: SessionConfig
  /** 跳板链（已解密为明文 target，按连接顺序）；最后一跳之后才是 config.target */
  jumpChain?: SshTarget[]
  /** 随会话自动启动的隧道定义（仅 SSH）；启动失败不阻断会话建立 */
  tunnels?: TunnelSpec[]
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

/** 会话保持中立：按当前协议选择对应的错误分类器 */
interface ClassifiedError {
  code: TerminalErrorCode
  message: string
  hint?: string
  fatal: boolean
}

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
  /** Telnet 传输（与 stream 互斥：同一会话只会走其中一条路径） */
  private telnet: TelnetTransport | undefined
  /** 端口转发管理（仅 SSH；随会话一同创建与销毁） */
  private tunnels: TunnelManager | undefined
  /** 自动启动隧道过程中产生的告警，供 REST 响应回传 */
  private tunnelWarnings: string[] = []
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
   * 供 SFTP 会话在同一连接上另开通道使用。
   * 返回 undefined 表示会话尚未就绪或已结束。
   *
   * 注意这里泄露的是底层 Client：SFTP 会话**不得**关闭它 ——
   * 连接的所有权始终属于终端会话（见 sftp-session.ts 的 ownsConnection）。
   */
  get sshClient(): Client | undefined {
    if (this.state === 'closed') return undefined
    return this.conn?.client
  }

  /** 会话是否仍可承载新通道 */
  get alive(): boolean {
    return this.state !== 'closed'
  }

  /**
   * 端口转发管理器（阶段 5）。
   * Telnet 会话与未就绪/已关闭的会话都没有 —— 调用方据此提示用户
   * 「先建立 SSH 连接」而不是抛一个语焉不详的错误。
   */
  get tunnelManager(): TunnelManager | undefined {
    if (this.state !== 'ready') return undefined
    return this.tunnels
  }

  /** 自动启动隧道时的告警（非致命），由 REST 响应回传给用户 */
  get tunnelStartWarnings(): string[] {
    return this.tunnelWarnings
  }

  /** 当前是否已有一条可用的传输（SSH 通道或 Telnet 连接） */
  private get hasTransport(): boolean {
    return this.stream !== undefined || this.telnet !== undefined
  }

  /**
   * 建立连接并进入就绪态。
   * 任何失败都会抛出 SshError / TelnetError，由 REST 层转成 HTTP 错误。
   */
  async start(): Promise<TerminalNegotiationInfo> {
    return protocolOf(this.config) === 'telnet' ? this.startTelnet() : this.startSsh()
  }

  /* ------------------------------------------------------------------ */
  /* Telnet 路径                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Telnet：一条裸 TCP 连接就是终端，没有握手、认证、通道申请这些阶段，
   * 因此「连接成功」即「终端就绪」，中途没有可失败的分支。
   */
  private async startTelnet(): Promise<TerminalNegotiationInfo> {
    const config = this.config
    if (config.protocol !== 'telnet') {
      throw new TelnetError('INTERNAL', '协议与调用路径不匹配')
    }

    // 跳板链依赖 SSH 的 forwardOut 通道，Telnet 这一层没有等价能力。
    // 与其静默忽略配置（用户会以为自己在走跳板），不如明确拒绝。
    if ((this.opts.jumpChain ?? []).length > 0) {
      throw new TelnetError('INVALID_CONFIG', 'Telnet 不支持跳板链', {
        hint: 'Telnet 属于明文协议且没有可承载转发通道的协议层。请先用 SSH 登录跳板机，再在终端里手动 telnet 目标设备。',
      })
    }

    const { target, terminal } = config
    const transport = await TelnetTransport.connect({
      host: target.host,
      port: target.port,
      term: terminal.term,
      cols: this.cols,
      rows: this.rows,
    })

    if (this.state === 'closed') {
      transport.close()
      throw new TelnetError('INTERNAL', '会话在建立过程中被取消')
    }

    this.telnet = transport
    this.serverIdent = transport.serverIdent

    transport.on('data', (chunk: Buffer) => {
      this.deliver(this.encoding.toClient(chunk))
    })

    // 协商结果会随后续往返变化（例如设备稍后才声明 WILL ECHO），
    // 变化时刷新一次摘要，附加到 WebSocket 时下发的就是最新状态
    transport.on('negotiation', () => {
      if (this.telnet) this.negotiation = this.buildTelnetInfo(this.telnet)
    })

    transport.on('error', (err: TelnetError) => {
      this.fail(err)
    })

    transport.on('close', (reason: string) => {
      const tail = this.encoding.flush()
      if (tail.length > 0) this.deliver(tail)
      this.emit('exit', { code: null, signal: null, reason })
      this.sendControl({ t: 'exit', code: null, signal: null, reason })
      this.shutdown(reason)
    })

    const info = this.buildTelnetInfo(transport)
    this.negotiation = info
    this.state = 'ready'
    return info
  }

  private buildTelnetInfo(transport: TelnetTransport): TerminalNegotiationInfo {
    const target = this.config.target as TelnetTarget
    return {
      protocol: 'telnet',
      host: target.host,
      port: target.port,
      // Telnet 没有登录名这一层，登录是在终端里逐行交互完成的
      username: '',
      serverIdent: transport.serverIdent,
      // 明文协议：这些 SSH 专有字段在界面上会整段隐藏，填占位符即可
      kex: '—',
      hostKeyAlgorithm: '—',
      cipherC2s: '—',
      cipherS2c: '—',
      mac: '—',
      profile: 'telnet',
      legacy: false,
      encoding: this.config.terminal.encoding,
      cols: this.cols,
      rows: this.rows,
      telnetOptions: transport.negotiationSummary,
    }
  }

  /* ------------------------------------------------------------------ */
  /* SSH 路径                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 建立 SSH 连接并打开 PTY shell。
   */
  private async startSsh(): Promise<TerminalNegotiationInfo> {
    const config = this.config
    if (config.protocol !== 'ssh') {
      throw new SshError('INTERNAL', '协议与调用路径不匹配')
    }
    const { target, terminal, legacyCompat } = config
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
      protocol: 'ssh',
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
    await this.setupTunnels(conn.client)
    return info
  }

  /**
   * 建立隧道管理器，并按会话配置自动启动隧道。
   *
   * 单条隧道失败（端口被占用是最常见的）绝不能把整个会话拖垮 ——
   * 用户的目的是登进设备，隧道只是搭在路上的便车。失败以告警形式回传，
   * 界面上是一条可忽略的提示，而不是「连接失败」。
   */
  private async setupTunnels(client: Client): Promise<void> {
    const manager = new TunnelManager({
      client,
      terminalId: this.id,
      terminalTitle: this.title,
      logger: this.logger,
    })
    this.tunnels = manager

    const specs = this.opts.tunnels ?? []
    if (specs.length === 0) return

    const results = await Promise.allSettled(
      specs.map((spec) => manager.create(spec, { autoStarted: true })),
    )

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      const spec = specs[index]
      if (!spec) return
      const err = result.reason as { message?: string; hint?: string } | undefined
      const message = err?.message ?? String(result.reason)
      const hint = err?.hint ? ` ${err.hint}` : ''
      const where =
        spec.type === 'dynamic'
          ? `${spec.bindHost}:${spec.bindPort}`
          : `${spec.bindHost}:${spec.bindPort} → ${spec.targetHost}:${spec.targetPort}`
      const line = `自动启动隧道失败（${where}）：${message}${hint}`
      this.tunnelWarnings.push(line)
      this.logger.warn({ terminalId: this.id, spec: where, err: message }, '自动启动隧道失败')
    })
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

    // Telnet 的协商是异步完成的（设备可能在连上几百毫秒后才声明 WILL ECHO），
    // 附加时重新取一次摘要，面板里显示的才是真实状态
    if (this.telnet) this.negotiation = this.buildTelnetInfo(this.telnet)

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
          // 窗口尺寸变化只需告知远端，不必重启会话。
          // SSH 走通道的 window-change，Telnet 走 NAWS 子协商。
          if (this.telnet) {
            this.telnet.setWindow(msg.cols, msg.rows)
          } else {
            this.stream?.setWindow(msg.rows, msg.cols, 0, 0)
          }
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
    if (!this.hasTransport || this.state !== 'ready') return

    const payload = this.encoding.toRemote(chunk)
    if (payload.length === 0) return

    if (this.telnet) {
      // Telnet 运输层负责把 0xFF 转义，并在对端不回显时补一份本地回显
      this.telnet.write(payload)
      return
    }

    // write 返回 false 表示远端窗口已满，此处无需额外处理：
    // ssh2 内部会缓冲并保证顺序，终端交互量级远小于输出量
    this.stream?.write(payload)
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
    if (!this.hasTransport) return false
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
    if (!this.hasTransport) return

    if (!this.paused && this.shouldPause()) {
      this.paused = true
      this.pauseTransport()
      this.sendControl({ t: 'flow', action: 'pause' })
      this.logger.debug({ terminalId: this.id, unacked: this.unackedBytes }, '背压触发，暂停远端读取')
      this.startBackpressureTimer()
      return
    }

    if (this.paused && this.canResume()) {
      this.paused = false
      this.stopBackpressureTimer()
      this.resumeTransport()
      this.sendControl({ t: 'flow', action: 'resume' })
      this.logger.debug({ terminalId: this.id }, '背压缓解，恢复远端读取')
    }
  }

  /** 暂停读取远端（SSH 通道或 Telnet socket 二选一） */
  private pauseTransport(): void {
    try {
      if (this.telnet) this.telnet.pause()
      else this.stream?.pause()
    } catch {
      /* 通道/套接字可能已关闭，忽略 */
    }
  }

  private resumeTransport(): void {
    try {
      if (this.telnet) this.telnet.resume()
      else this.stream?.resume()
    } catch {
      /* 通道/套接字可能已关闭，忽略 */
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
    this.resumeTransport()
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

    const classified = this.classifyError(err)
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

  /** 按协议选择错误分类器：Telnet 的 errno 与 SSH 的 ssh2 错误码不是一套 */
  private classifyError(err: unknown): ClassifiedError {
    if (err instanceof SshError || err instanceof TelnetError) return err
    return protocolOf(this.config) === 'telnet' ? classifyTelnetError(err) : classifySshError(err)
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
    const isTelnet = protocolOf(this.config) === 'telnet'
    return {
      protocol: isTelnet ? 'telnet' : 'ssh',
      host: target.host,
      port: target.port,
      username: isTelnet ? '' : (target as SshTarget).username,
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

    // 先撤隧道再拆连接：远程转发的 cancel-tcpip-forward 需要一条可用的 SSH 连接，
    // 本机监听则要显式 close 才会释放端口（`client.end()` 管不到本机端口）
    void this.closeTunnels(reason).catch(() => {
      /* destroy 内部已逐条容错，这里只兜底未预料的异常 */
    })

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
      this.telnet?.close()
    } catch {
      /* 忽略 */
    }
    this.telnet = undefined
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

  /**
   * 关闭全部隧道并等待监听端口释放（幂等）。
   * 与 shutdown 分开是因为用户主动关闭会话时，界面需要「端口已释放」这个事实
   * 在响应返回前就成立，而不是稍后异步成立。
   */
  async closeTunnels(reason: string): Promise<void> {
    const manager = this.tunnels
    this.tunnels = undefined
    if (manager) await manager.destroy(reason)
  }
}
