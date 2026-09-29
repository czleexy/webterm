/**
 * 隧道基类：状态机 + 双向转发 + 统计。
 *
 * 三类隧道（本地 / 远程 / 动态）的差异只在两处：
 *   1. 监听放在哪一侧（本机 net.createServer，还是远端 global request）
 *   2. 每个接入的连接如何拿到对端的通道（forwardOut，还是 forwarded-tcpip 回调）
 * 其余部分完全一致 —— 状态流转、字节统计、连接计数、销毁时的资源回收。
 * 把这些提到基类，三个子类各自只剩几十行，也保证统计口径不会各写一套。
 *
 * 统计口径（面板上会直接展示，必须写死）：
 *   bytesUp   本地 → 远端（用户发出去的数据）
 *   bytesDown 远端 → 本地（用户收到的数据）
 */
import type { Duplex } from 'node:stream'
import type { TunnelInfo, TunnelSpec, TunnelStatus } from '@webterm/shared'
import { TunnelError } from './errors.js'

export interface TunnelLogger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface TunnelBaseOptions {
  id: string
  spec: TunnelSpec
  /** 宿主终端 id 与标题，用于面板展示 */
  terminalId: string
  terminalTitle: string
  autoStarted?: boolean
  logger: TunnelLogger
}

export abstract class TunnelBase {
  readonly id: string
  readonly spec: TunnelSpec
  readonly terminalId: string
  readonly terminalTitle: string
  readonly autoStarted: boolean

  protected readonly logger: TunnelLogger

  private status: TunnelStatus = 'stopped'
  private lastError: string | undefined
  private startedAtMs: number | undefined

  /** 当前活跃的桥接 socket，stop 时需要全部拆掉 */
  private readonly sockets = new Set<Duplex>()

  private activeConnections = 0
  private totalConnections = 0
  private bytesUp = 0
  private bytesDown = 0

  constructor(opts: TunnelBaseOptions) {
    this.id = opts.id
    this.spec = opts.spec
    this.terminalId = opts.terminalId
    this.terminalTitle = opts.terminalTitle
    this.autoStarted = opts.autoStarted === true
    this.logger = opts.logger
  }

  /* ---------------- 子类钩子 ---------------- */

  /** 开始监听/申请转发；失败请抛 TunnelError */
  protected abstract onStart(): Promise<void>

  /** 撤销监听（幂等；可能已被远端断开，实现要容忍失败） */
  protected abstract onStop(): Promise<void>

  /** 实际生效的监听地址：远程转发 bindPort=0 时由远端分配，必须回报真实值 */
  protected describeBound(): { boundHost?: string; boundPort?: number } {
    return {}
  }

  /* ---------------- 生命周期 ---------------- */

  get isActive(): boolean {
    return this.status === 'active'
  }

  get currentStatus(): TunnelStatus {
    return this.status
  }

  /** 启动（可从 stopped / error 状态重启） */
  async start(): Promise<void> {
    if (this.status === 'active' || this.status === 'starting') return
    this.status = 'starting'
    this.lastError = undefined
    try {
      await this.onStart()
      this.status = 'active'
      this.startedAtMs = Date.now()
      this.logger.info(
        { tunnelId: this.id, type: this.spec.type, bind: describeBind(this.spec) },
        '隧道已启动',
      )
    } catch (err) {
      const tunnelErr = err instanceof TunnelError ? err : new TunnelError('TRANSPORT', String(err))
      this.status = 'error'
      this.lastError = tunnelErr.hint
        ? `${tunnelErr.message}\n${tunnelErr.hint}`
        : tunnelErr.message
      this.logger.warn({ tunnelId: this.id, err: this.lastError }, '隧道启动失败')
      throw tunnelErr
    }
  }

  /** 停止：先撤销监听，再拆掉所有在途连接（幂等） */
  async stop(reason = '用户停止'): Promise<void> {
    if (this.status === 'stopped') return
    try {
      await this.onStop()
    } catch (err) {
      // 监听已经不存在（对端断开等）不算失败，记 debug 即可
      this.logger.debug({ tunnelId: this.id, err: String(err) }, '撤销隧道监听时出错（已忽略）')
    }
    this.dropSockets()
    this.status = 'stopped'
    this.startedAtMs = undefined
    this.logger.info({ tunnelId: this.id, reason }, '隧道已停止')
  }

