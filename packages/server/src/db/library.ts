/**
 * 会话库 DAO：文件夹 + 会话节点的树操作。
 *
 * 树结构用 parent_id 邻接表存储；环形引用（把节点挂到自己的后代下）
 * 在 update 的 parentId 变更时通过「向上遍历祖先」显式拒绝。
 */
import type { Database } from 'better-sqlite3'
import type {
  CreateLibraryNodeRequest,
  LibraryNode,
  SessionRecord,
  UpdateLibraryNodeRequest,
} from '@webterm/shared'
import { newId, nowIso, type LibraryRow } from '../db/index.js'
import { CredentialStore } from '../security/credential-store.js'
import { VaultError } from '../security/vault.js'

export class LibraryStore {
  constructor(
    private readonly db: Database,
    private readonly credentials: CredentialStore,
  ) {}

  private toNode(row: LibraryRow): LibraryNode {
    const node: LibraryNode = {
      id: row.id,
      kind: row.kind as LibraryNode['kind'],
      name: row.name,
      parentId: row.parent_id,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.kind === 'session' && row.session_json) {
      const parsed = JSON.parse(row.session_json) as SessionRecord
      // 阶段 2 写入的记录没有 protocol 字段；统一归一成 ssh，
      // 免得协议判定散落到每个调用点各写一遍 `?? 'ssh'`
      node.session = { ...parsed, protocol: parsed.protocol ?? 'ssh' }
    }
    return node
  }

  list(): LibraryNode[] {
    const rows = this.db
      .prepare('SELECT * FROM library ORDER BY sort_order, created_at')
      .all() as LibraryRow[]
    return rows.map((r) => this.toNode(r))
  }

  get(id: string): LibraryNode | undefined {
    const row = this.db.prepare('SELECT * FROM library WHERE id = ?').get(id) as
      | LibraryRow
      | undefined
    return row ? this.toNode(row) : undefined
  }

  /** 取出会话节点的完整记录；非会话节点抛错 */
  getSessionRecord(id: string): { node: LibraryNode; record: SessionRecord } {
    const node = this.get(id)
    if (!node) throw new LibraryError('NOT_FOUND', `会话不存在：${id}`)
    if (node.kind !== 'session' || !node.session) {
      throw new LibraryError('NOT_A_SESSION', `节点 ${id} 不是会话`)
    }
    return { node, record: node.session }
  }

  create(req: CreateLibraryNodeRequest): LibraryNode {
    this.validateSessionPayload(req.session, req.kind)

    if (req.parentId) {
      const parent = this.get(req.parentId)
      if (!parent) throw new LibraryError('NOT_FOUND', `父节点不存在：${req.parentId}`)
      if (parent.kind !== 'folder') {
        throw new LibraryError('INVALID_PARENT', '父节点必须是文件夹')
      }
    }

    const now = nowIso()
    const row: LibraryRow = {
      id: newId(req.kind === 'folder' ? 'fld' : 'sess'),
      kind: req.kind,
      name: req.name,
      parent_id: req.parentId ?? null,
      sort_order: req.sortOrder ?? 0,
      session_json: req.session ? JSON.stringify(req.session) : null,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        'INSERT INTO library (id, kind, name, parent_id, sort_order, session_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.kind,
        row.name,
        row.parent_id,
        row.sort_order,
        row.session_json,
        row.created_at,
        row.updated_at,
      )
    return this.toNode(row)
  }

