/**
 * 保险库门禁：首次使用引导设置主密码；日常使用要求解锁。
 *
 * 设计取舍：没有做「记住主密码」。
 * 主密码的职责是保护磁盘上的密文；把它存进浏览器 localStorage 等于把
 * 钥匙挂在锁上。解锁是低频操作（每次服务重启后一次），安全收益远大于便利损失。
 */
import { useState } from 'react'
import { ApiRequestError } from '../api/client'
import { useVaultStore } from '../store/useVaultStore'

const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition-colors focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500'

export function VaultGate({ children }: { children: React.ReactNode }) {
  const ready = useVaultStore((s) => s.ready)
  const status = useVaultStore((s) => s.status)
  const loadError = useVaultStore((s) => s.error)
  const refresh = useVaultStore((s) => s.refresh)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        正在连接服务…
      </div>
    )
  }

  // 状态查询失败：只提供重试，不展示设置/解锁表单。
  // 否则 status 为 null 会被当成「未初始化」，诱导用户重新设置主密码而覆盖已有保险库。
  if (!status) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
        <div
          data-testid="vault-unreachable"
          className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            无法连接服务端
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {loadError ?? '请确认服务端已启动，然后重试。'}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-4 w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  // 已解锁：直接进入应用
  if (status?.initialized && status?.unlocked) return <>{children}</>

  const isSetup = !status?.initialized

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (isSetup && password !== confirm) {
      setError('两次输入的主密码不一致')
      return
    }

    setBusy(true)
    try {
      const store = useVaultStore.getState()
      if (isSetup) await store.setup(password)
      else await store.unlock(password)
      setPassword('')
      setConfirm('')
      await refresh()
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : '操作失败',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
      <form
        onSubmit={submit}
        data-testid="vault-gate"
        className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {isSetup ? '设置主密码' : '解锁保险库'}
        </h1>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {isSetup
            ? '主密码用于加密保存的凭据（口令 / 私钥）。它不会上传，也不会明文落盘——请务必牢记，遗失后已存凭据将无法恢复。'
            : '服务重启后保险库处于锁定状态。输入主密码解锁后才能使用已保存的凭据与会话。'}
        </p>

        <div className="mt-4 space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? '主密码（至少 8 位）' : '主密码'}
            autoFocus
            required
            minLength={isSetup ? 8 : 1}
            className={inputClass}
          />
          {isSetup ? (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入主密码"
              required
              className={inputClass}
            />
          ) : null}
        </div>

        {error ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="mt-4 w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          {busy ? '处理中…' : isSetup ? '设置并解锁' : '解锁'}
        </button>
      </form>
    </div>
  )
}