  /**
   * 立即放弃（连接已断开、进程退出等场景）。
   * 无法再与远端通信，因此只做本地资源回收 + 尽力撤销监听，不做任何等待。
   * 与 `stop()` 的区别：stop 会等 `onStop()` 完成（用户主动停止时端口要真释放）。
   */
  abort(reason: string): void {
    try {
      void Promise.resolve(this.onStop()).catch(() => {
        /* 连接已断，撤销失败是预期内的 */
      })
    } catch {
      /* 同上 */
    }
    this.dropSockets()
    if (this.status !== 'stopped') {
      this.status = 'stopped'
      this.startedAtMs = undefined
    }
    this.logger.debug({ tunnelId: this.id, reason }, '隧道被外部关闭')
  }

  /* ---------------- 转发与统计 ---------------- */

  /**
   * 桥接一对 socket。
   *
   * 两端都可能因为对端断开而触发 close，因此所有收尾动作都要幂等 ——
   * 重复 destroy 本身无害，但重复扣减活跃计数会让面板数字变负。
   */
  protected bridge(local: Duplex, remote: Duplex, label: string): void {
    this.activeConnections += 1
    this.totalConnections += 1

    this.sockets.add(local)
    this.sockets.add(remote)

    let closed = false
    const teardown = (): void => {
      if (closed) return
      closed = true
      this.activeConnections = Math.max(0, this.activeConnections - 1)
      this.sockets.delete(local)
      this.sockets.delete(remote)
      destroyQuietly(local)
      destroyQuietly(remote)
    }

    // 关闭任一端即整条连接结束：半关闭在转发场景没有意义，
    // 留着只会让「活跃连接数」永远降不下来
    local.once('close', teardown)
    remote.once('close', teardown)
    local.once('error', teardown)
    remote.once('error', teardown)

    // 数据方向：
    //   local  → remote  记为上行（用户把数据送进远端网络）
    //   remote → local   记为下行
    pipeCounted(local, remote, (n) => {
      this.bytesUp += n
    })
    pipeCounted(remote, local, (n) => {
      this.bytesDown += n
    })

    this.logger.debug(
      { tunnelId: this.id, label, active: this.activeConnections },
      '隧道接入新连接',
    )
  }

  private dropSockets(): void {
    for (const socket of [...this.sockets]) destroyQuietly(socket)
    this.sockets.clear()
    this.activeConnections = 0
  }

  /* ---------------- 快照 ---------------- */

  snapshot(): TunnelInfo {
    const bound = this.describeBound()
    const info: TunnelInfo = {
      id: this.id,
      terminalId: this.terminalId,
      terminalTitle: this.terminalTitle,
      spec: this.spec,
      status: this.status,
      activeConnections: this.activeConnections,
      totalConnections: this.totalConnections,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
    }
    if (this.lastError) info.error = this.lastError
    if (bound.boundHost !== undefined) info.boundHost = bound.boundHost
    if (bound.boundPort !== undefined) info.boundPort = bound.boundPort
    if (this.startedAtMs !== undefined) info.startedAt = new Date(this.startedAtMs).toISOString()
    if (this.autoStarted) info.autoStarted = true
    return info
  }

  /** 标记错误态（子类在运行期发现不可恢复问题时调用） */
  protected markError(err: TunnelError): void {
    this.lastError = err.hint ? `${err.message}\n${err.hint}` : err.message
    this.status = 'error'
    this.dropSockets()
  }
}

/** 展示用：`127.0.0.1:13306`；dynamic/remote 只显示监听端 */
function describeBind(spec: TunnelSpec): string {
  return `${spec.bindHost}:${spec.bindPort === 0 ? 'auto' : spec.bindPort}`
}

/**
 * 单向搬运并计数。
 *
 * 必须处理背压：`write()` 返回 false 表示对端消费不过来，此时暂停源端读取，
 * 等 drain 再恢复 —— 否则大文件经隧道传输时会把进程内存吃满。
 * 由于暂停后不会再收到 data 事件，同一时刻最多挂一个 drain 监听，不会堆积。
 */
function pipeCounted(src: Duplex, dst: Duplex, onBytes: (n: number) => void): void {
  src.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    onBytes(buf.length)
    if (!dst.write(buf)) {
      src.pause()
      dst.once('drain', () => src.resume())
    }
  })
  src.on('end', () => {
    try {
      dst.end()
    } catch {
      /* 对端可能已关闭 */
    }
  })
}

function destroyQuietly(stream: Duplex): void {
  try {
    stream.destroy()
  } catch {
    /* 忽略 */
  }
}
