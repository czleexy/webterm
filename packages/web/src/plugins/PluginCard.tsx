/**
 * 单个插件的卡片（阶段 9）。
 *
 * 信息的排布顺序是按「用户此刻要回答的问题」来的：
 *   1. 它现在是什么状态？（徽标 + 出错原因，最重要，故置顶）
 *   2. 我能让它做什么？（触发器动作 / 命令 / 面板）
 *   3. 它要我配什么？（清单声明的配置项）
 *   4. 它刚才做了什么？（日志）
 * 把日志放在最下面不是因为它不重要，而是因为它是「出事之后才看」的东西。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  PLUGIN_EVENT_LABEL,
  PLUGIN_PERMISSION_LABEL,
  type PluginConfigMap,
  type PluginConfigValue,
  type PluginInfo,
  type PluginLogLevel,
  type PluginPanelData,
} from '@webterm/shared'
import { usePluginStore } from '../store/usePluginStore'
import { Chip, cardClass, hintClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '../automation/ui'
import { cn } from '../utils/cn'

const STATE_LABEL: Record<PluginInfo['state'], string> = {
  ready: '已加载',
  error: '加载失败',
  disabled: '已停用',
}

const STATE_TONE: Record<PluginInfo['state'], 'green' | 'red' | 'neutral'> = {
  ready: 'green',
  error: 'red',
  disabled: 'neutral',
}

const LOG_TONE: Record<PluginLogLevel, string> = {
  debug: 'text-neutral-400 dark:text-neutral-500',
  info: 'text-neutral-600 dark:text-neutral-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
}

function timeOf(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString('zh-CN', { hour12: false })
}

export function PluginCard({ plugin }: { plugin: PluginInfo }) {
  const setEnabled = usePluginStore((s) => s.setEnabled)
  const reload = usePluginStore((s) => s.reload)
  const saveConfig = usePluginStore((s) => s.saveConfig)
  const runCommand = usePluginStore((s) => s.runCommand)
  const loadPanel = usePluginStore((s) => s.loadPanel)

  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [expandedPanel, setExpandedPanel] = useState<string | null>(null)
  const [panelData, setPanelData] = useState<PluginPanelData | null>(null)
  const [panelLoading, setPanelLoading] = useState(false)
  const [showLogs, setShowLogs] = useState(false)

  /**
   * 配置表单的本地副本。
   * 依赖 [plugin.id, plugin.config] 重建：服务端是唯一真相，
   * 提交成功后 store 会用响应覆盖，本地副本跟着刷新，不会出现
   * 「界面显示的值和实际生效的值不一样」这种最难查的状态。
   */
  const [form, setForm] = useState<PluginConfigMap>(() => ({ ...plugin.config }))
  useEffect(() => {
    setForm({ ...plugin.config })
  }, [plugin.id, plugin.config])

  const dirty = useMemo(
    () =>
      plugin.configFields.some((field) => String(form[field.key]) !== String(plugin.config[field.key])),
    [form, plugin.config, plugin.configFields],
  )

  /** 入口文件比加载时间新 → 提示用户重载（改了代码不重载是最常见的困惑） */
  const changedOnDisk =
    plugin.state === 'ready' && plugin.mtime !== undefined && plugin.loadedAt !== undefined
      ? new Date(plugin.mtime).getTime() > new Date(plugin.loadedAt).getTime() + 1000
      : false

  const act = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setNote(null)
    try {
      await fn()
    } catch (err) {
      setNote({ tone: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const fetchPanel = async (panelId: string): Promise<void> => {
    setPanelLoading(true)
    try {
      setPanelData(await loadPanel(plugin.id, panelId))
    } catch (err) {
      // 取数失败不该让整张卡片变成错误页：给一张空表 + 原因，其余能力照常可用
      setPanelData({
        columns: [],
        rows: [],
        note: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      })
    } finally {
      setPanelLoading(false)
    }
  }

  const togglePanel = async (panelId: string): Promise<void> => {
    if (expandedPanel === panelId) {
      setExpandedPanel(null)
      setPanelData(null)
      return
    }
    setExpandedPanel(panelId)
    await fetchPanel(panelId)
  }

  const setConfigValue = (key: string, type: string, raw: string | boolean): void => {
    setForm((prev) => ({
      ...prev,
      [key]: type === 'boolean' ? Boolean(raw) : raw,
    }))
  }

  return (
    <div data-testid={`plugin-${plugin.id}`} data-state={plugin.state} className={cn(cardClass, 'p-3')}>
      {/* 头部：名称 / 版本 / 状态 / 开关 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {plugin.name}
            </span>
            <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
              v{plugin.version}
            </span>
            <Chip tone={STATE_TONE[plugin.state]} title={`state=${plugin.state}`}>
              {STATE_LABEL[plugin.state]}
            </Chip>
            <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {plugin.id}
            </span>
            {changedOnDisk ? (
              <Chip tone="amber" title={`入口文件修改于 ${timeOf(plugin.mtime)}，加载于 ${timeOf(plugin.loadedAt)}`}>
                文件已改动
              </Chip>
            ) : null}
          </div>
          {plugin.description ? (
            <p className="mt-1 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
              {plugin.description}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {changedOnDisk || plugin.state === 'error' ? (
            <button
              type="button"
              data-testid={`plugin-reload-${plugin.id}`}
              disabled={busy !== null}
              onClick={() => void act('reload', () => reload(plugin.id))}
              className={secondaryButtonClass}
            >
              {busy === 'reload' ? '重载中…' : '重新加载'}
            </button>
          ) : null}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-600 dark:text-neutral-400">
            <input
              type="checkbox"
              data-testid={`plugin-toggle-${plugin.id}`}
              checked={plugin.enabled}
              disabled={busy !== null}
              onChange={(e) => {
                const next = e.target.checked
                void act('toggle', () => setEnabled(plugin.id, next))
              }}
            />
            启用
          </label>
        </div>
      </div>

      {/* 出错原因：必须是整段可读的错误，而不是一句「加载失败」 */}
      {plugin.state === 'error' && plugin.error ? (
        <pre
          data-testid={`plugin-error-${plugin.id}`}
          className="mt-2 whitespace-pre-wrap break-all rounded-md border border-red-200 bg-red-50 p-2 font-mono text-[11px] leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
        >
          {plugin.error}
        </pre>
      ) : null}

      {/* 能力概览 */}
      {plugin.state === 'ready' ? (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
          {plugin.triggerActions.map((action) => (
            <Chip key={action.id} tone="violet" title={`触发器动作 ${plugin.id}:${action.id}`}>
              触发器动作 · {action.label}
            </Chip>
          ))}
          {plugin.panels.map((panel) => (
            <Chip key={panel.id} tone="blue">
              面板 · {panel.title}
            </Chip>
          ))}
          {plugin.commands.map((command) => (
            <Chip key={command.id} tone="green">
              命令 · {command.label}
            </Chip>
          ))}
          {plugin.subscriptions.map((event) => (
            <Chip key={event} tone="neutral">
              订阅 · {PLUGIN_EVENT_LABEL[event]}
            </Chip>
          ))}
          {(plugin.permissions ?? []).map((permission) => (
            <Chip key={permission} tone="amber" title={`声明能力：${PLUGIN_PERMISSION_LABEL[permission]}`}>
              {PLUGIN_PERMISSION_LABEL[permission]}
            </Chip>
          ))}
        </div>
      ) : null}

      {/* 配置 */}
      {plugin.configFields.length > 0 ? (
        <div className="mt-3 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
          <div className="mb-1.5 text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            配置（保存后立即生效，插件无需重载）
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {plugin.configFields.map((field) => {
              const value = form[field.key] ?? field.default
              const id = `plugin-${plugin.id}-${field.key}`
              return (
                <div key={field.key}>
                  <label className={labelClass} htmlFor={id}>
                    {field.label}
                    <span className="ml-1 font-mono text-[10px] text-neutral-400">{field.key}</span>
                  </label>
                  {field.type === 'boolean' ? (
                    <label className="flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
                      <input
                        id={id}
                        data-testid={id}
                        type="checkbox"
                        checked={value === true}
                        onChange={(e) => setConfigValue(field.key, field.type, e.target.checked)}
                      />
                      启用
                    </label>
                  ) : (
                    <input
                      id={id}
                      data-testid={id}
                      className={inputClass}
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(value)}
                      min={field.min}
                      max={field.max}
                      onChange={(e) => setConfigValue(field.key, field.type, e.target.value)}
                    />
                  )}
                  {field.description ? <p className={hintClass}>{field.description}</p> : null}
                </div>
              )
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid={`plugin-save-${plugin.id}`}
              disabled={!dirty || busy !== null}
              onClick={() =>
                void act('save', async () => {
                  await saveConfig(plugin.id, form as Record<string, PluginConfigValue>)
                  setNote({ tone: 'ok', text: '配置已保存并立即生效' })
                })
              }
              className={primaryButtonClass}
            >
              {busy === 'save' ? '保存中…' : '保存配置'}
            </button>
            {dirty ? (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">有未保存的改动</span>
            ) : null}
            <span className="ml-auto text-[10px] text-neutral-400 dark:text-neutral-500">
              目录 {plugin.dir}
            </span>
          </div>
        </div>
      ) : null}

      {/* 命令 */}
      {plugin.commands.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-400">命令</span>
          {plugin.commands.map((command) => (
            <button
              key={command.id}
              type="button"
              data-testid={`plugin-command-${plugin.id}-${command.id}`}
              title={command.description ?? command.label}
              disabled={busy !== null}
              onClick={() =>
                void act(`cmd-${command.id}`, async () => {
                  const result = await runCommand(plugin.id, command.id)
                  setNote(
                    result.ok
                      ? { tone: 'ok', text: result.message ?? '已执行' }
                      : { tone: 'error', text: result.message ?? '执行失败' },
                  )
                })
              }
              className={secondaryButtonClass}
            >
              {busy === `cmd-${command.id}` ? '执行中…' : command.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* 面板 */}
      {plugin.panels.length > 0 ? (
        <div className="mt-3 space-y-2">
          {plugin.panels.map((panel) => (
            <div key={panel.id} className="rounded-md border border-neutral-200 dark:border-neutral-800">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  data-testid={`plugin-panel-${plugin.id}-${panel.id}`}
                  onClick={() => void togglePanel(panel.id)}
                  className="text-[11px] font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                >
                  {expandedPanel === panel.id ? '▾' : '▸'} {panel.title}
                </button>
                {panel.description ? (
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                    {panel.description}
                  </span>
                ) : null}
                {expandedPanel === panel.id ? (
                  <button
                    type="button"
                    data-testid={`plugin-panel-refresh-${plugin.id}-${panel.id}`}
                    disabled={panelLoading}
                    onClick={() => void fetchPanel(panel.id)}
                    className="ml-auto text-[10px] text-neutral-500 hover:underline dark:text-neutral-400"
                  >
                    刷新
                  </button>
                ) : null}
              </div>
              {expandedPanel === panel.id ? (
                <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
                  {panelLoading ? (
                    <p className="text-[11px] text-neutral-500 dark:text-neutral-400">正在取数…</p>
                  ) : panelData ? (
                    <>
                      {panelData.rows.length === 0 || panelData.columns.length === 0 ? (
                        <p data-testid={`plugin-panel-empty-${plugin.id}-${panel.id}`} className={hintClass}>
                          {panelData.note ?? '插件没有返回数据'}
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-[11px]">
                            <thead>
                              <tr className="text-neutral-500 dark:text-neutral-400">
                                {panelData.columns.map((column, index) => (
                                  <th key={`${column}-${index}`} className="whitespace-nowrap py-1 pr-3 font-medium">
                                    {column}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {panelData.rows.map((row, rowIndex) => (
                                <tr
                                  key={rowIndex}
                                  className="border-t border-neutral-100 text-neutral-700 dark:border-neutral-800 dark:text-neutral-300"
                                >
                                  {row.map((cell, cellIndex) => (
                                    <td key={cellIndex} className="whitespace-nowrap py-1 pr-3 font-mono">
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">
                        {panelData.note ? `${panelData.note}　·　` : ''}
                        取数于 {timeOf(panelData.updatedAt)}
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* 操作结果 */}
      {note ? (
        <p
          data-testid={`plugin-note-${plugin.id}`}
          className={cn(
            'mt-2 text-[11px]',
            note.tone === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400',
          )}
        >
          {note.text}
        </p>
      ) : null}

      {/* 日志 */}
      <div className="mt-2">
        <button
          type="button"
          data-testid={`plugin-logs-toggle-${plugin.id}`}
          onClick={() => setShowLogs((v) => !v)}
          className="text-[11px] text-neutral-500 hover:underline dark:text-neutral-400"
        >
          {showLogs ? '▾' : '▸'} 日志（{plugin.logs.length}）
        </button>
        {showLogs ? (
          <div
            data-testid={`plugin-logs-${plugin.id}`}
            className="mt-1 max-h-40 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 font-mono text-[10px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-950"
          >
            {plugin.logs.length === 0 ? (
              <p className="text-neutral-400 dark:text-neutral-500">（暂无日志）</p>
            ) : (
              plugin.logs.map((log, index) => (
                <p key={index} className={LOG_TONE[log.level]}>
                  {timeOf(log.at)} [{log.level}] {log.message}
                </p>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
