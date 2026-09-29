/**
 * 动态转发（对应 `ssh -D [bind:]port`）。
 *
 * 本机监听一个端口作为 SOCKS5 代理，每个会话的目标地址由客户端在握手时指定。
 * 一次配置即可覆盖「浏览器访问内网多个站点」这类场景，不必为每个目标开一条 -L。
 */
import net from 'node:net'
import type { Server as NetServer, Socket } from 'node:net'
import type { Client } from 'ssh2'
import type { DynamicForwardSpec } from '@webterm/shared'
import { SOCKS5_NO_AUTH, TUNNEL_CHANNEL_TIMEOUT_MS } from '@webterm/shared'
import { TunnelBase, type TunnelBaseOptions } from './tunnel-base.js'
import { classifyTunnelError, TunnelError } from './errors.js'
import {
  methodReply,
  replyBuffer,
  replyCodeForError,
  SOCKS5_METHOD_NO_ACCEPTABLE,
  SOCKS5_REP_SUCCESS,
  SOCKS5_REP_TTL_EXPIRED,
  Socks5Negotiator,
} from './socks5.js'

export interface DynamicForwardOptions extends Omit<TunnelBaseOptions, 'spec'> {
  spec: DynamicForwardSpec
  client: Client
}

export class DynamicForward extends TunnelBase {
  private readonly client: Client
  private server: NetServer | undefined

  constructor(opts: DynamicForwardOptions) {
    super({ ...opts, spec: opts.spec })
    this.client = opts.client
  }

  /** 基类的 spec 是联合类型；本类只会拿到 dynamic 分支 */
  private get dynamic(): DynamicForwardSpec {
    return this.spec as DynamicForwardSpec
  }

  protected override async onStart(): Promise<void> {
    const { bindHost, bindPort } = this.dynamic
    const server = net.createServer((socket) => {
      this.handleSocksClient(socket)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        reject(classifyTunnelError(err, { bindHost, bindPort }))
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(bindPort, bindHost)
    })

    this.server = server
    server.on('error', (err: Error) => {
      this.markError(classifyTunnelError(err, { bindHost, bindPort }))
    })
  }

  protected override async onStop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      setTimeout(resolve, 200).unref?.()
    })
  }

  protected override describeBound(): { boundHost?: string; boundPort?: number } {
    const address = this.server?.address()
    if (address && typeof address === 'object') {
      return { boundHost: address.address === '::' ? '0.0.0.0' : address.address, boundPort: address.port }
    }
    return { boundHost: this.dynamic.bindHost, boundPort: this.dynamic.bindPort }
  }

  /* ------------------------------------------------------------------ */
  /* SOCKS5 会话                                                         */
  /* ------------------------------------------------------------------ */

  private handleSocksClient(socket: Socket): void {
    const negotiator = new Socks5Negotiator()
    // 握手期间不转发数据；解析成功后才让数据流进入桥接
    let established = false

    const fail = (reason: string): void => {
      this.logger.debug({ tunnelId: this.id, reason }, 'SOCKS5 会话被拒绝')
      socket.destroy()
    }

    const onData = (chunk: Buffer): void => {
      if (established) return
      const step = negotiator.consume(chunk)

      switch (step.kind) {
        case 'need-more':
          return
        case 'greeting-accepted':
          socket.write(methodReply(SOCKS5_NO_AUTH))
          return
        case 'greeting-rejected':
          socket.write(methodReply(SOCKS5_METHOD_NO_ACCEPTABLE))
          fail('客户端不支持「无需认证」方式')
          return
        case 'unsupported':
          socket.write(step.reply)
          fail(step.reason)
          return
        case 'malformed':
          fail(step.reason)
          return
        case 'connect':
          established = true
          socket.removeListener('data', onData)
          this.openChannel(socket, step.request.host, step.request.port)
          return
      }
    }

    socket.on('error', () => {
      /* 客户端提前断开是常态，静默处理 */
    })
    socket.on('data', onData)
  }

  /** 按客户端指定的目标开通道，成功则回应答并桥接 */
  private openChannel(socket: Socket, rawHost: string, port: number): void {
    // IPv6 字面量在 SOCKS5 里用方括号表示，但 ssh2 的 forwardOut 需要裸地址
    const host = rawHost.replace(/^\[|\]$/g, '')
    const label = `${host}:${port}`

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.write(replyBuffer(SOCKS5_REP_TTL_EXPIRED))
      socket.destroy()
      this.logger.warn({ tunnelId: this.id, label }, 'SOCKS5 目标通道建立超时')
    }, TUNNEL_CHANNEL_TIMEOUT_MS)
    timer.unref?.()

    this.client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
      if (settled) {
        try {
          channel?.close()
        } catch {
          /* 忽略 */
        }
        return
      }
      settled = true
      clearTimeout(timer)

      if (err) {
        const classified = classifyTunnelError(err, { bindHost: host, bindPort: port })
        const errno = (err as { code?: string } | undefined)?.code
        // 失败也要回一个规范的应答，客户端才知道「是目标不可达」而不是代理挂了
        socket.write(replyBuffer(replyCodeForError(errno)))
        this.logger.warn({ tunnelId: this.id, label, err: classified.message }, 'SOCKS5 目标连接失败')
        socket.destroy()
        return
      }

      socket.write(replyBuffer(SOCKS5_REP_SUCCESS))
      // 握手期间可能已经攒下后续数据（客户端常常连握手带数据一起发），
      // 这些字节在 socket 的读缓冲里，桥接开始后会被自然读出
      this.bridge(socket, channel, label)
    })
  }

  static assert(spec: unknown): asserts spec is DynamicForwardSpec {
    const s = spec as DynamicForwardSpec
    if (!s || s.type !== 'dynamic' || typeof s.bindHost !== 'string' || typeof s.bindPort !== 'number') {
      throw new TunnelError('INVALID_CONFIG', '动态转发配置不完整')
    }
  }
}
