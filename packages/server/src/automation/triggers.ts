/**
 * 触发器引擎：在终端输出上做行匹配，命中后执行一组动作。
 *
 * 分工（这是本模块最需要说清楚的一点）：
 * - **模式判定**（要不要触发、命中哪一段）必须先做，且只做一次
 * - **动作执行**按类型分流：`send` 与 `script` 在服务端就地完成；
 *   `highlight` / `notify` / `label` 只能由渲染端完成，服务端推一条消息过去
 *
 * 所以「终端上出现 `(yes/no)?` 自动回 `yes`」这条链路是：
 *   远端输出 → 行缓冲切行 → 规则命中 → 立即写回 `yes\r` → 推一条 UI 消息
 * 其中「推 UI 消息」不是为了触发动作，而是为了在界面上留下一句
 * 「已自动应答 yes」——否则用户只看到屏幕自己动了，不知道是谁做的。
 *
 * 容错原则：**一条坏规则不能影响其他规则，更不能拖垮会话**。
 * 正则非法、引用的脚本被删、动作抛错，都只记在本规则的统计里并继续。
 */
import type {
  ScriptDefinition,
  TestTriggerMatch,
  TestTriggerResponse,
  TriggerAction,
  TriggerMatchMode,
  TriggerRule,
  TriggerStats,
  TriggerUiAction,
} from '@webterm/shared'
import { expandCaptureGroups, normalizeTriggerFlags } from '@webterm/shared'
import { LineBuffer, visibleLine, type LineEvent } from './line-buffer.js'

export interface TriggerEngineLogger {
  debug: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

/** 触发器动作的执行上下文（脚本动作会用到） */
export interface TriggerScriptContext {
  ruleId: string
  ruleName: string
  /** 命中的整行 */
  line: string
  /** 行内匹配到的片段 */
  matched: string
}

/** 插件动作的调用参数（阶段 9） */
export interface TriggerPluginInvocation {
  pluginId: string
  actionId: string
  params?: string
  ruleId: string
  ruleName: string
  line: string
  matched: string
}

/** 插件动作的调用结果 */
export interface TriggerPluginResult {
  ok: boolean
  /** 成功时是「已交给哪个插件的哪个动作」，失败时是原因 */
  message: string
}

export interface TriggerEngineDeps {
  logger: TriggerEngineLogger
  /** 把文本写回远端（自动应答） */
  sendToRemote: (text: string) => void
  /** 把需要渲染端配合的动作推给浏览器 */
  emitUi: (payload: {
    ruleId: string
    ruleName: string
    line: string
    matched: string
    at: string
    ui: TriggerUiAction[]
    performed: string[]
  }) => void
  /** 解析脚本引用；返回 undefined 表示脚本已被删除 */
  resolveScript: (scriptId: string) => Pick<ScriptDefinition, 'id' | 'name'> | undefined
  /** 提交一次脚本运行 */
  runScript: (script: Pick<ScriptDefinition, 'id' | 'name'>, context: TriggerScriptContext) => void
  /**
   * 执行插件注册的动作（阶段 9）。
   * 可选：未装配插件子系统时，引用插件动作的规则会得到一句明确的失败原因 ——
   * 这比让它静默什么都不做要好，用户至少知道该去查哪里。
   *
   * **必须是同步返回**：这条链路上每输出一行都会经过，等插件等于让插件决定终端吞吐。
   */
  runPluginAction?: (input: TriggerPluginInvocation) => TriggerPluginResult
}

interface CompiledRule {
  rule: TriggerRule
  /** 编译失败时为 null：规则保留在列表里（统计里能看出问题），但不再参与匹配 */
  regex: RegExp | null
  hitCount: number
  /** 上次触发时间戳；0 表示从未触发 */
  lastFiredAt: number
  lastError?: string
}

export class TriggerEngine {
  private readonly rules: CompiledRule[] = []
  private readonly buffer: LineBuffer
  /** 延迟发送的应答定时器；会话关闭时要一并取消，否则会往已关闭的通道写字 */
  private readonly timers = new Set<NodeJS.Timeout>()
  private disposed = false

  constructor(rules: TriggerRule[], private readonly deps: TriggerEngineDeps) {
    this.buffer = new LineBuffer((event) => this.onLine(event))

    for (const rule of rules) {
      const regex = compilePattern(rule.pattern, rule.matchMode, rule.flags)
      const compiled: CompiledRule = { rule, regex, hitCount: 0, lastFiredAt: 0 }
      if (!regex) {
        compiled.lastError = '正则表达式非法，该规则不会生效'
        this.deps.logger.warn(
          { ruleId: rule.id, pattern: rule.pattern, flags: rule.flags },
          '触发器规则的正则非法，已跳过匹配',
        )
      }
      this.rules.push(compiled)
    }
  }

