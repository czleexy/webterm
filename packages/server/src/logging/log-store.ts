/**
 * 日志文件存储：列出、按行预览、下载路径解析、删除与保留清理。
 *
 * 预览的关键是**行偏移索引**：直接按行号窗口读取 100 MB 的文件，
 * 不能每次请求都从头扫一遍。首次预览时把整个文件扫一遍，记下每行的
 * 起始字节偏移，之后任意窗口都是一次 seek + read。
 *
 * 扫描按字节找 `\n`（0x0A）是安全的：UTF-8 的多字节序列里不会出现 0x0A，
 * 因此按字节切行不会把多字节字符劈开。索引按文件大小 + mtime 失效，
 * 并用小容量 LRU 缓存。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { LogFileInfo, LogFormat, LogPreviewResponse } from '@webterm/shared'
import {
  LOG_PREVIEW_INDEX_CACHE,
  LOG_PREVIEW_MAX_LINE_CHARS,
  LOG_PREVIEW_MAX_LINES,
} from '@webterm/shared'
import type { TerminalLogger } from '../terminal/terminal-session.js'

/** 单个文件的行偏移索引 */
interface LineIndex {
  sizeBytes: number
  mtimeMs: number
  /** 每行起始字节偏移；totalLines = offsets.length（最后一行以文件结尾计） */
  offsets: number[]
}

const SCAN_CHUNK_BYTES = 1024 * 1024

export interface LogStoreOptions {
  logsRoot: string
  /** 目录名 → 会话库节点 id 的映射（设置里持久化），用于回显会话名 */
  dirToSession?: () => Record<string, { sessionId: string; sessionName: string }>
  logger: TerminalLogger
}

/** 日志路径相关的错误（REST 层转 400/404） */
export class LogStoreError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_PATH' | 'IO',
    message: string,
  ) {
    super(message)
  }
}

export class LogStore {
  /** 简易 LRU：插入序即使用序，超限时逐出最旧 */
  private readonly indexCache = new Map<string, LineIndex>()

  constructor(private readonly opts: LogStoreOptions) {}

  /** 日志根目录（写入器与路由需要落点） */
  get root(): string {
    return this.opts.logsRoot
  }

  /* ---------------------------------------------------------------- */
  /* 列表                                                              */
  /* ---------------------------------------------------------------- */

  list(filter: { sessionId?: string; date?: string }): LogFileInfo[] {
    const root = this.opts.logsRoot
    let dirs: string[] = []
    try {
      dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }

    const dirMap = this.opts.dirToSession?.() ?? {}
    const files: LogFileInfo[] = []
    for (const dir of dirs) {
      // 目录名带短哈希（`name-ab12cd`），映射表里以完整目录名为键
      const meta = dirMap[dir]
      if (filter.sessionId && meta?.sessionId !== filter.sessionId) continue

      let names: string[] = []
      try {
        names = fs.readdirSync(path.join(root, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.log') && !name.endsWith('.html')) continue
        if (name.endsWith('.tmp')) continue
        const absolute = path.join(root, dir, name)
        let stat: fs.Stats
        try {
          stat = fs.statSync(absolute)
        } catch {
          continue
        }
        if (!stat.isFile()) continue

        const date = extractDate(name) ?? formatDay(stat.mtimeMs)
        if (filter.date && date !== filter.date) continue

        files.push({
          id: `${dir}/${name}`,
          sessionDir: dir,
          sessionId: meta?.sessionId,
          sessionName: meta?.sessionName ?? dir,
          date,
          format: name.endsWith('.html') ? 'html' : guessFormat(name, absolute),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        })
      }
    }
    files.sort((a, b) => (a.sessionDir === b.sessionDir ? b.date.localeCompare(a.date) : a.sessionDir.localeCompare(b.sessionDir)))
    return files
  }

  /* ---------------------------------------------------------------- */
  /* 预览                                                              */
  /* ---------------------------------------------------------------- */

  async preview(id: string, start: number, count: number): Promise<LogPreviewResponse> {
    const absolute = this.resolve(id)
    const index = await this.lineIndex(id, absolute)
    const total = index.offsets.length

    const first = Math.max(0, Math.min(start, total - 1))
    const last = Math.min(total, first + Math.max(1, Math.min(count, LOG_PREVIEW_MAX_LINES)))

    let text: string
    try {
      text = await readRange(absolute, index.offsets[first] ?? 0, index.offsets[last] ?? null)
    } catch (err) {
      throw new LogStoreError('IO', `读取日志失败：${err instanceof Error ? err.message : String(err)}`)
    }

    let truncatedLines = 0
    const lines = text
      .split('\n')
      .map((line) => {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line
        if (clean.length > LOG_PREVIEW_MAX_LINE_CHARS) {
          truncatedLines += 1
          return `${clean.slice(0, LOG_PREVIEW_MAX_LINE_CHARS)} …（超长行截断显示）`
        }
        return clean
      })
    // readRange 读到下一行行首为止，最后一段是「下一行的内容」，去掉
    if (last < total) lines.pop()
    // 行数撑满 total 时 split 的最后一个空串是文件末尾换行的产物
    if (last >= total && lines[lines.length - 1] === '') lines.pop()

    return {
      id,
      sizeBytes: index.sizeBytes,
      totalLines: total,
      start: first,
      lines,
      truncatedLines,
    }
  }

  /**
   * 构建或复用行偏移索引。
   * 扫描按字节进行：`\n`（0x0A）不会出现在任何 UTF-8 多字节序列内部。
   */
  private async lineIndex(id: string, absolute: string): Promise<LineIndex> {
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(absolute)
    } catch {
      throw new LogStoreError('NOT_FOUND', '日志文件不存在或已被清理')
    }
    const cached = this.indexCache.get(id)
    if (cached && cached.sizeBytes === stat.size && cached.mtimeMs === stat.mtimeMs) {
      // 刷新 LRU 使用序
      this.indexCache.delete(id)
      this.indexCache.set(id, cached)
      return cached
    }

    const handle = await fs.promises.open(absolute, 'r')
    try {
      const offsets: number[] = [0]
      let offset = 0
      const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, SCAN_CHUNK_BYTES, offset)
        if (bytesRead === 0) break
        let from = 0
        for (;;) {
          const at = buffer.subarray(0, bytesRead).indexOf(0x0a, from)
          if (at === -1) break
          offsets.push(offset + at + 1)
          from = at + 1
        }
        offset += bytesRead
        if (bytesRead < SCAN_CHUNK_BYTES) break
      }

      const index: LineIndex = {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        offsets,
      }
      this.indexCache.set(id, index)
      while (this.indexCache.size > LOG_PREVIEW_INDEX_CACHE) {
        const oldest = this.indexCache.keys().next().value
        if (oldest === undefined) break
        this.indexCache.delete(oldest)
      }
      return index
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /* ---------------------------------------------------------------- */
  /* 删除与路径安全                                                     */
  /* ---------------------------------------------------------------- */

  async remove(id: string): Promise<void> {
    const absolute = this.resolve(id)
    try {
      await fs.promises.unlink(absolute)
    } catch {
      /* 已不存在视为删除成功 */
    }
    this.indexCache.delete(id)
  }

  /** 删除整个会话目录；返回删除的文件数 */
  async removeSessionDir(dir: string): Promise<number> {
    if (dir.includes('/') || dir.includes('\\') || dir === '.' || dir === '..') {
      throw new LogStoreError('INVALID_PATH', '目录名不合法')
    }
    const absolute = path.join(this.opts.logsRoot, dir)
    let names: string[] = []
    try {
      names = await fs.promises.readdir(absolute)
    } catch {
      return 0
    }
    let count = 0
    for (const name of names) {
      try {
        await fs.promises.unlink(path.join(absolute, name))
        count += 1
      } catch {
        /* 忽略单个失败 */
      }
    }
    try {
      await fs.promises.rmdir(absolute)
    } catch {
      /* 非空目录留着 */
    }
    for (const key of [...this.indexCache.keys()]) {
      if (key.startsWith(`${dir}/`)) this.indexCache.delete(key)
    }
    return count
  }

  /** 校验 id 并解析为日志根目录内的绝对路径（下载与删除共用） */
  resolveFile(id: string): string {
    const normalized = path.posix.normalize(id)
    if (
      normalized === '' ||
      normalized.startsWith('/') ||
      normalized.startsWith('..') ||
      normalized.includes('\\')
    ) {
      throw new LogStoreError('INVALID_PATH', '日志路径不合法')
    }
    const absolute = path.resolve(this.opts.logsRoot, normalized)
    const root = path.resolve(this.opts.logsRoot)
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new LogStoreError('INVALID_PATH', '日志路径越出日志根目录')
    }
    return absolute
  }

