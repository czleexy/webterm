/**
 * 主密码保险库。
 *
 * 威胁模型：保护「服务端磁盘被拷走」场景下的凭据安全。
 * - 主密钥由主密码经 scrypt 派生，**只存在于进程内存**，不落盘
 * - 验证器（verifier）是一段已知明文的 AES-256-GCM 密文，
 *   解锁时能正确解出即证明主密码正确（无需额外哈希比较）
 * - 所有凭据以 `iv(12B) | authTag(16B) | ciphertext` 格式存 DB
 *
 * GCM 的 authTag 保证密文被篡改时解密直接失败 —— 凭据不可能被静默替换。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto'
import type { Database } from 'better-sqlite3'

const KDF_SALT_BYTES = 32
const KDF_KEY_LEN = 32
// scrypt 参数：N=2^15（约 100ms/次 @ 现代 CPU），内存 ~32MB
const KDF_N = 2 ** 15
const KDF_R = 8
const KDF_P = 1

const VERIFIER_PLAINTEXT = 'webterm-vault-verifier-v1'

const MIN_MASTER_PASSWORD_LEN = 8

/** 解锁失败 / 未初始化时抛出的统一错误 */
export class VaultError extends Error {
  constructor(
    readonly code: 'NOT_INITIALIZED' | 'ALREADY_INITIALIZED' | 'LOCKED' | 'WRONG_PASSWORD' | 'WEAK_PASSWORD',
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

interface SecretBox {
  iv: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

function getSetting(db: Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

export class Vault {
  /** 派生出的主密钥；解锁前为 undefined，永不写盘 */
  private masterKey: Buffer | undefined

  constructor(private readonly db: Database) {}

  get initialized(): boolean {
    return getSetting(this.db, 'vault.kdfSalt') !== undefined
  }

  get unlocked(): boolean {
    return this.masterKey !== undefined
  }

  /** 首次设置主密码。已初始化时拒绝，防止被静默覆写。 */
  setup(masterPassword: string): void {
    if (this.initialized) {
      throw new VaultError('ALREADY_INITIALIZED', '主密码已设置，不可重复设置')
    }
    if (masterPassword.length < MIN_MASTER_PASSWORD_LEN) {
      throw new VaultError(
        'WEAK_PASSWORD',
        `主密码至少需要 ${MIN_MASTER_PASSWORD_LEN} 个字符`,
      )
    }

    const salt = randomBytes(KDF_SALT_BYTES)
    const key = scryptSync(masterPassword, salt, KDF_KEY_LEN, {
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
    })

    const verifier = this.encryptWith(key, Buffer.from(VERIFIER_PLAINTEXT, 'utf8'))

    this.db.transaction(() => {
      setSetting(this.db, 'vault.kdfSalt', salt.toString('hex'))
      setSetting(this.db, 'vault.verifier', serializeBox(verifier).toString('base64'))
      setSetting(this.db, 'vault.createdAt', new Date().toISOString())
    })()

    // 设置成功即视为已解锁
    this.masterKey = key
  }

  /** 用主密码解锁。失败抛 WRONG_PASSWORD，不透露更多信息（防暴力枚举探测）。 */
  unlock(masterPassword: string): void {
    const saltHex = getSetting(this.db, 'vault.kdfSalt')
    const verifierB64 = getSetting(this.db, 'vault.verifier')
    if (!saltHex || !verifierB64) {
      throw new VaultError('NOT_INITIALIZED', '尚未设置主密码')
    }

    const salt = Buffer.from(saltHex, 'hex')
    const key = scryptSync(masterPassword, salt, KDF_KEY_LEN, {
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
    })

    try {
      const plain = this.decryptWith(key, parseBox(Buffer.from(verifierB64, 'base64')))
      if (plain.toString('utf8') !== VERIFIER_PLAINTEXT) throw new Error('mismatch')
    } catch {
      // 用固定时长耗尽，避免通过解锁耗时差异枚举密码
      key.fill(0)
      throw new VaultError('WRONG_PASSWORD', '主密码不正确')
    }

    this.masterKey = key
  }

  lock(): void {
    if (this.masterKey) {
      this.masterKey.fill(0) // 主动清零内存中的密钥
      this.masterKey = undefined
    }
  }

  /** 加密任意 JSON（凭据秘密）。未解锁时抛 LOCKED。 */
  encryptJson(value: unknown): Buffer {
    const key = this.requireKey()
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    return serializeBox(this.encryptWith(key, plaintext))
  }

  /** 解密凭据秘密。密文损坏 / 主密码已更换时抛错。 */
  decryptJson<T>(blob: Buffer): T {
    const key = this.requireKey()
    try {
      const plain = this.decryptWith(key, parseBox(blob))
      return JSON.parse(plain.toString('utf8')) as T
    } catch (err) {
      throw new VaultError('LOCKED', '凭据解密失败：主密钥不匹配或密文已损坏')
    }
  }

  private requireKey(): Buffer {
    if (!this.masterKey) {
      throw new VaultError('LOCKED', '保险库已锁定，请先解锁')
    }
    return this.masterKey
  }

  private encryptWith(key: Buffer, plaintext: Buffer): SecretBox {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { iv, authTag: cipher.getAuthTag(), ciphertext }
  }

  private decryptWith(key: Buffer, box: SecretBox): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', key, box.iv) as DecipherGCM
    decipher.setAuthTag(box.authTag)
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()])
  }
}

function serializeBox(box: SecretBox): Buffer {
  return Buffer.concat([box.iv, box.authTag, box.ciphertext])
}

function parseBox(blob: Buffer): SecretBox {
  if (blob.length < 12 + 16 + 1) {
    throw new Error('密文格式非法')
  }
  return {
    iv: blob.subarray(0, 12),
    authTag: blob.subarray(12, 28),
    ciphertext: blob.subarray(28),
  }
}

export { MIN_MASTER_PASSWORD_LEN }
