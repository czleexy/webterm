/**
 * 阶段 3：SFTP 相关的 REST 封装。
 *
 * 分工与后端的约定一致：
 * - 目录列举、文件操作、文本预览/保存 → REST（需要明确的成败返回）
 * - 传输进度 → WebSocket（服务端主动推送的持续事件流，见 useSftpStore）
 * - 浏览器 ↔ 远端 的大文件搬运 → 原始字节流（octet-stream / Range）
 */
import {
  API_PREFIX,
  type CreateSftpSessionRequest,
  type CreateSftpSessionResponse,
  type CreateTransferRequest,
  type CreateTransferResponse,
  type ListTransfersResponse,
  type SftpChmodRequest,
  type SftpEntry,
  type SftpListResponse,
  type SftpMkdirRequest,
  type SftpOpTarget,
  type SftpPreviewRequest,
  type SftpPreviewResponse,
  type SftpRemoveRequest,
  type SftpRenameRequest,
  type SftpSaveRequest,
  type SftpSaveResponse,
  type SftpSide,
  type TransferAction,
  type UploadStreamResponse,
} from '@webterm/shared'
import { request, resolveWsBase } from './client'

/** 所有 SFTP 接口共用的路径前缀 */
function base(sftpId: string): string {
  return `/sftp/sessions/${encodeURIComponent(sftpId)}`
}

/* ---------------- 会话 ---------------- */

export function createSftpSession(
  body: CreateSftpSessionRequest,
): Promise<CreateSftpSessionResponse> {
  return request<CreateSftpSessionResponse>('/sftp/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function closeSftpSession(sftpId: string): Promise<void> {
  return request<void>(base(sftpId), { method: 'DELETE' })
}

/* ---------------- 目录列举与文件操作 ---------------- */

export function listSftpDir(
  sftpId: string,
  side: SftpSide,
  path?: string,
): Promise<SftpListResponse> {
  const query = new URLSearchParams({ side })
  if (path) query.set('path', path)
  return request<SftpListResponse>(`${base(sftpId)}/list?${query.toString()}`)
}

export function mkdirSftp(body: SftpMkdirRequest, sftpId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${base(sftpId)}/mkdir`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function renameSftp(body: SftpRenameRequest, sftpId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${base(sftpId)}/rename`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function chmodSftp(body: SftpChmodRequest, sftpId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${base(sftpId)}/chmod`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 创建一个 0 字节文件（或把已存在文件的 mtime 更新为当前时间） */
export function touchSftp(body: SftpOpTarget, sftpId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${base(sftpId)}/touch`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function removeSftp(body: SftpRemoveRequest, sftpId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${base(sftpId)}/remove`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/* ---------------- 文本预览与远程编辑 ---------------- */

export function previewRemoteFile(
  sftpId: string,
  body: SftpPreviewRequest,
): Promise<SftpPreviewResponse> {
  return request<SftpPreviewResponse>(`${base(sftpId)}/preview`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function saveRemoteFile(
  sftpId: string,
  body: SftpSaveRequest,
): Promise<SftpSaveResponse> {
  return request<SftpSaveResponse>(`${base(sftpId)}/save`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/* ---------------- 传输队列 ---------------- */

export function listTransfers(sftpId: string): Promise<ListTransfersResponse> {
  return request<ListTransfersResponse>(`${base(sftpId)}/transfers`)
}

export function createTransfer(
  sftpId: string,
  body: CreateTransferRequest,
): Promise<CreateTransferResponse> {
  return request<CreateTransferResponse>(`${base(sftpId)}/transfers`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function transferAction(
  sftpId: string,
  taskId: string,
  action: TransferAction,
): Promise<{ task: unknown }> {
  return request<{ task: unknown }>(
    `${base(sftpId)}/transfers/${encodeURIComponent(taskId)}/${action}`,
    { method: 'POST' },
  )
}

export function removeTransfer(sftpId: string, taskId: string): Promise<void> {
  return request<void>(`${base(sftpId)}/transfers/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })
}

/* ---------------- WebSocket ---------------- */

/** 组装 SFTP 事件流的 WebSocket 地址（沿用终端那套一次性附加令牌） */
export function buildSftpWsUrl(wsPath: string, attachToken: string): string {
  return `${resolveWsBase()}${wsPath}?token=${encodeURIComponent(attachToken)}`
}

/* ---------------- 浏览器 ↔ 远端的原始字节流 ---------------- */

/** 直接下载远端文件（服务端支持 Range，浏览器可断点续传） */
export function remoteDownloadUrl(sftpId: string, path: string): string {
  return `${API_PREFIX}${base(sftpId)}/download?path=${encodeURIComponent(path)}`
}

/** 直接下载服务端本地面板的文件 */
export function localDownloadUrl(sftpId: string, path: string): string {
  return `${API_PREFIX}${base(sftpId)}/local/download?path=${encodeURIComponent(path)}`
}

export interface UploadProgress {
  loaded: number
  total: number
}

/**
 * 浏览器 → 远端 的文件上传。
 *
 * 用 XMLHttpRequest 而不是 fetch：只有 XHR 能拿到**上传方向**的进度事件
 * （fetch 的 ReadableStream 请求体虽然理论上可观测，但需要 duplex 支持，
 * 浏览器兼容性远不如 XHR 稳定）。同时 XHR 天然支持 abort()。
 */
export function uploadToRemote(
  sftpId: string,
  remotePath: string,
  file: Blob,
  options: { offset?: number; touch?: boolean; onProgress?: (p: UploadProgress) => void } = {},
): Promise<UploadStreamResponse> {
  const query = new URLSearchParams({ path: remotePath })
  if (options.offset && options.offset > 0) query.set('offset', String(options.offset))
  if (options.touch) query.set('touch', '1')

  return new Promise<UploadStreamResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_PREFIX}${base(sftpId)}/upload?${query.toString()}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.responseType = 'json'

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.({ loaded: event.loaded, total: event.total })
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as UploadStreamResponse)
        return
      }
      const payload = xhr.response as { message?: string } | null
      reject(new Error(payload?.message ?? `上传失败（HTTP ${xhr.status}）`))
    }
    xhr.onerror = () => reject(new Error('上传失败：网络错误'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    xhr.send(file)
  })
}

/** 从浏览器上传时用到的远端路径拼接（POSIX 语义，不能用 path 模块） */
export function posixJoinPosix(dir: string, name: string): string {
  if (!dir) return `/${name}`
  const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return trimmed === '' ? `/${name}` : `${trimmed}/${name}`
}

/** 供 UI 复用的类型出口，避免组件到处 import 共享包 */
export type { SftpEntry, SftpListResponse, SftpPreviewResponse }
