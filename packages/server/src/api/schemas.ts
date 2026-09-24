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

export const ProbeSessionRequestSchema = z.object({
  target: SshTargetSchema,
  legacyCompat: LegacyCompatSchema.optional(),
})

export const CreateTerminalRequestSchema = z.object({
  config: SessionConfigSchema,
  title: z.string().trim().max(80, '标题过长').optional(),
})

export type SshTargetInput = z.infer<typeof SshTargetSchema>
export type SessionConfigInput = z.infer<typeof SessionConfigSchema>
