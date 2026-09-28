/**
 * 会话探测接口：只做「TCP + 握手 + 认证」，不开终端会话。
 *
 * 用于「测试连接」按钮。与直接创建终端的区别是：
 * 即使远端拒绝开启 shell（设备侧策略限制），认证信息依然是有价值的诊断结果，
 * 因此这里把「shell 被拒」降级为 warning 而非错误，让用户能区分
 * 「连不上」和「连上了但不让登录」这两种完全不同的故障。
 */
import type { FastifyPluginAsync } from 'fastify'
import type { ProbeSessionResponse } from '@webterm/shared'
import { LibraryError } from '../../db/library.js'
import { VaultError } from '../../security/vault.js'
import { establishConnection } from '../../ssh/connection.js'
import { classifySshError } from '../../ssh/errors.js'
import { ProbeSessionRequestSchema } from '../schemas.js'
import { sendError, sendSshError, sendValidationError } from '../errors.js'

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/sessions/probe', async (request, reply) => {
    const parsed = ProbeSessionRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    const input = parsed.data
    let target = input.target
    let legacyCompat = input.legacyCompat

    if (input.sessionId && !target) {
      try {
        const { record } = app.library.getSessionRecord(input.sessionId)
        const plan = app.sessionResolver.resolve(record)
        target = plan.target
        // 未显式指定策略时采用会话保存的策略
        legacyCompat = legacyCompat ?? record.legacyCompat
      } catch (err) {
        if (err instanceof VaultError) {
          return sendError(reply, 423, err.code, err.message)
        }
        if (err instanceof LibraryError) {
          const status = err.code === 'NOT_FOUND' ? 404 : 400
          return sendError(reply, status, err.code, err.message)
        }
        throw err
      }
    }
    if (!target) {
      return sendError(reply, 400, 'INVALID_CONFIG', '缺少连接参数')
    }

    let conn
    try {
      conn = await establishConnection({
        target,
        legacyCompat: legacyCompat ?? 'auto',
        // 探测阶段仍做主机密钥校验，这样「指纹不一致」能在测试连接时就被发现
        knownHosts: app.knownHosts,
        keyboardInteractivePassword: target.password,
        logger: app.log,
      })
    } catch (err) {
      return sendSshError(reply, err)
    }

    const warnings = [...conn.warnings]

    // 额外尝试申请一次 PTY + shell，用于提前发现「远端拒绝会话」这类限制。
    // 这一步失败不影响探测结论，只作为告警返回。
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      // 兜底超时，避免个别设备在 shell 请求后挂住不响应
      const timer = setTimeout(() => {
        warnings.push('申请终端会话超时，未能确认远端是否允许 shell 登录')
        finish()
      }, 8000)

      try {
        conn.client.shell({ term: 'vt100', cols: 80, rows: 24 }, (err, stream) => {
          clearTimeout(timer)
          if (err) {
            const classified = classifySshError(err)
            if (classified.code === 'CHANNEL_REJECTED' || classified.code === 'PTY_FAILED') {
              warnings.push(
                '远端接受了连接与认证，但拒绝开启终端会话。该账号可能没有 CLI 登录权限，或设备仅开放了受限服务。',
              )
            } else {
              warnings.push(`申请终端会话失败：${classified.message}`)
            }
            finish()
            return
          }
          // shell 能开就立刻关掉，探测不需要保持会话
          try {
            stream.end()
          } catch {
            /* 忽略 */
          }
          finish()
        })
      } catch (err) {
        clearTimeout(timer)
        warnings.push(`申请终端会话异常：${err instanceof Error ? err.message : String(err)}`)
        finish()
      }
    })

    if (warnings.length === 0) {
      warnings.push('连接与认证均正常，且远端允许开启终端会话。')
    }

    const response: ProbeSessionResponse = {
      ok: true,
      elapsedMs: conn.elapsedMs,
      serverIdent: conn.serverIdent,
      authMethod: target.authMethod,
      negotiation: {
        kex: conn.negotiation.kex,
        hostKeyAlgorithm: conn.negotiation.hostKeyAlgorithm,
        cipher: conn.negotiation.cipherC2s,
        mac: conn.negotiation.mac,
        profile: conn.profile.name,
        legacy: conn.profile.legacy,
      },
      hostKeyFingerprint: conn.hostKeyFingerprint,
      warnings,
    }

    try {
      conn.client.end()
    } catch {
      /* 忽略 */
    }

    return reply.send(response)
  })
}
