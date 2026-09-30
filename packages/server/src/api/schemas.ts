/**
 * REST 请求体的 zod 校验模式。
 *
 * 校验放在边界上：进入业务逻辑之前就拒绝非法输入，
 * 避免把「端口是 NaN」「cols 是负数」这类问题带到 SSH 层再报出难以理解的错误。
 */
import { z } from 'zod'
import {
  AUTH_METHODS,
  BATCH_MAX_CONCURRENCY,
  BATCH_MAX_TARGETS,
  BATCH_MAX_TIMEOUT_MS,
  CONNECTION_PROTOCOLS,
  DEFAULT_PORTS,
  DEFAULT_TERM,
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
  DEFAULT_TUNNEL_BIND_HOST,
  LOG_FORMATS,
  LOG_MAX_REDACTION_RULES,
  LOG_MAX_RETENTION_DAYS,
  LOG_MIN_RETENTION_DAYS,
  MACRO_MAX_DELAY_MS,
  MACRO_MAX_EXPECT_TIMEOUT_MS,
  MACRO_MAX_STEPS,
  MAX_STARTUP_SCRIPTS,
  MAX_TUNNELS_PER_SESSION,
  SCRIPT_MAX_CODE_BYTES,
  SCRIPT_MAX_TIMEOUT_MS,
  SUPPORTED_ENCODINGS,
  TRIGGER_HIGHLIGHT_COLORS,
  TRIGGER_MATCH_MODES,
  TRIGGER_MAX_ACTIONS,
  TRIGGER_MAX_COOLDOWN_MS,
  TRIGGER_MIN_COOLDOWN_MS,
  TRIGGER_SCOPES,
  type TriggerMatchMode,
} from '@webterm/shared'
import { compilePattern } from '../automation/triggers.js'

/** 主机名 / IP：允许 IPv4、IPv6、域名；禁止空白与协议前缀 */
const HostSchema = z
  .string()
  .trim()
  .min(1, '主机地址不能为空')
  .max(255, '主机地址过长')
  .refine((v) => !/\s/.test(v), '主机地址不能包含空白字符')
  .refine((v) => !v.includes('://'), '主机地址不应包含协议前缀（如 ssh://）')

/** 端口：缺省按协议取（SSH 22 / Telnet 23），由各自的 target 模式负责填默认值 */
const PortSchema = z.coerce.number().int().min(1).max(65535)

const UsernameSchema = z.string().trim().min(1, '用户名不能为空').max(128, '用户名过长')

/** 私钥内容大小上限，防止把超大文件当私钥提交上来 */
const MAX_PRIVATE_KEY_BYTES = 64 * 1024

export const SshTargetSchema = z
  .object({
    host: HostSchema,
    port: PortSchema.default(DEFAULT_PORTS.ssh),
    username: UsernameSchema,
    authMethod: z.enum(AUTH_METHODS).default('password'),
    password: z.string().max(1024, '口令过长').optional(),
    privateKey: z.string().max(MAX_PRIVATE_KEY_BYTES, '私钥内容过大').optional(),
    passphrase: z.string().max(1024, '私钥口令过长').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.authMethod === 'password' && !value.password) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: '使用口令认证时必须提供口令',
      })
    }
    if (value.authMethod === 'privateKey' && !value.privateKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['privateKey'],
        message: '使用密钥认证时必须提供私钥内容',
      })
    }
  })

/**
 * Telnet 目标：只有主机与端口。
 * 刻意不提供用户名/口令字段 —— 让用户把口令交给明文协议已经是权衡后的选择，
 * 更不该让它进入配置文件或被持久化。登录完全在终端里交互完成。
 */
export const TelnetTargetSchema = z.object({
  host: HostSchema,
  port: PortSchema.default(DEFAULT_PORTS.telnet),
})

export const TerminalOptionsSchema = z.object({
  cols: z.coerce.number().int().min(1).max(1000).default(DEFAULT_TERM_COLS),
  rows: z.coerce.number().int().min(1).max(1000).default(DEFAULT_TERM_ROWS),
  encoding: z.enum(SUPPORTED_ENCODINGS).default('utf8'),
  term: z.string().trim().min(1).max(64).default(DEFAULT_TERM),
})

export const LegacyCompatSchema = z.enum(['auto', 'always', 'never']).default('auto')

const DefaultTerminalOptions = {
  cols: DEFAULT_TERM_COLS,
  rows: DEFAULT_TERM_ROWS,
  encoding: 'utf8' as const,
  term: DEFAULT_TERM,
}

