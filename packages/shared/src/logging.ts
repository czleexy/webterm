/**
 * 阶段 7：日志与审计的共享契约。
 *
 * 三块能力：
 * - **会话日志**：把终端输出按天落成文件。三种格式 ——
 *   `plain`（纯文本）/ `timestamped`（行首带时间戳）在服务端流式写入；
 *   `html`（保留色彩）由前端用 xterm SerializeAddon 序列化**整份缓冲**，
 *   定期与关闭时上传，服务端原子替换当天的快照文件。
 * - **轮转与保留**：单文件超 LOG_ROTATE_BYTES 切分；超过保留天数由定时任务清理。
 * - **审计**：连接 / 断开 / 上传 / 下载 / 脚本执行等事件写 SQLite，记录来源 IP。
 *
 * 设计取舍：
 * - 脱敏只作用于 plain / timestamped（写入前做正则替换）；html 快照是
 *   「字节级忠实」的终端回放，对其做文本替换会破坏标记结构，因此不做，
 *   文档中已明确说明。
 * - html 快照文件用 `.html` 扩展名而不是计划里的 `.log`：浏览器只对
 *   `.html` 做「打开即渲染」，`.log` 会被当成纯文本下载 —— 验收条件
 *   「HTML 日志在浏览器打开颜色正确」依赖这一点。
 */

/* ================================================================== */
/* 日志格式                                                            */
/* ================================================================== */

export const LOG_FORMATS = ['plain', 'timestamped', 'html'] as const
export type LogFormat = (typeof LOG_FORMATS)[number]

export const LOG_FORMAT_LABEL: Record<LogFormat, string> = {
  plain: '纯文本',
  timestamped: '带时间戳',
  html: 'HTML（保留色彩）',
}

export const LOG_FORMAT_DESCRIPTION: Record<LogFormat, string> = {
  plain: '按天追加终端输出，控制序列已剥离，适合 grep 检索',
  timestamped: '每行行首带 [YYYY-MM-DD HH:mm:ss] 时间戳',
  html: '浏览器定期整份上传快照，双击文件即可回放彩色终端',
}

/** 会话级日志配置（存进 SessionRecord.logging） */
export interface SessionLogSettings {
  enabled: boolean
  format: LogFormat
}

export const LOG_DEFAULT_SESSION_SETTINGS: SessionLogSettings = {
  enabled: false,
  format: 'plain',
}

/* ================================================================== */
/* 全局设置：保留天数与脱敏规则                                          */
/* ================================================================== */

export interface RedactionRule {
  id: string
  name: string
  /** 正则源码；写入前逐条替换 */
  pattern: string
  /** 替换文本，如 `password=***` */
  replacement: string
  enabled: boolean
}

export interface LoggingSettings {
  /** 日志文件与审计记录的保留天数（1 ~ 3650） */
  retentionDays: number
  redactionRules: RedactionRule[]
}

export const LOG_DEFAULT_RETENTION_DAYS = 30
export const LOG_MIN_RETENTION_DAYS = 1
export const LOG_MAX_RETENTION_DAYS = 3650
export const LOG_MAX_REDACTION_RULES = 32

/** 单文件大小上限，超过后切分到 `{date}.part{n}.log` */
export const LOG_ROTATE_BYTES = 20 * 1024 * 1024
/** 预览单页返回的行数上限 */
export const LOG_PREVIEW_MAX_LINES = 500
/** 预览单行的显示长度上限（超长行截断展示，不截断文件本身） */
export const LOG_PREVIEW_MAX_LINE_CHARS = 10_000
/** 预览索引缓存的文件数量上限 */
export const LOG_PREVIEW_INDEX_CACHE = 8

/**
 * HTML 快照上传的分片大小。
 * WS maxPayload 是 1 MiB，单片必须留足余量；
 * 服务端把分片重新装配成完整快照后再原子写盘。
 */
export const LOG_HTML_CHUNK_BYTES = 256 * 1024
/** 单次 HTML 装配的总字节上限（超出即丢弃本次快照） */
export const LOG_HTML_MAX_BYTES = 32 * 1024 * 1024

/* ================================================================== */
/* 日志文件元数据与查询响应                                             */
/* ================================================================== */

/**
 * 日志文件条目。
 * `id` 是相对 logs 根目录的 POSIX 相对路径（如 `webserver/2026-09-30.log`），
 * 接口里 URL 编码后使用 —— 服务端会校验它不能越出日志根目录。
 */
export interface LogFileInfo {
  id: string
  /** 所属目录名（按会话分流） */
  sessionDir: string
  /** 目录能映射回会话库节点时给出 */
  sessionId?: string
  /** 展示名：优先会话库里的会话名，否则用目录名 */
  sessionName: string
  /** 从文件名解析的日期（YYYY-MM-DD）；解析不出时用修改时间 */
  date: string
  format: LogFormat
  sizeBytes: number
  modifiedAt: string
}

