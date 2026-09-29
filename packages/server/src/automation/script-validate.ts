/**
 * 脚本语法校验。
 *
 * 用与 worker 里**完全相同的包装**去编译：只有这样才能保证
 * 「编辑器里校验通过」等价于「运行前能编译出来」。
 * 若这里用一套包装、运行时用另一套，会出现「保存时说不合法、运行却又能跑」
 * 这种让人无所适从的分歧（例如是否允许顶层 `return`）。
 *
 * 只编译不执行：校验接口不该有任何副作用。
 */
import vm from 'node:vm'
import { SCRIPT_FILENAME } from './script-worker-source.js'

export interface ScriptValidationResult {
  ok: boolean
  error?: string
  /** 出错行号（相对用户代码，从 1 开始；拿不到时为 undefined） */
  line?: number
}

export function validateScriptSyntax(code: string): ScriptValidationResult {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: SCRIPT_FILENAME,
      // 减去包装行，让报出的行号与编辑器里看到的行号一致
      lineOffset: -1,
    })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const line = extractLine(err)
    return line === undefined ? { ok: false, error: message } : { ok: false, error: message, line }
  }
}

function extractLine(err: unknown): number | undefined {
  const stack = (err as { stack?: unknown }).stack
  if (typeof stack !== 'string') return undefined
  const match = /webterm-script\.js:(\d+)/.exec(stack)
  return match ? Number(match[1]) : undefined
}
