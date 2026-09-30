/**
 * 日志与审计面板（阶段 7）。
 *
 * 三个标签页共用一个外壳（与自动化面板同构）：
 * - **会话日志**：按会话 / 日期筛选文件列表，预览按行窗口分页浏览，
 *   下载交给浏览器，删除即时生效。
 * - **审计**：连接 / 断开 / 传输 / 自动化事件的时间线，带来源 IP。
 * - **设置**：保留天数与脱敏规则。
 *
 * 预览不做「把整份文件塞进内存再虚拟滚动」：100 MB 的日志光字符串数组就
 * 上百 MB。服务端有行偏移索引，按行窗口取页（每页最多 500 行）是 O(1) 的，
 * 页与页之间瞬间跳转 —— 浏览器只渲染当前一页，天然不会卡。
 */
import { useCallback, useEffect, useState } from 'react'
import type { AuditEntry, LogFileInfo, LoggingSettings, RedactionRule } from '../api/client'
import {
  deleteLogFile,
  deleteLogSession,
  getLoggingSettings,
  listLogFiles,
  logFileDownloadUrl,
  previewLogFile,
  queryAudit,
  updateLoggingSettings,
} from '../api/client'
import { AUDIT_EVENT_LABEL, AUDIT_EVENTS, formatBytes, LOG_FORMAT_LABEL, validateRedactionPattern } from '@webterm/shared'
import { cn } from '../utils/cn'
import { Chip } from '../automation/ui'

type Tab = 'files' | 'audit' | 'settings'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'files', label: '会话日志' },
  { id: 'audit', label: '审计' },
  { id: 'settings', label: '设置' },
]

const buttonClass =
  'rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
const primaryButtonClass =
  'rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300'
const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

function fmtClock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 5)
}

