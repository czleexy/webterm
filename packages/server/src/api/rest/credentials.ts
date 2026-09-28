/**
 * 凭据 REST：CRUD。
 * 读接口只返回摘要（无秘密字段）；写操作要求保险库处于解锁状态。
 */
import type { FastifyPluginAsync } from 'fastify'
import type {
  CreateCredentialRequest,
  CredentialSummary,
  ListCredentialsResponse,
} from '@webterm/shared'
import { handleVaultError } from './vault.js'
import {
  CreateCredentialRequestSchema,
  UpdateCredentialRequestSchema,
} from '../schemas.js'
import { sendError, sendValidationError } from '../errors.js'

export const credentialRoutes: FastifyPluginAsync = async (app) => {
  const store = app.credentials

  app.get('/credentials', async (): Promise<ListCredentialsResponse> => {
    return { credentials: store.list() }
  })

  app.post('/credentials', async (request, reply) => {
    const parsed = CreateCredentialRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      const summary = store.create(parsed.data as CreateCredentialRequest)
      return reply.code(201).send(summary)
    } catch (err) {
      return handleVaultError(reply, err)
    }
  })

  app.patch<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    const parsed = UpdateCredentialRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      const summary = store.update(request.params.id, parsed.data)
      if (!summary) {
        return sendError(reply, 404, 'CREDENTIAL_NOT_FOUND', '凭据不存在')
      }
      return summary satisfies CredentialSummary
    } catch (err) {
      return handleVaultError(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    // 先检查引用，避免删掉仍被会话使用的凭据
    const refCount = store.referencedByLibrary(request.params.id)
    if (refCount > 0) {
      return sendError(
        reply,
        409,
        'CREDENTIAL_IN_USE',
        `该凭据仍被 ${refCount} 处会话配置引用，请先更新相关会话`,
      )
    }
    try {
      const removed = store.remove(request.params.id)
      if (!removed) {
        return sendError(reply, 404, 'CREDENTIAL_NOT_FOUND', '凭据不存在')
      }
    } catch (err) {
      return handleVaultError(reply, err)
    }
    return reply.code(204).send()
  })
}
