/**
 * 本地转发（对应 `ssh -L [bind:]port:host:hostport`）。
 *
 * 本机 `net.createServer` 监听一个端口，每来一个连接就通过 SSH 连接
 * `forwardOut()` 打开一条到目标的通道，然后把两条流对接起来。
 *
 * 注意 forwardOut 的第一个参数 `srcIP/srcPort`：这里是「通道的来源描述」，
 * 远端服务器通常只在日志里记录它。填 127.0.0.1:0 而不是监听地址，
 * 是为了不去猜测真实客户端地址（多网卡场景下猜错反而更误导）。
 */
import net from 'node:net'
import type { Server as NetServer, Socket } from 'node:net'
import type { Client } from 'ssh2'
import type { LocalForwardSpec } from '@webterm/shared'
import { TUNNEL_CHANNEL_TIMEOUT_MS } from '@webterm/shared'
import { TunnelBase, type TunnelBaseOptions } from './tunnel-base.js'
import { classifyTunnelError, TunnelError } from './errors.js'

export interface LocalForwardOptions extends Omit<TunnelBaseOptions, 'spec'> {
  spec: LocalForwardSpec
  client: Client
}

export class LocalForward extends TunnelBase {
  private readonly client: Client
  private server: NetServer | undefined

  constructor(opts: LocalForwardOptions) {
    super({ ...opts, spec: opts.spec })
    this.client = opts.client
  }

  /** 基类的 spec 是联合类型；本类只会拿到 local 分支，收窄一次即可 */
  private get local(): LocalForwardSpec {
    return this.spec as LocalForwardSpec
  }

  protected override async onStart(): Promise<void> {
    const { bindHost, bindPort } = this.local
    const server = net.createServer((socket) => {
      this.handleIncoming(socket)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        // 端口占用 / 无权限等绑定失败：分类后抛给基类统一记录
        reject(classifyTunnelError(err, { bindHost, bindPort }))
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // 不指定 host 时 Node 会监听所有接口，这里必须显式传 bindHost
      server.listen(bindPort, bindHost)
    })

    this.server = server
    // 监听建立之后再把 error 事件转为「标记错误态」，避免静默失败
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
      // 已有连接会拦住 close 的回调，但本类在 stop() 之后紧接着就会
      // 拆掉全部在途 socket，这里不必额外等待
      setTimeout(resolve, 200).unref?.()
    })
  }

  protected override describeBound(): { boundHost?: string; boundPort?: number } {
    const address = this.server?.address()
    if (address && typeof address === 'object') {
      return { boundHost: address.address === '::' ? '0.0.0.0' : address.address, boundPort: address.port }
    }
    return { boundHost: this.local.bindHost, boundPort: this.local.bindPort }
  }

  /** 本机来的连接：开通道 → 对接 */
  private handleIncoming(socket: Socket): void {
    const { targetHost, targetPort } = this.local
    const label = `${targetHost}:${targetPort}`

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      this.logger.warn({ tunnelId: this.id, label }, '打开转发通道超时')
    }, TUNNEL_CHANNEL_TIMEOUT_MS)
    timer.unref?.()

    this.client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, channel) => {
      if (settled) {
        // 已经超时放弃，但通道可能仍被建立出来，必须关掉
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
        const classified = classifyTunnelError(err, { bindHost: targetHost, bindPort: targetPort })
        this.logger.warn({ tunnelId: this.id, label, err: classified.message }, '打开转发通道失败')
        socket.destroy()
        return
      }

      this.bridge(socket, channel, label)
    })
  }

  /** 供 manager 校验：目标必须存在（类型收窄用） */
  static assert(spec: unknown): asserts spec is LocalForwardSpec {
    const s = spec as LocalForwardSpec
    if (
      !s ||
      s.type !== 'local' ||
      typeof s.bindHost !== 'string' ||
      typeof s.bindPort !== 'number' ||
      typeof s.targetHost !== 'string' ||
      typeof s.targetPort !== 'number'
    ) {
      throw new TunnelError('INVALID_CONFIG', '本地转发配置不完整')
    }
  }
}
