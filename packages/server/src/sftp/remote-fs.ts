/**
 * 远端文件系统访问（SFTP）。
 *
 * 把 ssh2 的回调式 SFTPWrapper 包装成 Promise 接口，并统一做三件事：
 * 1. 路径归一化与绝对性校验（见 paths.ts）
 * 2. 错误归一为 SftpError
 * 3. 把 SFTP 的 `Stats` 转成前端可直接消费的 SftpEntry
 *
 * 独立于 SftpSession 是为了让传输队列只依赖「一个能拿到 SFTPWrapper 的函数」，
 * 而不关心连接是怎么建立、如何重建的。
 */
import type { SFTPWrapper, Stats, ReadStream, WriteStream } from 'ssh2'
import type { SftpEntry } from '@webterm/shared'
import { classifySftpError, SftpError } from './errors.js'
import {
  assertRemotePath,
  formatMode,
  permissionHints,
  posixBasename,
  posixJoin,
} from './paths.js'

export type SftpProvider = () => Promise<SFTPWrapper>

/** 把回调式 API 包成 Promise，并把错误归一 */
function promisify<T>(
  label: string,
  run: (cb: (err: Error | undefined | null, result: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      run((err, result) => {
        if (err) reject(classifySftpError(err, `${label}失败`))
        else resolve(result)
      })
    } catch (err) {
      reject(classifySftpError(err, `${label}失败`))
    }
  })
}

function typeOf(stats: Stats): SftpEntry['type'] {
  if (stats.isDirectory()) return 'dir'
  if (stats.isSymbolicLink()) return 'link'
  if (stats.isFile()) return 'file'
  return 'other'
}

function toEntry(name: string, dir: string, stats: Stats, target?: string): SftpEntry {
  const type = typeOf(stats)
  const mode = typeof stats.mode === 'number' ? stats.mode : 0
  const rawMode = mode & 0o7777
  const hints = permissionHints(rawMode)
  return {
    name,
    path: posixJoin(dir, name),
    type,
    size: typeof stats.size === 'number' ? stats.size : 0,
    mtime: typeof stats.mtime === 'number' ? stats.mtime * 1000 : 0,
    mode: rawMode,
    modeText: formatMode(rawMode, type),
    ...(target ? { target } : {}),
    readable: hints.readable,
    writable: hints.writable,
  }
}

export class RemoteFs {
  constructor(private readonly provider: SftpProvider) {}

  /** 直接拿到包装器，供需要自定义选项的调用方（如传输队列）使用 */
  get wrapper(): Promise<SFTPWrapper> {
    return this.provider()
  }

  /**
   * 解析远端真实路径。
   *
   * 这里是**唯一**允许传入相对路径的地方：`realpath('.')` 是向远端询问
   * 「我登录后的工作目录/家目录」的标准手段，而返回值必是绝对路径。
   * 结果仍然要过绝对性校验，因为少数服务端会把相对路径原样回给我们。
   */
  async realpath(input: string): Promise<string> {
    if (typeof input !== 'string' || input.length === 0) {
      throw new SftpError('INVALID_PATH', '路径不能为空')
    }
    const sftp = await this.provider()
    const real = await promisify<string>('解析远端真实路径', (cb) => sftp.realpath(input, cb))
    return assertRemotePath(real)
  }

