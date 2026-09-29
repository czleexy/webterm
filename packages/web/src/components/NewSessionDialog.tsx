/**
 * 新建连接弹窗。
 *
 * 包含「测试连接」能力：先只做握手与认证（POST /api/sessions/probe），
 * 把协商算法、主机密钥指纹、以及远端是否允许开启会话都提前告诉用户。
 * 这样「连不上」和「连上了但不让登录」能被清楚地区分开 ——
 * 后者在真实的老旧网络设备上非常常见。
 *
 * 支持 SSH 与 Telnet 两种协议：
 * - SSH：本机完成握手与认证，因此需要用户名 + 凭据，可开 SFTP。
 * - Telnet：没有认证阶段（登录是在终端里逐行交互完成的），因此**不收集任何凭据**，
 *   只填主机与端口；协议本身明文，界面上必须给出明确警示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PORTS,
  DEFAULT_TERM,
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
  PROTOCOL_LABEL,
  SUPPORTED_ENCODINGS,
  type AuthMethod,
  type ConnectionProtocol,
  type ProbeSessionResponse,
  type SessionConfig,
  type SshTarget,
  type SupportedEncoding,
  type TelnetTarget,
} from '@webterm/shared'
import { ApiRequestError, probeSession } from '../api/client'
import { cn } from '../utils/cn'

type LegacyCompat = 'auto' | 'always' | 'never'

const ENCODING_LABEL: Record<SupportedEncoding, string> = {
  utf8: 'UTF-8（推荐）',
  gbk: 'GBK（简体中文老设备）',
  gb18030: 'GB18030',
  big5: 'Big5（繁体中文）',
  latin1: 'Latin-1',
}

const LEGACY_LABEL: Record<LegacyCompat, string> = {
  auto: '自动（先现代，失败后降级）',
  always: '总是使用 legacy 算法',
  never: '仅现代算法（更安全）',
}

/** 连接用途：终端会话，或直接开一个 SFTP 文件传输标签（仅 SSH） */
export type ConnectMode = 'terminal' | 'sftp'

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
  /** 初始模式；从「打开 SFTP」入口进来时直接进 sftp */
  initialMode?: ConnectMode
  onSubmit: (config: SessionConfig, title: string, mode: ConnectMode) => void
}

interface FormState {
  protocol: ConnectionProtocol
  host: string
  port: string
  username: string
  authMethod: AuthMethod
  password: string
  privateKey: string
  passphrase: string
  encoding: SupportedEncoding
  term: string
  legacyCompat: LegacyCompat
  title: string
}

const INITIAL_FORM: FormState = {
  protocol: 'ssh',
  host: '',
  port: String(DEFAULT_PORTS.ssh),
  username: '',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  encoding: 'utf8',
  term: DEFAULT_TERM,
  legacyCompat: 'auto',
  title: '',
}

/** 把表单值转成后端要求的 SshTarget */
function toSshTarget(form: FormState): SshTarget {
  const base: SshTarget = {
    host: form.host.trim(),
    port: Number.parseInt(form.port, 10) || DEFAULT_PORTS.ssh,
    username: form.username.trim(),
    authMethod: form.authMethod,
  }
  if (form.authMethod === 'password') {
    base.password = form.password
  } else {
    base.privateKey = form.privateKey
    if (form.passphrase) base.passphrase = form.passphrase
  }
  return base
}

/** Telnet 目标只有主机与端口：协议本身没有认证阶段，凭据一律不进配置 */
function toTelnetTarget(form: FormState): TelnetTarget {
  return {
    host: form.host.trim(),
    port: Number.parseInt(form.port, 10) || DEFAULT_PORTS.telnet,
  }
}

