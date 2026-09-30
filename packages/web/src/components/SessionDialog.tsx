/**
 * 会话编辑弹窗：创建/编辑会话库中的连接配置。
 *
 * 结构：协议 → 基本（名称/分组/主机/端口[/用户名]）→ 认证（凭据选择 + 内联新建）→
 * 终端（编码/TERM[/算法兼容]）→ 跳板链（逐跳配置，凭据同样引用保险库）→
 * 隧道（随会话自动启动的端口转发，阶段 5）。
 *
 * Telnet 与 SSH 的差异全部体现在「哪些字段存在」上：Telnet 没有认证阶段
 * （登录在终端里交互完成）、没有算法协商、也没有跳板链与转发通道，
 * 因此这些段落整段不渲染。
 * 因为共享的 SessionRecord 是「扁平 + 按协议可缺省」而不是判别联合，
 * 只有这里把住「不该出现的字段一律不写入」这条线，落库的数据才不会有脏字段。
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  ConnectionProtocol,
  CredentialSummary,
  LibraryNode,
  LogFormat,
  SessionRecord,
  SupportedEncoding,
  TunnelSpec,
  TunnelType,
} from '@webterm/shared'
import {
  DEFAULT_PORTS,
  DEFAULT_TUNNEL_BIND_HOST,
  LOG_FORMATS,
  LOG_FORMAT_DESCRIPTION,
  LOG_FORMAT_LABEL,
  PROTOCOL_LABEL,
  SUPPORTED_ENCODINGS,
  TUNNEL_TYPES,
  TUNNEL_TYPE_LABEL,
} from '@webterm/shared'
import {
  createCredential,
  createLibraryNode,
  updateLibraryNode,
  ApiRequestError,
} from '../api/client'
import { cn } from '../utils/cn'

const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none transition-colors focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500'

function Field({
  label,
  children,
  required,
}: {
  label: string
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-500 dark:text-neutral-400">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </span>
      {children}
    </label>
  )
}

interface JumpHopForm {
  host: string
  port: string
  username: string
  credentialId: string
}

interface SessionForm {
  protocol: ConnectionProtocol
  name: string
  parentId: string | null
  host: string
  port: string
  username: string
  credentialId: string
  encoding: SupportedEncoding
  term: string
  legacyCompat: 'auto' | 'always' | 'never'
  jumpChain: JumpHopForm[]
  /** 随会话自动启动的隧道（阶段 5）；Telnet 无此概念 */
  tunnels: TunnelRowForm[]
  /** 会话日志（阶段 7）；SSH 与 Telnet 都可用 */
  logEnabled: boolean
  logFormat: LogFormat
}

const EMPTY_FORM: SessionForm = {
  protocol: 'ssh',
  name: '',
  parentId: null,
  host: '',
  port: String(DEFAULT_PORTS.ssh),
  username: 'root',
  credentialId: '',
  encoding: 'utf8',
  term: 'xterm-256color',
  legacyCompat: 'auto',
  jumpChain: [],
  tunnels: [],
  logEnabled: false,
  logFormat: 'plain',
}

/** 表单里的一行隧道定义（端口用字符串承载，便于输入中途的空值） */
interface TunnelRowForm {
  type: TunnelType
  bindHost: string
  bindPort: string
  targetHost: string
  targetPort: string
}

const NEW_TUNNEL_ROW: TunnelRowForm = {
  type: 'local',
  bindHost: DEFAULT_TUNNEL_BIND_HOST,
  bindPort: '',
  targetHost: '',
  targetPort: '',
}

/** 表单行 → 契约对象；端口非法时返回 null（保存前的校验会拦下） */
function rowToSpec(row: TunnelRowForm): TunnelSpec | null {
  const bindPort = Number.parseInt(row.bindPort, 10)
  if (!row.bindHost.trim() || !Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
    return null
  }
  if (row.type === 'dynamic') {
    return bindPort >= 1 ? { type: 'dynamic', bindHost: row.bindHost.trim(), bindPort } : null
  }
  const targetPort = Number.parseInt(row.targetPort, 10)
  if (row.type !== 'remote' && bindPort < 1) return null
  if (!row.targetHost.trim() || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return null
  }
  return {
    type: row.type,
    bindHost: row.bindHost.trim(),
    bindPort,
    targetHost: row.targetHost.trim(),
    targetPort,
  }
}

