/**
 * 插件状态 DAO。
 *
 * 只持久化「用户的决定」——启用与否、改过哪些配置项。
 * 插件能力（注册项）与日志不落库：它们是每次加载现算的运行时事实，
 * 落库只会制造「文件改了但库里还是旧的」这种需要手动同步的中间状态。
 */
import type { Database } from 'better-sqlite3'
import type { PluginConfigMap, PluginConfigValue } from '@webterm/shared'
import { nowIso } from './index.js'

export interface PluginStateRecord {
  pluginId: string
  enabled: boolean
  /** 用户覆盖值；键不在清单里的脏数据会被过滤掉（清单改了配置项之后很正常） */
  config: PluginConfigMap
  updatedAt: string
}

interface PluginStateDbRow {
  plugin_id: string
  enabled: number
  config_json: string
  updated_at: string
}

export class PluginStore {
  constructor(private readonly db: Database) {}

  list(): PluginStateRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM plugin_state ORDER BY plugin_id')
      .all() as PluginStateDbRow[]
    return rows.map(toRecord)
  }

  get(pluginId: string): PluginStateRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM plugin_state WHERE plugin_id = ?')
      .get(pluginId) as PluginStateDbRow | undefined
    return row ? toRecord(row) : undefined
  }

  /**
   * 取状态；不存在时**不落库**，返回一个「默认启用、无覆盖」的视图。
   *
   * 这一点是有意为之：插件是「把目录放进去就该能用」的东西，
   * 如果首次列出插件时顺手插一行，用户在界面上什么都还没做就已经产生了写操作，
   * 而写操作会产生「删除插件后还留着配置」需要清理的状态。
   */
  getOrDefault(pluginId: string): PluginStateRecord {
    return (
      this.get(pluginId) ?? {
        pluginId,
        enabled: true,
        config: {},
        updatedAt: nowIso(),
      }
    )
  }

  setEnabled(pluginId: string, enabled: boolean): PluginStateRecord {
    const current = this.getOrDefault(pluginId)
    return this.write(pluginId, enabled, current.config)
  }

  /** 覆盖配置：**整体替换**覆盖集合（界面提交的就是完整表单） */
  setConfig(pluginId: string, config: PluginConfigMap): PluginStateRecord {
    const current = this.getOrDefault(pluginId)
    return this.write(pluginId, current.enabled, config)
  }

  clearConfig(pluginId: string): PluginStateRecord {
    const current = this.getOrDefault(pluginId)
    return this.write(pluginId, current.enabled, {})
  }

  private write(pluginId: string, enabled: boolean, config: PluginConfigMap): PluginStateRecord {
    const updatedAt = nowIso()
    // 只留标量：配置值本来就只支持 string / number / boolean，
    // 存进去一个对象会让下次读回来的类型与清单声明不符，插件侧更难查
    const clean: PluginConfigMap = {}
    for (const [key, value] of Object.entries(config)) {
      if (isScalar(value)) clean[key] = value
    }

    this.db
      .prepare(
        `INSERT INTO plugin_state (plugin_id, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(pluginId, enabled ? 1 : 0, JSON.stringify(clean), updatedAt)

    return { pluginId, enabled, config: clean, updatedAt }
  }
}

function isScalar(value: unknown): value is PluginConfigValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function toRecord(row: PluginStateDbRow): PluginStateRecord {
  let config: PluginConfigMap = {}
  try {
    const parsed: unknown = JSON.parse(row.config_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isScalar(value)) config[key] = value
      }
    }
  } catch {
    // 配置 JSON 损坏不该让整个插件列表打不开：退回空覆盖（即全部用清单默认值）
    config = {}
  }
  return {
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    config,
    updatedAt: row.updated_at,
  }
}
