/**
 * 按钮栏（多步宏）分区。
 *
 * 宏的本质是「把一串有秩序的输入固化下来」：发什么、等多久、等到什么再继续。
 * 因此步骤编辑器刻意保留了 `delayMs`（无条件等）与 `expect`（等到为止）两个字段，
 * 没有合并成「等待」一个概念 —— 它们的用途完全不同：
 * 前者用于「设备需要一点时间处理」，后者用于「必须看到提示符才能继续」。
 *
 * 执行需要绑定一个**存活终端**：宏是往真实连接里敲字符，没有终端就没有落点。
 * 这里的下拉只列出已经建立好连接的标签，避免用户选了一个还没连上的目标才发现跑不了。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  MACRO_DEFAULT_EXPECT_TIMEOUT_MS,
  MACRO_MAX_DELAY_MS,
  MACRO_MAX_EXPECT_TIMEOUT_MS,
  MACRO_MAX_STEPS,
  describeMacroStep,
  type MacroDefinition,
  type MacroStep,
} from '@webterm/shared'
import { runMacro } from '../api/client'
import { useAutomationStore } from '../store/useAutomationStore'
import { useTerminalStore } from '../store/useTerminalStore'
import {
  Chip,
  EmptyState,
  SectionHeader,
  dangerButtonClass,
  hintClass,
  inputClass,
  labelClass,
  monoInputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui'

const EMPTY_STEP: MacroStep = { send: '', enter: true }

export function MacroSection() {
  const macros = useAutomationStore((s) => s.macros)
  const macroRuns = useAutomationStore((s) => s.macroRuns)
  const setError = useAutomationStore((s) => s.setError)
  const tabs = useTerminalStore((s) => s.tabs)

  const [editing, setEditing] = useState<MacroDefinition | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<MacroStep[]>([{ ...EMPTY_STEP }])
  const [saving, setSaving] = useState(false)
  const [targetTabId, setTargetTabId] = useState('')

  useEffect(() => {
    if (macros.length === 0) void useAutomationStore.getState().refreshMacros()
  }, [macros.length])

  /** 只有真正建立了服务端终端的标签才能作为宏的落点 */
  const runnable = useMemo(() => tabs.filter((t) => Boolean(t.terminalId)), [tabs])

  // 目标终端被关掉后自动清空选择，否则「执行」按钮会一直指向一个不存在的会话
  useEffect(() => {
    if (targetTabId && !runnable.some((t) => t.id === targetTabId)) setTargetTabId('')
    if (!targetTabId && runnable.length > 0) setTargetTabId(runnable[0]?.id ?? '')
  }, [runnable, targetTabId])

  const resetForm = () => {
    setEditing(null)
    setName('')
    setDescription('')
    setSteps([{ ...EMPTY_STEP }])
  }

  const startEdit = (macro: MacroDefinition) => {
    setEditing(macro)
    setName(macro.name)
    setDescription(macro.description)
    setSteps(macro.steps.length > 0 ? macro.steps.map((s) => ({ ...s })) : [{ ...EMPTY_STEP }])
  }

  const patchStep = (index: number, patch: Partial<MacroStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const save = async () => {
    if (name.trim() === '') {
      setError('按钮名称不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body = { name: name.trim(), description: description.trim(), steps }
      if (editing) await useAutomationStore.getState().saveMacro(editing.id, body)
      else await useAutomationStore.getState().createMacro(body)
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const execute = async (macro: MacroDefinition) => {
    const tab = runnable.find((t) => t.id === targetTabId)
    if (!tab?.terminalId) {
      setError('请先选择一个已连接的终端作为执行目标')
      return
    }
    setError(null)
    try {
      await runMacro({ terminalId: tab.terminalId, macroId: macro.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="按钮栏"
        description="把「发送 → 等待 → 再发送」的多步操作固化成一次点击。执行进度会实时推送到目标终端。"
      >
        {runnable.length > 0 ? (
          <select
            data-testid="macro-target"
            className={`${inputClass} w-48`}
            value={targetTabId}
            onChange={(e) => setTargetTabId(e.target.value)}
          >
            {runnable.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title}
              </option>
            ))}
          </select>
        ) : null}
      </SectionHeader>

      {/* ---------- 编辑器 ---------- */}
      <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            {editing ? `编辑按钮：${editing.name}` : '新建按钮'}
          </span>
          {editing ? (
            <button type="button" onClick={resetForm} className={secondaryButtonClass}>
              取消编辑
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>名称</label>
            <input
              data-testid="macro-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：查看磁盘使用"
            />
          </div>
          <div>
            <label className={labelClass}>说明</label>
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这个按钮做什么"
            />
          </div>
        </div>

        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <label className={labelClass}>步骤</label>
            <button
              type="button"
              data-testid="macro-add-step"
              disabled={steps.length >= MACRO_MAX_STEPS}
              onClick={() => setSteps((prev) => [...prev, { ...EMPTY_STEP }])}
              className={secondaryButtonClass}
            >
              + 添加一步
            </button>
          </div>

          <ul className="space-y-2">
            {steps.map((step, index) => (
              <li
                key={index}
                className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <Chip tone="blue">{describeMacroStep(step, index)}</Chip>
                  <button
                    type="button"
                    onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                    className="text-[11px] text-red-600 hover:underline dark:text-red-400"
                  >
                    移除
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    data-testid={`macro-step-send-${index}`}
                    className={monoInputClass}
                    value={step.send ?? ''}
                    onChange={(e) => patchStep(index, { send: e.target.value })}
                    placeholder="要发送的命令（留空表示本步只等待）"
                  />
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={step.enter !== false}
                      onChange={(e) => patchStep(index, { enter: e.target.checked })}
                    />
                    回车
                  </label>
                </div>

                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  <div>
                    <span className={hintClass}>无条件等待（毫秒）</span>
                    <input
                      type="number"
                      min={0}
                      max={MACRO_MAX_DELAY_MS}
                      className={inputClass}
                      value={step.delayMs ?? 0}
                      onChange={(e) => patchStep(index, { delayMs: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <span className={hintClass}>直到输出出现（留空表示不等待）</span>
                    <input
                      data-testid={`macro-step-expect-${index}`}
                      className={monoInputClass}
                      value={step.expect ?? ''}
                      onChange={(e) => patchStep(index, { expect: e.target.value })}
                      placeholder="例如：$ 或 Password:"
                    />
                  </div>
                </div>

                {step.expect ? (
                  <div className="mt-1.5">
                    <span className={hintClass}>等待上限（毫秒，超时按失败处理）</span>
                    <input
                      type="number"
                      min={1}
                      max={MACRO_MAX_EXPECT_TIMEOUT_MS}
                      className={inputClass}
                      value={step.expectTimeoutMs ?? MACRO_DEFAULT_EXPECT_TIMEOUT_MS}
                      onChange={(e) =>
                        patchStep(index, { expectTimeoutMs: Number(e.target.value) || undefined })
                      }
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            data-testid="macro-save"
            onClick={() => void save()}
            disabled={saving}
            className={primaryButtonClass}
          >
            {saving ? '保存中…' : editing ? '保存修改' : '创建按钮'}
          </button>
        </div>
      </div>

      {/* ---------- 列表 ---------- */}
      {macros.length === 0 ? (
        <EmptyState>还没有按钮。先在下面写好步骤，再点「创建按钮」。</EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="macro-list">
          {macros.map((macro) => (
            <li
              key={macro.id}
              data-testid={`macro-row-${macro.id}`}
              className="rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-neutral-900 dark:text-neutral-100">
                      {macro.name}
                    </span>
                    <Chip>{`${macro.steps.length} 步`}</Chip>
                  </div>
                  {macro.description ? (
                    <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                      {macro.description}
                    </p>
                  ) : null}
                  <ul className="mt-1 space-y-0.5">
                    {macro.steps.map((step, index) => (
                      <li key={index} className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
                        {describeMacroStep(step, index)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <button
                    type="button"
                    data-testid={`macro-run-${macro.id}`}
                    onClick={() => void execute(macro)}
                    disabled={runnable.length === 0}
                    title={runnable.length === 0 ? '需要一个已连接的终端' : '在选中终端上执行'}
                    className={primaryButtonClass}
                  >
                    执行
                  </button>
                  <button
                    type="button"
                    data-testid={`macro-edit-${macro.id}`}
                    onClick={() => startEdit(macro)}
                    className={secondaryButtonClass}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    data-testid={`macro-delete-${macro.id}`}
                    onClick={() => {
                      if (!window.confirm(`删除按钮「${macro.name}」？`)) return
                      void useAutomationStore.getState().removeMacro(macro.id).catch(() => {})
                    }}
                    className={dangerButtonClass}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ---------- 执行进度 ---------- */}
      {macroRuns.length > 0 ? (
        <div>
          <span className="mb-2 block text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            执行进度
          </span>
          <ul className="max-h-48 space-y-1 overflow-y-auto" data-testid="macro-runs">
            {macroRuns.map((run) => (
              <li
                key={run.runId}
                className="flex items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-[11px] dark:border-neutral-800"
              >
                <Chip
                  tone={
                    run.phase === 'done' ? 'green' : run.phase === 'error' ? 'red' : 'amber'
                  }
                >
                  {run.phase === 'start'
                    ? '开始'
                    : run.phase === 'step'
                      ? `第 ${run.stepIndex}/${run.stepCount} 步`
                      : run.phase === 'done'
                        ? '完成'
                        : '失败'}
                </Chip>
                <span className="text-neutral-700 dark:text-neutral-300">{run.macroName}</span>
                {run.detail ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-neutral-500 dark:text-neutral-400">
                    {run.detail}
                  </span>
                ) : null}
                {run.error ? (
                  <span className="text-red-600 dark:text-red-400">{run.error}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
