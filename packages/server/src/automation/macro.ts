/**
 * 宏执行器：把一串 `[{send, delay, expect}]` 按顺序跑完。
 *
 * 「多步宏」的价值在于把设备交互固化成一次点击，最典型的例子是
 * 交换机上的分页开关（`screen-length 0` 前要先 `system-view`、`undo info-center enable`）。
 * 因此每一步都可能需要「等上一步的输出出现」才继续 —— `expect` 就是这个用途。
 *
 * `delayMs` 与 `expect` 不合并成一个字段：前者是「无条件等一会儿」
 * （对端不输出任何东西时唯一可用），后者是「等到为止（有上限）」，用途不同。
 *
 * 与脚本引擎的分工：宏是**声明式**的（用户看不懂 JS 也能配），脚本是**编程式**的。
 * 两者都建在同一个 TerminalTap 之上，因此「等待输出」的行为完全一致。
 */
import type { MacroStep } from '@webterm/shared'
import {
  MACRO_DEFAULT_EXPECT_TIMEOUT_MS,
  MACRO_MAX_DELAY_MS,
  MACRO_MAX_EXPECT_TIMEOUT_MS,
  describeMacroStep,
} from '@webterm/shared'
import { AutomationFailure } from './errors.js'
import { TerminalTap } from './script-terminal.js'

export interface MacroProgressEvent {
  runId: string
  macroName: string
  phase: 'start' | 'step' | 'done' | 'error'
  /** phase = step 时的当前步序号，从 1 开始 */
  stepIndex?: number
  stepCount?: number
  /** 该步在做什么的摘要（界面上回显，让用户知道跑到哪了） */
  detail?: string
  error?: string
  at: string
}

export interface MacroRunDeps {
  logger: {
    debug: (obj: unknown, msg?: string) => void
    warn: (obj: unknown, msg?: string) => void
  }
  /** 订阅宿主会话的输出文本；返回退订函数 */
  subscribeOutput: (terminalId: string, fn: (text: string) => void) => (() => void) | undefined
  /** 把文本写回远端；返回 false 表示会话已关闭 */
  writeToRemote: (terminalId: string, text: string) => boolean
  /** 会话是否仍可承载数据 */
  isAlive: (terminalId: string) => boolean
  emit: (event: MacroProgressEvent) => void
}

export interface RunMacroOptions {
  runId: string
  macroName: string
  terminalId: string
  steps: MacroStep[]
  deps: MacroRunDeps
}

export async function runMacro(opts: RunMacroOptions): Promise<void> {
  const { deps, steps, terminalId, runId, macroName } = opts

  if (steps.length === 0) {
    throw new AutomationFailure('INVALID', '宏没有任何步骤')
  }

  const tap = new TerminalTap()
  const unsubscribe = deps.subscribeOutput(terminalId, (text) => tap.feed(text))
  const emit = (partial: Omit<MacroProgressEvent, 'runId' | 'macroName' | 'at'>): void => {
    deps.emit({ runId, macroName, at: new Date().toISOString(), ...partial })
  }

  emit({ phase: 'start', stepCount: steps.length })

  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      if (!step) continue

      if (!deps.isAlive(terminalId)) {
        throw new AutomationFailure('SESSION_CLOSED', '宿主会话已关闭，宏已中止')
      }

      emit({
        phase: 'step',
        stepIndex: index + 1,
        stepCount: steps.length,
        detail: describeMacroStep(step, index),
      })

      // `send: ''` 是有意义的配置（只发一个回车），所以判据是 undefined 而不是空串
      if (step.send !== undefined) {
        const payload = step.enter === false ? step.send : `${step.send}\r`
        if (!deps.writeToRemote(terminalId, payload)) {
          throw new AutomationFailure('SESSION_CLOSED', '宿主会话已关闭，无法发送数据')
        }
      }

      const delayMs = clampDelay(step.delayMs)
      if (delayMs > 0) await sleep(delayMs)

      if (step.expect) {
        // 超时由 tap 负责抛 AutomationFailure('TIMEOUT')，附带模式与耗时
        await tap.waitFor(step.expect, { timeoutMs: clampExpectTimeout(step.expectTimeoutMs) })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.warn({ runId, macroName, err: message }, '宏执行失败')
    emit({ phase: 'error', error: message })
    throw err
  } finally {
    unsubscribe?.()
    tap.dispose('宏执行结束')
  }

  emit({ phase: 'done', stepCount: steps.length })
}

function clampDelay(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(MACRO_MAX_DELAY_MS, Math.max(0, Math.trunc(value)))
}

function clampExpectTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MACRO_DEFAULT_EXPECT_TIMEOUT_MS
  return Math.min(MACRO_MAX_EXPECT_TIMEOUT_MS, Math.max(100, Math.trunc(value)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
