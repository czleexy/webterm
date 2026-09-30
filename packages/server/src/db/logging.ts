/**
 * 日志与审计 DAO：全局设置（保留天数 / 脱敏规则 / 目录映射）与 audit_log 表。
 *
 * 设置存 settings 表（单行 JSON）；audit_log 是纯追加的流水表，
 * 查询走 (event, at) 索引，保留期到点由 LogStore 的定时清理一并删除旧行。
 */
import type { Database } from 'better-sqlite3'
import type {
  AuditDetailPayload,
  AuditEntry,
  AuditEventType,
  LoggingSettings,
  RedactionRule,
} from '@webterm/shared'
import {
  describeAudit,
  LOG_DEFAULT_RETENTION_DAYS,
  LOG_MAX_REDACTION_RULES,
  LOG_MAX_RETENTION_DAYS,
  LOG_MIN_RETENTION_DAYS,
} from '@webterm/shared'
import { nowIso } from './index.js'

const SETTINGS_KEY = 'logging'

interface StoredLogging {
  retentionDays: number
  redactionRules: RedactionRule[]
  /** sessionId → 日志目录名（首次启用日志时分配并固化，会话改名不影响旧文件） */
  dirs: Record<string, string>
}

/** 默认脱敏规则：最常见的「口令进日志」形态。用户可禁用或删除 */
const DEFAULT_REDACTION_RULE: RedactionRule = {
  id: 'rule_default_password',
  name: '口令行脱敏',
  pattern: 'password\\s*=\\s*\\S+',
  replacement: 'password=***',
  enabled: true,
}

const DEFAULTS: StoredLogging = {
  retentionDays: LOG_DEFAULT_RETENTION_DAYS,
  redactionRules: [DEFAULT_REDACTION_RULE],
  dirs: {},
}

export interface AuditInsert {
  event: AuditEventType
  title: string
  clientIp: string
  detail: AuditDetailPayload
}

interface AuditRow {
  id: number
  at: string
  event: string
  title: string
  client_ip: string
  detail: string
}

export class LoggingStore {
  constructor(private readonly db: Database) {}

  /* ---------------------------------------------------------------- */
  /* 设置                                                              */
  /* ---------------------------------------------------------------- */

  private read(): StoredLogging {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      | { value: string }
      | undefined
    if (!row) return { ...DEFAULTS, redactionRules: [...DEFAULTS.redactionRules], dirs: {} }
    try {
      const parsed: unknown = JSON.parse(row.value)
      if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
      const raw = parsed as Partial<StoredLogging>
      return {
        retentionDays: clampRetention(raw.retentionDays),
        redactionRules: Array.isArray(raw.redactionRules)
          ? raw.redactionRules.slice(0, LOG_MAX_REDACTION_RULES)
          : [...DEFAULTS.redactionRules],
        dirs: typeof raw.dirs === 'object' && raw.dirs !== null ? { ...raw.dirs } : {},
      }
    } catch {
      return { ...DEFAULTS, redactionRules: [...DEFAULTS.redactionRules], dirs: {} }
    }
  }

  private write(stored: StoredLogging): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(SETTINGS_KEY, JSON.stringify(stored))
  }

  getSettings(): LoggingSettings {
    const stored = this.read()
    return {
      retentionDays: stored.retentionDays,
      redactionRules: stored.redactionRules,
    }
  }

  updateSettings(patch: Partial<Pick<LoggingSettings, 'retentionDays' | 'redactionRules'>>): LoggingSettings {
    const stored = this.read()
    if (patch.retentionDays !== undefined) {
      stored.retentionDays = clampRetention(patch.retentionDays)
    }
    if (patch.redactionRules !== undefined) {
      stored.redactionRules = patch.redactionRules.slice(0, LOG_MAX_REDACTION_RULES)
    }
    this.write(stored)
    return this.getSettings()
  }

  /* ---------------------------------------------------------------- */
  /* 日志目录映射                                                       */
  /* ---------------------------------------------------------------- */

  /** 会话首次启用日志时固化目录名；已存在映射则保持不变（目录名不随改名漂移） */
  dirFor(sessionId: string, preferred: string): string {
    const stored = this.read()
    const existing = stored.dirs[sessionId]
    if (existing) return existing
    // 理论上 writer 已带短哈希避免冲突，这里只做登记
    stored.dirs[sessionId] = preferred
    this.write(stored)
    return preferred
  }

  forgetSessionDirs(sessionIds: string[]): void {
    const stored = this.read()
    let changed = false
    for (const id of sessionIds) {
      if (stored.dirs[id] !== undefined) {
        delete stored.dirs[id]
        changed = true
      }
    }
    if (changed) this.write(stored)
  }

  /** 目录名 → 会话信息（列表回显用），sessionName 由调用方解析 */
  dirOwners(): Array<{ sessionId: string; dir: string }> {
    const stored = this.read()
    return Object.entries(stored.dirs).map(([sessionId, dir]) => ({ sessionId, dir }))
  }

  /* ---------------------------------------------------------------- */
  /* 审计                                                              */
  /* ---------------------------------------------------------------- */

  insertAudit(entry: AuditInsert): void {
    const detail = describeAudit(entry.clientIp, entry.event, entry.detail)
    this.db
      .prepare(
        'INSERT INTO audit_log (at, event, title, client_ip, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(nowIso(), entry.event, entry.title, entry.clientIp, detail)
  }

  queryAudit(filter: {
    event?: AuditEventType
    from?: string
    to?: string
    page: number
    pageSize: number
  }): { entries: AuditEntry[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, filter.page)
    const pageSize = Math.min(200, Math.max(1, filter.pageSize))
    const where: string[] = []
    const params: string[] = []
    if (filter.event) {
      where.push('event = ?')
      params.push(filter.event)
    }
    if (filter.from) {
      where.push('at >= ?')
      params.push(filter.from)
    }
    if (filter.to) {
      where.push('at <= ?')
      params.push(filter.to)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as {
        n: number
      }
    ).n
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as AuditRow[]
    return {
      entries: rows.map(toEntry),
      total,
      page,
      pageSize,
    }
  }

  /** 删除早于保留期的审计行；返回删除的行数 */
  pruneAudit(retentionDays: number): number {
    if (retentionDays <= 0) return 0
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    return this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff).changes
  }
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    event: row.event as AuditEventType,
    title: row.title,
    clientIp: row.client_ip,
    detail: row.detail,
  }
}

function clampRetention(value: unknown): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  if (!Number.isFinite(n)) return LOG_DEFAULT_RETENTION_DAYS
  return Math.min(LOG_MAX_RETENTION_DAYS, Math.max(LOG_MIN_RETENTION_DAYS, n))
}
