/**
 * 自动化 DAO：触发器 / 按钮栏宏 / 脚本。
 *
 * 三张表都只存定义。这里承担两件事：
 * 1. **规范化**：把外部输入钳到合法范围（冷却时间上下限、动作条数、修饰符白名单）。
 *    边界校验在 zod 层已经做过一次，这里再做一遍是因为 DAO 也可能被
 *    种子数据或未来的导入功能直接调用，不能假设调用方都过了 HTTP 校验。
 * 2. **按会话求生效规则**：全局规则 + 只对该会话生效的规则，按 sortOrder 排序。
 */
import type { Database } from 'better-sqlite3'
import type {
  CreateMacroRequest,
  CreateScriptRequest,
  CreateTriggerRequest,
  MacroDefinition,
  MacroStep,
  ScriptDefinition,
  TriggerAction,
  TriggerMatchMode,
  TriggerRule,
  TriggerScope,
  UpdateMacroRequest,
  UpdateScriptRequest,
  UpdateTriggerRequest,
} from '@webterm/shared'
import {
  MACRO_MAX_STEPS,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_MAX_CODE_BYTES,
  SCRIPT_MAX_TIMEOUT_MS,
  TRIGGER_DEFAULT_COOLDOWN_MS,
  TRIGGER_MAX_ACTIONS,
  TRIGGER_MAX_COOLDOWN_MS,
  TRIGGER_MAX_RULES_PER_SESSION,
  TRIGGER_MIN_COOLDOWN_MS,
  normalizeTriggerFlags,
} from '@webterm/shared'
import { newId, nowIso, type MacroRow, type ScriptRow, type TriggerRow } from './index.js'

const ACTION_TYPES = new Set(['send', 'highlight', 'notify', 'label', 'script'])

function isTriggerAction(value: unknown): value is TriggerAction {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && ACTION_TYPES.has(type)
}

/** JSON 列解析容错：手工改过库、或历史版本写坏的内容都不该让接口 500 */
function parseJsonArray<T>(raw: string, guard: (v: unknown) => v is T): T[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(guard)
  } catch {
    return []
  }
}

function isMacroStep(value: unknown): value is MacroStep {
  return typeof value === 'object' && value !== null
}

export class AutomationStore {
  constructor(private readonly db: Database) {}

  /* ------------------------------------------------------------------ */
  /* 触发器                                                              */
  /* ------------------------------------------------------------------ */

  private toRule(row: TriggerRow): TriggerRule {
    const rule: TriggerRule = {
      id: row.id,
      name: row.name,
      enabled: row.enabled !== 0,
      scope: (row.scope === 'session' ? 'session' : 'global') as TriggerScope,
      pattern: row.pattern,
      matchMode: (row.match_mode === 'text' ? 'text' : 'regex') as TriggerMatchMode,
      flags: normalizeTriggerFlags(row.flags),
      actions: parseJsonArray(row.actions_json, isTriggerAction),
      cooldownMs: row.cooldown_ms,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.session_id) rule.sessionId = row.session_id
    return rule
  }

  listTriggers(): TriggerRule[] {
    const rows = this.db
      .prepare('SELECT * FROM triggers ORDER BY sort_order, created_at')
      .all() as TriggerRow[]
    return rows.map((r) => this.toRule(r))
  }

  getTrigger(id: string): TriggerRule | undefined {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as
      | TriggerRow
      | undefined
    return row ? this.toRule(row) : undefined
  }

