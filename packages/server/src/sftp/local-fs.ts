/**
 * 本地文件系统访问（受限于配置的根目录）。
 *
 * 「本地」指的是**服务端进程所在的机器**。WebTerm 的典型部署是把服务跑在
 * 自己的机器上、用浏览器访问 localhost，此时这一侧就是用户的本地磁盘，
 * 双栏拖拽的体验与桌面客户端一致。
 *
 * 所有路径都必须先过 LocalGuard：既做词法检查（`..` 逃逸），
 * 也做物理检查（指向根目录之外的符号链接）。
 */
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  readdir as fsReaddir,
  readlink as fsReadlink,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  utimes as fsUtimes,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { createReadStream as fsCreateReadStream, createWriteStream as fsCreateWriteStream } from 'node:fs'
import type { ReadStream, WriteStream } from 'node:fs'
import path from 'node:path'
import type { SftpEntry } from '@webterm/shared'
import { classifySftpError, SftpError } from './errors.js'
import { formatMode, permissionHints, type LocalGuard } from './paths.js'

/** 单个目录列举时并发 stat 的上限，避免上万文件时打爆文件描述符 */
const STAT_CONCURRENCY = 64

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

function toEntry(name: string, parent: string, stats: import('node:fs').Stats): SftpEntry {
  const type: SftpEntry['type'] = stats.isDirectory()
    ? 'dir'
    : stats.isSymbolicLink()
      ? 'link'
      : stats.isFile()
        ? 'file'
        : 'other'
  const rawMode = stats.mode & 0o7777
  const hints = permissionHints(rawMode)
  return {
    name,
    path: path.join(parent, name),
    type,
    size: stats.size,
    mtime: stats.mtimeMs,
    mode: rawMode,
    modeText: formatMode(rawMode, type),
    readable: hints.readable,
    writable: hints.writable,
  }
}

export class LocalFs {
  constructor(private readonly guard: LocalGuard) {}

  get root(): string {
    return this.guard.root
  }

  /** 根目录本身作为初始位置 */
  get home(): string {
    return this.guard.root
  }

  async list(input?: string): Promise<{ path: string; entries: SftpEntry[] }> {
    let target: string
    try {
      target = await this.guard.resolvePhysical(input)
    } catch (err) {
      throw classifySftpError(err, '列目录失败')
    }

    const stats = await fsLstat(target)
    if (!stats.isDirectory()) {
      throw new SftpError('WRONG_TYPE', `不是目录：${target}`)
    }

    const dirents = await fsReaddir(target, { withFileTypes: true })
    const entries = await mapLimit(dirents, STAT_CONCURRENCY, async (dirent) => {
      const full = path.join(target, dirent.name)
      try {
        // 用 lstat：软链接本身作为一个条目展示，不跟随其指向
        const entryStats = await fsLstat(full)
        const entry = toEntry(dirent.name, target, entryStats)
        if (entry.type === 'link') {
          try {
            entry.target = await fsReadlink(full)
          } catch {
            /* 忽略无法读取的链接 */
          }
        }
        return entry
      } catch {
        return null // 列举期间被删除的条目
      }
    })

    return { path: target, entries: entries.filter((e): e is SftpEntry => e !== null) }
  }

  async stat(input: string): Promise<SftpEntry> {
    const target = await this.guard.resolvePhysical(input)
    const stats = await fsLstat(target)
    return toEntry(path.basename(target), path.dirname(target), stats)
  }

  /** 目标是否存在及其大小（用于续传判定），不存在返回 null */
  async sizeOf(input: string): Promise<number | null> {
    let target: string
    try {
      target = this.guard.resolve(input)
    } catch {
      return null
    }
    try {
      const stats = await fsStat(target)
      return stats.isFile() ? stats.size : null
    } catch {
      return null
    }
  }

  async exists(input: string): Promise<boolean> {
    try {
      const target = await this.guard.resolvePhysical(input)
      await access(target, fsConstants.F_OK)
      return true
    } catch {
      return false
    }
  }

  async mkdir(input: string): Promise<void> {
    const target = await this.guard.resolveParentPhysical(input)
    try {
      await fsMkdir(target)
    } catch (err) {
      throw classifySftpError(err, '创建本地目录失败')
    }
  }

