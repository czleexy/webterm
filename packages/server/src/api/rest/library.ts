/**
 * 会话库 REST：文件夹 + 会话节点的树 CRUD。
 */
import type { FastifyPluginAsync } from 'fastify'
import type {
  CreateLibraryNodeRequest,
  LibraryNode,
  LibraryTreeResponse,
} from '@webterm/shared'
import { LibraryError } from '../../db/library.js'
import { sendError, sendValidationError } from '../errors.js'
import {
  CreateLibraryNodeRequestSchema,
  UpdateLibraryNodeRequestSchema,
} from '../schemas.js'

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const library = app.library

  app.get('/library', async (): Promise<LibraryTreeResponse> => {
    return { nodes: library.list() }
  })

  app.post('/library', async (request, reply) => {
    const parsed = CreateLibraryNodeRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      const node = library.create(parsed.data as CreateLibraryNodeRequest)
      return reply.code(201).send(node satisfies LibraryNode)
    } catch (err) {
      return handleLibraryError(reply, err)
    }
  })

  app.patch<{ Params: { id: string } }>('/library/:id', async (request, reply) => {
    const parsed = UpdateLibraryNodeRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      const node = library.update(request.params.id, parsed.data)
      if (!node) return sendError(reply, 404, 'LIBRARY_NOT_FOUND', '节点不存在')
      return node
    } catch (err) {
      return handleLibraryError(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/library/:id', async (request, reply) => {
    try {
      const removed = library.remove(request.params.id)
      if (removed === 0) {
        return sendError(reply, 404, 'LIBRARY_NOT_FOUND', '节点不存在')
      }
    } catch (err) {
      return handleLibraryError(reply, err)
    }
    return reply.code(204).send()
  })
}

export function handleLibraryError(reply: Parameters<typeof sendError>[0], err: unknown): unknown {
  if (err instanceof LibraryError) {
    const status =
      err.code === 'NOT_FOUND' ? 404 : err.code === 'CREDENTIAL_MISSING' ? 400 : 409
    return sendError(reply, status, err.code, err.message)
  }
  return sendError(reply, 500, 'INTERNAL', '会话库操作失败')
}