/**
 * 会话配置按协议判别。
 * protocol 给了默认值 'ssh'，因此老的客户端脚本（不带 protocol）仍然可用；
 * 一旦显式写了 'telnet'，就必须走 Telnet 那一支的校验，不会出现
 * 「声明 telnet 却带着 SSH 私钥」这种半截配置。
 */
export const SessionConfigSchema = z.union([
  z.object({
    protocol: z.literal('ssh').default('ssh'),
    target: SshTargetSchema,
    terminal: TerminalOptionsSchema.default(DefaultTerminalOptions),
    legacyCompat: LegacyCompatSchema.optional(),
  }),
  z.object({
    protocol: z.literal('telnet'),
    target: TelnetTargetSchema,
    terminal: TerminalOptionsSchema.default(DefaultTerminalOptions),
  }),
])

export const ProbeSessionRequestSchema = z
  .object({
    target: z.union([SshTargetSchema, TelnetTargetSchema]).optional(),
    sessionId: z.string().trim().min(1).optional(),
    legacyCompat: LegacyCompatSchema.optional(),
    protocol: z.enum(CONNECTION_PROTOCOLS).default('ssh'),
  })
  .refine((v) => Boolean(v.target || v.sessionId), {
    message: 'target 与 sessionId 必须提供一个',
  })

export const CreateTerminalRequestSchema = z
  .object({
    config: SessionConfigSchema.optional(),
    sessionId: z.string().trim().min(1).optional(),
    title: z.string().trim().max(80, '标题过长').optional(),
  })
  .refine((v) => Boolean(v.config || v.sessionId), {
    message: 'config 与 sessionId 必须提供一个',
  })

/* ------------------------------------------------------------------ */
/* 阶段 2：保险库 / 凭据 / 会话库                                       */
/* ------------------------------------------------------------------ */

export const SetupVaultRequestSchema = z.object({
  masterPassword: z.string().min(8, '主密码至少需要 8 个字符').max(256),
})

const CredentialNameSchema = z
  .string()
  .trim()
  .min(1, '凭据名称不能为空')
  .max(64, '凭据名称过长')

export const CreateCredentialRequestSchema = z
  .object({
    name: CredentialNameSchema,
    type: z.enum(AUTH_METHODS),
    password: z.string().max(1024, '口令过长').optional(),
    privateKey: z.string().max(MAX_PRIVATE_KEY_BYTES, '私钥内容过大').optional(),
    passphrase: z.string().max(1024, '私钥口令过长').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'password' && !value.password) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: '口令认证必须提供口令' })
    }
    if (value.type === 'privateKey' && !value.privateKey) {
      ctx.addIssue({ code: 'custom', path: ['privateKey'], message: '密钥认证必须提供私钥内容' })
    }
  })

export const UpdateCredentialRequestSchema = z
  .object({
    name: CredentialNameSchema.optional(),
    password: z.string().max(1024).optional(),
    privateKey: z.string().max(MAX_PRIVATE_KEY_BYTES).optional(),
    passphrase: z.string().max(1024).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.password !== undefined ||
      v.privateKey !== undefined ||
      v.passphrase !== undefined,
    { message: '至少需要提供一个待更新字段' },
  )

const JumpHopSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  username: UsernameSchema,
  credentialId: z.string().trim().min(1, '跳板机凭据不能为空'),
  legacyCompat: LegacyCompatSchema.optional(),
})

/* ------------------------------------------------------------------ */
/* 阶段 5：端口转发与隧道                                               */
/* ------------------------------------------------------------------ */

/** 监听端口：1~65535。远程转发另允许 0（由远端分配空闲端口） */
const TunnelPortSchema = z.coerce.number().int().min(1).max(65535)

/**
 * 监听地址可以填 0.0.0.0 / :: / 本机任意地址，因此不能复用「目标主机」的
 * 校验思路去限制取值 —— 但空白与协议前缀同样要挡住。
 */
const TunnelBindHostSchema = HostSchema.default(DEFAULT_TUNNEL_BIND_HOST)

export const LocalForwardSpecSchema = z.object({
  type: z.literal('local'),
  bindHost: TunnelBindHostSchema,
  bindPort: TunnelPortSchema,
  targetHost: HostSchema,
  targetPort: TunnelPortSchema,
})

