/**
 * 终端会话注册表。
 *
 * 负责终端的创建、查找、附加令牌校验与回收。
 * 阶段 1 为纯内存实现；阶段 2 引入 SQLite 后，本层仍保持在内存中管理「活的」连接，
 * 数据库只负责持久化会话配置与凭据，两者职责不重叠。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { SessionConfig, SshTarget, TerminalListItem, TunnelSpec } from '@webterm/shared'
import {
  TERMINAL_ATTACH_GRACE_MS,
  TERMINAL_IDLE_TIMEOUT_MS,
  protocolOf,
  targetUsername,
} from '@webterm/shared'
import { TerminalSession, type TerminalLogger } from './terminal-session.js'
import type { KnownHostsStore } from '../ssh/known-hosts.js'

export interface CreateTerminalOptions {
  config: SessionConfig
  /** 跳板链（已解密为明文 target，按连接顺序）；最后一跳之后才是 config.target */
  jumpChain?: SshTarget[]
  /** 随会话自动启动的隧道定义（仅 SSH） */
  tunnels?: TunnelSpec[]
  title: string
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly knownHosts: KnownHostsStore
  private readonly logger: TerminalLogger
  /** 用于回收「创建后从未附加」的终端 */
  private readonly gcTimer: NodeJS.Timeout
  private disposed = false

  constructor(knownHosts: KnownHostsStore, logger: TerminalLogger) {
    this.knownHosts = knownHosts
    this.logger = logger
    // 每分钟检查一次过期终端；unref 避免阻止进程退出
    this.gcTimer = setInterval(() => this.collectGarbage(), 60_000)
    this.gcTimer.unref?.()
  }

  get count(): number {
    return this.sessions.size
  }

  /** 全部存活会话（隧道列表等需要遍历会话内部状态的场景用） */
  all(): TerminalSession[] {
    return [...this.sessions.values()]
  }

  list(): TerminalListItem[] {
    return [...this.sessions.values()].map((s) => ({
      terminalId: s.id,
      title: s.title,
      protocol: protocolOf(s.config),
      host: s.config.target.host,
      port: s.config.target.port,
      username: targetUsername(s.config),
      attached: s.attached,
      createdAt: s.createdAt.toISOString(),
      cols: s.dimensions.cols,
      rows: s.dimensions.rows,
      encoding: s.config.terminal.encoding,
    }))
  }

  /**
   * 创建并启动一个终端会话。
   * SSH 连接在此阶段建立，失败会向上抛出（由 REST 层转成 HTTP 错误）。
   */
  async create(opts: CreateTerminalOptions): Promise<TerminalSession> {
    if (this.disposed) throw new Error('TerminalManager 已释放')

    const session = new TerminalSession({
      id: randomUUID(),
      attachToken: randomBytes(24).toString('base64url'),
      title: opts.title,
      config: opts.config,
      jumpChain: opts.jumpChain,
      tunnels: opts.tunnels,
      knownHosts: this.knownHosts,
      logger: this.logger,
    })

    session.on('closed', (reason) => {
      this.sessions.delete(session.id)
      this.logger.debug({ terminalId: session.id, reason, remaining: this.sessions.size }, '终端已从注册表移除')
    })

    this.sessions.set(session.id, session)

    try {
      await session.start()
    } catch (err) {
      // 启动失败必须从注册表移除，否则会留下永远不会被使用的条目
      session.shutdown('启动失败')
      throw err
    }

    return session
  }

  get(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId)
  }

  /**
   * 校验附加令牌。
   * 使用固定时间比较，避免通过响应时间差推测令牌内容。
   */
  verifyToken(terminalId: string, token: string): TerminalSession | undefined {
    const session = this.sessions.get(terminalId)
    if (!session) return undefined
    const expected = Buffer.from(session.attachToken, 'utf8')
    const actual = Buffer.from(token, 'utf8')
    if (expected.length !== actual.length) return undefined
    if (!timingSafeEqual(expected, actual)) return undefined
    return session
  }

  /**
   * 关闭并移除一个终端；返回是否确实存在。
   *
   * 先撤隧道再拆连接：本机监听的端口必须显式关闭才会释放，
   * 而远程转发的撤销请求又需要一条还活着的 SSH 连接 —— 顺序反了会两头落空。
   */
  async close(terminalId: string): Promise<boolean> {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    await session.closeTunnels('用户主动关闭')
    session.shutdown('用户主动关闭')
    this.sessions.delete(terminalId)
    return true
  }

  /** 关闭全部终端（进程退出时调用） */
  closeAll(reason = '服务端关闭'): void {
    for (const session of [...this.sessions.values()]) {
      session.shutdown(reason)
    }
    this.sessions.clear()
  }

  /**
   * 回收两类终端：
   * 1. 创建后长时间未被附加（用户创建了但前端没连上）
   * 2. 客户端断开后长时间未重连（用户关掉浏览器标签）
   */
  private collectGarbage(): void {
    const now = Date.now()
    for (const session of [...this.sessions.values()]) {
      if (session.closed) {
        this.sessions.delete(session.id)
        continue
      }

      const age = now - session.createdAt.getTime()
      if (!session.attached) {
        // 刚创建不久、还没连上的属于正常情况
        const idleSince = session.lastDetachedAt ?? session.createdAt.getTime()
        const idleFor = now - idleSince
        if (session.lastDetachedAt === undefined) {
          if (age > TERMINAL_ATTACH_GRACE_MS) {
            this.logger.info({ terminalId: session.id }, '终端创建后长期未附加，已回收')
            session.shutdown('创建后未使用')
          }
        } else if (idleFor > TERMINAL_IDLE_TIMEOUT_MS) {
          this.logger.info({ terminalId: session.id }, '终端断开后长期未重连，已回收')
          session.shutdown('长时间无客户端')
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.gcTimer)
    this.closeAll()
  }
}
