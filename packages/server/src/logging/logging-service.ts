/**
 * 日志与审计服务：LogStore / LoggingStore / 会话写入器的装配层。
 *
 * 与 AutomationService 同构 —— 终端会话的生命周期在这里对接：
 * - 会话建立时按会话库配置创建写入器并订阅输出流（流式格式）
 *   或等待前端上传快照（html 格式）
 * - 会话关闭时收尾写入器，登记审计「断开」事件由终端路由负责（它拿得到 IP）
 */
import type {
  AuditDetailPayload,
  AuditEventType,
  LogFileInfo,
  LogPreviewResponse,
  LoggingCapabilities,
  LoggingSettings,
  QueryAuditResponse,
  SessionLogSettings,
} from '@webterm/shared'
import {
  LOG_PREVIEW_MAX_LINES,
  LOG_ROTATE_BYTES,
  LOG_FORMATS,
  LOG_DEFAULT_RETENTION_DAYS,
  LOG_MAX_RETENTION_DAYS,
} from '@webterm/shared'
import type { TerminalSession } from '../terminal/terminal-session.js'
import type { TerminalLogger } from '../terminal/terminal-session.js'
import type { LibraryStore } from '../db/library.js'
import type { LoggingStore } from '../db/logging.js'
import { LogStore } from './log-store.js'
import { SessionLogWriter } from './log-writer.js'

export interface LoggingServiceOptions {
  loggingStore: LoggingStore
  library: LibraryStore
  /** 日志文件根目录（config.logDir） */
  logsRoot: string
  logger: TerminalLogger
}

/** 提取自 ClientControlMessage 的 log-html 消息形状 */
interface LogHtmlChunk {
  seq: number
  final: boolean
  data: string
}

export class LoggingService {
  private readonly logStore: LogStore
  private readonly writers = new Map<string, SessionLogWriter>()
  private readonly unsubscribers = new Map<string, Array<() => void>>()
  private sweepTimer: NodeJS.Timeout | undefined
  private sweeping = false

  constructor(private readonly opts: LoggingServiceOptions) {
    // 目录名 → 会话名的翻译表：目录映射（持久化）+ 会话库当前名称。
    // 会话改名后列表立即跟随显示新名字，而文件仍留在原目录 —— 历史日志不挪窝
    this.logStore = new LogStore({
      logsRoot: opts.logsRoot,
      logger: opts.logger,
      dirToSession: () => {
        const map: Record<string, { sessionId: string; sessionName: string }> = {}
        for (const { sessionId, dir } of opts.loggingStore.dirOwners()) {
          const node = opts.library.get(sessionId)
          map[dir] = { sessionId, sessionName: node?.name ?? dir }
        }
        return map
      },
    })
  }

  /* ---------------------------------------------------------------- */
  /* 会话接入                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 为一个终端会话挂上日志写入器（如果会话配置启用了日志）。
   * 返回实际生效的配置（未启用时 enabled=false），供 REST 响应回传前端。
   */
  attachSession(
    terminal: TerminalSession,
    context: { sessionId?: string; sessionName: string; settings?: SessionLogSettings },
  ): SessionLogSettings {
    const settings = context.settings
    if (!settings || !settings.enabled) {
      return { enabled: false, format: 'plain' }
    }

    const writer = new SessionLogWriter({
      logsRoot: this.logStore.root,
      sessionName: context.sessionName,
      sessionId: context.sessionId,
      settings,
      redactionRules: this.opts.loggingStore.getSettings().redactionRules,
      logger: this.opts.logger,
    })

    // 目录映射登记：列表页要把目录名翻译回会话名
    if (context.sessionId) {
      this.opts.loggingStore.dirFor(context.sessionId, writer.dir)
    }

    const unsubs: Array<() => void> = []

    if (settings.format === 'html') {
      // 快照模式：服务端不碰输出流，等前端上传整份序列化结果
      const onHtml = (chunk: LogHtmlChunk): void => {
        writer.pushHtmlChunk(chunk.seq, chunk.final, chunk.data)
      }
      terminal.on('log-html', onHtml)
      unsubs.push(() => terminal.off('log-html', onHtml))
    } else {
      unsubs.push(terminal.subscribeOutput((text) => writer.write(text)))
    }

    const cleanup = (): void => {
      void writer.close()
      this.writers.delete(terminal.id)
      const list = this.unsubscribers.get(terminal.id)
      this.unsubscribers.delete(terminal.id)
      for (const fn of list ?? []) fn()
    }
    terminal.once('closed', cleanup)
    unsubs.push(() => terminal.off('closed', cleanup))

    this.writers.set(terminal.id, writer)
    this.unsubscribers.set(terminal.id, unsubs)
    return settings
  }

