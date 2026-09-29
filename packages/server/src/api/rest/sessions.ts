/**
 * 会话探测接口：只做连通性（与 SSH 的握手认证），不开终端会话。
 *
 * 用于「测试连接」按钮。SSH 与 Telnet 的探测语义差别很大，但对外保持同一份响应结构：
 *
 * - SSH：能区分「连不上」「认证失败」「认证通过但拒绝开会话」三种故障。
 *   后两者对排障最有价值 —— 老旧设备上「权限有、但不给 shell」极其常见，
 *   因此这里把「shell 被拒」降级为 warning 而非错误。
 * - Telnet：没有认证阶段，能验证的只有「TCP 通不通」与「对端说不说话」。
 *   顺带把读到的欢迎语（banner）带回去 —— 这是判断端口 23 后面到底是台设备
 *   还是别的服务最直接的证据。
 */
import type { FastifyPluginAsync } from 'fastify'
import type { ProbeSessionResponse, SshTarget, TelnetTarget } from '@webterm/shared'
import {
  DEFAULT_TERM,
  TELNET_BANNER_MAX_CHARS,
  TELNET_BANNER_WAIT_MS,
  protocolOf,
} from '@webterm/shared'
import { LibraryError } from '../../db/library.js'
import { VaultError } from '../../security/vault.js'
import { establishConnection } from '../../ssh/connection.js'
import { classifySshError } from '../../ssh/errors.js'
import { TelnetTransport } from '../../telnet/transport.js'
import { ProbeSessionRequestSchema } from '../schemas.js'
import { sendError, sendTerminalError, sendValidationError } from '../errors.js'

/** Telnet 明文风险提示：每次探测都明确说一次，不让用户忘记这条前提 */
const PLAINTEXT_WARNING =
  'Telnet 是明文协议：口令与全部会话内容都会以明文经过网络。请仅在受信网络中使用，或改用 SSH。'

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/sessions/probe', async (request, reply) => {
    const parsed = ProbeSessionRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    const input = parsed.data
    let protocol = input.protocol
    let legacyCompat = input.legacyCompat
    let sshTarget: SshTarget | undefined
    let telnetTarget: TelnetTarget | undefined

    if (input.sessionId && !input.target) {
      // 引用会话库：以库里记录的协议为准
      try {
        const { record } = app.library.getSessionRecord(input.sessionId)
        protocol = protocolOf(record)
        if (protocol === 'telnet') {
          telnetTarget = { host: record.host, port: record.port }
        } else {
          const plan = app.sessionResolver.resolve(record)
          sshTarget = plan.target
          // 未显式指定策略时采用会话保存的策略
          legacyCompat = legacyCompat ?? record.legacyCompat
        }
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
    } else if (input.target) {
      // 快速连接：按 protocol 判别目标形状（Telnet 的目标不可能带凭据字段）
      if (protocol === 'telnet') {
        telnetTarget = input.target as TelnetTarget
      } else {
        sshTarget = input.target as SshTarget
      }
    }

    if (protocol === 'telnet') {
      if (!telnetTarget) {
        return sendError(reply, 400, 'INVALID_CONFIG', '缺少 Telnet 连接参数')
      }
      try {
        return reply.send(await probeTelnet(telnetTarget))
      } catch (err) {
        return sendTerminalError(reply, err)
      }
    }

    if (!sshTarget) {
      return sendError(reply, 400, 'INVALID_CONFIG', '缺少连接参数')
    }

    let conn
    try {
      conn = await establishConnection({
        target: sshTarget,
        legacyCompat: legacyCompat ?? 'auto',
        // 探测阶段仍做主机密钥校验，这样「指纹不一致」能在测试连接时就被发现
        knownHosts: app.knownHosts,
        keyboardInteractivePassword: sshTarget.password,
        logger: app.log,
      })
    } catch (err) {
      return sendTerminalError(reply, err)
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
      protocol: 'ssh',
      elapsedMs: conn.elapsedMs,
      serverIdent: conn.serverIdent,
      authMethod: sshTarget.authMethod,
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

/**
 * Telnet 探测：连上去、听一会儿、断开。
 *
 * 不做交互式登录 —— 探测要回答的是「这个端口后面是不是一台可用的 Telnet 设备」，
 * 而不是替用户登录。真要登录，用终端自己连。
 */
async function probeTelnet(target: TelnetTarget): Promise<ProbeSessionResponse> {
  const started = Date.now()
  const transport = await TelnetTransport.connect({
    host: target.host,
    port: target.port,
    term: DEFAULT_TERM,
    cols: 80,
    rows: 24,
  })

  try {
    const banner = await collectBanner(transport)
    const elapsedMs = Date.now() - started
    const options = transport.negotiationSummary

    const warnings: string[] = [PLAINTEXT_WARNING]

    if (banner.length === 0) {
      warnings.push(
        `连接成功，但设备在 ${TELNET_BANNER_WAIT_MS} ms 内没有输出任何内容。部分设备需要先按一次回车才显示提示符，这属于正常现象。`,
      )
    }
    if (!options.remoteEcho) {
      warnings.push('设备未声明由它负责回显（WILL ECHO），连接后将由本端做本地回显兜底。')
    }
    // 本端会主动声明 SGA，因此不能拿「本端选项为空」当作「没协商」的判据；
    // 对端一个选项都没确认，才说明它根本没参与协商
    if (options.remoteOptions.length === 0) {
      warnings.push('设备没有确认任何 Telnet 选项协商，可能是极简实现，也可能并非标准 Telnet 服务。')
    }

    return {
      ok: true,
      protocol: 'telnet',
      elapsedMs,
      // Telnet 协议本身没有版本串
      serverIdent: '',
      authMethod: 'none',
      banner,
      warnings,
    }
  } finally {
    transport.close()
  }
}

/** 在限定时间内收集对端输出的欢迎语，超出长度上限即停止累积 */
function collectBanner(transport: TelnetTransport): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let done = false

    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      transport.off('data', onData)
      const text = Buffer.concat(chunks).toString('utf8')
      // 设备输出的多为 ASCII，去掉控制字符，避免把 IAC 残留或光标控制带进响应
      const cleaned = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
      resolve(cleaned.slice(0, TELNET_BANNER_MAX_CHARS))
    }

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      bytes += chunk.length
      if (bytes >= TELNET_BANNER_MAX_CHARS * 4) finish()
    }

    const timer = setTimeout(finish, TELNET_BANNER_WAIT_MS)
    transport.on('data', onData)
  })
}
