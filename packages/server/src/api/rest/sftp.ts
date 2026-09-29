/**
 * SFTP REST 接口。
 *
 * 分工：REST 负责「一次性的目录列举与文件操作」，WebSocket 只负责推送传输进度。
 * 这样大部分操作都能拿到标准的 HTTP 状态码与错误码，前端提示逻辑集中在一处。
 *
 * 路径约定：所有涉及路径的请求都由前端传「绝对路径」，服务端用
 * `assertRemotePath` / `LocalGuard` 各自再做一次校验 —— 绝不信任前端传来的路径。
 */
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  SFTP_PREVIEW_MAX_BYTES,
  WS_SFTP_PATH,
  protocolOf,
  type CreateSftpSessionRequest,
  type CreateSftpSessionResponse,
  type CreateTransferRequest,
  type CreateTransferResponse,
  type ListTransfersResponse,
  type SftpListResponse,
  type SftpOkResponse,
  type SftpPreviewResponse,
  type SftpSaveResponse,
  type SshTarget,
  type TransferAction,
  type TransferTask,
  type UploadStreamResponse,
} from '@webterm/shared'
import { LibraryError } from '../../db/library.js'
import { VaultError } from '../../security/vault.js'
import { SshError } from '../../ssh/errors.js'
import { SftpError, SFTP_ERROR_DESCRIPTION, SFTP_STATUS_BY_CODE } from '../../sftp/errors.js'
import { assertRemotePath, posixBasename, posixJoin, posixParent, parseMode } from '../../sftp/paths.js'
import type { BorrowedConnection } from '../../sftp/sftp-session.js'
import type { SftpSessionEntry } from '../../sftp/sftp-manager.js'
import {
  CreateSftpSessionRequestSchema,
  CreateTransferRequestSchema,
  SftpChmodRequestSchema,
  SftpListQuerySchema,
  SftpMkdirRequestSchema,
  SftpPreviewRequestSchema,
  SftpRemoveRequestSchema,
  SftpRenameRequestSchema,
  SftpSaveRequestSchema,
  SftpTouchRequestSchema,
  TransferActionSchema,
} from '../schemas.js'
import { sendError, sendTerminalError, sendValidationError } from '../errors.js'

interface SftpParams {
  id: string
}

/** 单文件上传的请求体上限（交给磁盘与远端空间去限制，而不是内存） */
const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024 * 1024

/** 去掉 UTF-8 BOM，避免编辑器里凭空多出一个不可见字符 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 文本判定：出现 NUL 或大量控制字符即视为二进制 */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192)
  if (sample.includes(0)) return true
  let control = 0
  for (const byte of sample) {
    // 允许 \t \n \r \f \b 等常见空白/控制字符
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  }
  return control / Math.max(1, sample.length) > 0.05
}

/** 解析单段 Range 请求头；不合法或不支持时返回 null（按整文件返回） */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // 后缀区间：最后 N 字节
    const suffix = Number.parseInt(rawEnd as string, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart as string, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd as string, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start > end) return null
    end = Math.min(end, size - 1)
    if (start >= size) return null
  }
  return { start, end }
}