export const RemoteForwardSpecSchema = z.object({
  type: z.literal('remote'),
  bindHost: TunnelBindHostSchema,
  bindPort: z.coerce.number().int().min(0).max(65535),
  targetHost: HostSchema,
  targetPort: TunnelPortSchema,
})

export const DynamicForwardSpecSchema = z.object({
  type: z.literal('dynamic'),
  bindHost: TunnelBindHostSchema,
  bindPort: TunnelPortSchema,
})

export const TunnelSpecSchema = z.discriminatedUnion('type', [
  LocalForwardSpecSchema,
  RemoteForwardSpecSchema,
  DynamicForwardSpecSchema,
])

export const CreateTunnelRequestSchema = z.object({
  terminalId: z.string().trim().min(1, '必须指定宿主终端'),
  spec: TunnelSpecSchema,
})

/**
 * 会话库记录。
 *
 * 结构与 shared 的 SessionRecord 一致：扁平字段 + protocol 判别，
 * 但这里要按协议把「必填项」补齐 —— Telnet 不需要用户名与凭据，
 * SSH 则两者都必须有。
 */
export const SessionRecordSchema = z
  .object({
    protocol: z.enum(CONNECTION_PROTOCOLS).default('ssh'),
    host: HostSchema,
    port: PortSchema,
    username: UsernameSchema.optional(),
    credentialId: z.string().trim().min(1, '必须选择登录凭据').optional(),
    encoding: z.enum(SUPPORTED_ENCODINGS).default('utf8'),
    term: z.string().trim().min(1).max(64).default(DEFAULT_TERM),
    legacyCompat: LegacyCompatSchema.optional(),
    jumpChain: z.array(JumpHopSchema).max(5, '跳板链最深 5 级').default([]),
    tunnels: z
      .array(TunnelSpecSchema)
      .max(MAX_TUNNELS_PER_SESSION, `单个会话最多 ${MAX_TUNNELS_PER_SESSION} 条隧道`)
      .default([]),
    /** 仅 SSH 有意义：登录后自动运行的脚本 id 列表，按数组顺序串行执行 */
    startupScripts: z
      .array(z.string().trim().min(1))
      .max(MAX_STARTUP_SCRIPTS, `单个会话最多挂 ${MAX_STARTUP_SCRIPTS} 个启动脚本`)
      .default([]),
    /** 阶段 7：会话日志配置（SSH 与 Telnet 都可用） */
    logging: z
      .object({
        enabled: z.boolean(),
        format: z.enum(LOG_FORMATS).default('plain'),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.protocol === 'ssh') {
      if (!value.username) {
        ctx.addIssue({ code: 'custom', path: ['username'], message: 'SSH 会话必须填写用户名' })
      }
      if (!value.credentialId) {
        ctx.addIssue({ code: 'custom', path: ['credentialId'], message: 'SSH 会话必须选择登录凭据' })
      }
      return
    }
    // Telnet：明令禁止携带凭据、跳板链与隧道，避免出现「看着像配了、实际不生效」的配置
    if (value.credentialId) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialId'],
        message: 'Telnet 会话不需要登录凭据（口令在终端里交互输入）',
      })
    }
    if (value.jumpChain.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['jumpChain'],
        message: 'Telnet 不支持跳板链',
      })
    }
    if (value.tunnels.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tunnels'],
        message: 'Telnet 没有可承载转发通道的协议层，不支持端口转发',
      })
    }
    if (value.startupScripts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['startupScripts'],
        message: 'Telnet 会话不支持登录脚本',
      })
    }
  })

export const CreateLibraryNodeRequestSchema = z
  .object({
    kind: z.enum(['folder', 'session']),
    name: z
      .string()
      .trim()
      .min(1, '名称不能为空')
      .max(64, '名称过长'),
    parentId: z.string().trim().nullable().optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    session: SessionRecordSchema.optional(),
  })
  .refine((v) => v.kind === 'folder' || v.session !== undefined, {
    message: '会话节点必须携带 session 配置',
  })

export const UpdateLibraryNodeRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  parentId: z.string().trim().nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  session: SessionRecordSchema.optional(),
})

export type SshTargetInput = z.infer<typeof SshTargetSchema>
export type SessionConfigInput = z.infer<typeof SessionConfigSchema>

/* ------------------------------------------------------------------ */
/* 阶段 3：SFTP                                                        */
/* ------------------------------------------------------------------ */

export const SftpSideSchema = z.enum(['local', 'remote'])

