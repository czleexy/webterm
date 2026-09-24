/**
 * 主机密钥记录（TOFU：Trust On First Use）。
 *
 * SSH 客户端的基本安全机制：首次连接时记录主机密钥指纹，之后连接若指纹变化则拒绝，
 * 以防中间人攻击。密钥变更（换设备、重装系统、固件升级）需要用户显式确认后清除记录。
 *
 * 阶段 1 用 JSON 文件存储；阶段 2 迁移到 SQLite 时保持同一接口即可。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface KnownHostEntry {
  host: string
  port: number
  /** 主机密钥算法，如 ssh-rsa */
  keyType: string
  /** 指纹，格式 SHA256:<base64> */
  fingerprint: string
  /** 首次记录时间（ISO 8601） */
  firstSeenAt: string
  /** 最近一次确认时间（ISO 8601） */
  lastSeenAt: string
}

export type HostKeyVerdict =
  /** 首次见到该主机，已记录 */
  | { status: 'trusted-new'; entry: KnownHostEntry }
  /** 指纹与记录一致 */
  | { status: 'trusted-known'; entry: KnownHostEntry }
  /** 指纹与记录不一致，默认拒绝 */
  | { status: 'mismatch'; known: KnownHostEntry; actual: { keyType: string; fingerprint: string } }

interface StoreFile {
  version: 1
  hosts: KnownHostEntry[]
}

const KEY_ALGORITHM_BY_PREFIX: Array<[string, string]> = [
  ['ssh-ed25519', 'ssh-ed25519'],
  ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp256'],
  ['ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp384'],
  ['ecdsa-sha2-nistp521', 'ecdsa-sha2-nistp521'],
  ['ssh-rsa', 'ssh-rsa'],
  ['ssh-dss', 'ssh-dss'],
]

/**
 * 从 ssh2 传入的原始主机密钥 Buffer 中解析出算法名。
 * SSH 公钥二进制格式为：uint32 长度 + 算法名字符串 + ...
 */
function parseKeyType(raw: Buffer): string {
  if (raw.length < 4) return 'unknown'
  try {
    const nameLen = raw.readUInt32BE(0)
    // 防御异常长度，避免越界读取
    if (nameLen <= 0 || nameLen > 64 || 4 + nameLen > raw.length) return 'unknown'
    const name = raw.toString('utf8', 4, 4 + nameLen)
    const matched = KEY_ALGORITHM_BY_PREFIX.find(([prefix]) => name.startsWith(prefix))
    return matched ? matched[1] : name
  } catch {
    return 'unknown'
  }
}

/** 计算 SHA256 指纹，格式与 OpenSSH 一致：SHA256:<base64无填充> */
export function fingerprint(raw: Buffer): string {
  const digest = createHash('sha256').update(raw).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

export function hostKeyTypeOf(raw: Buffer): string {
  return parseKeyType(raw)
}

export class KnownHostsStore {
  private readonly file: string
  private readonly entries = new Map<string, KnownHostEntry>()
  private loaded = false

  constructor(dir: string) {
    this.file = path.join(dir, 'known_hosts.json')
  }

  private static id(host: string, port: number): string {
    return `${host}:${port}`
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile
      if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return
      for (const entry of parsed.hosts) {
        if (typeof entry?.host === 'string' && typeof entry?.port === 'number') {
          this.entries.set(KnownHostsStore.id(entry.host, entry.port), entry)
        }
      }
    } catch {
      // 文件损坏时忽略并重建，不阻断连接；下次写入会覆盖
      this.entries.clear()
    }
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, hosts: [...this.entries.values()] }
    mkdirSync(path.dirname(this.file), { recursive: true })
    // 先写临时文件再重命名，避免写入中途崩溃导致文件损坏
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * 校验主机密钥。
   * @param acceptMismatch 指纹不一致时是否仍然接受（用于「删除记录后重连」的场景）
   */
  verify(
    host: string,
    port: number,
    keyType: string,
    fp: string,
    acceptMismatch = false,
  ): HostKeyVerdict {
    this.load()
    const id = KnownHostsStore.id(host, port)
    const now = new Date().toISOString()
    const existing = this.entries.get(id)

    if (!existing) {
      const entry: KnownHostEntry = {
        host,
        port,
        keyType,
        fingerprint: fp,
        firstSeenAt: now,
        lastSeenAt: now,
      }
      this.entries.set(id, entry)
      this.persist()
      return { status: 'trusted-new', entry }
    }

    if (existing.fingerprint === fp) {
      existing.lastSeenAt = now
      existing.keyType = keyType
      this.persist()
      return { status: 'trusted-known', entry: existing }
    }

    if (acceptMismatch) {
      const updated: KnownHostEntry = {
        ...existing,
        keyType,
        fingerprint: fp,
        lastSeenAt: now,
      }
      this.entries.set(id, updated)
      this.persist()
      return { status: 'trusted-known', entry: updated }
    }

    return { status: 'mismatch', known: existing, actual: { keyType, fingerprint: fp } }
  }

  /** 列出所有已记录主机，供设置页展示与清理 */
  list(): KnownHostEntry[] {
    this.load()
    return [...this.entries.values()].sort((a, b) => a.host.localeCompare(b.host))
  }

  /** 删除某主机的记录，返回是否确实删除了一条 */
  remove(host: string, port: number): boolean {
    this.load()
    const deleted = this.entries.delete(KnownHostsStore.id(host, port))
    if (deleted) this.persist()
    return deleted
  }
}
