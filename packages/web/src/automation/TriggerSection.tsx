/**
 * 触发器分区：规则列表 + 常备规则入口。
 *
 * 列表上刻意突出三样东西，它们都是「出事了才会去看」的信息：
 * - **作用域**：一条全局规则和一条会话级规则的杀伤范围完全不同
 * - **命中次数 / 最近触发时间**：规则会不会触发是唯一能证明它配对了的证据
 * - **lastError**：引用了一个被删掉的脚本时，规则本身还在，只是每次命中都悄悄失败。
 *   不把这条错误摆在列表上，用户会一直以为它在工作。
 */
import { useEffect, useState } from 'react'
import {
  TRIGGER_PRESETS,
  describeTrigger,
  describeTriggerPattern,
  type TriggerRule,
} from '@webterm/shared'
import { useAutomationStore } from '../store/useAutomationStore'
import { TriggerDialog } from './TriggerDialog'
import {
  Chip,
  EmptyState,
  SectionHeader,
  dangerButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui'

export function TriggerSection() {
  const triggers = useAutomationStore((s) => s.triggers)
  const stats = useAutomationStore((s) => s.stats)
  const loading = useAutomationStore((s) => s.loading)
  const announce = useAutomationStore((s) => s.announceInTerminal)
  const setAnnounce = useAutomationStore((s) => s.setAnnounceInTerminal)
  const hits = useAutomationStore((s) => s.hits)
  const clearHits = useAutomationStore((s) => s.clearHits)

  const [editing, setEditing] = useState<TriggerRule | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (triggers.length === 0) void useAutomationStore.getState().refreshTriggers()
  }, [triggers.length])

  const refresh = () => void useAutomationStore.getState().refreshTriggers()

  return (
    <div className="space-y-4">
      <SectionHeader
        title="触发器"
        description="在终端输出上逐行匹配，命中后立即执行一组动作。自动应答由服务端原地完成，不依赖浏览器是否在看着这个标签。"
      >
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            data-testid="trigger-announce-toggle"
            checked={announce}
            onChange={(e) => setAnnounce(e.target.checked)}
          />
          命中时在终端里回显一行提示
        </label>
        <button
          type="button"
          data-testid="trigger-new"
          onClick={() => {
            setEditing(null)
            setCreating(true)
            setDialogOpen(true)
          }}
          className={primaryButtonClass}
        >
          + 新建规则
        </button>
      </SectionHeader>

      {/* 常备规则：让用户不必从零开始写正则 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">常备规则：</span>
        {TRIGGER_PRESETS.map((preset) => (
          <button
            key={preset.name}
            type="button"
            title={preset.description}
            data-testid={`trigger-preset-${preset.name}`}
            onClick={() => {
              void useAutomationStore
                .getState()
                .createTrigger({
                  name: preset.name,
                  pattern: preset.pattern,
                  matchMode: preset.matchMode,
                  flags: preset.flags,
                  actions: preset.actions,
                })
                .catch(() => {})
            }}
            className="rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {preset.name}
          </button>
        ))}
      </div>

      {loading && triggers.length === 0 ? (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">加载中…</p>
      ) : triggers.length === 0 ? (
        <EmptyState>
          还没有任何规则。可以从上面的常备规则一键添加，或点「+ 新建规则」自己写一条。
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="trigger-list">
          {triggers.map((rule) => {
            const stat = stats[rule.id]
            const lastError = stat?.lastError
            return (
              <li
                key={rule.id}
                data-testid={`trigger-row-${rule.id}`}
                data-enabled={rule.enabled ? 'true' : 'false'}
                className="rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-100">
                        {rule.name}
                      </span>
                      <Chip tone={rule.scope === 'global' ? 'amber' : 'blue'}>
                        {rule.scope === 'global' ? '全局' : '会话级'}
                      </Chip>
                      <Chip>{rule.matchMode === 'text' ? '纯文本' : '正则'}</Chip>
                      {rule.enabled ? <Chip tone="green">启用</Chip> : <Chip>已停用</Chip>}
                      {stat && stat.hitCount > 0 ? (
                        <Chip tone="violet" title={stat.lastFiredAt ? `最近命中：${stat.lastFiredAt}` : undefined}>
                          命中 {stat.hitCount} 次
                        </Chip>
                      ) : (
                        <Chip title="还没有命中过 —— 检查一下模式是否匹配得上">未命中</Chip>
                      )}
                    </div>

                    <p className="mt-1 break-all font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
                      {describeTriggerPattern(rule)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                      {describeTrigger(rule)}
                    </p>
                    {rule.cooldownMs > 0 ? (
                      <p className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                        冷却 {rule.cooldownMs}ms
                      </p>
                    ) : null}

                    {lastError ? (
                      <p
                        data-testid={`trigger-error-${rule.id}`}
                        className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                      >
                        最近一次动作失败：{lastError}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      type="button"
                      data-testid={`trigger-toggle-${rule.id}`}
                      onClick={() => {
                        void useAutomationStore
                          .getState()
                          .setTriggerEnabled(rule.id, !rule.enabled)
                          .catch(() => {})
                      }}
                      className={secondaryButtonClass}
                    >
                      {rule.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      data-testid={`trigger-edit-${rule.id}`}
                      onClick={() => {
                        setEditing(rule)
                        setCreating(false)
                        setDialogOpen(true)
                      }}
                      className={secondaryButtonClass}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      data-testid={`trigger-delete-${rule.id}`}
                      onClick={() => {
                        if (!window.confirm(`删除规则「${rule.name}」？`)) return
                        void useAutomationStore.getState().removeTrigger(rule.id).catch(() => {})
                      }}
                      className={dangerButtonClass}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* 命中记录：调试规则时最有用的东西 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            命中记录（本次会话内，最多保留 200 条）
          </span>
          {hits.length > 0 ? (
            <button type="button" onClick={() => clearHits()} className={secondaryButtonClass}>
              清空
            </button>
          ) : null}
        </div>
        {hits.length === 0 ? (
          <EmptyState>还没有命中记录。规则配上之后，触发一次就能在这里看到完整过程。</EmptyState>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="trigger-hits">
            {hits.map((hit) => (
              <li
                key={hit.id}
                className="rounded border border-neutral-200 px-2 py-1.5 text-[11px] dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone="violet">{hit.ruleName}</Chip>
                  <Chip>{hit.tabTitle}</Chip>
                  {hit.notified ? <Chip tone="green">已弹通知</Chip> : null}
                  {hit.labels.map((label) => (
                    <Chip key={label} tone="blue">{`标签：${label}`}</Chip>
                  ))}
                  <span className="ml-auto text-[10px] text-neutral-400 dark:text-neutral-500">
                    {new Date(hit.at).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-neutral-700 dark:text-neutral-300">
                  {hit.line}
                </p>
                <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
                  匹配片段 {JSON.stringify(hit.matched)}
                  {hit.performed.length > 0 ? ` · ${hit.performed.join('；')}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialogOpen ? (
        <TriggerDialog
          editing={creating ? undefined : editing ?? undefined}
          onClose={() => setDialogOpen(false)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  )
}
