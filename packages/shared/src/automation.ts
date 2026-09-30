/**
 * 阶段 6：自动化与批量运维的共享契约。
 *
 * 三块能力相互独立，但共用同一套「会话上下文」：
 * - **触发器**：在终端输出上做行匹配，命中后执行一组动作
 * - **按钮栏 / 宏**：把一串「发送—等待—再发送」的多步操作固化成一次点击
 * - **脚本**：在受控沙箱里跑 JS，通过注入的 session/sftp API 操作会话
 *
 * 另外两件「一次性动作」不落库，因此只有请求/响应契约：
 * - **同步输入**：纯前端行为（见 web 的 terminalBus），这里只给出分组常量
 * - **批量执行**：选一组会话跑同一条命令，结果是一张表
 *
 * 设计取舍：触发器规则与宏都**只存定义、不存运行状态**（命中次数、最近触发时间
 * 属于进程内存里的运行时统计）。理由与隧道一致 —— 上一次的偶然失败不应该
 * 永久改变用户写下的配置。
 */

/* ================================================================== */
/* 触发器                                                              */
/* ================================================================== */

/** 规则作用域：全局 rules 对所有会话生效，会话级只对指定会话生效 */
export const TRIGGER_SCOPES = ['global', 'session'] as const
export type TriggerScope = (typeof TRIGGER_SCOPES)[number]

/**
 * 匹配模式。
 * - `regex`：正则匹配（默认，支持捕获组，动作里可用 `$1` 引用）
 * - `text`：纯文本包含（大小写由 `flags` 的 `i` 决定）
 *
 * 提供 `text` 不是为了省事，而是因为设备提示串里满是 `<`、`>`、`(`、`?`
 * 这类需要转义的字符（`(yes/no)?` 是典型），让用户自己转义纯属为难人。
 */
export const TRIGGER_MATCH_MODES = ['regex', 'text'] as const
export type TriggerMatchMode = (typeof TRIGGER_MATCH_MODES)[number]

/**
 * 允许的正则修饰符。
 * 刻意排除 `g` / `y`：它们会让 `lastIndex` 在多次匹配之间产生状态，
 * 同一个正则对象被复用时会「时灵时不灵」——这类 bug 极难排查。
 * 匹配一律用「每次新建正则、单次 exec」的写法。
 */
export const TRIGGER_FLAG_CHARS = ['i', 'm', 's', 'u'] as const
export type TriggerFlagChar = (typeof TRIGGER_FLAG_CHARS)[number]

/** 高亮配色（前端映射为实际色值） */
export const TRIGGER_HIGHLIGHT_COLORS = ['red', 'amber', 'green', 'blue'] as const
export type TriggerHighlightColor = (typeof TRIGGER_HIGHLIGHT_COLORS)[number]

export const TRIGGER_HIGHLIGHT_LABEL: Record<TriggerHighlightColor, string> = {
  red: '红色',
  amber: '琥珀',
  green: '绿色',
  blue: '蓝色',
}

/** 自动应答：把一段文本写回远端 */
export interface TriggerSendAction {
  type: 'send'
  /** 要发送的文本；正则模式下可用 `$1`…`$9` 引用捕获组（`$0` 为整个匹配） */
  text: string
  /** 是否追加回车（默认 true）。个别设备只吃单字符，需要关掉 */
  enter?: boolean
  /** 延迟若干毫秒再发送，用于等对端真正进入提示态 */
  delayMs?: number
}

/** 高亮标记：命中行在终端里被标色 */
export interface TriggerHighlightAction {
  type: 'highlight'
  color?: TriggerHighlightColor
}

/** 浏览器通知：由前端弹通知（需用户授权），适合长时间无人值守的会话 */
export interface TriggerNotifyAction {
  type: 'notify'
  title?: string
  body?: string
}

/** 记录标签：给终端打一个标签，用于后续归组与检索 */
export interface TriggerLabelAction {
  type: 'label'
  label: string
}

