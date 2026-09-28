/**
 * 文本预览 / 远程编辑弹窗。
 *
 * 保存走「下载 → 编辑 → 回写」的经典远程编辑流程，并带一道 mtime 冲突检测：
 * 打开预览时记下远端 mtime，保存时带上；若期间文件被别人改过，
 * 服务端返回 409 而不是静默覆盖 —— 远程编辑最容易造成的数据丢失就是这一种。
 *
 * 被截断（超出预览上限）或二进制文件一律不给编辑，只做只读展示。
 */
import { useCallback, useEffect, useState } from 'react'
import type { SftpPreviewResponse } from '@webterm/shared'
import { previewRemoteFile, saveRemoteFile } from '../api/sftp'
import { ApiRequestError } from '../api/client'
import { cn } from '../utils/cn'
import { baseName, formatBytes, formatMode } from './format'

interface FileViewerProps {
  sftpId: string
  path: string
  onClose: () => void
  /** 保存成功后通知父组件刷新所在目录 */
  onSaved: () => void
}

export function FileViewer({ sftpId, path, onClose, onSaved }: FileViewerProps) {
  const [preview, setPreview] = useState<SftpPreviewResponse | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const result = await previewRemoteFile(sftpId, { path })
      setPreview(result)
      setContent(result.content)
      if (result.truncated) {
        setNotice(`文件已超过预览上限，仅展示前 ${formatBytes(result.content.length)}，不可直接保存。`)
      } else if (result.kind === 'binary') {
        setNotice(result.reason ?? '该文件是二进制格式，无法以文本方式编辑。')
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err))
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }, [path, sftpId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dirty = preview !== null && content !== preview.content
  const canSave = Boolean(preview?.editable) && dirty && !saving

  const handleSave = useCallback(async () => {
    if (!preview) return
    setSaving(true)
    setError(null)
    try {
      await saveRemoteFile(sftpId, {
        path,
        content,
        expectedMtime: preview.mtime,
        mode: preview.mode,
      })
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setError(
          `${err.message}\n文件在编辑期间被其他程序修改过。可先关闭本窗口重新打开确认内容，再决定是否覆盖。`,
        )
      } else {
        setError(err instanceof ApiRequestError ? err.message : String(err))
      }
    } finally {
      setSaving(false)
    }
  }, [content, onClose, onSaved, path, preview, sftpId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`编辑 ${baseName(path)}`}
        className="flex h-[80vh] w-full max-w-4xl flex-col rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {baseName(path)}
            {dirty ? <span className="ml-2 text-[11px] text-amber-600 dark:text-amber-400">未保存</span> : null}
          </h2>
          <span className="shrink-0 font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            {path}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-6 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {notice ? (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div className="shrink-0 whitespace-pre-wrap border-b border-red-200 bg-red-50 px-4 py-1.5 text-[11px] leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          {loading ? (
            <p className="p-4 text-xs text-neutral-400">读取中…</p>
          ) : preview?.kind === 'binary' ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-300">二进制文件</p>
              <p className="max-w-md text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                无法以文本方式展示或编辑。可在文件列表里选中后下载到本地，用对应的工具打开。
              </p>
            </div>
          ) : (
            <textarea
              value={content}
              readOnly={!preview?.editable}
              spellCheck={false}
              onChange={(e) => setContent(e.target.value)}
              className={cn(
                'size-full resize-none border-0 p-3 font-mono text-[11px] leading-relaxed outline-none',
                preview?.editable
                  ? 'bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                  : 'bg-neutral-50 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
              )}
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
            {preview ? `${formatBytes(preview.size)} · ${formatMode(preview.mode)}` : ''}
            {preview?.encoding === 'latin1' ? ' · 非 UTF-8，按 Latin-1 展示' : ''}
          </span>
          <span className="ml-auto" />
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            重新载入
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
          <button
            type="button"
            data-testid="sftp-save"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