/**
 * 路径校验只做最基本的把关（非空、无 NUL、长度合理）。
 * 真正的越界/存在性判断必须在服务端按「实际解析结果」做 ——
 * 靠正则拦 `..` 是拦不住的（`a/../../b`、符号链接、Windows 的 `\\?\` 前缀都能绕过）。
 */
const SftpPathSchema = z
  .string()
  .min(1, '路径不能为空')
  .max(4096, '路径过长')
  .refine((v) => !v.includes('\0'), '路径包含非法字符')

export const CreateSftpSessionRequestSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  config: z
    .object({
      target: SshTargetSchema,
      legacyCompat: LegacyCompatSchema.default('auto'),
    })
    .optional(),
  terminalId: z.string().trim().min(1).optional(),
  title: z.string().trim().max(80, '标题过长').optional(),
})

export const SftpListQuerySchema = z.object({
  side: SftpSideSchema.default('remote'),
  path: SftpPathSchema.optional(),
})

export const SftpMkdirRequestSchema = z.object({
  side: SftpSideSchema,
  path: SftpPathSchema,
  name: z.string().trim().min(1).max(255).optional(),
})

export const SftpRenameRequestSchema = z.object({
  side: SftpSideSchema,
  from: SftpPathSchema,
  to: SftpPathSchema,
})

export const SftpChmodRequestSchema = z.object({
  side: SftpSideSchema,
  path: SftpPathSchema,
  mode: z
    .string()
    .trim()
    .regex(/^(0o)?[0-7]{3,4}$/i, '权限应为 3~4 位八进制数字，如 644'),
})

export const SftpRemoveRequestSchema = z.object({
  side: SftpSideSchema,
  paths: z.array(SftpPathSchema).min(1, '至少选择一个路径').max(200, '单次最多删除 200 项'),
})

export const SftpTouchRequestSchema = z.object({
  side: SftpSideSchema,
  path: SftpPathSchema,
})

export const SftpPreviewRequestSchema = z.object({
  path: SftpPathSchema,
  /** 上限压到 2MB，避免把整个大文件读进内存 */
  maxBytes: z.coerce.number().int().min(1).max(2 * 1024 * 1024).optional(),
})

export const SftpSaveRequestSchema = z.object({
  path: SftpPathSchema,
  content: z.string().max(4 * 1024 * 1024, '内容过大，请改用上传'),
  expectedMtime: z.coerce.number().int().nonnegative().optional(),
  mode: z.coerce.number().int().min(0).max(0o7777).optional(),
})

export const CreateTransferRequestSchema = z.object({
  direction: z.enum(['upload', 'download']),
  sources: z.array(SftpPathSchema).min(1, '至少选择一个源').max(200, '单次最多 200 项'),
  targetDir: SftpPathSchema,
  overwrite: z.boolean().default(false),
  recursive: z.boolean().default(true),
  preserveMode: z.boolean().default(true),
})

export const TransferActionSchema = z.enum(['pause', 'resume', 'cancel', 'retry'])

/* ------------------------------------------------------------------ */
/* 阶段 6：自动化（触发器 / 宏 / 脚本 / 批量执行）                        */
/* ------------------------------------------------------------------ */

/**
 * 校验匹配模式能否编译。
 *
 * 放在 zod 层而不是等到运行时：一条写坏的正则如果只在运行期被静默跳过，
 * 用户会以为「规则配好了但不生效」，而真正的原因藏在他看不见的地方。
 */
function refinePattern(
  value: { pattern?: string; matchMode?: TriggerMatchMode; flags?: string },
  ctx: z.RefinementCtx,
): void {
  if (!value.pattern) return
  if (!compilePattern(value.pattern, value.matchMode, value.flags)) {
    ctx.addIssue({
      code: 'custom',
      path: ['pattern'],
      message: '正则表达式无法编译，请检查括号、方括号与转义是否配对',
    })
  }
}

/** 匹配模式上限 1024 字符：再长的模式已经不适合用在逐行匹配上 */
const TriggerPatternSchema = z.string().min(1, '匹配模式不能为空').max(1024, '匹配模式过长')
const TriggerFlagsSchema = z.string().trim().max(4, '正则修饰符过长')

export const TriggerSendActionSchema = z.object({
  type: z.literal('send'),
  /** 允许空串（等价于只发一个回车） */
  text: z.string().max(4096, '发送内容过长'),
  enter: z.boolean().optional(),
  delayMs: z.coerce.number().int().min(0).max(60_000).optional(),
})

