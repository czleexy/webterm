/**
 * SQLite 数据库：打开、WAL、按 user_version 迁移。
 *
 * 设计约束：
 * - better-sqlite3 是同步接口，所有查询都在事件循环线程执行。
 *   终端转发的数据量不在 DB 上（终端不落库），此处压力可忽略。
 * - 全部访问经参数绑定（`?` 占位符），杜绝 SQL 注入。
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

export interface SettingsRow {
  key: string
  value: string
}

export interface CredentialRow {
  id: string
  name: string
  /** password | privateKey */
  type: string
  /** AES-256-GCM 密文：iv(12B) | tag(16B) | ciphertext，JSON 序列化后的秘密 */
  secret: Buffer
  created_at: string
  updated_at: string
}

export interface LibraryRow {
  id: string
  /** folder | session */
  kind: string
  name: string
  parent_id: string | null
  sort_order: number
  /** kind = session 时的 JSON 序列化配置 */
  session_json: string | null
  created_at: string
  updated_at: string
}

export interface TriggerRow {
  id: string
  name: string
  /** SQLite 无布尔：0 / 1 */
  enabled: number
  /** global | session */
  scope: string
  /** scope = session 时指向 library(id) */
  session_id: string | null
  pattern: string
  /** regex | text */
  match_mode: string
  flags: string
  actions_json: string
  cooldown_ms: number
  sort_order: number
  created_at: string
  updated_at: string
}

export interface MacroRow {
  id: string
  name: string
  description: string
  steps_json: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface ScriptRow {
  id: string
  name: string
  description: string
  code: string
  timeout_ms: number
  /** 0 / 1 */
  run_on_connect: number
  created_at: string
  updated_at: string
}

const MIGRATIONS: string[] = [
  // v1：初始表结构
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE credentials (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('password', 'privateKey')),
    secret     BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE library (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('folder', 'session')),
    name         TEXT NOT NULL,
    parent_id    TEXT REFERENCES library(id) ON DELETE CASCADE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    session_json TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX idx_library_parent ON library(parent_id, sort_order);
  `,
  // v2：阶段 6 —— 自动化（触发器 / 按钮栏宏 / 脚本）
  //
  // 三张表都只存「定义」：命中次数、最近触发时间、运行日志都属于进程内存里的
  // 运行时状态，写回库反而会让「上次碰巧失败」变成永久配置。
  //
  // triggers.session_id 引用 library(id) 并级联删除：会话记录没了，
  // 只对它生效的规则也就失去了锚点，留着只会在界面上显示一堆孤儿规则。
  `
  CREATE TABLE triggers (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    scope        TEXT NOT NULL CHECK (scope IN ('global', 'session')),
    session_id   TEXT REFERENCES library(id) ON DELETE CASCADE,
    pattern      TEXT NOT NULL,
    match_mode   TEXT NOT NULL DEFAULT 'regex' CHECK (match_mode IN ('regex', 'text')),
    flags        TEXT NOT NULL DEFAULT '',
    actions_json TEXT NOT NULL,
    cooldown_ms  INTEGER NOT NULL DEFAULT 500,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX idx_triggers_scope ON triggers(scope, session_id, sort_order);

  CREATE TABLE macros (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps_json  TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE scripts (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    code           TEXT NOT NULL,
    timeout_ms     INTEGER NOT NULL DEFAULT 30000,
    run_on_connect INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  `,
]

export function openDatabase(dbFile: string): Database.Database {
  mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version

  for (; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version]
    if (!migration) break
    db.transaction(() => {
      db.exec(migration)
      db.pragma(`user_version = ${version + 1}`)
    })()
  }
}

/** 生成实体 id —— 带前缀便于在日志与接口中一眼分辨类型 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
