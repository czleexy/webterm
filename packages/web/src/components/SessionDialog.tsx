/**
 * 会话编辑弹窗：创建/编辑会话库中的 SSH 会话。
 *
 * 结构：基本（名称/分组/主机/端口/用户名）→ 认证（凭据选择 + 内联新建）→
 * 终端（编码/TERM/算法兼容）→ 跳板链（逐跳配置，凭据同样引用保险库）。
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  CredentialSummary,
  LibraryNode,
  SessionRecord,
  SupportedEncoding,
} from '@webterm/shared'
import { SUPPORTED_ENCODINGS } from '@webterm/shared'
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
}

const EMPTY_FORM: SessionForm = {
  name: '',
  parentId: null,
  host: '',
  port: '22',
  username: 'root',
  credentialId: '',
  encoding: 'utf8',
  term: 'xterm-256color',
  legacyCompat: 'auto',
  jumpChain: [],
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
        name: editing.name,
        parentId: editing.parentId,
        host: s.host,
        port: String(s.port),
        username: s.username,
        credentialId: s.credentialId,
        encoding: s.encoding,
        term: s.term,
        legacyCompat: s.legacyCompat,
        jumpChain: s.jumpChain.map((h) => ({
          host: h.host,
          port: String(h.port),
          username: h.username,
          credentialId: h.credentialId,
        })),
      })
    } else {
      setForm({ ...EMPTY_FORM, parentId: defaultParentId })
    }
  }, [open, editing, defaultParentId])

  const patch = (p: Partial<SessionForm>) => setForm((f) => ({ ...f, ...p }))

  const credentialOptions = useMemo(() => {
    // 编辑态下，当前引用的凭据可能不在列表里（理论上不会，防御一下）
    return credentials
  }, [credentials])

  if (!open) return null

  const canSubmit =
    form.name.trim().length > 0 &&
    form.host.trim().length > 0 &&
    form.username.trim().length > 0 &&
    (newCred ? newCred.name.trim().length > 0 : form.credentialId !== '')

  const buildRecord = (credentialId: string): SessionRecord => ({
    host: form.host.trim(),
    port: Number.parseInt(form.port, 10) || 22,
    username: form.username.trim(),
    credentialId,
    encoding: form.encoding,
    term: form.term.trim() || 'xterm-256color',
    legacyCompat: form.legacyCompat,
    jumpChain: form.jumpChain.map((h) => ({
      host: h.host.trim(),
      port: Number.parseInt(h.port, 10) || 22,
      username: h.username.trim(),
      credentialId: h.credentialId,
    })),
  })

  const handleSubmit = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    setError(null)
    try {
      let credentialId = form.credentialId

      // 内联新建凭据：先创建再引用
      if (newCred) {
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
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {editing ? '编辑会话' : '新建会话'}
        </h2>

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
        </div>

        {/* 认证 */}
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

        {/* 终端设置 */}
        <div className="mt-4 grid grid-cols-3 gap-3">
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
        </div>

        {/* 跳板链 */}
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