  get ruleCount(): number {
    return this.rules.length
  }

  /**
   * 喂入远端输出文本。
   * 没有任何规则时直接返回 —— 行缓冲本身不便宜（剥离转义序列 + 定时器），
   * 不该让不用触发器的用户替它买单。
   */
  feed(text: string): void {
    if (this.disposed || this.rules.length === 0) return
    this.buffer.push(text)
  }

  stats(): TriggerStats[] {
    return this.rules.map((r) => {
      const stat: TriggerStats = { ruleId: r.rule.id, hitCount: r.hitCount }
      if (r.lastFiredAt > 0) stat.lastFiredAt = new Date(r.lastFiredAt).toISOString()
      if (r.lastError) stat.lastError = r.lastError
      return stat
    })
  }

  dispose(): void {
    this.disposed = true
    this.buffer.dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /* ------------------------------------------------------------------ */

  /** 返回 true 表示这一行至少触发了一条规则（尾部快照据此建立） */
  private onLine(event: LineEvent): boolean {
    // 由尾部匹配延续而来的行：前缀已经触发过了，再匹配一次就是自激
    if (event.carriedOver) return false

    const now = Date.now()
    let hit = false

    for (const compiled of this.rules) {
      if (!compiled.regex) continue

      const regex = compiled.regex
      regex.lastIndex = 0
      const match = regex.exec(event.text)
      if (!match) continue

      // 冷却：分页提示 `--More--` 会在一屏里出现多次，没有冷却就会连发几十条应答
      if (now - compiled.lastFiredAt < compiled.rule.cooldownMs) continue

      compiled.lastFiredAt = now
      compiled.hitCount += 1
      compiled.lastError = undefined
      hit = true
      this.fire(compiled, event.text, match)
    }

    return hit
  }

  private fire(compiled: CompiledRule, line: string, match: RegExpExecArray): void {
    const { rule } = compiled
    const ui: TriggerUiAction[] = []
    const performed: string[] = []

    for (const action of rule.actions) {
      try {
        this.runAction(action, compiled, line, match, ui, performed)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        compiled.lastError = message
        this.deps.logger.warn({ ruleId: rule.id, action: action.type, err: message }, '触发器动作执行失败')
      }
    }

    if (ui.length === 0 && performed.length === 0) return

    this.deps.emitUi({
      ruleId: rule.id,
      ruleName: rule.name,
      line,
      matched: match[0],
      at: new Date().toISOString(),
      ui,
      performed,
    })
  }

  private runAction(
    action: TriggerAction,
    compiled: CompiledRule,
    line: string,
    match: RegExpExecArray,
    ui: TriggerUiAction[],
    performed: string[],
  ): void {
    const expand = (template: string): string => expandCaptureGroups(template, match)

    switch (action.type) {
      case 'send': {
        const text = expand(action.text)
        // PTY 的行结束是 CR：`\n` 在 canonical 模式下不会触发 read 返回
        const payload = action.enter === false ? text : `${text}\r`
        const delayMs = action.delayMs ?? 0
        if (delayMs > 0) {
          const timer = setTimeout(() => {
            this.timers.delete(timer)
            if (!this.disposed) this.deps.sendToRemote(payload)
          }, delayMs)
          timer.unref?.()
          this.timers.add(timer)
          performed.push(`延迟自动应答 ${JSON.stringify(text)}`)
        } else {
          this.deps.sendToRemote(payload)
          performed.push(`自动应答 ${JSON.stringify(text)}`)
        }
        return
      }

      case 'highlight':
        ui.push({ type: 'highlight', color: action.color ?? 'amber' })
        return

      case 'notify':
        ui.push({
          type: 'notify',
          title: action.title ? expand(action.title) : compiled.rule.name,
          body: action.body ? expand(action.body) : line,
        })
        return

      case 'label':
        ui.push({ type: 'label', label: expand(action.label) })
        return

      case 'script': {
        const script = this.deps.resolveScript(action.scriptId)
        if (!script) {
          // 脚本被删除后规则还在：明确记下来，界面上一眼能看出该规则已失效
          compiled.lastError = `引用的脚本已不存在（${action.scriptId}）`
          performed.push('脚本缺失，未执行')
          return
        }
        try {
          this.deps.runScript(script, {
            ruleId: compiled.rule.id,
            ruleName: compiled.rule.name,
            line,
            matched: match[0],
          })
          performed.push(`执行脚本「${script.name}」`)
        } catch (err) {
          // 提交阶段就被拒（最常见的是宿主会话上已有自动化任务）。
          // 这里必须自己消化并写进 performed：若任由它抛到 fire() 的兜底 catch，
          // 界面只会显示「规则命中了」，用户完全看不出本该跑的脚本其实没跑。
          const message = err instanceof Error ? err.message : String(err)
          compiled.lastError = message
          performed.push(`执行脚本「${script.name}」失败：${message}`)
        }
        return
      }

      case 'plugin': {
        if (!this.deps.runPluginAction) {
          compiled.lastError = '插件子系统未启用，插件动作无法执行'
          performed.push('插件子系统未启用，未执行')
          return
        }
        const result = this.deps.runPluginAction({
          pluginId: action.pluginId,
          actionId: action.actionId,
          ...(action.params !== undefined ? { params: action.params } : {}),
          ruleId: compiled.rule.id,
          ruleName: compiled.rule.name,
          line,
          matched: match[0],
        })
        if (!result.ok) {
          // 与「脚本被删除」同样的处理：把原因写进规则统计，
          // 界面上这条规则旁边会出现红字，用户知道该去改哪里
          compiled.lastError = result.message
          performed.push(`插件动作未执行：${result.message}`)
          return
        }
        performed.push(result.message)
        return
      }
    }
  }
}

/* ================================================================== */
/* 模式编译与试匹配（REST 的「试一试」接口共用）                          */
/* ================================================================== */

/** 纯文本模式下的转义，避免用户为了匹配 `(yes/no)?` 自己写一堆反斜杠 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把规则编译成正则。两种模式最终都走正则 —— 这样 `text` 模式也能统一享受
 * 大小写处理与 `exec` 的索引语义，不必为它单写一条 `indexOf` 分支
 * （那条分支在处理 Unicode 大小写变长时会算错下标）。
 */
export function compilePattern(
  pattern: string,
  matchMode: TriggerMatchMode | undefined,
  flags: string | undefined,
): RegExp | null {
  const normalized = normalizeTriggerFlags(flags)
  if ((matchMode ?? 'regex') === 'text') {
    const textFlags = normalized.includes('i') ? 'i' : ''
    try {
      return new RegExp(escapeRegExp(pattern), textFlags)
    } catch {
      return null
    }
  }
  try {
    return new RegExp(pattern, normalized)
  } catch {
    return null
  }
}

export interface TestPatternInput {
  pattern: string
  matchMode?: TriggerMatchMode
  flags?: string
  sample: string
  /** 可选：动作里要发送的模板，用于预览 `$1` 展开后的实际内容 */
  previewTemplate?: string
}

/**
 * 对一段样例输出做试匹配。
 * 编辑弹窗全靠它做到「边写正则边看结果」，因此**不抛错**：
 * 正则非法时以 `valid: false` 返回，前端把它渲染成红字提示。
 */
export function testTriggerPattern(input: TestPatternInput): TestTriggerResponse {
  const regex = compilePattern(input.pattern, input.matchMode, input.flags)
  if (!regex) {
    return {
      ok: false,
      valid: false,
      error: '正则表达式无法编译，请检查括号、方括号或转义是否配对',
      matches: [],
    }
  }

  const matches: TestTriggerMatch[] = []
  const lines = input.sample.split(/\r\n|\r|\n/)

  lines.forEach((raw, index) => {
    // 口径与 LineBuffer 完全一致（同一个函数，不是「照抄一份」）：
    // 试匹配面板上看到的结果必须等于真实运行时命中的结果
    const visible = visibleLine(raw)
    if (visible.length === 0) return

    regex.lastIndex = 0
    const match = regex.exec(visible)
    if (!match) return

    const item: TestTriggerMatch = {
      line: index + 1,
      text: visible,
      matched: match[0],
      /**
       * `groups[0]` 是整个匹配、`groups[n]` 是第 n 个捕获组 —— 与动作模板里的
       * `$0` / `$1` 编号严格对齐。
       * 若只给捕获组（`match.slice(1)`），用户在试匹配面板上看到 `groups[0]="5001"`
       * 会自然地写 `$0`，而 `$0` 指的其实是整个匹配，编号就此错位一格。
       */
      groups: Array.from(match, (g) => g ?? ''),
    }
    if (input.previewTemplate !== undefined) {
      item.expanded = expandCaptureGroups(input.previewTemplate, match)
    }
    matches.push(item)
  })

  return { ok: matches.length > 0, valid: true, matches }
}