  /** 会话被 REST 主动关闭时也需要摘干净（closed 事件会兜底，这里只是提前） */
  detachSession(terminalId: string): void {
    const list = this.unsubscribers.get(terminalId)
    for (const fn of list ?? []) fn()
    const writer = this.writers.get(terminalId)
    if (writer) {
      void writer.close()
      this.writers.delete(terminalId)
      this.unsubscribers.delete(terminalId)
    }
  }

  /* ---------------------------------------------------------------- */
  /* 设置与能力                                                        */
  /* ---------------------------------------------------------------- */

  getSettings(): LoggingSettings {
    return this.opts.loggingStore.getSettings()
  }

  updateSettings(
    patch: Partial<Pick<LoggingSettings, 'retentionDays' | 'redactionRules'>>,
    context: { ip: string },
  ): LoggingSettings {
    const next = this.opts.loggingStore.updateSettings(patch)
    this.recordAudit('settings_change', '日志与审计设置', context.ip, {
      retentionDays: next.retentionDays,
      rules: next.redactionRules.length,
    })
    // 收紧保留期后立即清一轮：等下一个整点的话，用户改完设置看到的还是旧状态
    void this.logStore.sweepExpired(next.retentionDays).catch(() => {})
    return next
  }

  capabilities(): LoggingCapabilities {
    return {
      formats: [...LOG_FORMATS],
      rotateBytes: LOG_ROTATE_BYTES,
      defaultRetentionDays: LOG_DEFAULT_RETENTION_DAYS,
      maxRetentionDays: LOG_MAX_RETENTION_DAYS,
      htmlChunkBytes: 256 * 1024,
      previewPageLines: LOG_PREVIEW_MAX_LINES,
    }
  }

  /* ---------------------------------------------------------------- */
  /* 文件与预览                                                        */
  /* ---------------------------------------------------------------- */

  listFiles(filter: { sessionId?: string; date?: string }): LogFileInfo[] {
    return this.logStore.list(filter)
  }

  preview(id: string, start: number, count: number): Promise<LogPreviewResponse> {
    return this.logStore.preview(id, start, count)
  }

  async removeFile(id: string): Promise<void> {
    await this.logStore.remove(id)
  }

  async removeSession(sessionDir: string): Promise<number> {
    return this.logStore.removeSessionDir(sessionDir)
  }

  /** 解析下载用的绝对路径（含路径安全校验） */
  resolveFile(id: string): string {
    return this.logStore.resolveFile(id)
  }

  /* ---------------------------------------------------------------- */
  /* 审计                                                              */
  /* ---------------------------------------------------------------- */

  recordAudit(event: AuditEventType, title: string, ip: string, detail: AuditDetailPayload): void {
    try {
      this.opts.loggingStore.insertAudit({ event, title, clientIp: ip || '—', detail })
    } catch (err) {
      // 审计失败绝不能拖垮业务动作本身
      this.opts.logger.warn({ err: String(err), event }, '审计事件写入失败')
    }
  }

  queryAudit(filter: {
    event?: AuditEventType
    from?: string
    to?: string
    page: number
    pageSize: number
  }): QueryAuditResponse {
    return this.opts.loggingStore.queryAudit(filter)
  }

  /* ---------------------------------------------------------------- */
  /* 保留清理                                                          */
  /* ---------------------------------------------------------------- */

  startSweeping(): void {
    if (this.sweepTimer) return
    const run = async (): Promise<void> => {
      if (this.sweeping) return
      this.sweeping = true
      try {
        const { retentionDays } = this.getSettings()
        const files = await this.logStore.sweepExpired(retentionDays)
        const rows = this.opts.loggingStore.pruneAudit(retentionDays)
        if (files > 0 || rows > 0) {
          this.opts.logger.info({ files, rows }, '日志与审计保留清理完成')
        }
      } catch (err) {
        this.opts.logger.warn({ err: String(err) }, '日志保留清理失败')
      } finally {
        this.sweeping = false
      }
    }
    void run()
    this.sweepTimer = setInterval(() => void run(), 60 * 60 * 1000)
    this.sweepTimer.unref?.()
  }

  stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  /** 进程退出前把未落盘的写入全部冲完 */
  async dispose(): Promise<void> {
    this.stopSweeping()
    for (const [, list] of this.unsubscribers) {
      for (const fn of list) fn()
    }
    this.unsubscribers.clear()
    await Promise.allSettled([...this.writers.values()].map((w) => w.close()))
    this.writers.clear()
  }
}
