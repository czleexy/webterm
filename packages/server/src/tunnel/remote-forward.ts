/**
 * 远程转发（对应 `ssh -R [bind:]port:host:hostport`）。
 *
 * 与前两种正好相反：**监听发生在远端**。客户端只发一个 `tcpip-forward`
 * 全局请求告诉服务器「帮我在 X 端口上听」，之后每当有人连上那个端口，
 * 服务器就会打开一条 `forwarded-tcpip` 通道回到我们这边；我们要做的是
 * 把这条通道接到本机的目标服务上。
 *
 * 典型用途：把本机跑的服务临时暴露给远端网络（远端机器能访问到你本地的服务）。
 *
 * bindPort 允许填 0，表示「随便挑一个空闲端口」，此时必须用服务器
 * 在应答里返回的真实端口，否则后续事件无法匹配。
 */
import net from 'node:net'
import type { Socket } from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import type { RemoteForwardSpec } from '@webterm/shared'
import { TunnelBase, type TunnelBaseOptions } from './tunnel-base.js'
import { classifyTunnelError, TunnelError } from './errors.js'

/** ssh2 `tcp connection` 事件携带的信息 */
export interface ForwardedTcpipInfo {
  destIP: string
  destPort: number
  srcIP: string
  srcPort: number
}

export interface RemoteForwardOptions extends Omit<TunnelBaseOptions, 'spec'> {
  spec: RemoteForwardSpec
  client: Client
}

export class RemoteForward extends TunnelBase {
  private readonly client: Client
  /** 远端实际监听的地址与端口（bindPort=0 时由服务器分配） */
  private actualHost = ''
  private actualPort = 0

  constructor(opts: RemoteForwardOptions) {
    super({ ...opts, spec: opts.spec })
    this.client = opts.client
  }

  /** 基类的 spec 是联合类型；本类只会拿到 remote 分支 */
  private get remote(): RemoteForwardSpec {
    return this.spec as RemoteForwardSpec
  }

  protected override async onStart(): Promise<void> {
    const { bindHost, bindPort } = this.remote

    let granted: number
    try {
      granted = await new Promise<number>((resolve, reject) => {
        this.client.forwardIn(bindHost, bindPort, (err, port) => {
          if (err) {
            reject(classifyTunnelError(err, { bindHost, bindPort }))
            return
          }
          // 固定端口时服务器不回带端口，沿用请求值
          resolve(typeof port === 'number' && port > 0 ? port : bindPort)
        })
      })
    } catch (err) {
      if (err instanceof TunnelError) throw err
      throw classifyTunnelError(err, { bindHost, bindPort })
    }

    if (!granted) {
      throw new TunnelError('FORWARD_REJECTED', `远端未返回可用的监听端口（${bindHost}）`, {
        hint: '对端 sshd 可能禁止端口转发（AllowTcpForwarding no / GatewayPorts 限制）。',
      })
    }

    this.actualHost = bindHost
    this.actualPort = granted
  }

  protected override async onStop(): Promise<void> {
    const port = this.actualPort
    const host = this.actualHost
    this.actualPort = 0
    this.actualHost = ''
    if (!port) return

    await new Promise<void>((resolve) => {
      try {
        this.client.unforwardIn(host, port, () => resolve())
      } catch {
        // 连接已经断了，远端监听随之失效，无需再撤销
        resolve()
      }
      setTimeout(resolve, 500).unref?.()
    })
  }

  protected override describeBound(): { boundHost?: string; boundPort?: number } {
    return {
      boundHost: this.actualHost || this.remote.bindHost,
      boundPort: this.actualPort || this.remote.bindPort,
    }
  }

  /** 这条隧道是否负责处理该端口上的入站连接 */
  matches(destPort: number): boolean {
    return this.isActive && this.actualPort !== 0 && destPort === this.actualPort
  }

  /**
   * 处理远端回送过来的一条通道。
   * 先把通道 accept 下来（此时已经无法拒绝），再连本机目标；连不上就关掉通道。
   */
  handleChannel(info: ForwardedTcpipInfo, accept: () => ClientChannel): void {
    const { targetHost, targetPort } = this.remote
    const label = `${targetHost}:${targetPort}`

    let channel: ClientChannel
    try {
      channel = accept()
    } catch (err) {
      this.logger.warn({ tunnelId: this.id, err: String(err) }, '接受远端转发通道失败')
      return
    }

    const socket: Socket = net.connect(targetPort, targetHost)
    socket.on('connect', () => {
      this.bridge(socket, channel, `<- ${info.srcIP}:${info.srcPort} → ${label}`)
    })
    socket.on('error', (err) => {
      const classified = classifyTunnelError(err, { bindHost: targetHost, bindPort: targetPort })
      this.logger.warn(
        { tunnelId: this.id, label, src: `${info.srcIP}:${info.srcPort}`, err: classified.message },
        '远程转发到本机目标失败',
      )
      try {
        channel.close()
      } catch {
        /* 忽略 */
      }
      socket.destroy()
    })
  }

  static assert(spec: unknown): asserts spec is RemoteForwardSpec {
    const s = spec as RemoteForwardSpec
    if (
      !s ||
      s.type !== 'remote' ||
      typeof s.bindHost !== 'string' ||
      typeof s.bindPort !== 'number' ||
      typeof s.targetHost !== 'string' ||
      typeof s.targetPort !== 'number'
    ) {
      throw new TunnelError('INVALID_CONFIG', '远程转发配置不完整')
    }
  }
}
