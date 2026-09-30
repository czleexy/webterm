/**
 * 插件面板（阶段 9）。
 *
 * 与自动化面板同一种外壳：覆盖式弹窗。插件是低频配置的东西，
 * 但要能一眼看到「哪些加载失败了、失败在哪一行」—— 所以列表按
 * 「有问题的排在前面」排序，而不是按字母序。
 *
 * 空状态不是一句「暂无插件」，而是一段可照抄的清单 + 目录路径：
 * 插件机制最常见的卡点是「我该把文件放在哪儿、清单长什么样」。
 */
import { useEffect } from 'react'
import { usePluginStore } from '../store/usePluginStore'
import { PluginCard } from './PluginCard'
import { hintClass, secondaryButtonClass } from '../automation/ui'

/** 状态排序权重：出错的排最前，其次是停用的，正常加载的垫底 */
const STATE_WEIGHT: Record<string, number> = { error: 0, disabled: 1, ready: 2 }

export function PluginsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const plugins = usePluginStore((s) => s.plugins)
  const dir = usePluginStore((s) => s.dir)
  const apiVersion = usePluginStore((s) => s.apiVersion)
  const loading = usePluginStore((s) => s.loading)
  const error = usePluginStore((s) => s.error)
  const refresh = usePluginStore((s) => s.refresh)
  const rescan = usePluginStore((s) => s.rescan)

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  // Esc 关闭：面板覆盖全屏，没有键盘出口会让人下意识去点遮罩
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  const sorted = [...plugins].sort((a, b) => {
    const weight = (STATE_WEIGHT[a.state] ?? 9) - (STATE_WEIGHT[b.state] ?? 9)
    return weight !== 0 ? weight : a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
  const readyCount = plugins.filter((p) => p.state === 'ready').length
  const errorCount = plugins.filter((p) => p.state === 'error').length

  return (
    <div
      data-testid="plugins-panel"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[5vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">插件</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              插件把能力注册给宿主：<span className="font-mono">触发器动作</span> 出现在触发器编辑器的下拉里，
              <span className="font-mono">命令</span> 与 <span className="font-mono">面板</span> 在下面直接可用
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[10px] text-neutral-400 dark:text-neutral-500">
              <span>
                已加载 {readyCount} / {plugins.length}
                {errorCount > 0 ? `　加载失败 ${errorCount}` : ''}
              </span>
              <span className="font-mono">API v{apiVersion}</span>
              <span className="font-mono break-all">目录 {dir || '（未返回）'}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="plugins-rescan"
              onClick={() => void rescan()}
              className={secondaryButtonClass}
            >
              重新扫描目录
            </button>
            <button
              type="button"
              data-testid="plugins-close"
              onClick={onClose}
              className={secondaryButtonClass}
            >
              关闭
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {error ? (
            <pre className="whitespace-pre-wrap break-all rounded-md border border-red-200 bg-red-50 p-2 font-mono text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </pre>
          ) : null}

          {loading && plugins.length === 0 ? (
            <p className={hintClass}>正在读取插件列表…</p>
          ) : null}

          {!loading && plugins.length === 0 ? (
            <div
              data-testid="plugins-empty"
              className="rounded-lg border border-dashed border-neutral-300 p-4 dark:border-neutral-700"
            >
              <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                还没有插件
              </p>
              <p className={`${hintClass} mt-1`}>
                在{' '}
                <span className="font-mono break-all">{dir || 'data/plugins'}</span>{' '}
                下建一个目录，放一个 <span className="font-mono">plugin.json</span> 与入口文件，
                然后点「重新扫描目录」即可。最小清单：
              </p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-neutral-50 p-2 font-mono text-[10px] leading-relaxed text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">{`{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": ${apiVersion}
}`}</pre>
              <p className={`${hintClass} mt-2`}>
                入口文件里用全局的 <span className="font-mono">host</span> 注册能力：
                <span className="font-mono">
                  {' '}
                  host.registerTriggerAction / registerCommand / registerPanel / on / notify
                </span>
                。仓库里的 <span className="font-mono">data/plugins/heartbeat-monitor</span> 是一份可直接抄的示例。
              </p>
            </div>
          ) : null}

          {sorted.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} />
          ))}
        </div>
      </div>
    </div>
  )
}
