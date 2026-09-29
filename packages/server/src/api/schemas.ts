/**
 * REST 请求体的 zod 校验模式。
 *
 * 校验放在边界上：进入业务逻辑之前就拒绝非法输入，
 * 避免把「端口是 NaN」「cols 是负数」这类问题带到 SSH 层再报出难以理解的错误。
 */
import { z } from 'zod'
import {
  AUTH_METHODS,
  CONNECTION_PROTOCOLS,
  DEFAULT_PORTS,
  DEFAULT_TERM,
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
  DEFAULT_TUNNEL_BIND_HOST,
  MAX_TUNNELS_PER_SESSION,
  SUPPORTED_ENCODINGS,
} from '@webterm/shared'

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