  private resolve(id: string): string {
    return this.resolveFile(id)
  }

  /* ---------------------------------------------------------------- */
  /* 保留清理                                                          */
  /* ---------------------------------------------------------------- */

  /** 删除修改时间早于保留期的文件；返回删除的文件数 */
  async sweepExpired(retentionDays: number): Promise<number> {    if (retentionDays <= 0) return 0
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const root = this.opts.logsRoot
    let dirs: string[] = []
    try {
      dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return 0
    }

    let removed = 0
    for (const dir of dirs) {
      let names: string[] = []
      try {
        names = await fs.promises.readdir(path.join(root, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.log') && !name.endsWith('.html')) continue
        const absolute = path.join(root, dir, name)
        try {
          const stat = await fs.promises.stat(absolute)
          if (stat.mtimeMs < cutoff) {
            await fs.promises.unlink(absolute)
            removed += 1
          }
        } catch {
          /* 忽略单个失败 */
        }
      }
      // 目录空了就顺带删掉，避免日志列表里堆出空壳会话
      try {
        await fs.promises.rmdir(path.join(root, dir))
      } catch {
        /* 非空：正常 */
      }
    }
    return removed
  }
}

/* ------------------------------------------------------------------ */
/* 助手                                                                */
/* ------------------------------------------------------------------ */

function extractDate(name: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(name)
  return match?.[1] ?? null
}

function formatDay(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString().slice(0, 10)
}

/** 从文件头嗅探格式：内容以 `<!doctype` / `<html` 开头即 html（扩展名丢失时的兜底） */
function guessFormat(name: string, absolute: string): LogFormat {
  if (name.endsWith('.html')) return 'html'
  try {
    const fd = fs.openSync(absolute, 'r')
    try {
      const head = Buffer.alloc(64)
      const bytesRead = fs.readSync(fd, head, 0, 64, 0)
      const text = head.subarray(0, bytesRead).toString('utf8').trimStart().toLowerCase()
      if (text.startsWith('<!doctype') || text.startsWith('<html')) return 'html'
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* 读不到就按扩展名 */
  }
  return 'plain'
}

/** 读取 [start, end) 字节区间；end 为 null 读到文件尾 */
async function readRange(absolute: string, start: number, end: number | null): Promise<string> {
  const handle = await fs.promises.open(absolute, 'r')
  try {
    const stat = await handle.stat()
    const from = Math.min(start, stat.size)
    const to = end === null ? stat.size : Math.min(end, stat.size)
    if (to <= from) return ''
    const buffer = Buffer.allocUnsafe(to - from)
    await handle.read(buffer, 0, buffer.length, from)
    return buffer.toString('utf8')
  } finally {
    await handle.close().catch(() => {})
  }
}
