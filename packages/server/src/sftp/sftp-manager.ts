/**
 * SFTP 会话注册表。
 *
 * 与 TerminalManager 同构：内存中管理活跃会话，负责创建、令牌校验、回收。
 * 每个会话自带一个传输队列 —— 队列与连接的耦合点是「两个文件系统端点」，
 * 会话结束队列就没有存在的意义了，放在会话粒度最自然。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Client } from 'ssh2'
import type { SshTarget } from '@webterm/shared'
import type { KnownHostsStore } from '../ssh/known-hosts.js'
import type { TerminalLogger } from '../terminal/terminal-session.js'
import { LocalFs } from './local-fs.js'
import { LocalGuard } from './paths.js'
import { RemoteFs } from './remote-fs.js'
import { SftpSession } from './sftp-session.js'
import { TransferQueue } from './transfer-queue.js'

export interface CreateSftpSessionOptions {
  title: string
  /** 借用终端连接（优先级高于 target） */
  borrowed?: {
    terminalId: string
    client: Client
    host: string
    port: number
    username: string
  }
  target?: SshTarget
  jumpChain?: SshTarget[]
  legacyCompat?: 'auto' | 'always' | 'never'
}

export interface SftpSessionEntry {
  session: SftpSession
  queue: TransferQueue
}

export interface SftpManagerOptions {
  knownHosts: KnownHostsStore
  logger: TerminalLogger
  /** 本地面板的受限根目录 */
  localRoot: string
  /** 传输并发上限 */
  concurrency: number
}

export class SftpManager {
  private readonly entries = new Map<string, SftpSessionEntry>()
  private disposed = false

  constructor(private readonly opts: SftpManagerOptions) {}

  get count(): number {
    return this.entries.size
  }

  list(): Array<{ sftpId: string; title: string; host: string; username: string }> {
    return [...this.entries.values()].map(({ session }) => ({
      sftpId: session.id,
      title: session.title,
      host: session.host,
      username: session.username,
    }))
  }

  async create(input: CreateSftpSessionOptions): Promise<SftpSessionEntry> {
    if (this.disposed) throw new Error('SftpManager 已释放')

    const session = new SftpSession({
      id: randomUUID(),
      attachToken: randomBytes(24).toString('base64url'),
      title: input.title,
      knownHosts: this.opts.knownHosts,
      logger: this.opts.logger,
      localRoot: this.opts.localRoot,
      ...(input.borrowed ? { borrowed: input.borrowed } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.jumpChain ? { jumpChain: input.jumpChain } : {}),
      ...(input.legacyCompat ? { legacyCompat: input.legacyCompat } : {}),
    })

    // 队列与会话共用同一对文件系统端点与本地根目录守卫，
    // 保证传输路径与面板浏览路径受同一套越界校验约束
    const guard = new LocalGuard(this.opts.localRoot)
    const queue = new TransferQueue({
      logger: this.opts.logger,
      concurrency: this.opts.concurrency,
      local: new LocalFs(guard),
      remote: new RemoteFs(() => session.sftp()),
    })

    const entry: SftpSessionEntry = { session, queue }

    session.on('closed', (reason) => {
      this.entries.delete(session.id)
      queue.dispose()
      this.opts.logger.debug(
        { sftpId: session.id, reason, remaining: this.entries.size },
        'SFTP 会话已从注册表移除',
      )
    })

    this.entries.set(session.id, entry)

    try {
      await session.start()
    } catch (err) {
      session.shutdown('建立失败')
      queue.dispose()
      this.entries.delete(session.id)
      throw err
    }

    return entry
  }

  entry(sftpId: string): SftpSessionEntry | undefined {
    return this.entries.get(sftpId)
  }

  get(sftpId: string): SftpSession | undefined {
    return this.entries.get(sftpId)?.session
  }

  /** 固定时间比较附加令牌，避免通过响应时间差推测令牌 */
  verifyToken(sftpId: string, token: string): SftpSessionEntry | undefined {
    const entry = this.entries.get(sftpId)
    if (!entry) return undefined
    const expected = Buffer.from(entry.session.attachToken, 'utf8')
    const actual = Buffer.from(token, 'utf8')
    if (expected.length !== actual.length) return undefined
    if (!timingSafeEqual(expected, actual)) return undefined
    return entry
  }

  close(sftpId: string): boolean {
    const entry = this.entries.get(sftpId)
    if (!entry) return false
    entry.queue.dispose()
    entry.session.shutdown('用户主动关闭')
    this.entries.delete(sftpId)
    return true
  }

  closeAll(reason = '服务端关闭'): void {
    for (const entry of [...this.entries.values()]) {
      entry.queue.dispose()
      entry.session.shutdown(reason)
    }
    this.entries.clear()
  }

  dispose(): void {
    this.disposed = true
    this.closeAll('服务端关闭')
  }
}
