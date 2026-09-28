/**
 * 路径处理与安全校验。
 *
 * 远端一律使用 POSIX 语义（Node 的 `path` 在 Windows 上会把 `\` 当分隔符，
 * 所以远端路径**绝不能**用 `path` 模块处理）。
 * 本地侧使用平台语义，但必须被约束在配置的根目录内。
 */
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { realpath as fsRealpath } from 'node:fs/promises'
import { SftpError } from './errors.js'

/* ------------------------------------------------------------------ */
/* 远端（POSIX）                                                        */
/* ------------------------------------------------------------------ */

/**
 * 归一化一个 POSIX 路径：折叠 `.` / `..` / 重复斜杠，保留前导斜杠。
 * 与 `path.posix.normalize` 的差别在于：这里对 `..` 越出根目录的情况
 * 直接截断到 `/`，而不是留下 `..`（避免把 `../../etc` 传给远端）。
 */
export function posixNormalize(input: string): string {
  if (input.length === 0) return '/'
  const absolute = input.startsWith('/')
  const out: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (absolute) return `/${joined}`
  return joined.length > 0 ? joined : '.'
}

/** 拼接远端路径片段 */
export function posixJoin(...parts: string[]): string {
  const filtered = parts.filter((p) => p.length > 0)
  if (filtered.length === 0) return '/'
  return posixNormalize(filtered.join('/'))
}

/** 取父目录；已在根时返回 null */
export function posixParent(input: string): string | null {
  const normalized = posixNormalize(input)
  if (normalized === '/') return null
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

/** 取最后一段作为显示名 */
export function posixBasename(input: string): string {
  const normalized = posixNormalize(input)
  if (normalized === '/') return '/'
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

/**
 * 校验远端路径可用。
 * 必须是绝对路径 —— 相对路径的含义取决于登录后远端进程的工作目录，
 * 而在独立 SFTP 通道里这个目录并不确定，容易被误用。
 */
export function assertRemotePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new SftpError('INVALID_PATH', '路径不能为空')
  }
  if (input.includes('\0')) {
    throw new SftpError('INVALID_PATH', '路径包含非法字符')
  }
  if (!input.startsWith('/')) {
    throw new SftpError('INVALID_PATH', `远端路径必须是绝对路径：${input}`)
  }
  return posixNormalize(input)
}

/* ------------------------------------------------------------------ */
/* 本地（受限于根目录）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 判断 child 是否位于 root 之内（含 root 自身）。
 *
 * 用 `path.relative` 而不是字符串前缀比较：前缀比较会把
 * `/home/user2` 误判为在 `/home/user` 之内。
 */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child)
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 本地根目录守卫。
 *
 * 两道防线：
 * 1. **词法**：`path.resolve` 之后必须落在 root 之内，拦掉 `../../etc/passwd`
 * 2. **物理**：对已存在的路径做 `realpath`，拦掉「root 内有一个指向外部的符号链接」
 *    这种绕过词法检查的情况
 */
export class LocalGuard {
  readonly root: string

  constructor(root: string) {
    // 根目录自身也可能是符号链接（macOS 的 /tmp、/var 都是）。
    // 先把根解析成真实路径，否则内部比对会认为「根自己不在根之内」。
    const absolute = path.resolve(root)
    try {
      this.root = realpathSync(absolute)
    } catch {
      this.root = absolute
    }
  }

  /** 把用户输入解析为绝对路径，并做词法越界检查 */
  resolve(input?: string): string {
    if (typeof input === 'string' && input.includes('\0')) {
      throw new SftpError('INVALID_PATH', '路径包含非法字符')
    }
    const base = input === undefined || input.length === 0 ? this.root : input
    const absolute = path.isAbsolute(base) ? path.resolve(base) : path.resolve(this.root, base)
    if (!isInside(this.root, absolute)) {
      throw new SftpError('PATH_ESCAPE', `路径超出允许访问的根目录：${absolute}`, {
        hint: `本地文件面板被限制在 ${this.root} 之内。如需访问其它位置，请通过 WEBTERM_LOCAL_ROOT 调整根目录后重启服务。`,
      })
    }
    return absolute
  }

  /** 在 resolve 的基础上再做物理检查（realpath），用于读写与列目录 */
  async resolvePhysical(input?: string): Promise<string> {
    const lexical = this.resolve(input)
    return this.assertPhysical(lexical)
  }

  /**
   * 目标可能不存在（如新建文件），此时退化为校验其父目录的物理位置。
   */
  async resolveParentPhysical(target: string): Promise<string> {
    const lexical = this.resolve(target)
    const parent = path.dirname(lexical)
    await this.assertPhysical(parent)
    return lexical
  }

  private async assertPhysical(target: string): Promise<string> {
    try {
      const real = await fsRealpath(target)
      if (!isInside(this.root, real)) {
        throw new SftpError('PATH_ESCAPE', `路径经由符号链接指向根目录之外：${target}`, {
          hint: `符号链接的真实位置是 ${real}，不在允许的根目录内。`,
        })
      }
      return real
    } catch (err) {
      if (err instanceof SftpError) throw err
      const code = (err as { code?: string }).code
      if (code === 'ENOENT') {
        throw new SftpError('NOT_FOUND', `本地路径不存在：${target}`)
      }
      throw err
    }
  }

  /** 相对根目录的展示路径，用于面包屑 */
  display(target: string): string {
    const rel = path.relative(this.root, target)
    return rel === '' ? '.' : rel
  }
}

/* ------------------------------------------------------------------ */
/* 权限展示                                                             */
/* ------------------------------------------------------------------ */

/** 由权限位与类型生成 `ls -l` 风格字符串 */
export function formatMode(mode: number, type: 'file' | 'dir' | 'link' | 'other'): string {
  const typeChar = type === 'dir' ? 'd' : type === 'link' ? 'l' : type === 'other' ? '?' : '-'
  const bits = ['r', 'w', 'x']
  let out = typeChar
  for (let shift = 8; shift >= 0; shift -= 1) {
    const bit = 1 << shift
    const index = (8 - shift) % 3
    out += mode & bit ? (bits[index] as string) : '-'
  }
  return out
}

/** 解析用户输入的八进制权限，如 '644' / '0755' */
export function parseMode(input: string): number {
  const trimmed = input.trim().replace(/^0o/i, '')
  if (!/^[0-7]{3,4}$/.test(trimmed)) {
    throw new SftpError('INVALID_PATH', `权限格式非法：${input}（应为 3~4 位八进制，如 644）`)
  }
  const value = Number.parseInt(trimmed, 8)
  if (value > 0o7777) {
    throw new SftpError('INVALID_PATH', `权限超出范围：${input}`)
  }
  return value
}

/** 由权限位粗略推断可读/可写（仅用于 UI 提示） */
export function permissionHints(mode: number): { readable: boolean; writable: boolean } {
  // 以「任意一类用户具备该权限」作为判断依据：真正的判定取决于远端进程的 uid/gid，
  // 客户端无法仅凭 mode 得出准确结论，这里只求给出合理的可视化提示。
  return {
    readable: (mode & 0o444) !== 0,
    writable: (mode & 0o222) !== 0,
  }
}
