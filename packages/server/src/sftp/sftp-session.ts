/**
 * SFTP 会话：一条 SSH 连接 + 一个 SFTP 子系统通道，服务于一对本地/远端文件面板。
 *
 * 与终端会话的关系（关键设计决策）：
 * - **可以借用终端会话的 SSH 连接**（在同一个 Client 上另开一条 SFTP 通道），
 *   这样「打开终端 + 打开文件面板」对目标设备只产生一次登录。
 *   老式网络设备的 VTY 线路常常只有 4~5 条，重复登录会直接把线路占满。
 * - 借来的连接**不由本会话关闭**（ownsConnection = false），终端关闭时 SFTP 随之失效，
 *   此时会话标记为已结束，前端提示重新打开。
 * - 也支持独立建立连接（带跳板链），这样不打开终端也能直接浏览文件。
 *
 * SFTP 通道**懒创建**：很多用户打开文件面板后只是看一眼目录，
 * 过早建立通道会白白占用远端的子系统进程。
 */
import { EventEmitter } from 'node:events'
import type { Client, SFTPWrapper } from 'ssh2'
import type { SshTarget } from '@webterm/shared'
import { establishConnection, establishConnectionChain, type EstablishedConnection } from '../ssh/connection.js'
import type { KnownHostsStore } from '../ssh/known-hosts.js'
import type { TerminalLogger } from '../terminal/terminal-session.js'
import { classifySftpError, SftpError } from './errors.js'
import { LocalFs } from './local-fs.js'
import { LocalGuard, posixNormalize } from './paths.js'
import { RemoteFs } from './remote-fs.js'

export interface BorrowedConnection {
  client: Client
  terminalId: string
  host: string
  port: number
  username: string
}

export interface SftpSessionOptions {
  id: string
  attachToken: string
  title: string
  knownHosts: KnownHostsStore
  logger: TerminalLogger
  /** 本地面板的受限根目录 */
  localRoot: string
  /** 自行建立连接所需的参数（与 borrowed 二选一） */
  target?: SshTarget
  jumpChain?: SshTarget[]
  legacyCompat?: 'auto' | 'always' | 'never'
  /** 借用现有终端连接 */
  borrowed?: BorrowedConnection
}

export type SftpSessionState = 'connecting' | 'ready' | 'closed'

export interface SftpSessionEvents {
  closed: [reason: string]
}

export class SftpSession extends EventEmitter<SftpSessionEvents> {
  readonly id: string
  readonly attachToken: string
  readonly title: string
  readonly createdAt = new Date()
  readonly host: string
  readonly port: number
  readonly username: string
  /** 是否复用了终端连接 */
  readonly reusedConnection: boolean

  readonly local: LocalFs
  readonly remote: RemoteFs

  /** 远端初始目录（家目录），由 realpath('.') 得到 */
  remoteHome = '/'

  private readonly opts: SftpSessionOptions
  private readonly logger: TerminalLogger
  private state: SftpSessionState = 'connecting'

  private client: Client | undefined
  /** 本会话是否拥有连接的所有权（借来的连接不能由我们 end） */
  private ownsConnection = false
  private intermediate: EstablishedConnection[] = []
  private clientClosed = false

  private wrapper: SFTPWrapper | undefined
  private opening: Promise<SFTPWrapper> | undefined

  private closeReason = ''

  constructor(opts: SftpSessionOptions) {
    super()
    this.opts = opts
    this.logger = opts.logger
    this.id = opts.id
    this.attachToken = opts.attachToken
    this.title = opts.title

    const borrowed = opts.borrowed
    const target = borrowed ?? opts.target
    if (!target) throw new SftpError('INTERNAL', '创建 SFTP 会话时缺少连接参数')
    this.host = target.host
    this.port = target.port
    this.username = target.username
    this.reusedConnection = borrowed !== undefined

    const guard = new LocalGuard(opts.localRoot)
    this.local = new LocalFs(guard)
    this.remote = new RemoteFs(() => this.sftp())
  }

  get closed(): boolean {
    return this.state === 'closed'
  }

  get closeMessage(): string {
    return this.closeReason
  }

  get localRoot(): string {
    return this.local.root
  }

  get localHome(): string {
    return this.local.home
  }

  /** 建立（或接管）SSH 连接并首次打开 SFTP 通道 */
  async start(): Promise<void> {
    const borrowed = this.opts.borrowed
    if (borrowed) {
      this.client = borrowed.client
      this.ownsConnection = false
      this.logger.info(
        { sftpId: this.id, terminalId: borrowed.terminalId, host: this.host },
        'SFTP 会话复用现有终端连接',
      )
    } else {
      const chain = await this.establish()
      this.client = chain.connection.client
      this.intermediate = chain.intermediate
      this.ownsConnection = true
    }

    const client = this.client
    if (client) this.watchClient(client)

    // 首次打开通道：让「远端不支持 SFTP」这类错误在建会话时就暴露出来，
    // 前端可以在打开面板的瞬间给出明确提示，而不是等用户点进目录才报错。
    try {
      await this.sftp()
      this.remoteHome = await this.remote.realpath('.')
    } catch (err) {
      this.shutdown('建立 SFTP 会话失败')
      throw err
    }

    if (this.state === 'closed') {
      throw new SftpError('SESSION_NOT_FOUND', '会话在建立过程中被关闭')
    }
    this.state = 'ready'
  }