export interface ListLogFilesResponse {
  files: LogFileInfo[]
  total: number
  page: number
  pageSize: number
}

/** 预览：按行窗口读取（服务端为每个文件维护行偏移索引，随机访问） */
export interface LogPreviewResponse {
  id: string
  sizeBytes: number
  totalLines: number
  /** 本页第一行的行号（从 0 开始） */
  start: number
  lines: string[]
  /** 超长行是否被截断过（展示提示用） */
  truncatedLines: number
}

/* ================================================================== */
/* 审计                                                                */
/* ================================================================== */

export const AUDIT_EVENTS = [
  'connect',
  'disconnect',
  'upload',
  'download',
  'script_run',
  'macro_run',
  'batch_run',
  'log_delete',
  'settings_change',
] as const
export type AuditEventType = (typeof AUDIT_EVENTS)[number]

export const AUDIT_EVENT_LABEL: Record<AuditEventType, string> = {
  connect: '连接',
  disconnect: '断开',
  upload: '上传',
  download: '下载',
  script_run: '脚本',
  macro_run: '宏',
  batch_run: '批量',
  log_delete: '日志删除',
  settings_change: '设置变更',
}

/** 审计条目（查询响应） */
export interface AuditEntry {
  id: number
  at: string
  event: AuditEventType
  /** 主体：会话名 / 终端标题 / 「日志与审计设置」等 */
  title: string
  /** 来源 IP；无法取得时为 `—` */
  clientIp: string
  /** 人读详情，服务端入库前生成 */
  detail: string
}

export interface QueryAuditResponse {
  entries: AuditEntry[]
  total: number
  page: number
  pageSize: number
}

/** 各事件入库时携带的细节（detail 由 describeAudit 生成，不逐个定义类型） */
export interface AuditDetailPayload {
  protocol?: string
  host?: string
  port?: number
  username?: string
  reason?: string
  name?: string
  bytes?: number
  files?: number
  count?: number
  retentionDays?: number
  rules?: number
}

/* ================================================================== */
/* 能力声明                                                            */
/* ================================================================== */

export interface LoggingCapabilities {
  formats: LogFormat[]
  rotateBytes: number
  defaultRetentionDays: number
  maxRetentionDays: number
  htmlChunkBytes: number
  previewPageLines: number
}

/* ================================================================== */
/* 助手                                                                */
/* ================================================================== */

/** 人读的字节数：1.2 MB / 3.4 KB / 8 B */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'KB'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/** 验证脱敏正则是否可用（设置编辑器就地报错用） */
export function validateRedactionPattern(pattern: string): string | null {
  if (pattern === '') return '正则不能为空'
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * 生成审计详情文本（服务端入库时调用，前端直接展示）。
 * 句式覆盖验收条件：「用户从 127.0.0.1 上传了 a.zip」。
 */
export function describeAudit(
  ip: string,
  event: AuditEventType,
  detail: AuditDetailPayload,
): string {
  const from = ip && ip !== '—' ? `用户从 ${ip}` : '用户'
  switch (event) {
    case 'connect': {
      const who = detail.username ? `${detail.username}@${detail.host}` : (detail.host ?? '?')
      const proto = detail.protocol ? `（${detail.protocol.toUpperCase()}）` : ''
      return `${from} 建立了到 ${who} 的连接${proto}`
    }
    case 'disconnect':
      return `会话已关闭：${detail.reason ?? '未知原因'}`
    case 'upload':
      return `${from} 上传了 ${detail.name ?? '?'}${detail.bytes ? `（${formatBytes(detail.bytes)}）` : ''}`
    case 'download':
      return `${from} 下载了 ${detail.name ?? '?'}${detail.bytes ? `（${formatBytes(detail.bytes)}）` : ''}`
    case 'script_run':
      return `${from} 运行了脚本「${detail.name ?? '?'}」`
    case 'macro_run':
      return `${from} 执行了宏「${detail.name ?? '?'}」`
    case 'batch_run':
      return `${from} 对 ${detail.count ?? '?'} 台主机执行了批量命令`
    case 'log_delete':
      return `${from} 删除了 ${detail.files ?? detail.count ?? '?'} 个日志文件`
    case 'settings_change':
      return `${from} 更新了日志与审计设置（保留 ${detail.retentionDays ?? '?'} 天，脱敏规则 ${detail.rules ?? 0} 条）`
  }
}

/**
 * 清洗会话名为可安全用作目录名的形式。
 * 非法字符（Windows 保留字符 + 控制字符）替换为 `-`，去掉首尾的点与空格
 * （Windows 不允许目录名以它们结尾），并限制长度。
 */
export function sanitizeLogDirName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 64)
    .replace(/[.\s]+$/g, '')
  return cleaned === '' ? 'session' : cleaned
}

/** 剥离 ANSI/OSC 控制序列（plain / timestamped 日志用） */
export function stripAnsiSequences(text: string): string {
  // CSI 序列、OSC 序列、其余单字符转义
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]/g, '')
}