export const TriggerHighlightActionSchema = z.object({
  type: z.literal('highlight'),
  color: z.enum(TRIGGER_HIGHLIGHT_COLORS).optional(),
})

export const TriggerNotifyActionSchema = z.object({
  type: z.literal('notify'),
  title: z.string().trim().max(120).optional(),
  body: z.string().max(512).optional(),
})

export const TriggerLabelActionSchema = z.object({
  type: z.literal('label'),
  label: z.string().trim().min(1, '标签不能为空').max(32, '标签过长'),
})

export const TriggerScriptActionSchema = z.object({
  type: z.literal('script'),
  scriptId: z.string().trim().min(1, '必须指定脚本'),
})

export const TriggerActionSchema = z.discriminatedUnion('type', [
  TriggerSendActionSchema,
  TriggerHighlightActionSchema,
  TriggerNotifyActionSchema,
  TriggerLabelActionSchema,
  TriggerScriptActionSchema,
])

const TriggerRuleFields = {
  name: z.string().trim().min(1, '规则名称不能为空').max(64, '规则名称过长'),
  enabled: z.boolean().optional(),
  scope: z.enum(TRIGGER_SCOPES).optional(),
  sessionId: z.string().trim().min(1).nullable().optional(),
  pattern: TriggerPatternSchema,
  matchMode: z.enum(TRIGGER_MATCH_MODES).optional(),
  flags: TriggerFlagsSchema.optional(),
  cooldownMs: z.coerce
    .number()
    .int()
    .min(TRIGGER_MIN_COOLDOWN_MS)
    .max(TRIGGER_MAX_COOLDOWN_MS, `冷却时间最多 ${TRIGGER_MAX_COOLDOWN_MS} 毫秒`)
    .optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
}

export const CreateTriggerRequestSchema = z
  .object({
    ...TriggerRuleFields,
    actions: z
      .array(TriggerActionSchema)
      .min(1, '至少需要配置一个动作')
      .max(TRIGGER_MAX_ACTIONS, `单条规则最多 ${TRIGGER_MAX_ACTIONS} 个动作`),
  })
  .superRefine((value, ctx) => {
    refinePattern(value, ctx)
    if (value.scope === 'session' && !value.sessionId) {
      ctx.addIssue({ code: 'custom', path: ['sessionId'], message: '会话级规则必须指定所属会话' })
    }
  })

export const UpdateTriggerRequestSchema = z
  .object({
    ...TriggerRuleFields,
    // 复用创建用的字段定义，但**必须显式放开**这两个必填项：
    // 直接展开 TriggerRuleFields 会把 name / pattern 继续当成必填，
    // PATCH 就只能整体替换，「只改个名字」会被 400 挡回来。
    name: TriggerRuleFields.name.optional(),
    pattern: TriggerRuleFields.pattern.optional(),
    actions: z.array(TriggerActionSchema).max(TRIGGER_MAX_ACTIONS).optional(),
  })
  .superRefine((value, ctx) => {
    refinePattern(value, ctx)
    // 只在「本次请求显式指定 scope=session」时校验：
    // 存量规则的 scope 在库里，zod 看不到，交由 DAO 把关
    if (value.scope === 'session' && !value.sessionId) {
      ctx.addIssue({ code: 'custom', path: ['sessionId'], message: '会话级规则必须指定所属会话' })
    }
  })

export const TestTriggerRequestSchema = z.object({
  pattern: TriggerPatternSchema,
  matchMode: z.enum(TRIGGER_MATCH_MODES).optional(),
  flags: TriggerFlagsSchema.optional(),
  /** 样例输出上限 8 KB：够贴一段真实回显了 */
  sample: z.string().max(8192, '样例输出过长'),
  /** 可选：预览某个 send 动作里 `$1` 展开后的实际内容 */
  previewTemplate: z.string().max(4096).optional(),
})

export const MacroStepSchema = z
  .object({
    send: z.string().max(4096, '发送内容过长').optional(),
    enter: z.boolean().optional(),
    delayMs: z.coerce.number().int().min(0).max(MACRO_MAX_DELAY_MS).optional(),
    expect: z.string().max(1024, 'expect 模式过长').optional(),
    expectTimeoutMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(MACRO_MAX_EXPECT_TIMEOUT_MS)
      .optional(),
  })
  .refine(
    (v) => v.send !== undefined || v.delayMs !== undefined || v.expect !== undefined,
    { message: '步骤至少需要「发送」「等待」或「expect」之一' },
  )