  async stat(input: string): Promise<{ entry: SftpEntry; stats: Stats }> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    const stats = await promisify<Stats>('查询远端属性', (cb) => sftp.stat(target, cb))
    return { entry: toEntry(posixBasename(target), posixParentOf(target), stats), stats }
  }

  async lstat(input: string): Promise<{ entry: SftpEntry; stats: Stats }> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    const stats = await promisify<Stats>('查询远端属性', (cb) => sftp.lstat(target, cb))
    return { entry: toEntry(posixBasename(target), posixParentOf(target), stats), stats }
  }

  /** 目标是否已存在；用于覆盖检查 */
  async exists(input: string): Promise<boolean> {
    try {
      await this.lstat(input)
      return true
    } catch (err) {
      if (err instanceof SftpError && err.code === 'NOT_FOUND') return false
      throw err
    }
  }

  /**
   * 已存在的普通文件大小；不存在或不是文件时返回 null。
   * 用于断点续传：从已写入的字节数继续，而不是重新传一遍。
   */
  async sizeOf(input: string): Promise<number | null> {
    try {
      const { stats } = await this.lstat(input)
      return stats.isFile() ? stats.size : null
    } catch (err) {
      if (err instanceof SftpError && err.code === 'NOT_FOUND') return null
      return null
    }
  }

  /**
   * 列举目录。
   *
   * 优先使用 readdir 一次拿回条目自带的 attrs（OpenSSH 会附带 lstat 结果），
   * 只在 attrs 缺少关键字段时才逐个补 lstat —— 大目录下逐个 stat 会让
   * 列举耗时线性增长，能省则省。
   */
  async list(input: string): Promise<{ path: string; entries: SftpEntry[] }> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()

    const { stats } = await this.stat(target)
    if (!stats.isDirectory()) {
      throw new SftpError('WRONG_TYPE', `不是目录：${target}`)
    }

    const raw = await promisify<Array<{ filename: string; attrs?: Stats }>>(
      '列举远端目录',
      (cb) => sftp.readdir(target, cb),
    )

    const entries: SftpEntry[] = []
    for (const item of raw) {
      if (item.filename === '.' || item.filename === '..') continue
      let attrs = item.attrs
      if (!attrs || attrs.mode === undefined || attrs.size === undefined) {
        // 少数服务端（含部分嵌入式设备）不在 READDIR 响应里带属性
        try {
          attrs = await promisify<Stats>('查询远端属性', (cb) =>
            sftp.lstat(posixJoin(target, item.filename), cb),
          )
        } catch {
          continue // 列举期间被删除的条目：跳过而不是整体失败
        }
      }
      entries.push(toEntry(item.filename, target, attrs))
    }

    await this.attachLinkTargets(entries)
    return { path: target, entries }
  }

  /** 为符号链接补上指向目标；数量过多时跳过，避免几十次串行往返 */
  private async attachLinkTargets(entries: SftpEntry[]): Promise<void> {
    const links = entries.filter((e) => e.type === 'link')
    if (links.length === 0 || links.length > 50) return
    const sftp = await this.provider()
    await Promise.all(
      links.map(async (entry) => {
        try {
          const target = await promisify<string>('读取链接指向', (cb) =>
            sftp.readlink(entry.path, cb),
          )
          entry.target = target
        } catch {
          /* 链接可能已失效，忽略 */
        }
      }),
    )
  }

  async mkdir(input: string, mode?: number): Promise<void> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    await promisify<void>('创建远端目录', (cb) =>
      sftp.mkdir(target, mode === undefined ? {} : { mode }, cb),
    )
  }

  /** 逐级创建目录（等价 mkdir -p） */
  async mkdirp(input: string): Promise<void> {
    const target = assertRemotePath(input)
    if (target === '/') return
    const segments = target.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      try {
        await this.mkdir(current)
      } catch (err) {
        // 已存在就继续（并发创建或多级已存在都属于正常情况）
        if (err instanceof SftpError && (err.code === 'ALREADY_EXISTS' || err.code === 'PERMISSION_DENIED')) {
          // PERMISSION_DENIED 也可能是「已存在但不可读」，这里用 stat 复核一次
          try {
            await this.stat(current)
            continue
          } catch {
            throw err
          }
        }
        if (err instanceof SftpError && err.code === 'IO') {
          try {
            await this.stat(current)
            continue
          } catch {
            throw err
          }
        }
        throw err
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const a = assertRemotePath(from)
    const b = assertRemotePath(to)
    const sftp = await this.provider()
    await promisify<void>('重命名远端路径', (cb) => sftp.rename(a, b, cb))
  }

  async chmod(input: string, mode: number): Promise<void> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    await promisify<void>('修改远端权限', (cb) => sftp.chmod(target, mode, cb))
  }

  async utimes(input: string, atime: Date, mtime: Date): Promise<void> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    await promisify<void>('设置远端时间', (cb) => sftp.utimes(target, atime, mtime, cb))
  }

  async unlink(input: string): Promise<void> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    await promisify<void>('删除远端文件', (cb) => sftp.unlink(target, cb))
  }

  async rmdir(input: string): Promise<void> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    await promisify<void>('删除远端目录', (cb) => sftp.rmdir(target, cb))
  }

  /** 递归删除。深度优先，先删子树再删自身，返回删除的条目数 */
  async removeRecursive(input: string, depth = 0): Promise<number> {
    const target = assertRemotePath(input)
    if (depth > 64) {
      throw new SftpError('IO', `目录层级过深，已中止删除：${target}`)
    }
    const { stats } = await this.lstat(target)
    if (!stats.isDirectory()) {
      await this.unlink(target)
      return 1
    }

    let removed = 0
    const { entries } = await this.list(target)
    for (const entry of entries) {
      if (entry.type === 'link') {
        // 符号链接本身是文件，删除链接不会跟随其指向
        await this.unlink(entry.path)
        removed += 1
        continue
      }
      removed += await this.removeRecursive(entry.path, depth + 1)
    }
    await this.rmdir(target)
    return removed + 1
  }

  createReadStream(input: string, opts: { start?: number; end?: number } = {}): Promise<ReadStream> {
    const target = assertRemotePath(input)
    return this.provider().then((sftp) => sftp.createReadStream(target, opts))
  }

  createWriteStream(
    input: string,
    opts: { flags?: string; mode?: number; start?: number },
  ): Promise<WriteStream> {
    const target = assertRemotePath(input)
    return this.provider().then((sftp) =>
      // ssh2 的选项类型用字面量联合约束 flags，这里按需收窄
      sftp.createWriteStream(target, opts as Parameters<SFTPWrapper['createWriteStream']>[1]),
    )
  }

  /** 读取文件开头若干字节，用于文本预览 */
  async readHead(input: string, maxBytes: number): Promise<Buffer> {
    const limit = Math.max(1, Math.floor(maxBytes))
    // 用普通读流而不是 readFile：readFile 的 length 选项依赖服务端对
    // SSH_FILEXFER_ATTR 的处理，而带 end 的读流在各实现上行为一致。
    const stream = await this.createReadStream(input, { start: 0, end: limit - 1 })
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', (err: Error) => reject(classifySftpError(err, '读取远端文件失败')))
    })
  }

  /** 整体写入（用于保存编辑结果） */
  async writeFile(input: string, data: Buffer, mode?: number): Promise<void> {
    const target = assertRemotePath(input)
    const sftp = await this.provider()
    await promisify<void>('写入远端文件', (cb) =>
      sftp.writeFile(target, data, mode === undefined ? {} : { mode }, cb),
    )
  }
}

/** 远端路径的父目录（POSIX 语义） */
function posixParentOf(input: string): string {
  const idx = input.lastIndexOf('/')
  if (idx <= 0) return '/'
  return input.slice(0, idx)
}