/** 执行脚本：把命中的行作为上下文交给脚本引擎 */
export interface TriggerScriptAction {
  type: 'script'
  scriptId: string
}

/**
 * 插件动作（阶段 9）：把命中的行交给插件注册的动作处理器。
 *
 * 三个字段各司其职，缺一不可：
 * - `pluginId` + `actionId` 才是**真正的引用**。不拼成一个 `plugin:xxx:yyy`
 *   字符串，是为了插件被停用/卸载后，规则能明确报出「引用的插件动作已不存在」，
 *   而不是留下一个看不懂所以然的长 id。
 * - `label` 是**选定时的快照**，只用于列表与摘要展示 —— 规则列表要在不拉取
 *   插件注册表的情况下也能渲染出人话。插件改名后以插件为准，这里允许过期。
 */
export interface TriggerPluginAction {
  type: 'plugin'
  pluginId: string
  actionId: string
  /** 选定时的动作名快照（展示用，可为空） */
  label?: string
  /** 传给插件的额外参数，原样字符串；语义由插件定义 */
  params?: string
}

export type TriggerAction =
  | TriggerSendAction
  | TriggerHighlightAction
  | TriggerNotifyAction
  | TriggerLabelAction
  | TriggerScriptAction
  | TriggerPluginAction

/**
 * 全部动作类型。
 *
 * 这份清单是**落库后读回时的白名单**：库里的 `actions_json` 是 JSON 文本，
 * 反序列化时必须逐个判别类型，认不出来的就丢掉（手工改过库、历史版本写坏的
 * 内容都不该让接口 500）。新增动作类型时忘了加到这里的后果很隐蔽 ——
 * 规则能存进去、接口也能查出来，只有运行时「这条规则什么都不做」，
 * 而且不报任何错。所以判别必须用这一个常量，而不是各处再手抄一份数组。
 */
export const TRIGGER_ACTION_TYPES = [
  'send',
  'highlight',
  'notify',
  'label',
  'script',
  'plugin',
] as const

export type TriggerActionType = (typeof TRIGGER_ACTION_TYPES)[number]

/** 需要推给前端才能完成的那部分动作（其余在服务端就地执行） */
export type TriggerUiAction =
  | { type: 'highlight'; color: TriggerHighlightColor }
  | { type: 'notify'; title: string; body: string }
  | { type: 'label'; label: string }

