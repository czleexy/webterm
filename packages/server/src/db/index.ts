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