export function LogsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('files')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  return (
    <div
      data-testid="logs-panel"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[5vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div>
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              日志与审计
            </h2>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              会话日志按天归档在服务端 logs 目录；审计记录连接、传输与自动化动作
            </p>
          </div>
          <button
            type="button"
            data-testid="logs-close"
            onClick={onClose}
            className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-3 dark:border-neutral-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`logs-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-xs transition-colors',
                tab === t.id
                  ? 'border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error ? (
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 rounded border border-red-300 px-1.5 py-0.5 dark:border-red-800"
            >
              知道了
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'files' ? <FilesTab onError={setError} /> : null}
          {tab === 'audit' ? <AuditTab onError={setError} /> : null}
          {tab === 'settings' ? <SettingsTab onError={setError} /> : null}
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* 会话日志                                                            */
/* ================================================================== */

function FilesTab({ onError }: { onError: (msg: string) => void }) {
  const [files, setFiles] = useState<LogFileInfo[] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [date, setDate] = useState('')
  const [preview, setPreview] = useState<LogFileInfo | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await listLogFiles({
        sessionId: sessionId || undefined,
        date: date || undefined,
      })
      setFiles(res.files)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }, [date, onError, sessionId])

  useEffect(() => {
    if (sessionId === '' && date === '') void reload()
  }, [reload, sessionId, date])

  const sessions = new Map<string, string>()
  for (const f of files ?? []) {
    if (f.sessionId && !sessions.has(f.sessionId)) sessions.set(f.sessionId, f.sessionName)
  }

  const removeFile = async (f: LogFileInfo): Promise<void> => {
    try {
      await deleteLogFile(f.id)
      await reload()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeSession = async (f: LogFileInfo): Promise<void> => {
    if (!window.confirm(`清空「${f.sessionName}」的全部日志？此操作不可恢复。`)) return
    try {
      await deleteLogSession(f.sessionDir)
      await reload()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56">
          <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            会话
          </label>
          <select
            data-testid="logs-session-filter"
            value={sessionId}
            onChange={(e) => {
              setSessionId(e.target.value)
              void (async () => {
                try {
                  const res = await listLogFiles({
                    sessionId: e.target.value || undefined,
                    date: date || undefined,
                  })
                  setFiles(res.files)
                } catch (err) {
                  onError(err instanceof Error ? err.message : String(err))
                }
              })()
            }}
            className={inputClass}
          >
            <option value="">全部会话</option>
            {[...sessions.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            日期
          </label>
          <input
            type="date"
            data-testid="logs-date-filter"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              void (async () => {
                try {
                  const res = await listLogFiles({
                    sessionId: sessionId || undefined,
                    date: e.target.value || undefined,
                  })
                  setFiles(res.files)
                } catch (err) {
                  onError(err instanceof Error ? err.message : String(err))
                }
              })()
            }}
            className={inputClass}
          />
        </div>
        <button type="button" data-testid="logs-refresh" onClick={() => void reload()} className={buttonClass}>
          刷新
        </button>
      </div>

      {files === null ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">正在读取日志列表…</p>
      ) : files.length === 0 ? (
        <p data-testid="logs-empty" className="rounded-lg border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400 dark:border-neutral-800">
          还没有日志文件。在会话编辑里开启「会话日志」后，输出会按天归档到服务端。
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-50 text-[11px] text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
              <tr>
                <th className="px-3 py-2 font-medium">会话</th>
                <th className="px-3 py-2 font-medium">日期</th>
                <th className="px-3 py-2 font-medium">格式</th>
                <th className="px-3 py-2 font-medium">大小</th>
                <th className="px-3 py-2 font-medium">修改时间</th>
                <th className="px-3 py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {files.map((f) => (
                <tr key={f.id} data-testid="logs-file-row" className="text-neutral-700 dark:text-neutral-300">
                  <td className="max-w-48 truncate px-3 py-2" title={f.sessionName}>
                    {f.sessionName}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{f.date}</td>
                  <td className="px-3 py-2">
                    <Chip tone={f.format === 'html' ? 'violet' : 'neutral'}>
                      {LOG_FORMAT_LABEL[f.format]}
                    </Chip>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{formatBytes(f.sizeBytes)}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{fmtTime(f.modifiedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex gap-1.5">
                      <button
                        type="button"
                        data-testid={`logs-preview-${f.date}`}
                        onClick={() => setPreview(f)}
                        className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                      >
                        预览
                      </button>
                      <a
                        data-testid={`logs-download-${f.date}`}
                        href={logFileDownloadUrl(f.id)}
                        className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                      >
                        下载
                      </a>
                      <button
                        type="button"
                        data-testid={`logs-delete-${f.date}`}
                        onClick={() => void removeFile(f)}
                        className="rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        删除
                      </button>
                      {f.sessionId ? (
                        <button
                          type="button"
                          onClick={() => void removeSession(f)}
                          className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                        >
                          清空全部
                        </button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview ? <PreviewModal file={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 预览（行窗口分页）                                                   */
/* ------------------------------------------------------------------ */

const PREVIEW_PAGE = 500

function PreviewModal({ file, onClose }: { file: LogFileInfo; onClose: () => void }) {
  const [page, setPage] = useState(0)
  const [lines, setLines] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(0)
  const [loading, setLoading] = useState(false)
  const [jump, setJump] = useState('')

  const load = useCallback(
    async (line: number) => {
      setLoading(true)
      try {
        const res = await previewLogFile(file.id, line, PREVIEW_PAGE)
        setLines(res.lines)
        setTotal(res.totalLines)
        setTruncated(res.truncatedLines)
        setPage(res.start)
      } finally {
        setLoading(false)
      }
    },
    [file.id],
  )

  useEffect(() => {
    void load(0)
  }, [load])

  const pageCount = Math.max(1, Math.ceil(total / PREVIEW_PAGE))
  const currentPage = Math.floor(page / PREVIEW_PAGE) + 1

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-100">
              {file.sessionName} · {file.date} · {LOG_FORMAT_LABEL[file.format]} ·{' '}
              {formatBytes(file.sizeBytes)}
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              共 {total} 行 · 每页 {PREVIEW_PAGE} 行（服务端按行窗口取页，大文件不整读）
            </p>
          </div>
          <button type="button" data-testid="logs-preview-close" onClick={onClose} className={buttonClass}>
            关闭
          </button>
        </div>

        <pre
          data-testid="logs-preview-content"
          className="min-h-0 flex-1 overflow-auto bg-neutral-50 px-3 py-2 font-mono text-[11px] leading-[1.5] text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
        >
          {loading ? '加载中…' : lines.length > 0 ? lines.join('\n') : '（空文件或该区间没有内容）'}
        </pre>

        {truncated > 0 ? (
          <p className="shrink-0 px-4 pt-1 text-[11px] text-amber-600 dark:text-amber-400">
            本页有 {truncated} 行超长被截断显示（文件本身未改动）
          </p>
        ) : null}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
          <div className="flex gap-1.5">
            <button
              type="button"
              data-testid="logs-preview-first"
              disabled={page === 0 || loading}
              onClick={() => void load(0)}
              className={buttonClass}
            >
              首页
            </button>
            <button
              type="button"
              data-testid="logs-preview-prev"
              disabled={page - PREVIEW_PAGE < 0 || loading}
              onClick={() => void load(Math.max(0, page - PREVIEW_PAGE))}
              className={buttonClass}
            >
              上一页
            </button>
            <span className="px-1 py-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              第 {currentPage} / {pageCount} 页（行 {page + 1} 起）
            </span>
            <button
              type="button"
              data-testid="logs-preview-next"
              disabled={page + PREVIEW_PAGE >= total || loading}
              onClick={() => void load(page + PREVIEW_PAGE)}
              className={buttonClass}
            >
              下一页
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(Math.max(0, total - PREVIEW_PAGE))}
              className={buttonClass}
            >
              末页
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              data-testid="logs-preview-jump"
              value={jump}
              onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
              placeholder="行号"
              className="w-20 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <button
              type="button"
              disabled={jump === '' || loading}
              onClick={() => {
                const n = Number.parseInt(jump, 10)
                if (Number.isInteger(n) && n >= 1) void load(n - 1)
              }}
              className={buttonClass}
            >
              跳转
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* 审计                                                               */
/* ================================================================== */

const AUDIT_PAGE_SIZE = 50

function AuditTab({ onError }: { onError: (msg: string) => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [event, setEvent] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const load = useCallback(
    async (targetPage: number) => {
      try {
        const res = await queryAudit({
          event: event || undefined,
          from: from || undefined,
          to: to || undefined,
          page: targetPage,
          pageSize: AUDIT_PAGE_SIZE,
        })
        setEntries(res.entries)
        setTotal(res.total)
        setPage(res.page)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      }
    },
    [event, from, onError, to],
  )

  useEffect(() => {
    void load(1)
    // 事件/日期变化时回到第一页
  }, [load])

  const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            事件类型
          </label>
          <select
            data-testid="audit-event-filter"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            className={inputClass}
          >
            <option value="">全部事件</option>
            {AUDIT_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {AUDIT_EVENT_LABEL[ev]}
              </option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            开始日期
          </label>
          <input type="date" data-testid="audit-from" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </div>
        <div className="w-40">
          <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            结束日期
          </label>
          <input type="date" data-testid="audit-to" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </div>
        <button type="button" data-testid="audit-refresh" onClick={() => void load(1)} className={buttonClass}>
          刷新
        </button>
      </div>

      {entries === null ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">正在读取审计记录…</p>
      ) : entries.length === 0 ? (
        <p data-testid="audit-empty" className="rounded-lg border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400 dark:border-neutral-800">
          还没有审计记录。连接、传输与自动化动作发生时会自动记录。
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-50 text-[11px] text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">事件</th>
                <th className="px-3 py-2 font-medium">主体</th>
                <th className="px-3 py-2 font-medium">来源 IP</th>
                <th className="px-3 py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {entries.map((e) => (
                <tr key={e.id} data-testid="audit-row" className="text-neutral-700 dark:text-neutral-300">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px]">
                    {fmtClock(e.at)}
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={e.event === 'disconnect' ? 'amber' : e.event === 'download' || e.event === 'upload' ? 'blue' : 'neutral'}>
                      {AUDIT_EVENT_LABEL[e.event] ?? e.event}
                    </Chip>
                  </td>
                  <td className="max-w-40 truncate px-3 py-2" title={e.title}>
                    {e.title}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px]">{e.clientIp}</td>
                  <td className="px-3 py-2" title={e.detail}>
                    {e.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>
          共 {total} 条 · 第 {page} / {pageCount} 页
        </span>
        <div className="flex gap-1.5">
          <button type="button" data-testid="audit-prev" disabled={page <= 1} onClick={() => void load(page - 1)} className={buttonClass}>
            上一页
          </button>
          <button type="button" data-testid="audit-next" disabled={page >= pageCount} onClick={() => void load(page + 1)} className={buttonClass}>
            下一页
          </button>
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* 设置                                                               */
/* ================================================================== */

function SettingsTab({ onError }: { onError: (msg: string) => void }) {
  const [settings, setSettings] = useState<LoggingSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [retention, setRetention] = useState('30')

  useEffect(() => {
    getLoggingSettings()
      .then((s) => {
        setSettings(s)
        setRetention(String(s.retentionDays))
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
  }, [onError])

  if (!settings) {
    return <p className="text-xs text-neutral-500 dark:text-neutral-400">正在读取设置…</p>
  }

  const updateRule = (index: number, patch: Partial<RedactionRule>): void => {
    const rules = settings.redactionRules.map((r, i) => (i === index ? { ...r, ...patch } : r))
    setSettings({ ...settings, redactionRules: rules })
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    try {
      const rules = settings.redactionRules.map((r, i) => ({
        ...r,
        id: r.id ?? `rule_${Date.now()}_${i}`,
      }))
      const res = await updateLoggingSettings({
        retentionDays: Number.parseInt(retention, 10) || undefined,
        redactionRules: rules,
      })
      setSettings(res.settings)
      setRetention(String(res.settings.retentionDays))
      setSaved(true)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
          日志与审计保留天数（1 ~ 3650，到点自动清理）
        </label>
        <input
          data-testid="logs-retention"
          type="number"
          min={1}
          max={3650}
          value={retention}
          onChange={(e) => {
            setRetention(e.target.value)
            setSaved(false)
          }}
          className="w-32 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </div>

      <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-neutral-900 dark:text-neutral-100">脱敏规则</p>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              写入纯文本 / 带时间戳日志前逐条正则替换；HTML 快照是忠实回放，不做脱敏
            </p>
          </div>
          <button
            type="button"
            data-testid="logs-rule-add"
            onClick={() => {
              setSettings({
                ...settings,
                redactionRules: [
                  ...settings.redactionRules,
                  { id: `rule_${Date.now()}`, name: '', pattern: '', replacement: '', enabled: true },
                ],
              })
              setSaved(false)
            }}
            className={buttonClass}
          >
            + 添加规则
          </button>
        </div>

        <div className="space-y-2">
          {settings.redactionRules.length === 0 ? (
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500">还没有规则。</p>
          ) : null}
          {settings.redactionRules.map((rule, index) => {
            const patternError = validateRedactionPattern(rule.pattern)
            return (
              <div
                key={rule.id ?? index}
                data-testid={`logs-rule-row-${index}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-100 p-2 dark:border-neutral-800"
              >
                <input
                  value={rule.name}
                  onChange={(e) => updateRule(index, { name: e.target.value })}
                  placeholder="规则名"
                  className="w-32 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />
                <input
                  data-testid={`logs-rule-pattern-${index}`}
                  value={rule.pattern}
                  onChange={(e) => updateRule(index, { pattern: e.target.value })}
                  placeholder="正则，如 password\s*=\s*\S+"
                  className={cn(
                    'min-w-0 flex-1 rounded-md border bg-white px-2 py-1.5 font-mono text-[11px] outline-none dark:bg-neutral-900',
                    patternError
                      ? 'border-red-300 dark:border-red-800'
                      : 'border-neutral-200 dark:border-neutral-700',
                    'text-neutral-900 dark:text-neutral-100',
                  )}
                />
                <input
                  value={rule.replacement}
                  onChange={(e) => updateRule(index, { replacement: e.target.value })}
                  placeholder="替换为，如 password=***"
                  className="w-44 rounded-md border border-neutral-200 bg-white px-2 py-1.5 font-mono text-[11px] outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />
                <label className="flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-400">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => updateRule(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <button
                  type="button"
                  data-testid={`logs-rule-remove-${index}`}
                  onClick={() => {
                    setSettings({
                      ...settings,
                      redactionRules: settings.redactionRules.filter((_, i) => i !== index),
                    })
                    setSaved(false)
                  }}
                  className={cn(buttonClass, 'text-red-600 dark:text-red-400')}
                >
                  删除
                </button>
                {patternError ? (
                  <span className="w-full text-[11px] text-red-600 dark:text-red-400">
                    正则错误：{patternError}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" data-testid="logs-settings-save" onClick={() => void save()} disabled={saving} className={primaryButtonClass}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        {saved ? (
          <span data-testid="logs-settings-saved" className="text-[11px] text-emerald-600 dark:text-emerald-400">
            已保存
          </span>
        ) : null}
      </div>
    </div>
  )
}