/** 契约对象 → 表单行（编辑已有会话时回填） */
function specToRow(spec: TunnelSpec): TunnelRowForm {
  return {
    type: spec.type,
    bindHost: spec.bindHost,
    bindPort: String(spec.bindPort),
    targetHost: spec.type === 'dynamic' ? '' : spec.targetHost,
    targetPort: spec.type === 'dynamic' ? '' : String(spec.targetPort),
  }
}

interface NewCredentialForm {
  name: string
  type: 'password' | 'privateKey'
  password: string
  privateKey: string
  passphrase: string
}

const EMPTY_CRED: NewCredentialForm = {
  name: '',
  type: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
}

export interface SessionDialogProps {
  open: boolean
  onClose: () => void
  /** 编辑已有会话时传入；不传则为新建 */
  editing?: LibraryNode | null
  credentials: CredentialSummary[]
  folders: LibraryNode[]
  defaultParentId?: string | null
  /** 保存成功后回调（返回新建/更新后的节点） */
  onSaved: (node: LibraryNode) => void
}

export function SessionDialog({
  open,
  onClose,
  editing,
  credentials,
  folders,
  defaultParentId = null,
  onSaved,
}: SessionDialogProps) {
  const [form, setForm] = useState<SessionForm>(EMPTY_FORM)
  const [newCred, setNewCred] = useState<NewCredentialForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 打开时初始化表单
  useEffect(() => {
    if (!open) return
    setError(null)
    setNewCred(null)
    if (editing?.session) {
      const s: SessionRecord = editing.session
      setForm({
        protocol: s.protocol ?? 'ssh',
        name: editing.name,
        parentId: editing.parentId,
        host: s.host,
        port: String(s.port),
        // 旧记录 / Telnet 记录不含用户名与凭据，回退成空串避免出现 'undefined'
        username: s.username ?? '',
        credentialId: s.credentialId ?? '',
        encoding: s.encoding,
        term: s.term,
        legacyCompat: s.legacyCompat ?? 'auto',
        jumpChain: (s.jumpChain ?? []).map((h) => ({
          host: h.host,
          port: String(h.port),
          username: h.username,
          credentialId: h.credentialId,
        })),
        tunnels: (s.tunnels ?? []).map(specToRow),
        logEnabled: s.logging?.enabled ?? false,
        logFormat: s.logging?.format ?? 'plain',
      })
    } else {
      setForm({ ...EMPTY_FORM, parentId: defaultParentId })
    }
  }, [open, editing, defaultParentId])

  const patch = (p: Partial<SessionForm>) => setForm((f) => ({ ...f, ...p }))

  const isTelnet = form.protocol === 'telnet'

  /** 切换协议：端口只在仍是另一协议默认值时才跟随，避免覆盖用户手改的端口 */
  const switchProtocol = (next: ConnectionProtocol) => {
    setForm((f) => ({
      ...f,
      protocol: next,
      port: f.port === String(DEFAULT_PORTS[f.protocol]) ? String(DEFAULT_PORTS[next]) : f.port,
    }))
    // Telnet 不走凭据/跳板链，内联新建凭据的表单一并收起
    if (next === 'telnet') setNewCred(null)
  }

  const credentialOptions = useMemo(() => {
    // 编辑态下，当前引用的凭据可能不在列表里（理论上不会，防御一下）
    return credentials
  }, [credentials])

  if (!open) return null

  const canSubmit =
    form.name.trim().length > 0 &&
    form.host.trim().length > 0 &&
    (isTelnet ||
      (form.username.trim().length > 0 &&
        (newCred ? newCred.name.trim().length > 0 : form.credentialId !== '')))

  /**
   * 组装落库记录。
   * Telnet 记录**只写** protocol/host/port/encoding/term —— 明确不写 username、
   * credentialId、legacyCompat、jumpChain，否则编辑一次就会把 SSH 的字段污染进 Telnet 记录。
   */
  const buildRecord = (credentialId: string): SessionRecord => {
    const base: SessionRecord = {
      protocol: form.protocol,
      host: form.host.trim(),
      port: Number.parseInt(form.port, 10) || DEFAULT_PORTS[form.protocol],
      encoding: form.encoding,
      term: form.term.trim() || 'xterm-256color',
      // 日志配置对 SSH 与 Telnet 一视同仁：记的是终端输出，与协议能力无关
      logging: { enabled: form.logEnabled, format: form.logFormat },
    }
    if (isTelnet) return base
    return {
      ...base,
      username: form.username.trim(),
      credentialId,
      legacyCompat: form.legacyCompat,
      jumpChain: form.jumpChain.map((h) => ({
        host: h.host.trim(),
        port: Number.parseInt(h.port, 10) || DEFAULT_PORTS.ssh,
        username: h.username.trim(),
        credentialId: h.credentialId,
      })),
      // 填了一半的隧道（端口没填完）直接丢弃并保存其余部分 ——
      // 因为一条写不完整的定义而拒绝整份会话配置，代价太大
      tunnels: form.tunnels.map(rowToSpec).filter((s): s is TunnelSpec => s !== null),
    }
  }

  const handleSubmit = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    setError(null)
    try {
      let credentialId = form.credentialId

      // 内联新建凭据：先创建再引用（仅 SSH 路径会出现）
      if (newCred && !isTelnet) {
        const cred = await createCredential({
          name: newCred.name.trim(),
          type: newCred.type,
          ...(newCred.type === 'password'
            ? { password: newCred.password }
            : { privateKey: newCred.privateKey, passphrase: newCred.passphrase || undefined }),
        })
        credentialId = cred.id
      }

      const record = buildRecord(credentialId)
      const node = editing
        ? await updateLibraryNode(editing.id, { name: form.name.trim(), parentId: form.parentId, session: record })
        : await createLibraryNode({
            kind: 'session',
            name: form.name.trim(),
            parentId: form.parentId,
            session: record,
          })
      onSaved(node)
      onClose()
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        data-testid="session-dialog"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {editing ? '编辑会话' : '新建会话'}
          </h2>
          <div className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700">
            {(['ssh', 'telnet'] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`session-protocol-${value}`}
                onClick={() => switchProtocol(value)}
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

        {isTelnet ? (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            Telnet 为明文协议，且没有独立的认证阶段：登录名与口令在终端里交互输入，
            因此这里不需要配置凭据、跳板链与算法档案。
          </p>
        ) : null}

        {/* 基本设置 */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="会话名称" required>
            <input
              data-testid="session-name"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="生产环境核心交换机"
              className={inputClass}
            />
          </Field>
          <Field label="所属分组">
            <select
              value={form.parentId ?? ''}
              onChange={(e) => patch({ parentId: e.target.value || null })}
              className={inputClass}
            >
              <option value="">（根目录）</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="主机地址" required>
            <input
              data-testid="session-host"
              value={form.host}
              onChange={(e) => patch({ host: e.target.value })}
              placeholder="192.168.1.254"
              className={inputClass}
            />
          </Field>
          {isTelnet ? (
            <Field label="端口" required>
              <input
                data-testid="session-port"
                value={form.port}
                onChange={(e) => patch({ port: e.target.value })}
                inputMode="numeric"
                className={inputClass}
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="端口" required>
                <input
                  data-testid="session-port"
                  value={form.port}
                  onChange={(e) => patch({ port: e.target.value })}
                  inputMode="numeric"
                  className={inputClass}
                />
              </Field>
              <Field label="用户名" required>
                <input
                  data-testid="session-username"
                  value={form.username}
                  onChange={(e) => patch({ username: e.target.value })}
                  className={inputClass}
                />
              </Field>
            </div>
          )}
        </div>

        {/* 认证：Telnet 整段不显示 */}
        {isTelnet ? null : (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                登录凭据<span className="text-red-500"> *</span>
              </span>
              <button
                type="button"
                onClick={() => setNewCred(newCred ? null : { ...EMPTY_CRED })}
                className="text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
              >
                {newCred ? '选择已有凭据' : '+ 新建凭据'}
              </button>
            </div>

            {newCred ? (
              <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="凭据名称" required>
                    <input
                      data-testid="cred-name"
                      value={newCred.name}
                      onChange={(e) => setNewCred({ ...newCred, name: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="类型">
                    <select
                      value={newCred.type}
                      onChange={(e) =>
                        setNewCred({ ...newCred, type: e.target.value as NewCredentialForm['type'] })
                      }
                      className={inputClass}
                    >
                      <option value="password">口令</option>
                      <option value="privateKey">私钥</option>
                    </select>
                  </Field>
                </div>
                {newCred.type === 'password' ? (
                  <div className="mt-3">
                    <Field label="口令" required>
                      <input
                        data-testid="cred-password"
                        type="password"
                        value={newCred.password}
                        onChange={(e) => setNewCred({ ...newCred, password: e.target.value })}
                        autoComplete="new-password"
                        className={inputClass}
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <Field label="私钥内容（OpenSSH / PEM）" required>
                      <textarea
                        data-testid="cred-private-key"
                        value={newCred.privateKey}
                        onChange={(e) => setNewCred({ ...newCred, privateKey: e.target.value })}
                        rows={4}
                        spellCheck={false}
                        placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                        className={cn(inputClass, 'resize-y font-mono text-[11px] leading-relaxed')}
                      />
                    </Field>
                    <Field label="私钥口令（若有）">
                      <input
                        type="password"
                        value={newCred.passphrase}
                        onChange={(e) => setNewCred({ ...newCred, passphrase: e.target.value })}
                        autoComplete="new-password"
                        className={inputClass}
                      />
                    </Field>
                  </div>
                )}
              </div>
            ) : (
              <select
                data-testid="session-credential"
                value={form.credentialId}
                onChange={(e) => patch({ credentialId: e.target.value })}
                className={inputClass}
              >
                <option value="">（选择凭据）</option>
                {credentialOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.type === 'password' ? '口令' : '私钥'}）
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* 终端设置 */}
        <div className={cn('mt-4 grid gap-3', isTelnet ? 'grid-cols-2' : 'grid-cols-3')}>
          <Field label="编码">
            <select
              value={form.encoding}
              onChange={(e) => patch({ encoding: e.target.value as SupportedEncoding })}
              className={inputClass}
            >
              {SUPPORTED_ENCODINGS.map((enc) => (
                <option key={enc} value={enc}>
                  {enc}
                </option>
              ))}
            </select>
          </Field>
          <Field label="TERM">
            <input value={form.term} onChange={(e) => patch({ term: e.target.value })} className={inputClass} />
          </Field>
          {isTelnet ? null : (
            <Field label="算法兼容">
              <select
                value={form.legacyCompat}
                onChange={(e) =>
                  patch({ legacyCompat: e.target.value as SessionForm['legacyCompat'] })
                }
                className={inputClass}
              >
                <option value="auto">自动降级</option>
                <option value="always">总是 legacy</option>
                <option value="never">只用现代算法</option>
              </select>
            </Field>
          )}
        </div>

        {/* 跳板链：Telnet 无此概念 */}
        {isTelnet ? null : (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                跳板链（按顺序经过，最多 5 级）
              </span>
              <button
                type="button"
                onClick={() =>
                  patch({ jumpChain: [...form.jumpChain, { host: '', port: '22', username: '', credentialId: '' }] })
                }
                disabled={form.jumpChain.length >= 5}
                className="text-xs text-neutral-500 underline-offset-2 hover:underline disabled:opacity-40 dark:text-neutral-400"
              >
                + 添加一跳
              </button>
            </div>
            {form.jumpChain.map((hop, i) => (
              <div key={i} className="mt-2 grid grid-cols-[1fr_64px_1fr_1.2fr_auto] items-end gap-2">
                <input
                  placeholder="跳板主机"
                  value={hop.host}
                  onChange={(e) => {
                    const jc = [...form.jumpChain]
                    jc[i] = { ...hop, host: e.target.value }
                    patch({ jumpChain: jc })
                  }}
                  className={inputClass}
                />
                <input
                  placeholder="端口"
                  value={hop.port}
                  onChange={(e) => {
                    const jc = [...form.jumpChain]
                    jc[i] = { ...hop, port: e.target.value }
                    patch({ jumpChain: jc })
                  }}
                  className={inputClass}
                />
                <input
                  placeholder="用户名"
                  value={hop.username}
                  onChange={(e) => {
                    const jc = [...form.jumpChain]
                    jc[i] = { ...hop, username: e.target.value }
                    patch({ jumpChain: jc })
                  }}
                  className={inputClass}
                />
                <select
                  value={hop.credentialId}
                  onChange={(e) => {
                    const jc = [...form.jumpChain]
                    jc[i] = { ...hop, credentialId: e.target.value }
                    patch({ jumpChain: jc })
                  }}
                  className={inputClass}
                >
                  <option value="">（跳板凭据）</option>
                  {credentialOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => patch({ jumpChain: form.jumpChain.filter((_, j) => j !== i) })}
                  className="px-1.5 py-1.5 text-xs text-neutral-400 hover:text-red-500"
                  title="删除此跳"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 隧道：随会话自动启动的端口转发；Telnet 没有可承载转发通道的协议层 */}
        {isTelnet ? null : (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                端口转发（连接建立后自动启动）
              </span>
              <button
                type="button"
                data-testid="add-tunnel"
                onClick={() => patch({ tunnels: [...form.tunnels, { ...NEW_TUNNEL_ROW }] })}
                className="text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
              >
                + 添加隧道
              </button>
            </div>

            {form.tunnels.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                例如 `-L 13306:10.0.0.5:3306`（本机连内网数据库）、`-D 1080`（本机 SOCKS5 代理）。
                端口被占用等情况不会影响会话建立，只会在终端里给出提示。
              </p>
            ) : null}

            {form.tunnels.map((row, i) => {
              const update = (part: Partial<TunnelRowForm>) => {
                const next = [...form.tunnels]
                next[i] = { ...row, ...part }
                patch({ tunnels: next })
              }
              return (
                <div
                  key={i}
                  data-testid="session-tunnel-row"
                  className="mt-2 rounded-md border border-neutral-200 px-2 py-2 dark:border-neutral-700"
                >
                  <div className="grid grid-cols-[92px_1fr_80px_auto] items-center gap-2">
                    <select
                      value={row.type}
                      onChange={(e) => update({ type: e.target.value as TunnelType })}
                      className={inputClass}
                    >
                      {TUNNEL_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TUNNEL_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder="监听地址"
                      value={row.bindHost}
                      onChange={(e) => update({ bindHost: e.target.value })}
                      spellCheck={false}
                      className={inputClass}
                    />
                    <input
                      placeholder={row.type === 'remote' ? '0=自动' : '端口'}
                      value={row.bindPort}
                      onChange={(e) => update({ bindPort: e.target.value })}
                      inputMode="numeric"
                      className={inputClass}
                    />
                    <button
                      type="button"
                      onClick={() => patch({ tunnels: form.tunnels.filter((_, j) => j !== i) })}
                      className="px-1 text-xs text-neutral-400 hover:text-red-500"
                      title="删除此隧道"
                    >
                      ✕
                    </button>
                  </div>
                  {row.type === 'dynamic' ? null : (
                    <div className="mt-2 grid grid-cols-[1fr_80px_auto] items-center gap-2">
                      <input
                        placeholder={row.type === 'local' ? '目标主机（远端视角）' : '目标主机（本机视角）'}
                        value={row.targetHost}
                        onChange={(e) => update({ targetHost: e.target.value })}
                        spellCheck={false}
                        className={inputClass}
                      />
                      <input
                        placeholder="端口"
                        value={row.targetPort}
                        onChange={(e) => update({ targetPort: e.target.value })}
                        inputMode="numeric"
                        className={inputClass}
                      />
                      <span className="text-[11px] text-neutral-400 dark:text-neutral-500">目标</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 日志：按天归档终端输出（阶段 7）；SSH 与 Telnet 都可用 */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              会话日志（按天归档到服务端，可在「日志」面板预览与下载）
            </span>
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                data-testid="session-log-enabled"
                checked={form.logEnabled}
                onChange={(e) => patch({ logEnabled: e.target.checked })}
              />
              启用
            </label>
          </div>
          {form.logEnabled ? (
            <div data-testid="session-log-config" className="mt-2 flex items-center gap-2">
              <select
                data-testid="session-log-format"
                value={form.logFormat}
                onChange={(e) => patch({ logFormat: e.target.value as LogFormat })}
                className={inputClass}
              >
                {LOG_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {LOG_FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {LOG_FORMAT_DESCRIPTION[form.logFormat]}
              </span>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="session-save"
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
