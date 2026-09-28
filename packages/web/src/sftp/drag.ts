/**
 * 双栏之间的拖拽协议。
 *
 * 用自定义 MIME 而不是 text/plain：浏览器窗口内拖动时我们搬运的是
 * 「某一个面板里的哪些路径」，而 text/plain 会被系统里的其它拖放源
 * （比如从记事本拖一段文字）污染，导致误判为一次文件传输。
 */
import type { SftpSide } from '@webterm/shared'

export const SFTP_DRAG_MIME = 'application/x-webterm-sftp'

export interface SftpDragPayload {
  /** 源面板所在的一侧 */
  side: SftpSide
  /** 源面板里被选中的绝对路径 */
  paths: string[]
}

export function setDragPayload(dt: DataTransfer, payload: SftpDragPayload): void {
  try {
    dt.setData(SFTP_DRAG_MIME, JSON.stringify(payload))
    // 某些浏览器会因为没有 text/plain 而拒绝启动拖拽，补一个兜底
    dt.setData('text/plain', payload.paths.join('\n'))
  } catch {
    /* 忽略：不影响主流程 */
  }
  dt.effectAllowed = 'copy'
}

export function readDragPayload(dt: DataTransfer): SftpDragPayload | null {
  let raw = ''
  try {
    raw = dt.getData(SFTP_DRAG_MIME)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SftpDragPayload>
    if (parsed.side !== 'local' && parsed.side !== 'remote') return null
    if (!Array.isArray(parsed.paths) || parsed.paths.length === 0) return null
    const paths = parsed.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (paths.length === 0) return null
    return { side: parsed.side, paths }
  } catch {
    return null
  }
}

/**
 * 判断这次拖放是否携带了**操作系统文件**（从桌面/资源管理器拖进来）。
 * 这类拖放走浏览器上传通道（octet-stream），而不是服务端内部的复制。
 */
export function hasOsFiles(dt: DataTransfer): boolean {
  if (dt.types.includes(SFTP_DRAG_MIME)) return false
  if (dt.files.length > 0) return true
  return Array.from(dt.types).includes('Files')
}
