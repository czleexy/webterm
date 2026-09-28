/**
 * 保险库 REST：主密码状态 / 设置 / 解锁 / 锁定。
 *
 * 语义提醒：
 * - setup 只允许一次；已初始化后返回 409
 * - 解锁状态只存在于服务端进程内存（重启即锁），前端不持有任何密钥材料
 */
import type { FastifyPluginAsync } from 'fastify'
import type {
  VaultOkResponse,
  VaultStatusResponse,
} from '@webterm/shared'
import { VaultError } from '../../security/vault.js'
import { sendValidationError } from '../errors.js'
import { SetupVaultRequestSchema } from '../schemas.js'

export const vaultRoutes: FastifyPluginAsync = async (app) => {
  const vault = app.vault

  app.get('/vault/status', async (): Promise<VaultStatusResponse> => {
    const status: VaultStatusResponse = {
      initialized: vault.initialized,
      unlocked: vault.unlocked,
    }
    if (vault.unlocked) {
      status.credentialCount = (
        app.credentials.list() as unknown[]
      ).length
    }
    return status
  })

  app.post('/vault/setup', async (request, reply) => {
    const parsed = SetupVaultRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      vault.setup(parsed.data.masterPassword)
    } catch (err) {
      if (!(err instanceof VaultError)) request.log.error({ err }, '设置主密码时发生非预期错误')
      return handleVaultError(reply, err)
    }
    app.log.info('主密码已设置，保险库初始化完成')
    const ok: VaultOkResponse = { ok: true }
    return ok
  })

  app.post('/vault/unlock', async (request, reply) => {
    const parsed = SetupVaultRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      vault.unlock(parsed.data.masterPassword)
    } catch (err) {
      if (!(err instanceof VaultError)) request.log.error({ err }, '解锁保险库时发生非预期错误')
      return handleVaultError(reply, err)
    }
    app.log.info('保险库已解锁')
    const ok: VaultOkResponse = { ok: true }
    return ok
  })

  app.post('/vault/lock', async (): Promise<VaultOkResponse> => {
    vault.lock()
    app.log.info('保险库已锁定')
    return { ok: true }
  })
}

/** 保险库错误 → HTTP 状态码的统一映射 */
export function handleVaultError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof VaultError) {
    const status =
      err.code === 'NOT_INITIALIZED'
        ? 409
        : err.code === 'ALREADY_INITIALIZED'
          ? 409
          : err.code === 'LOCKED'
            ? 423 // Locked
            : err.code === 'WRONG_PASSWORD'
              ? 401
              : 400 // WEAK_PASSWORD
    return reply.code(status).send({ error: err.code, message: err.message })
  }
  return reply.code(500).send({ error: 'INTERNAL', message: '保险库操作失败' })
}
