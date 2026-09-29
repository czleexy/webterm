/**
 * 终端里的按钮栏。
 *
 * 位置很关键：宏是「针对当前这个会话」的动作，所以按钮必须长在终端上，
 * 而不是只在自动化面板里。用户点「查看磁盘使用」时，心里想的是「在这个标签上跑」，
 * 让他先去面板选目标终端再回来，就是把最顺手的入口藏起来了。
 *
 * 只显示已配置的宏；一个都没有时整条不渲染，不给界面增加噪音。
 * 宏执行中按钮会禁用：服务端对同一会话的自动化任务加了互斥锁，
 * 但让用户点了才发现被拒是很差的体验 —— 直接置灰并说明原因。
 */
import { useMemo } from 'react'
import type { TerminalTab } from '../store/useTerminalStore'
import { useAutomationStore } from '../store/useAutomationStore'
import { runMacro } from '../api/client'
import { cn } from '../utils/cn'

export function MacroBar({ tab }: { tab: TerminalTab }) {
  const macros = useAutomationStore((s) => s.macros)
  const macroRuns = useAutomationStore((s) => s.macroRuns)
  const setError = useAutomationStore((s) => s.setError)

  /** 这个终端上正在跑的宏（同一会话同时只有一个） */
  const running = useMemo(
    () => macroRuns.find((r) => r.tabId === tab.id && (r.phase === 'start' || r.phase === 'step')),
    [macroRuns, tab.id],
  )

  if (macros.length === 0) return null

  const execute = async (macroId: string) => {
    if (!tab.terminalId) return
    try {
      await runMacro({ terminalId: tab.terminalId, macroId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const disabled = Boolean(running) || !tab.terminalId

  return (
    <div
      data-testid={`macro-bar-${tab.id}`}
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-3 py-1 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <span className="mr-1 text-[10px] text-neutral-400 dark:text-neutral-500">按钮栏</span>
      {macros.map((macro) => (
        <button
          key={macro.id}
          type="button"
          data-testid={`macro-bar-run-${macro.id}`}
          onClick={() => void execute(macro.id)}
          disabled={disabled}
          title={
            !tab.terminalId
              ? '终端尚未就绪'
              : running
                ? `正在执行「${running.macroName}」，同一会话同时只能跑一个`
                : macro.description || macro.name
          }
          className={cn(
            'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
            running
              ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
              : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700',
          )}
        >
          {macro.name}
        </button>
      ))}
      {running ? (
        <span className="ml-1 text-[10px] text-amber-700 dark:text-amber-300">
          {running.phase === 'step'
            ? `执行中 ${running.stepIndex}/${running.stepCount}${running.detail ? ` · ${running.detail}` : ''}`
            : '执行中…'}
        </span>
      ) : null}
    </div>
  )
}