  private async establish(): Promise<{ connection: EstablishedConnection; intermediate: EstablishedConnection[] }> {
    const { target, jumpChain = [], legacyCompat, knownHosts, logger } = this.opts
    if (!target) throw new SftpError('INTERNAL', '缺少连接参数')

    if (jumpChain.length > 0) {
      return establishConnectionChain(
        [...jumpChain.map((t) => ({ target: t })), { target, legacyCompat: legacyCompat ?? 'auto' }],
        { knownHosts, logger },
      )
    }
    const connection = await establishConnection({
      target,
      legacyCompat: legacyCompat ?? 'auto',
      knownHosts,
      keyboardInteractivePassword: target.password,
      logger,
    })
    return { connection, intermediate: [] }
  }

  private watchClient(client: Client): void {
    client.on('error', (err: unknown) => {
      if (this.state === 'closed') return
      this.logger.warn({ sftpId: this.id, err: String(err) }, 'SFTP 连接发生错误')
    })
    client.on('close', () => {
      this.clientClosed = true
      this.wrapper = undefined
      if (this.state === 'closed') return
      const reason = this.reusedConnection
        ? '终端会话已关闭，文件面板随之结束'
        : 'SSH 连接已断开'
      this.shutdown(reason)
    })
  }

  /** 取得 SFTP 通道；已建立则复用，通道失效后会自动重建 */
  async sftp(): Promise<SFTPWrapper> {
    if (this.state === 'closed' || this.clientClosed) {
      throw new SftpError('SESSION_NOT_FOUND', 'SFTP 会话已结束')
    }
    if (this.wrapper) return this.wrapper
    if (this.opening) return this.opening

    const opening = this.openWrapper()
    this.opening = opening
    try {
      const wrapper = await opening
      this.wrapper = wrapper
      return wrapper
    } finally {
      this.opening = undefined
    }
  }

  private openWrapper(): Promise<SFTPWrapper> {
    const client = this.client
    if (!client) return Promise.reject(new SftpError('SESSION_NOT_FOUND', 'SSH 连接尚未建立'))

    return new Promise<SFTPWrapper>((resolve, reject) => {
      try {
        client.sftp((err, sftp) => {
          if (err) {
            reject(this.normalizeChannelError(err))
            return
          }
          // 通道级错误或关闭：清掉缓存，下次调用会重建通道
          const invalidate = (): void => {
            if (this.wrapper === sftp) this.wrapper = undefined
          }
          sftp.on('close', invalidate)
          sftp.on('end', invalidate)
          sftp.on('error', (e: Error) => {
            invalidate()
            this.logger.warn({ sftpId: this.id, err: e.message }, 'SFTP 通道发生错误')
          })
          resolve(sftp)
        })
      } catch (err) {
        reject(this.normalizeChannelError(err))
      }
    })
  }

  /**
   * 把「开不了 SFTP 通道」的原始错误转成可操作的提示。
   * 这是最常见的失败：设备只开了 shell，没有 sftp 子系统。
   */
  private normalizeChannelError(err: unknown): SftpError {
    const message = err instanceof Error ? err.message : String(err)
    const lower = message.toLowerCase()
    if (lower.includes('subsystem') || lower.includes('sftp') || lower.includes('channel open failure')) {
      return new SftpError('UNSUPPORTED', `远端未提供 SFTP 子系统：${message}`, {
        hint: '该设备可能只开放了交互式命令行，未启用 sftp 子系统。可在设备上执行 `show run | include sftp` 或直接改用终端上传下载（如 zmodem/tftp）。',
      })
    }
    const classified = classifySftpError(err, '开启 SFTP 通道失败')
    if (classified.code === 'IO') {
      return new SftpError('UNSUPPORTED', `开启 SFTP 通道失败：${message}`, {
        hint: '远端接受了连接与认证，但拒绝开启 SFTP 通道。请确认账号权限与设备是否启用了 sftp 服务。',
      })
    }
    return classified
  }

  /** 归一化远端路径为绝对路径（供路由层使用） */
  normalizeRemote(input: string): string {
    return posixNormalize(input)
  }

  /** 关闭会话（幂等）。借来的连接不会在这里被断开 */
  shutdown(reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.closeReason = reason

    try {
      this.wrapper?.end()
    } catch {
      /* 忽略 */
    }
    this.wrapper = undefined

    if (this.ownsConnection) {
      try {
        this.client?.end()
      } catch {
        /* 忽略 */
      }
    }
    // 跳板链上的中间连接一定是我们自己建立的，需要释放
    for (const conn of this.intermediate) {
      try {
        conn.client.end()
      } catch {
        /* 忽略 */
      }
    }
    this.intermediate = []

    this.logger.info({ sftpId: this.id, reason }, 'SFTP 会话已关闭')
    this.emit('closed', reason)
  }
}
