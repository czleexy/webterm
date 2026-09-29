/**
 * 隧道管理器：挂在一个会话的 SSH 连接上。
 *
 * 为什么按「会话」而不是「全局」组织：
 * 三类转发都需要一条已认证的 SSH 连接来承载通道，连接的所有权属于终端会话
 * （老设备的 VTY 线路有限，重复登录会把后来的会话挡在门外，这一点在 SFTP
 * 阶段已经踩过坑）。因此隧道的生命周期天然与会话一致：会话关闭 → 全部隧道
 * 连带监听端口一起释放，不会留下悬挂监听。
 *
 * 远程转发的入站通道由 ssh2 通过 `tcp connection` 事件回调，多个远程转发
 * 共享同一个事件，所以在管理器里只注册**一个**监听器再按端口分发 ——
 * 每个隧道各注册一个监听器会让「谁的端口」变得难以推理，漏网通道还会一直挂着。
 */
import { randomUUID } from 'node:crypto'
import type { Client } from 'ssh2'
import type { TunnelInfo, TunnelSpec } from '@webterm/shared'
import { MAX_TUNNELS_PER_SESSION } from '@webterm/shared'
import { DynamicForward } from './dynamic-forward.js'
import { LocalForward } from './local-forward.js'
import { RemoteForward, type ForwardedTcpipInfo } from './remote-forward.js'
import { TunnelBase, type TunnelLogger } from './tunnel-base.js'
import { TunnelError } from './errors.js'

export interface TunnelManagerOptions {
  client: Client
  terminalId: string
  terminalTitle: string
  logger: TunnelLogger
}

export interface CreateTunnelResult {
  tunnel: TunnelBase
  info: TunnelInfo
}

export class TunnelManager {
  private readonly client: Client
  private readonly terminalId: string
  private readonly terminalTitle: string
  private readonly logger: TunnelLogger
  private readonly tunnels = new Map<string, TunnelBase>()
  /** 远程转发的入站通道监听器（整个会话只注册一次） */
  private readonly onTcpConnection: (
    info: ForwardedTcpipInfo,
    accept: () => import('ssh2').ClientChannel,
    reject: () => void,
  ) => void

  constructor(opts: TunnelManagerOptions) {
    this.client = opts.client
    this.terminalId = opts.terminalId
    this.terminalTitle = opts.terminalTitle
    this.logger = opts.logger

    this.onTcpConnection = (info, accept, reject) => {
      for (const tunnel of this.tunnels.values()) {
        if (tunnel instanceof RemoteForward && tunnel.matches(info.destPort)) {
          this.logger.debug(
            { tunnelId: tunnel.id, destPort: info.destPort, src: `${info.srcIP}:${info.srcPort}` },
            '远端转发的入站连接',
          )
          tunnel.handleChannel(info, accept)
          return
        }
      }
      // 没有隧道认领：必须显式拒绝，否则这条通道会一直挂在连接上
      this.logger.warn(
        { terminalId: this.terminalId, destPort: info.destPort },
        '收到无人认领的转发通道，已拒绝',
      )
      try {
        reject()
      } catch {
        /* 忽略 */
      }
    }
    this.client.on('tcp connection', this.onTcpConnection)
  }

  get count(): number {
    return this.tunnels.size
  }

  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map((t) => t.snapshot())
  }

  get(id: string): TunnelBase | undefined {
    return this.tunnels.get(id)
  }

  /**
   * 创建并启动一条隧道。
   * 启动失败时**不保留**这条记录：面板里留一条永远起不来的红条目，
   * 比直接把失败原因弹给用户更让人困惑；表单里的值不会丢，改个端口即可重试。
   */
  async create(spec: TunnelSpec, options: { autoStarted?: boolean } = {}): Promise<TunnelBase> {
    if (this.tunnels.size >= MAX_TUNNELS_PER_SESSION) {
      throw new TunnelError(
        'INVALID_CONFIG',
        `单个会话最多 ${MAX_TUNNELS_PER_SESSION} 条隧道，已达上限`,
        { hint: '先停掉不再使用的隧道再新建。' },
      )
    }

    const id = randomUUID()
    const base = {
      id,
      terminalId: this.terminalId,
      terminalTitle: this.terminalTitle,
      autoStarted: options.autoStarted === true,
      logger: this.logger,
    }
    let tunnel: TunnelBase

    switch (spec.type) {
      case 'local':
        LocalForward.assert(spec)
        tunnel = new LocalForward({ ...base, spec, client: this.client })
        break
      case 'remote':
        RemoteForward.assert(spec)
        tunnel = new RemoteForward({ ...base, spec, client: this.client })
        break
      case 'dynamic':
        DynamicForward.assert(spec)
        tunnel = new DynamicForward({ ...base, spec, client: this.client })
        break
      default: {
        // 穷尽性检查：新增隧道类型时这里会编译报错，避免漏改
        const never: never = spec
        throw new TunnelError('INVALID_CONFIG', `不支持的隧道类型：${JSON.stringify(never)}`)
      }
    }

    try {
      await tunnel.start()
    } catch (err) {
      // 起不来的隧道直接丢弃，半开状态（监听了但没写进表）绝对不能留
      throw err instanceof TunnelError
        ? err
        : new TunnelError('TRANSPORT', err instanceof Error ? err.message : String(err))
    }

    this.tunnels.set(id, tunnel)
    this.logger.info(
      { terminalId: this.terminalId, tunnelId: id, type: spec.type, auto: base.autoStarted },
      '隧道已创建',
    )
    return tunnel
  }

  /** 停止（保留定义，可再次启动） */
  async stop(id: string): Promise<boolean> {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) return false
    await tunnel.stop()
    return true
  }

  /** 重新启动一条已停止的隧道 */
  async restart(id: string): Promise<boolean> {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) return false
    await tunnel.start()
    return true
  }

  /** 停止并移除 */
  async remove(id: string): Promise<boolean> {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) return false
    await tunnel.stop('隧道已删除')
    this.tunnels.delete(id)
    return true
  }

  /**
   * 优雅销毁：撤销远端监听、关闭本地监听并等在途连接拆完（幂等）。
   * 用户主动关闭会话时走这条路 —— 返回后端口必须已经真的能重新 bind，
   * 否则界面上「已关闭」和 `netstat` 看到的会自相矛盾。
   */
  async destroy(reason = '会话已关闭'): Promise<void> {
    const all = [...this.tunnels.values()]
    // 先清空：销毁过程中到来的其它调用应当直接返回，不再重复处理同一批隧道
    this.tunnels.clear()
    this.client.removeListener('tcp connection', this.onTcpConnection)
    await Promise.all(
      all.map(async (t) => {
        try {
          await t.stop(reason)
        } catch (err) {
          this.logger.debug({ tunnelId: t.id, err: String(err) }, '关闭隧道时出错（已忽略）')
        }
      }),
    )
  }

  /** 同步尽力销毁（进程退出、宿主连接已断等来不及等待的场景） */
  abortAll(reason = '连接已断开'): void {
    const all = [...this.tunnels.values()]
    this.tunnels.clear()
    this.client.removeListener('tcp connection', this.onTcpConnection)
    for (const tunnel of all) tunnel.abort(reason)
  }
}
