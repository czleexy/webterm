/**
 * REST 请求体的 zod 校验模式。
 *
 * 校验放在边界上：进入业务逻辑之前就拒绝非法输入，
 * 避免把「端口是 NaN」「cols 是负数」这类问题带到 SSH 层再报出难以理解的错误。
 */
import { z } from 'zod'
import {
  AUTH_METHODS,
  DEFAULT_TERM,
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
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

const PortSchema = z.coerce.number().int().min(1).max(65535).default(22)

const UsernameSchema = z.string().trim().min(1, '用户名不能为空').max(128, '用户名过长')

/** 私钥内容大小上限，防止把超大文件当私钥提交上来 */
const MAX_PRIVATE_KEY_BYTES = 64 * 1024

export const SshTargetSchema = z
  .object({
    host: HostSchema,
    port: PortSchema,
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

export const TerminalOptionsSchema = z.object({
  cols: z.coerce.number().int().min(1).max(1000).default(DEFAULT_TERM_COLS),
  rows: z.coerce.number().int().min(1).max(1000).default(DEFAULT_TERM_ROWS),
  encoding: z.enum(SUPPORTED_ENCODINGS).default('utf8'),
  term: z.string().trim().min(1).max(64).default(DEFAULT_TERM),
})

export const LegacyCompatSchema = z.enum(['auto', 'always', 'never']).default('auto')

export const SessionConfigSchema = z.object({
  target: SshTargetSchema,
  terminal: TerminalOptionsSchema.default({
    cols: DEFAULT_TERM_COLS,
    rows: DEFAULT_TERM_ROWS,
    encoding: 'utf8',
    term: DEFAULT_TERM,
  }),
  legacyCompat: LegacyCompatSchema.optional(),
})

export const ProbeSessionRequestSchema = z
  .object({
    target: SshTargetSchema.optional(),
    sessionId: z.string().trim().min(1).optional(),
    legacyCompat: LegacyCompatSchema.optional(),
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

export const SessionRecordSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  username: UsernameSchema,
  credentialId: z.string().trim().min(1, '必须选择登录凭据'),
  encoding: z.enum(SUPPORTED_ENCODINGS).default('utf8'),
  term: z.string().trim().min(1).max(64).default(DEFAULT_TERM),
  legacyCompat: LegacyCompatSchema.default('auto'),
  jumpChain: z.array(JumpHopSchema).max(5, '跳板链最深 5 级').default([]),
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