  async mkdirp(input: string): Promise<void> {
    const target = this.guard.resolve(input)
    // 逐级检查而不是直接 recursive:true —— 后者会顺带创建词法之外的父目录
    const parts = path.relative(this.guard.root, target)
    let current = this.guard.root
    for (const segment of parts.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      const inside = this.guard.resolve(current)
      try {
        await fsMkdir(inside)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code !== 'EEXIST') throw classifySftpError(err, '创建本地目录失败')
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.guard.resolvePhysical(from)
    const dst = await this.guard.resolveParentPhysical(to)
    try {
      await fsRename(src, dst)
    } catch (err) {
      throw classifySftpError(err, '重命名失败')
    }
  }

  async chmod(input: string, mode: number): Promise<void> {
    const target = await this.guard.resolvePhysical(input)
    try {
      await fsChmod(target, mode)
    } catch (err) {
      throw classifySftpError(err, '修改本地权限失败')
    }
  }

  async utimes(input: string, atime: Date, mtime: Date): Promise<void> {
    const target = await this.guard.resolveParentPhysical(input)
    try {
      await fsUtimes(target, atime, mtime)
    } catch (err) {
      throw classifySftpError(err, '设置本地时间失败')
    }
  }

  /** 递归删除（force + recursive）。根目录本身不允许删除 */
  async remove(input: string): Promise<void> {
    const target = await this.guard.resolvePhysical(input)
    if (target === this.guard.root) {
      throw new SftpError('PERMISSION_DENIED', '不允许删除本地根目录本身', {
        hint: `本地面板的根目录是 ${this.guard.root}，如需更换请调整 WEBTERM_LOCAL_ROOT。`,
      })
    }
    try {
      await fsRm(target, { recursive: true, force: true })
    } catch (err) {
      throw classifySftpError(err, '删除失败')
    }
  }

  /**
   * 创建/更新文件的修改时间（touch）。
   * 不存在时先建空文件，与 `touch` 命令行为一致。
   */
  async touch(input: string): Promise<void> {
    const target = await this.guard.resolveParentPhysical(input)
    try {
      const now = new Date()
      const handle = await fsOpen(target, 'a')
      await handle.close()
      await fsUtimes(target, now, now)
    } catch (err) {
      throw classifySftpError(err, '创建文件失败')
    }
  }

  createReadStream(input: string, opts: { start?: number; end?: number } = {}): ReadStream {
    const target = this.guard.resolve(input)
    return fsCreateReadStream(target, opts)
  }

  createWriteStream(input: string, opts: { flags?: string; start?: number } = {}): WriteStream {
    const target = this.guard.resolve(input)
    return fsCreateWriteStream(target, opts)
  }

  async readHead(input: string, maxBytes: number): Promise<Buffer> {
    const target = await this.guard.resolvePhysical(input)
    const limit = Math.max(1, Math.floor(maxBytes))
    return new Promise<Buffer>((resolve, reject) => {
      const stream = fsCreateReadStream(target, { start: 0, end: limit - 1 })
      const chunks: Buffer[] = []
      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', (err) => reject(classifySftpError(err, '读取本地文件失败')))
    })
  }

  async writeFile(input: string, data: Buffer, mode?: number): Promise<void> {
    const target = await this.guard.resolveParentPhysical(input)
    try {
      await fsWriteFile(target, data, mode === undefined ? {} : { mode })
    } catch (err) {
      throw classifySftpError(err, '写入本地文件失败')
    }
  }

  /** 递归聚合目录大小与文件数，用于传输任务的进度分母 */
  async measure(input: string, depth = 0): Promise<{ size: number; files: number }> {
    if (depth > 64) return { size: 0, files: 0 }
    const target = await this.guard.resolvePhysical(input)
    const stats = await fsLstat(target)
    if (!stats.isDirectory()) return { size: stats.size, files: 1 }

    const dirents = await fsReaddir(target, { withFileTypes: true })
    let size = 0
    let files = 0
    for (const dirent of dirents) {
      const child = path.join(target, dirent.name)
      if (dirent.isSymbolicLink()) continue // 不跟随符号链接，避免环路与越界
      const measured = await this.measure(child, depth + 1)
      size += measured.size
      files += measured.files
    }
    return { size, files }
  }

  /** 目录树快照（相对路径 + 大小），供传输队列展开 */
  async walk(
    input: string,
    depth = 0,
  ): Promise<Array<{ abs: string; rel: string; size: number; isDir: boolean; mode: number }>> {
    if (depth > 64) return []
    const target = await this.guard.resolvePhysical(input)
    const stats = await fsLstat(target)
    if (!stats.isDirectory()) {
      return [
        {
          abs: target,
          rel: path.basename(target),
          size: stats.size,
          isDir: false,
          mode: stats.mode & 0o7777,
        },
      ]
    }

    const out: Array<{ abs: string; rel: string; size: number; isDir: boolean; mode: number }> = []
    const dirents = await fsReaddir(target, { withFileTypes: true })
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue
      const child = path.join(target, dirent.name)
      const childStats = await fsLstat(child)
      if (childStats.isDirectory()) {
        out.push({
          abs: child,
          rel: dirent.name,
          size: 0,
          isDir: true,
          mode: childStats.mode & 0o7777,
        })
        const nested = await this.walk(child, depth + 1)
        for (const item of nested) {
          out.push({ ...item, rel: path.join(dirent.name, item.rel) })
        }
      } else if (childStats.isFile()) {
        out.push({
          abs: child,
          rel: dirent.name,
          size: childStats.size,
          isDir: false,
          mode: childStats.mode & 0o7777,
        })
      }
    }
    return out
  }
}
