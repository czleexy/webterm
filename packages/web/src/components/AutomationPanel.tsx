/**
 * 自动化面板外壳（阶段 6）。
 *
 * 四个分区共用一个面板而不是四个独立入口：它们服务的是同一件事 ——
 * 「让重复的操作自动发生」，用户在配置规则时经常需要顺手去看一眼按钮或脚本，
 * 来回关开窗口会把上下文打断。
 *
 * 分区内容各自成文件（automation/*Section.tsx）：触发器带正则试匹配、
 * 脚本带代码编辑器，任何一个塞进这里都会让本文件迅速失控。
 */
import { useEffect } from 'react'
import {
  AUTOMATION_SECTIONS,
  AUTOMATION_SECTION_LABEL,
  useAutomationStore,
  type AutomationSection,
} from '../store/useAutomationStore'
import { TriggerSection } from '../automation/TriggerSection'
import { MacroSection } from '../automation/MacroSection'
import { ScriptSection } from '../automation/ScriptSection'
import { BatchSection } from '../automation/BatchSection'
import { cn } from '../utils/cn'

export function AutomationPanel() {
  const open = useAutomationStore((s) => s.panelOpen)
  const section = useAutomationStore((s) => s.section)
  const setSection = useAutomationStore((s) => s.setSection)
  const closePanel = useAutomationStore((s) => s.closePanel)
  const error = useAutomationStore((s) => s.error)
  const setError = useAutomationStore((s) => s.setError)
  const triggers = useAutomationStore((s) => s.triggers)
  const macros = useAutomationStore((s) => s.macros)
  const scripts = useAutomationStore((s) => s.scripts)

  // Esc 关闭：面板很大且覆盖全屏，没有键盘出口会让人下意识去点遮罩
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePanel, open])

  if (!open) return null

  /** 分区标题上的计数：一眼能看出「我一共有多少条规则在跑」 */
  const countOf: Record<AutomationSection, number> = {
    triggers: triggers.filter((t) => t.enabled).length,
    macros: macros.length,
    scripts: scripts.length,
    batch: 0,
  }

  return (
    <div
      data-testid="automation-panel"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[5vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePanel()
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div>
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              自动化与批量运维
            </h2>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              触发器在服务端就地完成自动应答与脚本调用，只把需要界面配合的动作推给浏览器
            </p>
          </div>
          <button
            type="button"
            data-testid="automation-close"
            onClick={closePanel}
            className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-3 dark:border-neutral-800">
          {AUTOMATION_SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`automation-tab-${id}`}
              onClick={() => setSection(id)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-xs transition-colors',
                section === id
                  ? 'border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
              )}
            >
              {AUTOMATION_SECTION_LABEL[id]}
              {countOf[id] > 0 ? (
                <span className="ml-1.5 rounded bg-neutral-100 px-1 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {countOf[id]}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {error ? (
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 rounded border border-red-300 px-1.5 py-0.5 dark:border-red-800"
            >
              知道了
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {section === 'triggers' ? <TriggerSection /> : null}
          {section === 'macros' ? <MacroSection /> : null}
          {section === 'scripts' ? <ScriptSection /> : null}
          {section === 'batch' ? <BatchSection /> : null}
        </div>
      </div>
    </div>
  )
}