  update(id: string, req: UpdateLibraryNodeRequest): LibraryNode | undefined {
    const row = this.db.prepare('SELECT * FROM library WHERE id = ?').get(id) as
      | LibraryRow
      | undefined
    if (!row) return undefined

    // 环形引用检查：folder 不能移动到自己的后代之下
    if (req.parentId !== undefined && req.parentId !== null) {
      if (req.parentId === id) {
        throw new LibraryError('CYCLE', '不能把节点移动到自己之下')
      }
      if (row.kind === 'folder') {
        const ancestors = this.ancestorIds(req.parentId)
        if (ancestors.has(id)) {
          throw new LibraryError('CYCLE', '不能把文件夹移动到自己的子节点之下')
        }
      }
      const parent = this.get(req.parentId)
      if (!parent) throw new LibraryError('NOT_FOUND', `父节点不存在：${req.parentId}`)
      if (parent.kind !== 'folder') {
        throw new LibraryError('INVALID_PARENT', '父节点必须是文件夹')
      }
    }

    if (req.session !== undefined) {
      if (row.kind !== 'session') {
        throw new LibraryError('NOT_A_SESSION', '文件夹节点不能携带会话配置')
      }
      this.validateSessionPayload(req.session, 'session')
    }

    const name = req.name ?? row.name
    const parentId =
      req.parentId === undefined ? row.parent_id : (req.parentId ?? null)
    const sortOrder = req.sortOrder ?? row.sort_order
    const sessionJson =
      req.session !== undefined ? JSON.stringify(req.session) : row.session_json
    const updated = nowIso()

    this.db
      .prepare(
        'UPDATE library SET name = ?, parent_id = ?, sort_order = ?, session_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(name, parentId, sortOrder, sessionJson, updated, id)
    return this.get(id)
  }

  /** 删除节点；文件夹递归删除全部后代 */
  remove(id: string): number {
    const row = this.db.prepare('SELECT * FROM library WHERE id = ?').get(id) as
      | LibraryRow
      | undefined
    if (!row) return 0

    const ids = [id]
    if (row.kind === 'folder') {
      // 收集全部后代（BFS；数据量小，一次查询足够）
      let frontier = [id]
      while (frontier.length > 0) {
        const placeholders = frontier.map(() => '?').join(',')
        const children = this.db
          .prepare(`SELECT id FROM library WHERE parent_id IN (${placeholders})`)
          .all(...frontier) as Array<{ id: string }>
        frontier = children.map((c) => c.id)
        ids.push(...frontier)
      }
    }

    const placeholders = ids.map(() => '?').join(',')
    const info = this.db
      .prepare(`DELETE FROM library WHERE id IN (${placeholders})`)
      .run(...ids)
    return info.changes
  }

  private ancestorIds(id: string): Set<string> {
    const seen = new Set<string>()
    let current: string | null = id
    while (current) {
      if (seen.has(current)) break
      seen.add(current)
      const row = this.db
        .prepare('SELECT parent_id FROM library WHERE id = ?')
        .get(current) as { parent_id: string | null } | undefined
      current = row?.parent_id ?? null
    }
    return seen
  }

  /**
   * 校验会话配置：SSH 的凭据必须真实存在；Telnet 无需凭据，但要挡住
   * 「配了凭据/跳板链」这种看起来生效、实际上根本不会被用到的组合。
   * 注意这里不要求保险库已解锁 —— 保存时只需 id 存在，
   * 连接时才需要解密（那时才要求解锁）。
   */
  private validateSessionPayload(
    session: SessionRecord | undefined,
    kind: 'folder' | 'session',
  ): void {
    if (kind !== 'session') return
    if (!session) {
      throw new LibraryError('MISSING_SESSION', '会话节点必须携带 session 配置')
    }

    if ((session.protocol ?? 'ssh') === 'telnet') {
      if (session.credentialId) {
        throw new LibraryError(
          'CREDENTIAL_NOT_APPLICABLE',
          'Telnet 会话不需要登录凭据：口令在终端里交互输入，不会被保存',
        )
      }
      if ((session.jumpChain ?? []).length > 0) {
        throw new LibraryError('CREDENTIAL_NOT_APPLICABLE', 'Telnet 不支持跳板链')
      }
      return
    }

    if (!session.credentialId) {
      throw new LibraryError('CREDENTIAL_MISSING', 'SSH 会话必须选择登录凭据')
    }

    const checks: Array<{ id: string | undefined; label: string }> = [
      { id: session.credentialId, label: '登录凭据' },
      ...(session.jumpChain ?? []).map((h, i) => ({
        id: h.credentialId,
        label: `跳板链第 ${i + 1} 跳凭据`,
      })),
    ]
    for (const check of checks) {
      if (!check.id || !this.credentials.exists(check.id)) {
        throw new LibraryError('CREDENTIAL_MISSING', `${check.label}不存在或已被删除`)
      }
    }
  }
}

export class LibraryError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_A_SESSION'
      | 'INVALID_PARENT'
      | 'CYCLE'
      | 'MISSING_SESSION'
      | 'CREDENTIAL_MISSING'
      | 'CREDENTIAL_NOT_APPLICABLE',
    message: string,
  ) {
    super(message)
    this.name = 'LibraryError'
  }
}

export { VaultError }