export interface TriggerRule {
  id: string
  name: string
  enabled: boolean
  scope: TriggerScope
  /** scope = session 时必填：会话库节点 id */
  sessionId?: string
  /** 匹配用的模式串（正则源码或纯文本） */
  pattern: string
  matchMode: TriggerMatchMode
  /** 正则修饰符，如 `i`；text 模式下只认 `i` */
  flags: string
  actions: TriggerAction[]
  /**
   * 同一规则的冷却时间（毫秒）。
   * 分页提示（`--More--`）会在一屏里出现多次，没有冷却就会瞬间连发几十条应答。
   */
  cooldownMs: number
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 运行时统计（不落库，进程重启即清零） */
export interface TriggerStats {
  ruleId: string
  hitCount: number
  lastFiredAt?: string
  /** 最近一次执行动作时的错误（如「引用的脚本已被删除」） */
  lastError?: string
}

export interface CreateTriggerRequest {
  name: string
  enabled?: boolean
  scope?: TriggerScope
  sessionId?: string | null
  pattern: string
  matchMode?: TriggerMatchMode
  flags?: string
  actions: TriggerAction[]
  cooldownMs?: number
  sortOrder?: number
}

export interface UpdateTriggerRequest {
  name?: string
  enabled?: boolean
  scope?: TriggerScope
  sessionId?: string | null
  pattern?: string
  matchMode?: TriggerMatchMode
  flags?: string
  actions?: TriggerAction[]
  cooldownMs?: number
  sortOrder?: number
}

export interface ListTriggersResponse {
  rules: TriggerRule[]
  stats: TriggerStats[]
}

/* ------------------------------------------------------------------ */
/* 试匹配：编辑弹窗里的「拿一段样例输出试试」                            */
/* ------------------------------------------------------------------ */

export interface TestTriggerRequest {
  pattern: string
  matchMode?: TriggerMatchMode
  flags?: string
  /** 样例输出，可含多行；服务端逐行尝试 */
  sample: string
}

export interface TestTriggerMatch {
  /** 行号，从 1 开始 */
  line: number
  text: string
  /** 整个匹配到的文本 */
  matched: string
  /**
   * `groups[0]` 是整个匹配，`groups[n]` 是第 n 个捕获组。
   * 与动作模板的 `$0` / `$1` 编号一致 —— 用户在试匹配面板上看到第 n 项，
   * 写 `$n` 就对了。未参与匹配的组为 `''`。
   */
  groups: string[]
  /** 若动作里引用了 `$1`，替换后的实际发送内容 */
  expanded?: string
}

export interface TestTriggerResponse {
  ok: boolean
  /** 模式本身是否合法（正则模式下可能是 false） */
  valid: boolean
  error?: string
  matches: TestTriggerMatch[]
}

/* ================================================================== */
/* 按钮栏 / 多步宏                                                     */
/* ================================================================== */

/**
 * 宏的一步。
 *
 * 三个字段的语义是顺序的：先 `send`，再等 `delayMs`，再等输出命中 `expect`。
 * `expect` 与 `delayMs` 可以同时存在 —— 前者是「等到为止（有上限）」，
 * 后者是「无条件等一会儿」，两者用途不同，不要合并成一个。
 */
export interface MacroStep {
  /** 发送的文本；为空表示本步只做等待 */
  send?: string
  /** 是否追加回车（默认 true，且仅在 send 非空时有意义） */
  enter?: boolean
  /** 无条件等待的毫秒数 */
  delayMs?: number
  /** 等待输出命中该模式（纯文本包含）后才进入下一步 */
  expect?: string
  /** expect 的最长等待时间，超时则按失败处理 */
  expectTimeoutMs?: number
}

export interface MacroDefinition {
  id: string
  name: string
  description: string
  steps: MacroStep[]
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface CreateMacroRequest {
  name: string
  description?: string
  steps: MacroStep[]
  sortOrder?: number
}

export interface UpdateMacroRequest {
  name?: string
  description?: string
  steps?: MacroStep[]
  sortOrder?: number
}

export interface ListMacrosResponse {
  macros: MacroDefinition[]
}

/** 执行宏：绑定到一个存活终端 */
export interface RunMacroRequest {
  terminalId: string
  /** 引用已保存的宏；与 steps 二选一 */
  macroId?: string
  /** 也可以直接内联一段步骤（「临时执行」用） */
  steps?: MacroStep[]
  /** 内联步骤时的展示名，用于运行进度里回显 */
  macroName?: string
}

export interface RunMacroResponse {
  runId: string
  /** 已接受，执行进度通过终端 WebSocket 推送 */
  accepted: boolean
}

/* ================================================================== */
/* 脚本                                                                */
/* ================================================================== */

export interface ScriptDefinition {
  id: string
  name: string
  description: string
  /** JavaScript 源码；顶层可用 await（按 async 函数体执行） */
  code: string
  /** 超时（毫秒）；到点强制中断 */
  timeoutMs: number
  /** 是否在会话建立后自动运行 */
  runOnConnect: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateScriptRequest {
  name: string
  description?: string
  code: string
  timeoutMs?: number
  runOnConnect?: boolean
}

export interface UpdateScriptRequest {
  name?: string
  description?: string
  code?: string
  timeoutMs?: number
  runOnConnect?: boolean
}

export interface ListScriptsResponse {
  scripts: ScriptDefinition[]
}

export interface RunScriptRequest {
  terminalId: string
  /** 引用已保存的脚本；与 code 二选一 */
  scriptId?: string
  /** 直接运行一段临时代码（编辑器里「试运行」用） */
  code?: string
  timeoutMs?: number
}

export interface RunScriptResponse {
  runId: string
  accepted: boolean
}

export type ScriptLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 脚本运行日志（通过终端 WebSocket 推送） */
export interface ScriptLogEntry {
  level: ScriptLogLevel
  message: string
  /** 脚本内自报的行号（尽力而为） */
  line?: number
  at: string
}

/** 脚本运行状态（服务端内存中的最近若干次记录，供界面回看） */
export interface ScriptRunRecord {
  runId: string
  terminalId: string
  terminalTitle: string
  scriptId?: string
  scriptName: string
  phase: 'running' | 'done' | 'error' | 'timeout'
  startedAt: string
  finishedAt?: string
  elapsedMs?: number
  /** 脚本 `return` 的值（JSON 序列化后） */
  result?: unknown
  error?: string
  /** 运行期间被截断的输出行数 */
  droppedLogs?: number
  logs: ScriptLogEntry[]
}

/* ================================================================== */
/* 批量执行                                                            */
/* ================================================================== */

/**
 * 批量执行的单个目标。
 *
 * 两种给法对应两种成本：
 * - `terminalId`：复用**已经登录好的** SSH 连接另开一条 exec 通道。
 *   不占新的 VTY 线路 —— 交换机、路由器这类只有几条 VTY 的设备上，
 *   重复登录会直接把后续连接挡在门外。
 * - `sessionId`：从会话库取配置，独立建连执行完就断。适合「这几台机器我并没有开着会话」。
 *
 * 只支持 SSH：要拿到退出码就必须用 exec 通道，而 Telnet 没有这个协议层
 * （不同厂商的交互式 CLI 差异极大，用提示符猜退出码不可靠）。Telnet 目标会被明确拒绝，
 * 而不是给一个看起来跑了、实际结果不可信的成功。
 */
export interface BatchTarget {
  /** 会话库节点 id；与 terminalId 二选一（都缺省时按 host 直连，不可用） */
  sessionId?: string
  /** 复用一条已建立的 SSH 连接的终端 id */
  terminalId?: string
  /** 展示名，缺省由服务端推导 */
  label?: string
}

export interface RunBatchRequest {
  targets: BatchTarget[]
  command: string
  /** 并发度，缺省 5 */
  concurrency?: number
  /** 单个目标的超时（毫秒），缺省 30000 */
  timeoutMs?: number
}

export interface BatchResult {
  /** 展示名（host 或会话名） */
  target: string
  sessionId?: string
  terminalId?: string
  protocol: 'ssh' | 'telnet'
  ok: boolean
  exitCode: number | null
  signal?: string
  stdout: string
  stderr: string
  elapsedMs: number
  /** 连接层或执行层失败时的说明（此时 stdout/stderr 可能为空） */
  error?: string
  /** 输出被截断时给出原始字节数 */
  truncated?: boolean
}

export interface RunBatchResponse {
  results: BatchResult[]
  /** 总耗时 */
  elapsedMs: number
  /** 汇总：成功 / 失败（含超时与连接失败） */
  succeeded: number
  failed: number
}

/* ================================================================== */
/* 能力声明与常量                                                       */
/* ================================================================== */

export interface AutomationCapabilities {
  supportedTriggerMatchModes: TriggerMatchMode[]
  supportedTriggerFlagChars: TriggerFlagChar[]
  maxTriggers: number
  maxMacroSteps: number
  maxScriptCodeBytes: number
  defaultScriptTimeoutMs: number
  maxScriptTimeoutMs: number
  defaultBatchConcurrency: number
  maxBatchConcurrency: number
  maxBatchTargets: number
  /** 沙箱内可用的全局标识符（供编辑器补全提示与文档展示） */
  scriptGlobals: string[]
}

/** 单条规则的动作数量上限 —— 超过这个数说明该拆规则了 */
export const TRIGGER_MAX_ACTIONS = 8
/** 规则总数上限（全局 + 会话级） */
export const TRIGGER_MAX_RULES = 128
/** 单个会话生效的规则数量上限，防止一个会话挂几百条正则拖慢输出 */
export const TRIGGER_MAX_RULES_PER_SESSION = 64
/** 冷却时间范围 */
export const TRIGGER_MIN_COOLDOWN_MS = 0
export const TRIGGER_MAX_COOLDOWN_MS = 60_000
export const TRIGGER_DEFAULT_COOLDOWN_MS = 500

/**
 * 尾行（尚未换行的那一段）的匹配延迟。
 * 形如 `(yes/no)? ` 的提示不会自己换行，只在对端静默下来之后才该被当作「一行」；
 * 收到数据就立刻匹配会在分片到达时匹配到半截内容。
 */
export const TRIGGER_TAIL_DEBOUNCE_MS = 60
/** 行缓冲的单行长度上限；超过就截断，避免无换行的二进制输出把内存撑爆 */
export const TRIGGER_MAX_LINE_CHARS = 4096

/** 宏的步骤数量上限 */
export const MACRO_MAX_STEPS = 32
/** 单步 expect / delay 的上限 */
export const MACRO_MAX_DELAY_MS = 60_000
export const MACRO_MAX_EXPECT_TIMEOUT_MS = 300_000
export const MACRO_DEFAULT_EXPECT_TIMEOUT_MS = 15_000

/** 脚本源码上限（64 KiB 足够写不少东西了） */
export const SCRIPT_MAX_CODE_BYTES = 64 * 1024
export const SCRIPT_DEFAULT_TIMEOUT_MS = 30_000
export const SCRIPT_MAX_TIMEOUT_MS = 300_000
/** 单个会话可挂载的「登录后自动运行」脚本数量上限 */
export const MAX_STARTUP_SCRIPTS = 8
/** 单次运行保留的日志条数上限，超出后只计数不保留 */
export const SCRIPT_MAX_LOGS = 500
/** 脚本运行记录在内存里保留的条数 */
export const SCRIPT_RUN_HISTORY = 50
/** 脚本单次读取终端输出的等待上限（waitFor/readUntil 的默认超时） */
export const SCRIPT_DEFAULT_WAIT_MS = 10_000
/** 脚本能读到的终端输出缓冲上限（字符） */
export const SCRIPT_READ_BUFFER_CHARS = 64 * 1024

/** 批量执行 */
export const BATCH_DEFAULT_CONCURRENCY = 5
export const BATCH_MAX_CONCURRENCY = 20
export const BATCH_MAX_TARGETS = 50
export const BATCH_DEFAULT_TIMEOUT_MS = 30_000
export const BATCH_MAX_TIMEOUT_MS = 300_000
/** 单个目标的输出上限（超出截断，避免一台机器 `cat` 大文件把响应撑爆） */
export const BATCH_MAX_OUTPUT_BYTES = 256 * 1024

/* ================================================================== */
/* 展示助手                                                            */
/* ================================================================== */

/** 把 `$1`…`$9` / `$0` 替换为捕获组内容；组不存在时保留原样，便于发现问题 */
export function expandCaptureGroups(template: string, match: RegExpExecArray | null): string {
  if (!match) return template
  return template.replace(/\$([0-9])/g, (whole, digit: string) => {
    const index = Number(digit)
    if (index === 0) return match[0]
    return match[index] ?? whole
  })
}

/** 规范化修饰符：去重、按固定顺序、丢弃不支持的字符 */
export function normalizeTriggerFlags(flags: string | undefined): string {
  const set = new Set((flags ?? '').split('').filter((c) => TRIGGER_FLAG_CHARS.includes(c as TriggerFlagChar)))
  return TRIGGER_FLAG_CHARS.filter((c) => set.has(c)).join('')
}

/** 人读的匹配表达式，如 `/error/i` 或 `包含「(yes/no)?」` */
export function describeTriggerPattern(
  rule: Pick<TriggerRule, 'matchMode' | 'pattern' | 'flags'>,
): string {
  if ((rule.matchMode ?? 'regex') === 'text') {
    const flags = normalizeTriggerFlags(rule.flags)
    return `包含「${rule.pattern}」${flags.includes('i') ? '（忽略大小写）' : ''}`
  }
  return `/${rule.pattern}/${normalizeTriggerFlags(rule.flags)}`
}

/** 动作的一句话描述 */
export function describeTriggerAction(action: TriggerAction): string {
  switch (action.type) {
    case 'send': {
      const tail = action.enter === false ? '（不回车）' : ''
      const delay = action.delayMs ? ` · 延迟 ${action.delayMs}ms` : ''
      return `自动应答 ${JSON.stringify(action.text)}${tail}${delay}`
    }
    case 'highlight':
      return `高亮标记（${TRIGGER_HIGHLIGHT_LABEL[action.color ?? 'amber']}）`
    case 'notify':
      return `浏览器通知${action.title ? `：${action.title}` : ''}`
    case 'label':
      return `记录标签「${action.label}」`
    case 'script':
      return `执行脚本 ${action.scriptId}`
    case 'plugin':
      // 优先用快照名；没有就退回 pluginId:actionId —— 至少能看出是哪个插件的哪个动作
      return `插件动作：${action.label ?? `${action.pluginId}:${action.actionId}`}`
  }
}

/** 规则用途的一句话摘要，用于列表行 */
export function describeTrigger(rule: TriggerRule): string {
  const head = describeTriggerPattern(rule)
  if (rule.actions.length === 0) return `${head} → （无动作）`
  if (rule.actions.length === 1) {
    const first = rule.actions[0]
    return first ? `${head} → ${describeTriggerAction(first)}` : head
  }
  return `${head} → ${rule.actions.length} 个动作`
}

/** 宏步骤的摘要 */
export function describeMacroStep(step: MacroStep, index: number): string {
  const parts: string[] = []
  if (step.send !== undefined && step.send !== '') {
    parts.push(`发送 ${JSON.stringify(step.send)}${step.enter === false ? '（不回车）' : ''}`)
  }
  if (step.delayMs) parts.push(`等待 ${step.delayMs}ms`)
  if (step.expect) parts.push(`直到出现「${step.expect}」`)
  return `${index + 1}. ${parts.length > 0 ? parts.join('，') : '（空步骤）'}`
}

/* ------------------------------------------------------------------ */
/* 常备规则：让用户不必从零开始写正则                                     */
/* ------------------------------------------------------------------ */

export interface TriggerPreset {
  name: string
  description: string
  pattern: string
  matchMode: TriggerMatchMode
  flags: string
  actions: TriggerAction[]
}

export const TRIGGER_PRESETS: TriggerPreset[] = [
  {
    name: '确认提示自动应答',
    description: '出现 (yes/no)? 时自动回 yes —— 最常见的交互式确认',
    pattern: '(yes/no)?',
    matchMode: 'text',
    flags: '',
    actions: [{ type: 'send', text: 'yes' }],
  },
  {
    name: 'SSH 首次连接接受指纹',
    description: '出现 are you sure you want to continue connecting 时自动确认',
    pattern: 'are you sure you want to continue connecting',
    matchMode: 'text',
    flags: 'i',
    actions: [{ type: 'send', text: 'yes' }],
  },
  {
    name: '分页 --More-- 自动翻页',
    description: '设备分页提示自动发空格，避免长输出卡住（带 200ms 冷却）',
    pattern: '--More--',
    matchMode: 'text',
    flags: '',
    actions: [{ type: 'send', text: ' ', enter: false }],
  },
  {
    name: '方括号确认自动回车',
    description: '[confirm] / [Y/N] 一类提示直接回车',
    pattern: '[confirm]',
    matchMode: 'text',
    flags: '',
    actions: [{ type: 'send', text: '' }],
  },
  {
    name: '报错行高亮',
    description: '输出里出现 error / failed 时把该行标红',
    pattern: '(error|failed|denied|refused)',
    matchMode: 'regex',
    flags: 'i',
    actions: [{ type: 'highlight', color: 'red' }],
  },
  {
    name: '登录成功标记',
    description: '看到典型的 shell 提示符时给终端打上「已登录」标签',
    pattern: '(\\$|#)\\s*$',
    matchMode: 'regex',
    flags: '',
    actions: [{ type: 'label', label: '已登录' }],
  },
]

/* ------------------------------------------------------------------ */
/* 脚本 API 说明（编辑器补全与帮助面板共用）                              */
/* ------------------------------------------------------------------ */

export interface ScriptApiDoc {
  /** 调用名，如 `session.send` */
  name: string
  signature: string
  description: string
  example?: string
}

export const SCRIPT_API_DOCS: ScriptApiDoc[] = [
  {
    name: 'session.send',
    signature: "await session.send(text, { enter = true, delayMs = 0 })",
    description: '向远端发送文本；enter 为 true 时追加回车',
    example: "await session.send('uname -a')",
  },
  {
    name: 'session.write',
    signature: 'await session.write(text)',
    description: '发送裸字节，不追加回车（等价于 send 且 enter=false）',
    example: "await session.write(' ')",
  },
  {
    name: 'session.waitFor',
    signature: 'await session.waitFor(pattern, { timeoutMs = 10000, regex = false })',
    description: '等待终端输出命中模式，返回匹配到的文本；超时抛错',
    example: "await session.waitFor('#')",
  },
  {
    name: 'session.expect',
    signature: 'await session.expect(patterns, { timeoutMs })',
    description: '等待多个模式中的任意一个，返回命中的下标与匹配文本',
    example: "const r = await session.expect(['Password:', 'Last login'])",
  },
  {
    name: 'session.readUntil',
    signature: 'await session.readUntil(pattern, { timeoutMs })',
    description: '读取输出直到命中模式，返回区间内的全部文本',
    example: "const out = await session.readUntil('$')",
  },
  {
    name: 'session.read',
    signature: 'session.read()',
    description: '立即取出缓冲区里已有的输出（不等待）',
  },
  {
    name: 'session.clear',
    signature: 'session.clear()',
    description: '清空读取缓冲，常用于丢弃上一条命令的残留输出',
  },
  {
    name: 'session.run',
    signature: 'await session.run(command, { timeoutMs, prompt })',
    description:
      '「发一条命令并读回输出」的便捷封装：自动清缓冲、发送、按提示符或超时收尾，返回输出文本',
    example: "const out = await session.run('df -h')",
  },
  {
    name: 'session.info',
    signature: 'session.info',
    description: '宿主信息：{ terminalId, title, protocol, host, port, username }',
  },
  {
    name: 'sftp.list',
    signature: 'await sftp.list(path)',
    description: '列目录，返回 [{ name, size, isDirectory, mtimeMs }]',
  },
  {
    name: 'sftp.stat',
    signature: 'await sftp.stat(path)',
    description: '取单个路径的属性',
  },
  {
    name: 'sftp.read',
    signature: 'await sftp.read(path, { encoding = "utf8" })',
    description: '读取远程文件；encoding 传 null 得到 Buffer 的字节长度信息',
  },
  {
    name: 'sftp.write',
    signature: 'await sftp.write(path, content)',
    description: '写入远程文件（覆盖）',
  },
  {
    name: 'sftp.exists',
    signature: 'await sftp.exists(path)',
    description: '路径是否存在',
  },
  {
    name: 'sleep',
    signature: 'await sleep(ms)',
    description: '等待若干毫秒（受脚本总超时约束）',
  },
  {
    name: 'log',
    signature: "log(message, level = 'info')",
    description: "输出一行日志到运行面板；level 取 'debug' | 'info' | 'warn' | 'error'",
  },
  {
    name: 'console',
    signature: 'console.log/info/warn/error(...)',
    description: '等价于 log，便于从普通 JS 代码迁移过来',
  },
]

/** 沙箱内可见的全局名字（用于能力声明与文档） */
export const SCRIPT_GLOBAL_NAMES = [
  'session',
  'sftp',
  'log',
  'console',
  'sleep',
  'target',
  'params',
] as const
