/**
 * 端口转发（隧道）管理面板。
 *
 * 交互上的两个取舍：
 * 1. **表单常驻面板顶部**，而不是藏在「新建」按钮后面。开隧道是个高频小动作，
 *    少一层弹窗就少一次犹豫；同时保留「等价 ssh 命令」预览，
 *    让熟悉命令行的用户能立刻确认自己配的是哪一条。
 * 2. **宿主会话必选**。隧道挂在这条连接的通道上，不存在「脱离会话的隧道」，
 *    因此不给「全局」选项 —— 那会让用户以为关掉会话后隧道还在。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TerminalListItem, TunnelInfo, TunnelSpec, TunnelType } from '@webterm/shared'
import {
  DEFAULT_TUNNEL_BIND_HOST,
  TUNNEL_TYPES,
  TUNNEL_TYPE_DESC,
  TUNNEL_TYPE_EXAMPLE,
  TUNNEL_TYPE_LABEL,
  bindLabel,
  tunnelCommand,
} from '@webterm/shared'
import { listTerminals } from '../api/client'
import { useTunnelStore } from '../store/useTunnelStore'
import { formatBytes } from '../sftp/format'
import { cn } from '../utils/cn'

const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none transition-colors focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500'

const TONE: Record<TunnelType, string> = {
  local: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-400',
  remote: 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-400',
  dynamic: 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-400',
}

interface FormState {
  type: TunnelType
  bindHost: string
  bindPort: string
  targetHost: string
  targetPort: string
}

const EMPTY_FORM: FormState = {
  type: 'local',
  bindHost: DEFAULT_TUNNEL_BIND_HOST,
  bindPort: '',
  targetHost: '',
  targetPort: '',
}

export function TunnelPanel() {
  const open = useTunnelStore((s) => s.panelOpen)
  const tunnels = useTunnelStore((s) => s.tunnels)
  const listError = useTunnelStore((s) => s.error)
  const closePanel = useTunnelStore((s) => s.closePanel)
  const create = useTunnelStore((s) => s.create)
  const setRunning = useTunnelStore((s) => s.setRunning)
  const remove = useTunnelStore((s) => s.remove)

  const [terminals, setTerminals] = useState<TerminalListItem[]>([])
  const [terminalId, setTerminalId] = useState('')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadTerminals = useCallback(async () => {
    try {
      const { terminals: all } = await listTerminals()
      // 只有 SSH 会话能承载转发通道
      const usable = all.filter((t) => t.protocol === 'ssh')
      setTerminals(usable)
      setTerminalId((prev) => (usable.some((t) => t.terminalId === prev) ? prev : (usable[0]?.terminalId ?? '')))
    } catch {
      setTerminals([])
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setError(null)
    void loadTerminals()
  }, [open, loadTerminals])

  // 隧道数量变化（含会话被关闭导致隧道被回收）时，会话列表也要跟着刷新，
  // 否则下拉里会留下已经不存在的宿主
  useEffect(() => {
    if (open) void loadTerminals()
  }, [open, tunnels.length, loadTerminals])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePanel, open])

  const host = terminals.find((t) => t.terminalId === terminalId)

  /** 表单 → 隧道定义；同时用于校验与命令预览 */
  const preview = useMemo((): { spec: TunnelSpec } | { error: string } => {
    const bindPort = Number.parseInt(form.bindPort, 10)
    const targetPort = Number.parseInt(form.targetPort, 10)

    if (!form.bindHost.trim()) return { error: '请填写监听地址' }
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      return { error: '监听端口需为 0 ~ 65535 的整数' }
    }
    if (form.type !== 'remote' && bindPort < 1) {
      return { error: '监听端口需为 1 ~ 65535 的整数（只有远程转发允许填 0 由远端分配）' }
    }
    if (form.type === 'dynamic') {
      return { spec: { type: 'dynamic', bindHost: form.bindHost.trim(), bindPort } }
    }
    if (!form.targetHost.trim()) return { error: '请填写目标主机' }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return { error: '目标端口需为 1 ~ 65535 的整数' }
    }
    return {
      spec: {
        type: form.type,
        bindHost: form.bindHost.trim(),
        bindPort,
        targetHost: form.targetHost.trim(),
        targetPort,
      },
    }
  }, [form])

  const commandPreview = useMemo(() => {
    if ('error' in preview) return null
    const sshTarget = host
      ? `${host.username || 'user'}@${host.host}${host.port === 22 ? '' : `:${host.port}`}`
      : 'user@host'
    return tunnelCommand(preview.spec, sshTarget)
  }, [host, preview])

  const handleSubmit = useCallback(async () => {
    if ('error' in preview) {
      setError(preview.error)
      return
    }
    if (!terminalId) {
      setError('请先选择一个已建立的 SSH 会话作为隧道宿主')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await create(terminalId, preview.spec)
      // 端口清掉、主机保留：同一个目标连开几条隧道是常见操作
      setForm((f) => ({ ...f, bindPort: '', targetPort: '' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [create, preview, terminalId])

  if (!open) return null

  const activeCount = tunnels.filter((t) => t.status === 'active').length

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[6vh] backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="端口转发与隧道"
        data-testid="tunnel-panel"
        className="w-full max-w-3xl rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">端口转发 / 隧道</h2>
            <span className="rounded border border-neutral-200 px-1.5 py-px text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              运行中 {activeCount}
            </span>
          </div>
          <button
            type="button"
            onClick={closePanel}
            aria-label="关闭"
            className="flex size-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {listError ? (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
              获取隧道列表失败：{listError}
            </div>
          ) : null}

          {/* ---------------- 新建 ---------------- */}
          <section className="rounded-lg border border-neutral-200 dark:border-neutral-800">
            <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">新建隧道</span>
              <button
                type="button"
                onClick={() => void loadTerminals()}
                className="text-[11px] text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
              >
                刷新会话
              </button>
            </div>

            <div className="space-y-3 px-3 py-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
                  宿主会话（隧道随该 SSH 连接存活，关闭会话即释放端口）
                </span>
                <select
                  data-testid="tunnel-terminal"
                  value={terminalId}
                  onChange={(e) => setTerminalId(e.target.value)}
                  className={inputClass}
                >
                  {terminals.length === 0 ? <option value="">（暂无已建立的 SSH 会话）</option> : null}
                  {terminals.map((t) => (
                    <option key={t.terminalId} value={t.terminalId}>
                      {t.title} · {t.username ? `${t.username}@` : ''}
                      {t.host}
                      {t.attached ? '' : '（未附加）'}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-wrap gap-2">
                {TUNNEL_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    data-testid={`tunnel-type-${type}`}
                    onClick={() => setForm((f) => ({ ...f, type }))}
                    className={cn(
                      'rounded-md border px-3 py-1 text-xs transition-colors',
                      form.type === type
                        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                        : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800',
                    )}
                  >
                    {TUNNEL_TYPE_LABEL[type]}
                  </button>
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                {TUNNEL_TYPE_DESC[form.type]}
                <span className="ml-1 font-mono text-neutral-400 dark:text-neutral-500">
                  {TUNNEL_TYPE_EXAMPLE[form.type]}
                </span>
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
                    监听地址
                  </span>
                  <input
                    data-testid="tunnel-bind-host"
                    value={form.bindHost}
                    onChange={(e) => setForm((f) => ({ ...f, bindHost: e.target.value }))}
                    spellCheck={false}
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
                    监听端口{form.type === 'remote' ? '（填 0 由远端分配）' : ''}
                  </span>
                  <input
                    data-testid="tunnel-bind-port"
                    value={form.bindPort}
                    onChange={(e) => setForm((f) => ({ ...f, bindPort: e.target.value }))}
                    inputMode="numeric"
                    placeholder={form.type === 'remote' ? '0' : '13306'}
                    className={inputClass}
                  />
                </label>
              </div>

              {form.type !== 'dynamic' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
                      目标主机（{form.type === 'local' ? '从远端视角解析' : '从本机视角解析'}）
                    </span>
                    <input
                      data-testid="tunnel-target-host"
                      value={form.targetHost}
                      onChange={(e) => setForm((f) => ({ ...f, targetHost: e.target.value }))}
                      placeholder="10.0.0.5"
                      spellCheck={false}
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-neutral-500 dark:text-neutral-400">目标端口</span>
                    <input
                      data-testid="tunnel-target-port"
                      value={form.targetPort}
                      onChange={(e) => setForm((f) => ({ ...f, targetPort: e.target.value }))}
                      inputMode="numeric"
                      placeholder="3306"
                      className={inputClass}
                    />
                  </label>
                </div>
              ) : null}

              <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
                <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  等价命令
                </div>
                <div className="mt-0.5 break-all font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
                  {commandPreview ?? '（填写完整参数后显示）'}
                </div>
              </div>

              {error ? (
                <div
                  data-testid="tunnel-error"
                  className="whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400"
                >
                  {error}
                </div>
              ) : null}

              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  只监听 127.0.0.1 时仅本机可用；填 0.0.0.0 会对局域网开放，请确认风险
                </span>
                <button
                  type="button"
                  data-testid="tunnel-create"
                  onClick={() => void handleSubmit()}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
                >
                  {busy ? '创建中…' : '创建并启动'}
                </button>
              </div>
            </div>
          </section>

          {/* ---------------- 列表 ---------------- */}
          <section className="mt-4">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                隧道列表（{tunnels.length}）
              </span>
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                ↑ 本地 → 远端 · ↓ 远端 → 本地
              </span>
            </div>

            {tunnels.length === 0 ? (
              <div
                data-testid="tunnel-empty"
                className="rounded-lg border border-dashed border-neutral-200 px-3 py-6 text-center text-[11px] leading-relaxed text-neutral-400 dark:border-neutral-800 dark:text-neutral-500"
              >
                还没有隧道。
                <br />
                典型用法：`-L 13306:10.0.0.5:3306` 让本机客户端连内网 MySQL，
                `-D 1080` 把本机变成能访问内网的 SOCKS5 代理。
              </div>
            ) : (
              <ul className="space-y-2">
                {tunnels.map((tunnel) => (
                  <TunnelRow
                    key={tunnel.id}
                    tunnel={tunnel}
                    onToggle={(running) => void setRunning(tunnel.id, running)}
                    onRemove={() => void remove(tunnel.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/** 单条隧道 */
function TunnelRow({
  tunnel,
  onToggle,
  onRemove,
}: {
  tunnel: TunnelInfo
  onToggle: (running: boolean) => void
  onRemove: () => void
}) {
  const running = tunnel.status === 'active'
  const spec = tunnel.spec
  const target = spec.type === 'dynamic' ? null : `${spec.targetHost}:${spec.targetPort}`

  const statusText =
    tunnel.status === 'active'
      ? '运行中'
      : tunnel.status === 'starting'
        ? '启动中'
        : tunnel.status === 'error'
          ? '错误'
          : '已停止'

  return (
    <li
      data-testid="tunnel-row"
      className="rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'shrink-0 rounded border px-1.5 py-px text-[10px] font-medium',
            TONE[spec.type],
          )}
        >
          {TUNNEL_TYPE_LABEL[spec.type]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-800 dark:text-neutral-200">
          {bindLabel(spec, tunnel.boundPort, tunnel.boundHost)}
          {target ? ` → ${target}` : ''}
        </span>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-px text-[10px]',
            running
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
              : tunnel.status === 'error'
                ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
          )}
        >
          {statusText}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span className="truncate">宿主：{tunnel.terminalTitle}</span>
        <span>连接 {tunnel.activeConnections}／{tunnel.totalConnections}</span>
        <span>↑ {formatBytes(tunnel.bytesUp)}</span>
        <span>↓ {formatBytes(tunnel.bytesDown)}</span>
        {tunnel.autoStarted ? <span className="text-sky-600 dark:text-sky-400">随会话启动</span> : null}

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onToggle(!running)}
            disabled={tunnel.status === 'starting'}
            className="rounded border border-neutral-200 px-2 py-px text-[10px] text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {running ? '停止' : '启动'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded border border-neutral-200 px-2 py-px text-[10px] text-neutral-600 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            删除
          </button>
        </span>
      </div>

      {tunnel.error ? (
        <div className="mt-1.5 whitespace-pre-wrap rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {tunnel.error}
        </div>
      ) : null}
    </li>
  )
}