/** 生成兼顾 ASCII 与 UTF-8 文件名的 Content-Disposition */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export const sftpRoutes: FastifyPluginAsync = async (app) => {
  const manager = app.sftp

  /**
   * 上传体是原始文件流：用 octet-stream 直接接流，不引入 multipart。
   * bodyLimit 单独放大 —— 全局 1 MiB 的限额是给 JSON 接口用的。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: UPLOAD_BODY_LIMIT },
    (_request, payload, done) => {
      done(null, payload)
    },
  )

  /** 取出会话；不存在时抛 SftpError 由统一错误处理转成 404 */
  const requireEntry = (id: string): SftpSessionEntry => {
    const entry = manager.entry(id)
    if (!entry) {
      throw new SftpError('SESSION_NOT_FOUND', 'SFTP 会话不存在或已关闭')
    }
    if (entry.session.closed) {
      throw new SftpError(
        'SESSION_NOT_FOUND',
        entry.session.closeMessage || 'SFTP 会话已结束',
      )
    }
    return entry
  }

  const handle = (reply: FastifyReply, err: unknown): unknown => {
    if (err instanceof SftpError) {
      const body = {
        error: err.code,
        message: `${SFTP_ERROR_DESCRIPTION[err.code]}：${err.message}${err.hint ? `\n\n${err.hint}` : ''}`,
      }
      return reply.code(SFTP_STATUS_BY_CODE[err.code] ?? 500).send(body)
    }
    if (err instanceof SshError) return sendTerminalError(reply, err)
    app.log.error({ err }, 'SFTP 操作失败')
    return sendError(reply, 500, 'INTERNAL', '文件操作时发生内部错误')
  }

  /* ------------------------------------------------------------------ */
  /* 会话                                                               */
  /* ------------------------------------------------------------------ */

  app.get('/sftp/sessions', async () => {
    return { sessions: manager.list() }
  })

  app.post('/sftp/sessions', async (request, reply) => {
    const parsed = CreateSftpSessionRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    const input: CreateSftpSessionRequest = parsed.data

    let target = input.config?.target
    let legacyCompat = input.config?.legacyCompat ?? 'auto'
    let jumpChain: SshTarget[] | undefined
    let title = input.title

    if (input.sessionId) {
      try {
        const { record } = app.library.getSessionRecord(input.sessionId)
        // SFTP 是 SSH 的子协议，Telnet 那头没有等价能力
        if (protocolOf(record) === 'telnet') {
          return sendError(
            reply,
            400,
            'INVALID_CONFIG',
            'Telnet 不支持文件传输：Telnet 只提供终端数据流，没有文件子系统。请为该主机配置 SSH 会话。',
          )
        }
        const plan = app.sessionResolver.resolve(record)
        target = plan.target
        jumpChain = plan.jumpChain.length > 0 ? plan.jumpChain : undefined
        legacyCompat = record.legacyCompat ?? 'auto'
        title = title ?? defaultTitle(record.username ?? '', record.host, record.port)
      } catch (err) {
        if (err instanceof VaultError) return sendError(reply, 423, err.code, err.message)
        if (err instanceof LibraryError) {
          return sendError(reply, err.code === 'NOT_FOUND' ? 404 : 400, err.code, err.message)
        }
        app.log.error({ err }, '解析会话配置失败')
        return sendError(reply, 500, 'INTERNAL', '解析会话配置失败')
      }
    }

    // 复用终端连接：仅当目标一致时才复用，否则会出现「面板显示 A 主机、
    // 实际连的是 B 主机」这种最难排查的一类问题
    let borrowed: BorrowedConnection | undefined
    if (input.terminalId) {
      const terminal = app.terminals.get(input.terminalId)
      const client = terminal?.sshClient
      // 只有 SSH 终端才有可借用的连接：Telnet 终端的 sshClient 恒为 undefined。
      // 这里直接判 protocol 字段而不是调 protocolOf()，为的是让 TS 能把
      // config.target 收窄成 SshTarget
      const terminalConfig = terminal?.config
      const terminalTarget =
        terminalConfig?.protocol === 'ssh' ? terminalConfig.target : undefined
      if (terminal && client && target && terminalTarget) {
        const sameTarget =
          terminalTarget.host === target.host &&
          terminalTarget.port === target.port &&
          terminalTarget.username === target.username
        if (sameTarget) {
          borrowed = {
            terminalId: terminal.id,
            client,
            host: target.host,
            port: target.port,
            username: target.username,
          }
        } else {
          app.log.warn(
            { terminalId: terminal.id, host: target.host },
            '终端连接的目标与 SFTP 会话不一致，改为新建独立连接',
          )
        }
      }
    }

    if (!borrowed && !target) {
      return sendError(reply, 400, 'INVALID_CONFIG', '缺少连接参数（sessionId / config / terminalId）')
    }

    const host = (target ?? borrowed)?.host as string
    const port = (target ?? borrowed)?.port as number
    const username = (target ?? borrowed)?.username as string

    try {
      const entry = await manager.create({
        title: title ?? defaultTitle(username, host, port),
        ...(borrowed ? { borrowed } : {}),
        ...(target ? { target } : {}),
        ...(jumpChain ? { jumpChain } : {}),
        legacyCompat,
      })

      const response: CreateSftpSessionResponse = {
        sftpId: entry.session.id,
        attachToken: entry.session.attachToken,
        wsPath: `${WS_SFTP_PATH}/${entry.session.id}`,
        title: entry.session.title,
        host: entry.session.host,
        port: entry.session.port,
        username: entry.session.username,
        remoteHome: entry.session.remoteHome,
        localRoot: entry.session.localRoot,
        localHome: entry.session.localHome,
        reusedConnection: entry.session.reusedConnection,
      }
      return reply.code(201).send(response)
    } catch (err) {
      if (err instanceof SshError) return sendTerminalError(reply, err)
      return handle(reply, err)
    }
  })

  app.delete<{ Params: SftpParams }>('/sftp/sessions/:id', async (request, reply) => {
    const closed = manager.close(request.params.id)
    if (!closed) return sendError(reply, 404, 'SESSION_NOT_FOUND', 'SFTP 会话不存在或已关闭')
    return reply.code(204).send()
  })

  /* ------------------------------------------------------------------ */
  /* 目录列举与文件操作                                                  */
  /* ------------------------------------------------------------------ */

  app.get<{ Params: SftpParams }>('/sftp/sessions/:id/list', async (request, reply) => {
    const parsed = SftpListQuerySchema.safeParse(request.query)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    try {
      const entry = requireEntry(request.params.id)
      const { session } = entry
      const { side, path: inputPath } = parsed.data

      if (side === 'local') {
        const { path: resolved, entries } = await session.local.list(inputPath)
        const body: SftpListResponse = {
          side,
          path: resolved,
          parent: localParent(session.localRoot, resolved),
          root: session.localRoot,
          entries,
        }
        return reply.send(body)
      }

      const target = inputPath ? assertRemotePath(inputPath) : session.remoteHome
      const { path: resolved, entries } = await session.remote.list(target)
      const body: SftpListResponse = {
        side,
        path: resolved,
        parent: posixParent(resolved),
        home: session.remoteHome,
        entries,
      }
      return reply.send(body)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/mkdir', async (request, reply) => {
    const parsed = SftpMkdirRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const { side, path: inputPath, name } = parsed.data
      if (side === 'local') {
        await session.local.mkdir(name ? path.join(inputPath, name) : inputPath)
      } else {
        const parent = assertRemotePath(inputPath)
        await session.remote.mkdir(name ? posixJoin(parent, name) : parent)
      }
      return reply.code(201).send({ ok: true } satisfies SftpOkResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/rename', async (request, reply) => {
    const parsed = SftpRenameRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const { side, from, to } = parsed.data
      if (side === 'local') await session.local.rename(from, to)
      else await session.remote.rename(from, to)
      return reply.send({ ok: true } satisfies SftpOkResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/chmod', async (request, reply) => {
    const parsed = SftpChmodRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const { side, path: inputPath, mode } = parsed.data
      const value = parseMode(mode)
      if (side === 'local') await session.local.chmod(inputPath, value)
      else await session.remote.chmod(inputPath, value)
      return reply.send({ ok: true } satisfies SftpOkResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/touch', async (request, reply) => {
    const parsed = SftpTouchRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const { side, path: inputPath } = parsed.data
      if (side === 'local') await session.local.touch(inputPath)
      else {
        const target = assertRemotePath(inputPath)
        const now = new Date()
        const existed = await session.remote.exists(target)
        if (existed) await session.remote.utimes(target, now, now)
        else await session.remote.writeFile(target, Buffer.alloc(0))
      }
      return reply.send({ ok: true } satisfies SftpOkResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/remove', async (request, reply) => {
    const parsed = SftpRemoveRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const { side, paths } = parsed.data
      for (const item of paths) {
        if (side === 'local') {
          await session.local.remove(item)
        } else {
          const target = assertRemotePath(item)
          if (target === '/') {
            throw new SftpError('PERMISSION_DENIED', '不允许删除远端根目录')
          }
          await session.remote.removeRecursive(target)
        }
      }
      return reply.send({ ok: true } satisfies SftpOkResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  /* ------------------------------------------------------------------ */
  /* 文本预览与远程编辑                                                  */
  /* ------------------------------------------------------------------ */

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/preview', async (request, reply) => {
    const parsed = SftpPreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const target = assertRemotePath(parsed.data.path)
      const maxBytes = parsed.data.maxBytes ?? SFTP_PREVIEW_MAX_BYTES

      const { entry: fileEntry } = await session.remote.lstat(target)
      if (fileEntry.type === 'dir') {
        throw new SftpError('WRONG_TYPE', '目录无法作为文本预览')
      }

      const buf = await session.remote.readHead(target, maxBytes)
      const truncated = fileEntry.size > buf.length
      const binary = looksBinary(buf)

      const body: SftpPreviewResponse = {
        path: target,
        size: fileEntry.size,
        mtime: fileEntry.mtime,
        mode: fileEntry.mode,
        kind: binary ? 'binary' : 'text',
        content: binary ? '' : stripBom(buf.toString('utf8')),
        encoding: 'utf8',
        truncated,
        editable: !binary && !truncated,
        ...(binary
          ? { reason: '该文件是二进制格式，无法以文本方式编辑' }
          : truncated
            ? { reason: `文件超过 ${Math.round(maxBytes / 1024)} KB 的预览上限，为避免截断保存导致数据损坏，禁止直接编辑` }
            : {}),
      }
      return reply.send(body)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/save', async (request, reply) => {
    const parsed = SftpSaveRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session } = requireEntry(request.params.id)
      const target = assertRemotePath(parsed.data.path)
      const { entry: current } = await session.remote.lstat(target)

      // 冲突检测：编辑期间远端文件被改动过就拒绝覆盖。
      // 允许 1 秒误差 —— SFTP 的 mtime 精度只到秒，本地换算可能带来毫秒级偏移。
      if (
        parsed.data.expectedMtime !== undefined &&
        Math.abs(current.mtime - parsed.data.expectedMtime) > 1000
      ) {
        throw new SftpError('CONFLICT', '文件在编辑期间已被其它程序修改', {
          hint: '为避免覆盖他人的改动，保存已中止。请重新打开该文件确认内容后再保存。',
        })
      }

      const data = Buffer.from(parsed.data.content, 'utf8')
      const mode = parsed.data.mode ?? current.mode
      await session.remote.writeFile(target, data, mode)

      const { entry: saved } = await session.remote.lstat(target)
      const body: SftpSaveResponse = { ok: true, mtime: saved.mtime, size: saved.size }
      return reply.send(body)
    } catch (err) {
      return handle(reply, err)
    }
  })

  /* ------------------------------------------------------------------ */
  /* 传输任务                                                            */
  /* ------------------------------------------------------------------ */

  app.get<{ Params: SftpParams }>('/sftp/sessions/:id/transfers', async (request, reply) => {
    try {
      const { queue } = requireEntry(request.params.id)
      return reply.send({
        tasks: queue.list(),
        concurrency: queue.concurrency,
      } satisfies ListTransfersResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams }>('/sftp/sessions/:id/transfers', async (request, reply) => {
    const parsed = CreateTransferRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const { session, queue } = requireEntry(request.params.id)
      const input: CreateTransferRequest = parsed.data

      // 路径侧校验：远端路径必须绝对；本地路径交由 LocalGuard 在队列里
      // 真正落地时校验（此处不做半吊子拦截，避免出现「这里过了那里不过」）
      const targetDir =
        input.direction === 'upload' ? assertRemotePath(input.targetDir) : input.targetDir
      const sources =
        input.direction === 'download' ? input.sources.map((s) => assertRemotePath(s)) : input.sources

      void session

      const tasks: TransferTask[] = queue.enqueue({ ...input, sources, targetDir })
      return reply.code(201).send({ tasks } satisfies CreateTransferResponse)
    } catch (err) {
      return handle(reply, err)
    }
  })

  app.post<{ Params: SftpParams & { taskId: string; action: string } }>(
    '/sftp/sessions/:id/transfers/:taskId/:action',
    async (request, reply) => {
      const action = TransferActionSchema.safeParse(request.params.action)
      if (!action.success) {
        return sendError(reply, 400, 'INVALID_CONFIG', `不支持的操作：${request.params.action}`)
      }
      try {
        const { queue } = requireEntry(request.params.id)
        const task = queue.action(request.params.taskId, action.data as TransferAction)
        return reply.send({ task })
      } catch (err) {
        return handle(reply, err)
      }
    },
  )

  app.delete<{ Params: SftpParams & { taskId: string } }>(
    '/sftp/sessions/:id/transfers/:taskId',
    async (request, reply) => {
      try {
        const { queue } = requireEntry(request.params.id)
        queue.remove(request.params.taskId)
        return reply.code(204).send()
      } catch (err) {
        return handle(reply, err)
      }
    },
  )

  /* ------------------------------------------------------------------ */
  /* 浏览器 ↔ 远端 的原始文件流（真正跨机器搬运时使用）                   */
  /* ------------------------------------------------------------------ */

  app.post<{ Params: SftpParams; Querystring: { path: string; offset?: string } }>(
    '/sftp/sessions/:id/upload',
    async (request, reply) => {
      const payload = request.body as Readable | undefined
      const inputPath = request.query.path
      if (!inputPath) return sendError(reply, 400, 'INVALID_PATH', '缺少 path 参数')
      if (!payload || typeof (payload as Readable).pipe !== 'function') {
        return sendError(reply, 400, 'INVALID_CONFIG', '请求体必须是 application/octet-stream 的文件流')
      }

      try {
        const { session } = requireEntry(request.params.id)
        const target = assertRemotePath(inputPath)
        const offset = Math.max(0, Number.parseInt(request.query.offset ?? '0', 10) || 0)

        const parent = posixParent(target)
        if (parent) await session.remote.mkdirp(parent)

        const dest = await session.remote.createWriteStream(target, {
          flags: offset > 0 ? 'r+' : 'w',
          start: offset,
        })

        let written = 0
        payload.on('data', (chunk: Buffer) => {
          written += chunk.length
        })
        await pipeline(payload, dest)

        const size = (await session.remote.sizeOf(target)) ?? offset + written
        return reply.send({
          ok: true,
          path: target,
          written,
          size,
        } satisfies UploadStreamResponse)
      } catch (err) {
        return handle(reply, err)
      }
    },
  )

  app.get<{ Params: SftpParams; Querystring: { path: string } }>(
    '/sftp/sessions/:id/download',
    async (request, reply) => {
      const inputPath = request.query.path
      if (!inputPath) return sendError(reply, 400, 'INVALID_PATH', '缺少 path 参数')
      try {
        const { session } = requireEntry(request.params.id)
        const target = assertRemotePath(inputPath)
        return await sendFileStream(request, reply, {
          name: posixBasename(target),
          size: async () => (await session.remote.lstat(target)).entry.size,
          read: (range) => session.remote.createReadStream(target, range),
        })
      } catch (err) {
        return handle(reply, err)
      }
    },
  )

  /**
   * 本地面板文件的下载（落回浏览器）。
   * 双栏模式下这一侧通常就在同一台机器上，此接口是给「服务跑在远端、
   * 浏览器在本地」的部署准备的。
   */
  app.get<{ Params: SftpParams; Querystring: { path: string } }>(
    '/sftp/sessions/:id/local/download',
    async (request, reply) => {
      const inputPath = request.query.path
      if (!inputPath) return sendError(reply, 400, 'INVALID_PATH', '缺少 path 参数')
      try {
        const { session } = requireEntry(request.params.id)
        const local = session.local
        return await sendFileStream(request, reply, {
          name: path.basename(inputPath),
          size: async () => (await local.stat(inputPath)).size,
          read: async (range) => local.createReadStream(inputPath, range),
        })
      } catch (err) {
        return handle(reply, err)
      }
    },
  )
}

/** 本地面板的向上导航边界：不得超过根目录 */
function localParent(root: string, current: string): string | null {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(current)
  if (resolved === resolvedRoot) return null
  const parent = path.dirname(resolved)
  const rel = path.relative(resolvedRoot, parent)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return parent
}

interface StreamSource {
  name: string
  size: () => Promise<number>
  read: (range: { start?: number; end?: number }) => Promise<Readable> | Readable
}

/** 统一的文件流响应：支持 HTTP Range，浏览器因此可以用原生断点续传 */
async function sendFileStream(
  request: FastifyRequest,
  reply: FastifyReply,
  source: StreamSource,
): Promise<FastifyReply> {
  const size = await source.size()
  const range = parseRange(request.headers.range, size)

  reply.header('accept-ranges', 'bytes')
  reply.header('content-type', 'application/octet-stream')
  reply.header('content-disposition', disposition(source.name))

  if (range) {
    reply.code(206)
    reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`)
    reply.header('content-length', String(range.end - range.start + 1))
    const stream = await source.read(range)
    return reply.send(stream)
  }

  reply.header('content-length', String(size))
  const stream = await source.read({})
  return reply.send(stream)
}

/** 由连接参数推导默认标题，与终端侧保持一致 */
function defaultTitle(username: string, host: string, port: number): string {
  return `${username}@${host}${port === 22 ? '' : `:${port}`}`
}