const MacroStepListSchema = z
  .array(MacroStepSchema)
  .min(1, '宏至少需要一个步骤')
  .max(MACRO_MAX_STEPS, `单个宏最多 ${MACRO_MAX_STEPS} 个步骤`)

export const CreateMacroRequestSchema = z.object({
  name: z.string().trim().min(1, '按钮名称不能为空').max(32, '按钮名称过长'),
  description: z.string().trim().max(200, '说明过长').optional(),
  steps: MacroStepListSchema,
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
})

export const UpdateMacroRequestSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  description: z.string().trim().max(200).optional(),
  steps: MacroStepListSchema.optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
})

export const RunMacroRequestSchema = z
  .object({
    terminalId: z.string().trim().min(1, '必须指定宿主终端'),
    macroId: z.string().trim().min(1).optional(),
    steps: MacroStepListSchema.optional(),
    macroName: z.string().trim().max(32).optional(),
  })
  .refine((v) => Boolean(v.macroId || v.steps), {
    message: 'macroId 与 steps 必须提供一个',
  })

export const CreateScriptRequestSchema = z.object({
  name: z.string().trim().min(1, '脚本名称不能为空').max(64, '脚本名称过长'),
  description: z.string().trim().max(200, '说明过长').optional(),
  code: z
    .string()
    .min(1, '脚本内容不能为空')
    .max(SCRIPT_MAX_CODE_BYTES, '脚本内容过大'),
  timeoutMs: z.coerce.number().int().min(1000).max(SCRIPT_MAX_TIMEOUT_MS).optional(),
  runOnConnect: z.boolean().optional(),
})

export const UpdateScriptRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(200).optional(),
  code: z.string().min(1).max(SCRIPT_MAX_CODE_BYTES).optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(SCRIPT_MAX_TIMEOUT_MS).optional(),
  runOnConnect: z.boolean().optional(),
})

export const RunScriptRequestSchema = z
  .object({
    terminalId: z.string().trim().min(1, '必须指定宿主终端'),
    scriptId: z.string().trim().min(1).optional(),
    code: z.string().max(SCRIPT_MAX_CODE_BYTES, '脚本内容过大').optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(SCRIPT_MAX_TIMEOUT_MS).optional(),
  })
  .refine((v) => Boolean(v.scriptId || v.code), {
    message: 'scriptId 与 code 必须提供一个',
  })

export const ValidateScriptRequestSchema = z.object({
  code: z.string().max(SCRIPT_MAX_CODE_BYTES, '脚本内容过大'),
})

export const RunBatchRequestSchema = z.object({
  targets: z
    .array(
      z
        .object({
          sessionId: z.string().trim().min(1).optional(),
          terminalId: z.string().trim().min(1).optional(),
          label: z.string().trim().max(80).optional(),
        })
        .refine((v) => Boolean(v.sessionId || v.terminalId), {
          message: '每个目标必须指定 sessionId 或 terminalId',
        }),
    )
    .min(1, '至少选择一个目标')
    .max(BATCH_MAX_TARGETS, `单次最多 ${BATCH_MAX_TARGETS} 个目标`),
  command: z.string().trim().min(1, '命令不能为空').max(8192, '命令过长'),
  concurrency: z.coerce.number().int().min(1).max(BATCH_MAX_CONCURRENCY).optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(BATCH_MAX_TIMEOUT_MS).optional(),
})


/* ------------------------------------------------------------------ */
/* 阶段 7：日志与审计                                                   */
/* ------------------------------------------------------------------ */

const RedactionRuleSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1, '规则名不能为空').max(64, '规则名过长'),
  pattern: z.string().min(1, '正则不能为空').max(512, '正则过长'),
  replacement: z.string().max(256, '替换文本过长').default(''),
  enabled: z.boolean().default(true),
})

export const UpdateLoggingSettingsSchema = z
  .object({
    retentionDays: z.coerce.number().int().min(LOG_MIN_RETENTION_DAYS).max(LOG_MAX_RETENTION_DAYS).optional(),
    redactionRules: z
      .array(RedactionRuleSchema)
      .max(LOG_MAX_REDACTION_RULES, `脱敏规则最多 ${LOG_MAX_REDACTION_RULES} 条`)
      .optional(),
  })
  .refine((v) => v.retentionDays !== undefined || v.redactionRules !== undefined, {
    message: '至少提供一个要更新的字段',
  })