  /**
   * 某个会话实际生效的规则：全局 + 该会话专属。
   * `sessionId` 为 undefined（快速连接，不经会话库）时只有全局规则。
   * 返回顺序即匹配顺序，因此命中多条时动作也按这个顺序发生。
   */
  triggerRulesForSession(sessionId: string | undefined): TriggerRule[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            `SELECT * FROM triggers
             WHERE enabled = 1 AND (scope = 'global' OR session_id = ?)
             ORDER BY sort_order, created_at
             LIMIT ?`,
          )
          .all(sessionId, TRIGGER_MAX_RULES_PER_SESSION) as TriggerRow[])
      : (this.db
          .prepare(
            `SELECT * FROM triggers
             WHERE enabled = 1 AND scope = 'global'
             ORDER BY sort_order, created_at
             LIMIT ?`,
          )
          .all(TRIGGER_MAX_RULES_PER_SESSION) as TriggerRow[])
    return rows.map((r) => this.toRule(r))
  }

  createTrigger(req: CreateTriggerRequest): TriggerRule {
    this.assertSessionScope(req.scope ?? 'global', req.sessionId ?? null)
    const now = nowIso()
    const row: TriggerRow = {
      id: newId('trg'),
      name: req.name,
      enabled: req.enabled === false ? 0 : 1,
      scope: req.scope ?? 'global',
      session_id: req.scope === 'session' ? (req.sessionId ?? null) : null,
      pattern: req.pattern,
      match_mode: req.matchMode ?? 'regex',
      flags: normalizeTriggerFlags(req.flags),
      actions_json: JSON.stringify((req.actions ?? []).slice(0, TRIGGER_MAX_ACTIONS)),
      cooldown_ms: clampCooldown(req.cooldownMs),
      sort_order: req.sortOrder ?? 0,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO triggers
           (id, name, enabled, scope, session_id, pattern, match_mode, flags, actions_json, cooldown_ms, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.enabled,
        row.scope,
        row.session_id,
        row.pattern,
        row.match_mode,
        row.flags,
        row.actions_json,
        row.cooldown_ms,
        row.sort_order,
        row.created_at,
        row.updated_at,
      )
    return this.toRule(row)
  }

  updateTrigger(id: string, req: UpdateTriggerRequest): TriggerRule | undefined {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as
      | TriggerRow
      | undefined
    if (!row) return undefined

    const scope = req.scope ?? (row.scope as TriggerScope)
    const sessionId =
      req.sessionId !== undefined ? req.sessionId : row.session_id
    this.assertSessionScope(scope, scope === 'session' ? sessionId : null)

    const next: TriggerRow = {
      ...row,
      name: req.name ?? row.name,
      enabled: req.enabled === undefined ? row.enabled : req.enabled ? 1 : 0,
      scope,
      session_id: scope === 'session' ? (sessionId ?? null) : null,
      pattern: req.pattern ?? row.pattern,
      match_mode: req.matchMode ?? row.match_mode,
      flags: req.flags === undefined ? row.flags : normalizeTriggerFlags(req.flags),
      actions_json:
        req.actions === undefined
          ? row.actions_json
          : JSON.stringify(req.actions.slice(0, TRIGGER_MAX_ACTIONS)),
      cooldown_ms: req.cooldownMs === undefined ? row.cooldown_ms : clampCooldown(req.cooldownMs),
      sort_order: req.sortOrder ?? row.sort_order,
      updated_at: nowIso(),
    }

    this.db
      .prepare(
        `UPDATE triggers SET
           name = ?, enabled = ?, scope = ?, session_id = ?, pattern = ?, match_mode = ?,
           flags = ?, actions_json = ?, cooldown_ms = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.enabled,
        next.scope,
        next.session_id,
        next.pattern,
        next.match_mode,
        next.flags,
        next.actions_json,
        next.cooldown_ms,
        next.sort_order,
        next.updated_at,
        id,
      )
    return this.toRule(next)
  }

  removeTrigger(id: string): boolean {
    const info = this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id)
    return info.changes > 0
  }

  /** 会话作用域的规则必须带 sessionId，且该会话节点要真实存在 */
  private assertSessionScope(scope: TriggerScope, sessionId: string | null): void {
    if (scope !== 'session') return
    if (!sessionId) {
      throw new AutomationError('INVALID', '会话级触发规则必须指定所属会话')
    }
    const exists = this.db.prepare('SELECT id FROM library WHERE id = ?').get(sessionId)
    if (!exists) {
      throw new AutomationError('NOT_FOUND', `会话不存在：${sessionId}`)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 宏（按钮栏）                                                        */
  /* ------------------------------------------------------------------ */

  private toMacro(row: MacroRow): MacroDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      steps: parseJsonArray(row.steps_json, isMacroStep).slice(0, MACRO_MAX_STEPS),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listMacros(): MacroDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM macros ORDER BY sort_order, created_at')
      .all() as MacroRow[]
    return rows.map((r) => this.toMacro(r))
  }

  getMacro(id: string): MacroDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM macros WHERE id = ?').get(id) as
      | MacroRow
      | undefined
    return row ? this.toMacro(row) : undefined
  }

  createMacro(req: CreateMacroRequest): MacroDefinition {
    const now = nowIso()
    const row: MacroRow = {
      id: newId('mac'),
      name: req.name,
      description: req.description ?? '',
      steps_json: JSON.stringify(req.steps.slice(0, MACRO_MAX_STEPS)),
      sort_order: req.sortOrder ?? 0,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        'INSERT INTO macros (id, name, description, steps_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.name, row.description, row.steps_json, row.sort_order, row.created_at, row.updated_at)
    return this.toMacro(row)
  }

  updateMacro(id: string, req: UpdateMacroRequest): MacroDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM macros WHERE id = ?').get(id) as
      | MacroRow
      | undefined
    if (!row) return undefined

    const next: MacroRow = {
      ...row,
      name: req.name ?? row.name,
      description: req.description ?? row.description,
      steps_json:
        req.steps === undefined
          ? row.steps_json
          : JSON.stringify(req.steps.slice(0, MACRO_MAX_STEPS)),
      sort_order: req.sortOrder ?? row.sort_order,
      updated_at: nowIso(),
    }
    this.db
      .prepare(
        'UPDATE macros SET name = ?, description = ?, steps_json = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.name, next.description, next.steps_json, next.sort_order, next.updated_at, id)
    return this.toMacro(next)
  }

  removeMacro(id: string): boolean {
    return this.db.prepare('DELETE FROM macros WHERE id = ?').run(id).changes > 0
  }

  /* ------------------------------------------------------------------ */
  /* 脚本                                                                */
  /* ------------------------------------------------------------------ */

  private toScript(row: ScriptRow): ScriptDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      code: row.code,
      timeoutMs: row.timeout_ms,
      runOnConnect: row.run_on_connect !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listScripts(): ScriptDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM scripts ORDER BY created_at')
      .all() as ScriptRow[]
    return rows.map((r) => this.toScript(r))
  }

  getScript(id: string): ScriptDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as
      | ScriptRow
      | undefined
    return row ? this.toScript(row) : undefined
  }

  /**
   * 按给定 id 顺序取脚本；已删除的 id 会被静默跳过。
   * 顺序必须保留 —— 会话启动脚本是「按数组顺序串行执行」的语义。
   */
  resolveScripts(ids: string[]): ScriptDefinition[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM scripts WHERE id IN (${placeholders})`)
      .all(...ids) as ScriptRow[]
    const byId = new Map(rows.map((r) => [r.id, this.toScript(r)]))
    return ids
      .map((id) => byId.get(id))
      .filter((s): s is ScriptDefinition => s !== undefined)
  }

  /** 所有勾选了「随会话自动运行」的脚本 */
  listConnectScripts(): ScriptDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM scripts WHERE run_on_connect = 1 ORDER BY created_at')
      .all() as ScriptRow[]
    return rows.map((r) => this.toScript(r))
  }

  createScript(req: CreateScriptRequest): ScriptDefinition {
    const now = nowIso()
    const row: ScriptRow = {
      id: newId('scr'),
      name: req.name,
      description: req.description ?? '',
      code: req.code.slice(0, SCRIPT_MAX_CODE_BYTES),
      timeout_ms: clampTimeout(req.timeoutMs),
      run_on_connect: req.runOnConnect ? 1 : 0,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        'INSERT INTO scripts (id, name, description, code, timeout_ms, run_on_connect, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.code,
        row.timeout_ms,
        row.run_on_connect,
        row.created_at,
        row.updated_at,
      )
    return this.toScript(row)
  }

  updateScript(id: string, req: UpdateScriptRequest): ScriptDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as
      | ScriptRow
      | undefined
    if (!row) return undefined

    const next: ScriptRow = {
      ...row,
      name: req.name ?? row.name,
      description: req.description ?? row.description,
      code: req.code === undefined ? row.code : req.code.slice(0, SCRIPT_MAX_CODE_BYTES),
      timeout_ms: req.timeoutMs === undefined ? row.timeout_ms : clampTimeout(req.timeoutMs),
      run_on_connect:
        req.runOnConnect === undefined ? row.run_on_connect : req.runOnConnect ? 1 : 0,
      updated_at: nowIso(),
    }
    this.db
      .prepare(
        'UPDATE scripts SET name = ?, description = ?, code = ?, timeout_ms = ?, run_on_connect = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.name,
        next.description,
        next.code,
        next.timeout_ms,
        next.run_on_connect,
        next.updated_at,
        id,
      )
    return this.toScript(next)
  }

  removeScript(id: string): boolean {
    return this.db.prepare('DELETE FROM scripts WHERE id = ?').run(id).changes > 0
  }

  /**
   * 有多少会话引用了该脚本。
   * 删除脚本前用它给出「还有 N 个会话在用」的提醒 —— 静默删除会让那些会话
   * 在下次连接时莫名其妙少跑一段逻辑。
   */
  countScriptReferences(scriptId: string): number {
    const rows = this.db
      .prepare("SELECT session_json FROM library WHERE kind = 'session' AND session_json IS NOT NULL")
      .all() as Array<{ session_json: string }>
    let count = 0
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.session_json) as { startupScripts?: unknown }
        if (Array.isArray(parsed.startupScripts) && parsed.startupScripts.includes(scriptId)) {
          count += 1
        }
      } catch {
        /* 坏数据跳过 */
      }
    }
    // 触发器动作里引用脚本的规则同样算引用
    const triggerRows = this.db
      .prepare('SELECT actions_json FROM triggers')
      .all() as Array<{ actions_json: string }>
    for (const row of triggerRows) {
      const actions = parseJsonArray(row.actions_json, isTriggerAction)
      if (actions.some((a) => a.type === 'script' && a.scriptId === scriptId)) count += 1
    }
    return count
  }
}

function clampCooldown(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return TRIGGER_DEFAULT_COOLDOWN_MS
  return Math.min(TRIGGER_MAX_COOLDOWN_MS, Math.max(TRIGGER_MIN_COOLDOWN_MS, Math.trunc(value)))
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SCRIPT_DEFAULT_TIMEOUT_MS
  return Math.min(SCRIPT_MAX_TIMEOUT_MS, Math.max(1000, Math.trunc(value)))
}

export type AutomationErrorCode = 'NOT_FOUND' | 'INVALID' | 'IN_USE' | 'LIMIT'

export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AutomationError'
  }
}