export function NewSessionDialog({ open, onClose, initialMode, onSubmit }: NewSessionDialogProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [mode, setMode] = useState<ConnectMode>(initialMode ?? 'terminal')
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<ProbeSessionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hostInputRef = useRef<HTMLInputElement | null>(null)

  // 每次打开时重置，避免上次的凭据与探测结果残留
  useEffect(() => {
    if (open) {
      setForm(INITIAL_FORM)
      setMode(initialMode ?? 'terminal')
      setProbe(null)
      setError(null)
      setTesting(false)
      // 等弹窗渲染完成再聚焦
      requestAnimationFrame(() => hostInputRef.current?.focus())
    }
  }, [open, initialMode])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const patch = useCallback((part: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...part }))
    // 修改任何字段都让上一次的探测结果失效，避免误导
    setProbe(null)
    setError(null)
  }, [])

  /**
   * 切换协议。
   * 端口只在「当前值仍是上一协议的默认端口」时才跟随切换 ——
   * 用户手改过端口（比如 2323 的 Telnet）就不该被覆盖掉。
   * Telnet 没有 SFTP 子系统，因此同时把用途强制切回终端。
   */
  const switchProtocol = useCallback((next: ConnectionProtocol) => {
    setForm((prev) => ({
      ...prev,
      protocol: next,
      port:
        prev.port === String(DEFAULT_PORTS[prev.protocol]) ? String(DEFAULT_PORTS[next]) : prev.port,
    }))
    setProbe(null)
    setError(null)
    if (next === 'telnet') setMode('terminal')
  }, [])

  const isTelnet = form.protocol === 'telnet'

  /** 前端预校验，避免把明显不合法的请求发到后端再报错 */
  const validationError = useMemo(() => {
    if (!form.host.trim()) return '请填写主机地址'
    if (/\s/.test(form.host)) return '主机地址不能包含空格'
    if (form.host.includes('://')) return '主机地址不要带 ssh:// 或 telnet:// 前缀'
    const port = Number.parseInt(form.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口需为 1~65535 的整数'
    // 以下只有 SSH 需要：Telnet 的登录名与口令都在终端里交互输入
    if (!isTelnet) {
      if (!form.username.trim()) return '请填写用户名'
      if (form.authMethod === 'password' && !form.password) return '请填写登录口令'
      if (form.authMethod === 'privateKey' && !form.privateKey.trim()) return '请粘贴私钥内容'
    }
    return null
  }, [form, isTelnet])

  const buildConfig = useCallback((): SessionConfig => {
    const terminal = {
      cols: DEFAULT_TERM_COLS,
      rows: DEFAULT_TERM_ROWS,
      encoding: form.encoding,
      term: form.term.trim() || DEFAULT_TERM,
    }
    if (form.protocol === 'telnet') {
      return { protocol: 'telnet', target: toTelnetTarget(form), terminal }
    }
    return {
      protocol: 'ssh',
      target: toSshTarget(form),
      terminal,
      legacyCompat: form.legacyCompat,
    }
  }, [form])

  const handleTest = useCallback(async () => {
    if (validationError) {
      setError(validationError)
      return
    }
    setTesting(true)
    setError(null)
    setProbe(null)
    try {
      const result = await probeSession(
        form.protocol === 'telnet'
          ? { protocol: 'telnet', target: toTelnetTarget(form) }
          : { protocol: 'ssh', target: toSshTarget(form), legacyCompat: form.legacyCompat },
      )
      setProbe(result)
    } catch (err) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      setError(message)
    } finally {
      setTesting(false)
    }
  }, [form, validationError])

  const handleSubmit = useCallback(() => {
    if (validationError) {
      setError(validationError)
      return
    }
    onSubmit(buildConfig(), form.title.trim(), isTelnet ? 'terminal' : mode)
  }, [buildConfig, form.title, isTelnet, mode, onSubmit, validationError])

  if (!open) return null

  const title = isTelnet ? '新建 Telnet 连接' : mode === 'sftp' ? '新建 SFTP 文件传输' : '新建 SSH 连接'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-2xl rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{title}</h2>
            {/* 协议选择：决定后续表单的形状与可用的用途 */}
            <div className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700">
              {(['ssh', 'telnet'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`protocol-${value}`}
                  onClick={() => switchProtocol(value)}
                  title={
                    value === 'telnet'
                      ? '明文协议，仅建议在受信网络使用'
                      : '加密协议，支持密钥认证与 SFTP'
                  }
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] transition-colors',
                    form.protocol === value
                      ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100',
                  )}
                >
                  {PROTOCOL_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* 用途切换：同一条 SSH 连接既能开终端也能开文件传输；Telnet 只有终端 */}
            {isTelnet ? null : (
              <div className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700">
                {(
                  [
                    ['terminal', '终端'],
                    ['sftp', 'SFTP 文件'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`mode-${value}`}
                    onClick={() => setMode(value)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[11px] transition-colors',
                      mode === value
                        ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex size-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="max-h-[64vh] overflow-y-auto px-5 py-4">
          {isTelnet ? (
            <div
              data-testid="telnet-warning"
              className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <b className="font-medium">Telnet 是明文协议</b>
              ：登录名、口令与全部会话内容都会以明文经过网络。
              登录过程在本终端里交互完成，因此这里不需要也不应该填写凭据；
              请仅在受信网络中使用，条件允许时优先改用 SSH。
            </div>
          ) : null}

          {/* 主机与认证 */}
          <Section title="连接目标">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_100px]">
              <Field label="主机地址 / IP" required>
                <input
                  ref={hostInputRef}
                  name="host"
                  value={form.host}
                  onChange={(e) => patch({ host: e.target.value })}
                  placeholder="192.168.1.254"
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>
              <Field label="端口" required>
                <input
                  name="port"
                  value={form.port}
                  onChange={(e) => patch({ port: e.target.value })}
                  inputMode="numeric"
                  className={inputClass}
                />
              </Field>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {isTelnet ? null : (
                <Field label="用户名" required>
                  <input
                    name="username"
                    value={form.username}
                    onChange={(e) => patch({ username: e.target.value })}
                    placeholder="root"
                    spellCheck={false}
                    autoComplete="off"
                    className={inputClass}
                  />
                </Field>
              )}
              <Field label="标签标题">
                <input
                  name="title"
                  value={form.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder={
                    isTelnet ? '留空则使用 主机[:端口]' : '留空则使用 用户名@主机'
                  }
                  className={inputClass}
                />
              </Field>
            </div>
          </Section>

          {/* 认证方式：Telnet 没有认证阶段，整段不显示 */}
          {isTelnet ? null : (
            <Section title="认证方式">
              <div className="flex gap-2">
                {(
                  [
                    ['password', '口令'],
                    ['privateKey', '私钥'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => patch({ authMethod: value })}
                    className={cn(
                      'rounded-md border px-3 py-1 text-xs transition-colors',
                      form.authMethod === value
                        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                        : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {form.authMethod === 'password' ? (
                <div className="mt-3">
                  <Field label="登录口令" required>
                    <input
                      name="password"
                      type="password"
                      value={form.password}
                      onChange={(e) => patch({ password: e.target.value })}
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </Field>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    口令仅在本次连接时经本机后端转发，不会写入浏览器存储；
                    需要复用可保存到会话库（凭据由主密码保险库以 AES-256-GCM 加密存储）。
                  </p>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <Field label="私钥内容（OpenSSH / PEM）" required>
                    <textarea
                      name="privateKey"
                      value={form.privateKey}
                      onChange={(e) => patch({ privateKey: e.target.value })}
                      rows={5}
                      spellCheck={false}
                      placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                      className={cn(inputClass, 'resize-y font-mono text-[11px] leading-relaxed')}
                    />
                  </Field>
                  <Field label="私钥口令（若已加密）">
                    <input
                      name="passphrase"
                      type="password"
                      value={form.passphrase}
                      onChange={(e) => patch({ passphrase: e.target.value })}
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}
            </Section>
          )}

          {/* 终端与兼容性：SFTP 模式不需要终端编码与 TERM */}
          <Section title={mode === 'sftp' ? '连接兼容性' : '终端与兼容性'}>
            {mode === 'terminal' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="终端编码">
                  <select
                    name="encoding"
                    value={form.encoding}
                    onChange={(e) => patch({ encoding: e.target.value as SupportedEncoding })}
                    className={inputClass}
                  >
                    {SUPPORTED_ENCODINGS.map((enc) => (
                      <option key={enc} value={enc}>
                        {ENCODING_LABEL[enc]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={isTelnet ? 'TERM 类型（经 TERMINAL-TYPE 上报）' : 'TERM 类型'}>
                  <input
                    name="term"
                    value={form.term}
                    onChange={(e) => patch({ term: e.target.value })}
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
              </div>
            ) : null}

            {isTelnet ? (
              <p className={cn('text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400', mode === 'terminal' && 'mt-3')}>
                老设备常用 GBK / GB18030 输出，选错编码会出现乱码。
                窗口尺寸通过 NAWS 选项上报；若设备不回显（WILL ECHO 未协商成功），本端会自动做本地回显。
              </p>
            ) : (
              <div className={cn(mode === 'terminal' && 'mt-3')}>
                <Field label="算法兼容策略">
                  <select
                    name="legacyCompat"
                    value={form.legacyCompat}
                    onChange={(e) => patch({ legacyCompat: e.target.value as LegacyCompat })}
                    className={inputClass}
                  >
                    {(Object.keys(LEGACY_LABEL) as LegacyCompat[]).map((key) => (
                      <option key={key} value={key}>
                        {LEGACY_LABEL[key]}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                  老旧的交换机 / 路由器通常只支持 SHA-1 类算法。
                  选择「自动」时会先尝试现代算法，协商失败后自动降级，无需手动判断设备型号。
                </p>
              </div>
            )}
          </Section>

          {/* 校验与探测结果 */}
          {validationError && (error || probe) ? null : validationError ? (
            <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
              {validationError}
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </div>
          ) : null}

          {probe ? <ProbeResult probe={probe} /> : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <button
            type="button"
            data-testid="probe-session"
            onClick={handleTest}
            disabled={testing}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="connect-session"
            onClick={handleSubmit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {mode === 'sftp' && !isTelnet ? '打开文件传输' : '连接'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:border-neutral-500'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-neutral-100 pb-4 pt-1 last:border-b-0 dark:border-neutral-800/60">
      <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </span>
      {children}
    </label>
  )
}

/** 探测结果面板。SSH 与 Telnet 能回答的问题不同，因此分两套展示。 */
function ProbeResult({ probe }: { probe: ProbeSessionResponse }) {
  // Telnet 没有 shell 概念，也就无所谓「远端拒绝开会话」
  const isTelnet = probe.protocol === 'telnet'
  const hasBlockingWarning = probe.warnings.some((w) => w.includes('拒绝开启终端会话'))
  const allowShell = isTelnet || !hasBlockingWarning

  return (
    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div
        className={cn(
          'flex items-center gap-2 rounded-t-lg border-b px-3 py-2 text-[11px] font-medium',
          allowShell
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400'
            : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400',
        )}
      >
        <span>
          {isTelnet
            ? 'TCP 端口可达，设备已响应'
            : allowShell
              ? '连接与认证正常，远端允许开启终端会话'
              : '认证成功，但远端拒绝开启终端会话'}
        </span>
        <span className="ml-auto font-mono font-normal opacity-70">{probe.elapsedMs} ms</span>
      </div>

      {isTelnet ? (
        <>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-2">
            <Row label="协议" value="Telnet（明文）" />
            <Row label="服务端标识" value={probe.serverIdent || '（Telnet 无版本串）'} />
          </dl>
          <div className="border-t border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
            <div className="text-[11px] text-neutral-400 dark:text-neutral-500">设备欢迎语</div>
            {probe.banner ? (
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
                {probe.banner}
              </pre>
            ) : (
              <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                设备未主动输出内容。多数 Telnet 设备要等按下回车才会显示登录提示，这不代表异常。
              </div>
            )}
          </div>
        </>
      ) : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-2">
          <Row label="服务端标识" value={probe.serverIdent || '（未提供）'} />
          <Row label="认证方式" value={probe.authMethod} />
          <Row label="密钥交换" value={probe.negotiation?.kex ?? '—'} />
          <Row label="主机密钥算法" value={probe.negotiation?.hostKeyAlgorithm ?? '—'} />
          <Row label="加密算法" value={probe.negotiation?.cipher ?? '—'} />
          <Row label="MAC 算法" value={probe.negotiation?.mac ?? '—'} />
          <Row
            label="算法档案"
            value={
              probe.negotiation
                ? probe.negotiation.profile + (probe.negotiation.legacy ? '（legacy）' : '（modern）')
                : '—'
            }
          />
          <Row label="主机密钥指纹" value={probe.hostKeyFingerprint ?? '—'} mono />
        </dl>
      )}

      {probe.warnings.length > 0 ? (
        <ul className="space-y-1 border-t border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
          {probe.warnings.map((warning, index) => (
            <li
              key={index}
              className="flex gap-1.5 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400"
            >
              <span className="text-neutral-400 dark:text-neutral-600">·</span>
              <span className="min-w-0 flex-1">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500">{label}</dt>
      <dd
        className={cn(
          'min-w-0 flex-1 truncate text-[11px] text-neutral-800 dark:text-neutral-200',
          mono && 'font-mono',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}
