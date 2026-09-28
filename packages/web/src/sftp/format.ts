/** 文件面板与传输面板共用的格式化工具 */

/** 人类可读的字节数（二进制单位，与文件的真实占用一致） */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** 传输速度（字节/秒）；为 0 时显示占位符而不是 0 B/s，避免误以为卡住 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 剩余时间 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return '<1 秒'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 列表里的时间列：今天只显示时分，其余显示日期 */
export function formatMtime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—'
  const date = new Date(epochMs)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameYear = date.getFullYear() === now.getFullYear()
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return sameYear ? md : `${date.getFullYear()}-${md}`
}

/** 进度百分比；总大小未知（0）时返回 null，交给 UI 显示为不确定态 */
export function progressPercent(transferred: number, size: number): number | null {
  if (!size || size <= 0) return null
  const value = (transferred / size) * 100
  return Math.max(0, Math.min(100, value))
}

/** 路径最后一段（兼容 '/' 与 '\\'，两侧面板的路径分隔符不同） */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** 八进制权限文本，如 0o644 → '0644' */
export function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`
}
