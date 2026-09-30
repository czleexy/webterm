/**
 * 插件清单（plugin.json）的解析与校验。
 *
 * 校验策略是**严格但解释清楚**：不合法就拒绝加载，并把「哪一条不合法、
 * 期望什么」原样写进错误信息。插件作者对着面板上的红字就能改对，
 * 不需要去翻源码 —— 这是插件机制能不能被用起来的分水岭。
 *
 * 路径安全：`main` 只允许是插件目录内的相对路径。
 * `../` 与绝对路径一律拒绝 —— 插件是本地可信代码没错，但「清单里能指向
 * 任意文件」意味着一次复制粘贴错误就能让服务端去执行一个不相干的文件，
 * 这种错误没有任何收益，只有风险。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  PLUGIN_API_VERSION,
  PLUGIN_DEFAULT_MAIN,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PERMISSIONS,
  type PluginConfigMap,
  type PluginManifest,
} from '@webterm/shared'
import { PluginFailure } from './errors.js'

/** 允许的入口扩展名：只接受 Node 能直接 import 的 JS 形式 */
const MAIN_EXTENSIONS = ['.js', '.mjs', '.cjs']

const ConfigFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, '配置项的 key 不能为空')
    .max(48, '配置项的 key 过长')
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '配置项的 key 只能是字母、数字与下划线，且不能以数字开头'),
  label: z.string().trim().min(1, '配置项的 label 不能为空').max(64, '配置项的 label 过长'),
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]),
  description: z.string().max(200, '配置项说明过长（最多 200 字）').optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

const ManifestSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, '插件 id 不能为空')
    .max(48, '插件 id 过长')
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, '插件 id 只能包含字母、数字、点、下划线与连字符'),
  name: z.string().trim().min(1, '插件名称不能为空').max(64, '插件名称过长'),
  version: z.string().trim().min(1, '插件版本不能为空').max(32, '插件版本过长'),
  description: z.string().max(300, '插件说明过长（最多 300 字）').optional(),
  author: z.string().max(64, '作者字段过长').optional(),
  apiVersion: z.number().int().positive('apiVersion 必须是正整数'),
  main: z.string().trim().min(1).max(200).optional(),
  config: z.array(ConfigFieldSchema).max(32, '配置项最多 32 个').optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).optional(),
})

export interface LoadedManifest {
  manifest: PluginManifest
  /** 入口文件的绝对路径（已确认在插件目录内） */
  entry: string
  /** 清单原始文本的 mtime（ISO），用于提示「文件改过，需要重载」 */
  mtime: string
}

/**
 * 读取并校验一个插件目录的清单。任何不合法都以 PluginFailure('MANIFEST') 抛出。
 */
export function loadManifest(pluginDir: string): LoadedManifest {
  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    throw new PluginFailure(
      'MANIFEST',
      `缺少 ${PLUGIN_MANIFEST_FILE}`,
      `插件目录里必须有一个 ${PLUGIN_MANIFEST_FILE}，例如：\n` +
        `{\n  "id": "my-plugin",\n  "name": "我的插件",\n  "version": "1.0.0",\n  "apiVersion": ${PLUGIN_API_VERSION}\n}`,
    )
  }

  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (err) {
    throw new PluginFailure('MANIFEST', `无法读取 ${PLUGIN_MANIFEST_FILE}：${describeError(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new PluginFailure(
      'MANIFEST',
      `${PLUGIN_MANIFEST_FILE} 不是合法的 JSON：${describeError(err)}`,
      '常见原因是多了一个逗号、用了单引号，或写了注释（JSON 不支持注释）。',
    )
  }

  const result = ManifestSchema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(根)'}: ${issue.message}`)
      .join('\n')
    throw new PluginFailure('MANIFEST', `${PLUGIN_MANIFEST_FILE} 校验失败：\n${detail}`)
  }

  const data = result.data
  if (data.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginFailure(
      'MANIFEST',
      `apiVersion 不匹配：清单声明 ${data.apiVersion}，当前宿主只支持 ${PLUGIN_API_VERSION}`,
      '插件与宿主是一起升级的，请把清单里的 apiVersion 改成宿主支持的值（或升级 WebTerm）。',
    )
  }

  const entry = resolveEntry(pluginDir, data.main ?? PLUGIN_DEFAULT_MAIN)

  const manifest: PluginManifest = {
    id: data.id,
    name: data.name,
    version: data.version,
    apiVersion: data.apiVersion,
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.author !== undefined ? { author: data.author } : {}),
    ...(data.main !== undefined ? { main: data.main } : {}),
    ...(data.config !== undefined ? { config: data.config } : {}),
    ...(data.permissions !== undefined ? { permissions: data.permissions } : {}),
  }

  return { manifest, entry, mtime: new Date().toISOString() }
}

/** 校验入口路径：必须落在插件目录内且是 JS 文件 */
function resolveEntry(pluginDir: string, main: string): string {
  if (main.includes('\0')) {
    throw new PluginFailure('MANIFEST', 'main 含非法字符')
  }
  const normalizedMain = main.replace(/\\/g, '/')
  const entry = path.resolve(pluginDir, normalizedMain)
  const root = path.resolve(pluginDir)
  const rel = path.relative(root, entry)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PluginFailure('MANIFEST', `main 必须指向插件目录内的文件：${main}`)
  }
  if (!MAIN_EXTENSIONS.includes(path.extname(entry).toLowerCase())) {
    throw new PluginFailure(
      'MANIFEST',
      `main 只支持 ${MAIN_EXTENSIONS.join(' / ')} 结尾的文件：${main}`,
    )
  }
  if (!existsSync(entry)) {
    throw new PluginFailure('MANIFEST', `入口文件不存在：${main}`)
  }
  return entry
}

/**
 * 把清单里的默认值与用户覆盖合并成生效配置。
 *
 * 覆盖值要重新过一遍类型：用户在界面上填的是字符串（表单原生就是字符串），
 * 插件拿到的必须是它声明的类型 —— 否则 `config.intervalMs > 1000` 在
 * 字符串下会静默变成字典序比较，这种 bug 插件作者根本想不到。
 */
export function resolveConfig(
  manifest: PluginManifest,
  overrides: PluginConfigMap | undefined,
): PluginConfigMap {
  const config: PluginConfigMap = {}
  for (const field of manifest.config ?? []) {
    config[field.key] = field.default
  }
  if (!overrides) return config

  for (const field of manifest.config ?? []) {
    const raw = overrides[field.key]
    if (raw === undefined) continue
    const coerced = coerceConfigValue(field.type, raw, field.min, field.max)
    if (coerced !== undefined) config[field.key] = coerced
  }
  return config
}

/** 按声明类型转换；无法转换时返回 undefined（调用方保留默认值） */
export function coerceConfigValue(
  type: 'string' | 'number' | 'boolean',
  raw: unknown,
  min?: number,
  max?: number,
): string | number | boolean | undefined {
  if (type === 'string') {
    if (typeof raw === 'string') return raw
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    return undefined
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === '1' || raw === 1) return true
    if (raw === 'false' || raw === '0' || raw === 0) return false
    return undefined
  }
  // number：空串是「没填」，不当作 0
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(num)) return undefined
  if (min !== undefined && num < min) return min
  if (max !== undefined && num > max) return max
  return num
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
