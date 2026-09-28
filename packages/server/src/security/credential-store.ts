/**
 * 凭据存取层：DB 行 ↔ 加密秘密 ↔ 明文（仅在内存、仅在连接时）。
 *
 * 铁律：
 * - 所有「读」接口只返回 CredentialSummary，永不返回秘密字段
 * - 明文只在 resolveCredential() 被调用时短暂解出，
 *   由调用方（连接层）用完即弃
 */
import type { Database } from 'better-sqlite3'
import type {
  CreateCredentialRequest,
  CredentialSummary,
  UpdateCredentialRequest,
} from '@webterm/shared'
import { Vault, VaultError } from './vault.js'
import { newId, nowIso, type CredentialRow } from '../db/index.js'

/** 解密后的凭据明文（只应出现在连接参数组装的瞬间） */
export interface ResolvedSecret {
  password?: string
  privateKey?: string
  passphrase?: string
}

interface SecretPayload extends ResolvedSecret {}

export class CredentialStore {
  constructor(
    private readonly db: Database,
    private readonly vault: Vault,
  ) {}

  private toSummary(row: CredentialRow): CredentialSummary {
    const summary: CredentialSummary = {
      id: row.id,
      name: row.name,
      type: row.type as CredentialSummary['type'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.type === 'privateKey') {
      // hasPassphrase 需要解密才知道；仅保险库解锁时提供，未解锁时省略
      if (this.vault.unlocked) {
        try {
          const payload = this.vault.decryptJson<SecretPayload>(row.secret)
          summary.hasPassphrase = Boolean(payload.passphrase)
        } catch {
          // 密钥不匹配等异常场景：不泄露，标记为未知
          summary.hasPassphrase = undefined
        }
      }
    }
    return summary
  }

  list(): CredentialSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM credentials ORDER BY name COLLATE NOCASE')
      .all() as CredentialRow[]
    return rows.map((r) => this.toSummary(r))
  }

  get(id: string): CredentialSummary | undefined {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined
    return row ? this.toSummary(row) : undefined
  }

  exists(id: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id) !== undefined
    )
  }

  create(req: CreateCredentialRequest): CredentialSummary {
    if (!this.vault.unlocked) {
      throw new VaultError('LOCKED', '保险库未解锁，无法保存凭据')
    }

    const payload: SecretPayload =
      req.type === 'password'
        ? { password: req.password ?? '' }
        : { privateKey: req.privateKey ?? '', passphrase: req.passphrase || undefined }

    const now = nowIso()
    const row: CredentialRow = {
      id: newId('cred'),
      name: req.name,
      type: req.type,
      secret: this.vault.encryptJson(payload),
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        'INSERT INTO credentials (id, name, type, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.name, row.type, row.secret, row.created_at, row.updated_at)
    return this.toSummary(row)
  }

  update(id: string, req: UpdateCredentialRequest): CredentialSummary | undefined {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined
    if (!row) return undefined
    if (!this.vault.unlocked) {
      throw new VaultError('LOCKED', '保险库未解锁，无法修改凭据')
    }

    const payload = this.vault.decryptJson<SecretPayload>(row.secret)

    // 密码型凭据只允许更新 password；私钥型可更新 privateKey / passphrase
    if (row.type === 'password' && req.password !== undefined) {
      payload.password = req.password
    }
    if (row.type === 'privateKey') {
      if (req.privateKey !== undefined) payload.privateKey = req.privateKey
      if (req.passphrase !== undefined) {
        payload.passphrase = req.passphrase || undefined
      }
    }

    const name = req.name ?? row.name
    const secret = this.vault.encryptJson(payload)
    const updated = nowIso()
    this.db
      .prepare('UPDATE credentials SET name = ?, secret = ?, updated_at = ? WHERE id = ?')
      .run(name, secret, updated, id)
    return this.get(id)
  }

  remove(id: string): boolean {
    const info = this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
    return info.changes > 0
  }

  /** 引用检查：会话库 / 跳板链中还有哪些节点在用该凭据 */
  referencedByLibrary(id: string): number {
    const rows = this.db
      .prepare("SELECT session_json FROM library WHERE kind = 'session' AND session_json IS NOT NULL")
      .all() as Array<{ session_json: string }>
    let count = 0
    for (const r of rows) {
      try {
        const session = JSON.parse(r.session_json) as {
          credentialId?: string
          jumpChain?: Array<{ credentialId?: string }>
        }
        if (session.credentialId === id) count += 1
        count += (session.jumpChain ?? []).filter((h) => h.credentialId === id).length
      } catch {
        /* 脏数据跳过 */
      }
    }
    return count
  }

  /** 解密出明文秘密 —— 只允许连接装配路径调用 */
  resolveSecret(id: string): ResolvedSecret {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined
    if (!row) {
      throw new VaultError('NOT_INITIALIZED', `凭据不存在：${id}`)
    }
    return this.vault.decryptJson<SecretPayload>(row.secret)
  }
}
