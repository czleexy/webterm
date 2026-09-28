/**
 * SSH 连接的建立与协商。
 *
 * 核心职责：
 * 1. 按算法档案顺序尝试握手，仅在「算法类错误」上降级重试（见 algorithms.ts）
 * 2. 校验主机密钥（TOFU），指纹不一致即拒绝
 * 3. 完成认证，返回已就绪的连接与协商信息
 *
 * 为什么把「降级重试」放在这一层：
 * 算法协商失败发生在握手阶段，此时连接尚未建立，重试成本极低且对用户完全透明。
 * 用户不需要知道目标设备有多老旧 —— 这正是客户端该替他处理的事。
 */
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { SshTarget } from '@webterm/shared'
import { SSH_READY_TIMEOUT_MS } from '@webterm/shared'
import { type AlgorithmProfile, resolveProfiles } from './algorithms.js'
import { classifySshError, isAlgorithmError, SshError } from './errors.js'
import { fingerprint, hostKeyTypeOf, type KnownHostsStore } from './known-hosts.js'

export interface NegotiationSummary {
  kex: string
  hostKeyAlgorithm: string
  cipherC2s: string
  cipherS2c: string
  mac: string
  compress: string
}

export interface EstablishedConnection {
  client: Client
  /** 远端软件标识串，如 SSH-2.0-OpenSSH_9.5；无法获取时为 '' */
  serverIdent: string
  negotiation: NegotiationSummary
  /** 主机密钥指纹 SHA256:... */
  hostKeyFingerprint: string
  /** 主机密钥算法 */
  hostKeyType: string
  /** 命中/最终使用的算法档案 */
  profile: AlgorithmProfile
  /** 握手与认证总耗时（毫秒） */
  elapsedMs: number
  /** 过程中产生的非致命告警 */
  warnings: string[]
}

export interface EstablishOptions {
  target: SshTarget
  /** 算法兼容策略，默认 auto */
  legacyCompat?: 'auto' | 'always' | 'never'
  /** 主机密钥记录；不传则跳过校验（仅用于内部测试） */
  knownHosts?: KnownHostsStore
  /** 指纹不一致时是否仍接受 */
  acceptHostKeyMismatch?: boolean
  /** 上游 socket（跳板链场景：由上一跳 forwardOut 提供）。不传则直连 */
  sock?: import('node:stream').Readable
  /**
   * keyboard-interactive 自动应答的口令。
   * 多数网络设备在密码认证之外还要求 keyboard-interactive 轮次，
   * 自动应答存储的口令可以覆盖绝大多数场景；OTP 类手动交互留待阶段 7。
   */
  keyboardInteractivePassword?: string
  logger?: ConnectionLogger
}

export interface ConnectionLogger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

/** ssh2 handshake 事件携带的协商结果 */
interface HandshakeInfo {
  kex: string
  serverHostKey: string
  cs: { cipher: string; mac: string; compress: string }
  sc: { cipher: string; mac: string; compress: string }
}

/** 内部错误：用于在降级循环中携带「已收集到的信息」继续下一次尝试 */
class HostKeyMismatchError extends Error {
  constructor(
    readonly knownFingerprint: string,
    readonly actualFingerprint: string,
    readonly keyType: string,
  ) {
    super(
      `主机密钥指纹与记录不一致。\n记录值：${knownFingerprint}\n本次值：${actualFingerprint}`,
    )
    this.name = 'HostKeyMismatchError'
  }
}

/**
 * 单次尝试：用一个固定算法档案完成「握手 + 认证」。
 * 返回就绪的连接；失败时抛出原始错误（由调用方决定是否降级）。
 */
async function attemptConnect(
  opts: EstablishOptions,
  profile: AlgorithmProfile,
): Promise<EstablishedConnection> {
  const { target, knownHosts, acceptHostKeyMismatch, logger } = opts
  const startedAt = Date.now()

  const client = new Client()
  const warnings: string[] = []
  let handshake: HandshakeInfo | undefined
  let serverIdent = ''
  let hostKeyFingerprint = ''
  let hostKeyType = ''

  return new Promise<EstablishedConnection>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    client.on('handshake', (info: HandshakeInfo) => {
      handshake = info
      logger?.debug(
        { kex: info.kex, hostKey: info.serverHostKey, cipher: info.cs.cipher },
        'SSH 握手完成',
      )
    })

    // keyboard-interactive：用存储的口令自动应答（覆盖多数网络设备的双轮认证）
    client.on('keyboard-interactive', (name, _instructions, _lang, prompts, finish) => {
      logger?.debug({ name, prompts: prompts.length }, 'keyboard-interactive 认证')
      finish(
        prompts.map(() => opts.keyboardInteractivePassword ?? '') satisfies string[],
      )
    })

    client.on('ready', () => {
      settle(() => {
        resolve({
          client,
          serverIdent,
          hostKeyFingerprint,
          hostKeyType,
          negotiation: {
            kex: handshake?.kex ?? 'unknown',
            hostKeyAlgorithm: handshake?.serverHostKey ?? 'unknown',
            cipherC2s: handshake?.cs.cipher ?? 'unknown',
            cipherS2c: handshake?.sc.cipher ?? 'unknown',
            mac: handshake?.cs.mac ?? 'unknown',
            compress: handshake?.cs.compress ?? 'unknown',
          },
          profile,
          elapsedMs: Date.now() - startedAt,
          warnings,
        })
      })
    })

    client.on('error', (err: unknown) => {
      settle(() => reject(err))
    })

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      // 上游 socket 存在时（跳板链）忽略 host/port 的直连语义
      ...(opts.sock ? { sock: opts.sock } : {}),
      // 关闭 SSH 层 keepalive 的默认值，改由上层按需控制，避免与 ws 心跳重复
      keepaliveInterval: 0,
      // 算法清单来自运行时读取 ssh2 的 SUPPORTED_* 列表（见 algorithms.ts），
      // 因此类型上是 string[]，而 @types/ssh2 约束为字面量联合类型。
      // 这里断言是有意为之：我们保证清单内每一项都来自 ssh2 自身的支持列表，
      // 且断言比硬编码字面量更不容易随 ssh2 版本升级而失效。
      ...(profile.algorithms
        ? { algorithms: profile.algorithms as ConnectConfig['algorithms'] }
        : {}),
      debug: (msg: string) => {
        // 从 debug 流中提取远端标识串（ssh2 不通过事件暴露该字段）
        const m = /^Remote ident: (.*)$/.exec(msg)
        if (m?.[1]) {
          const raw = m[1].replace(/^['"]|['"]$/g, '')
          if (raw.startsWith('SSH-')) serverIdent = raw
        }
      },
    }

    if (target.authMethod === 'privateKey') {
      if (!target.privateKey) {
        settle(() => reject(new SshError('AUTH_FAILED', '缺少私钥内容')))
        return
      }
      config.privateKey = target.privateKey
      if (target.passphrase) config.passphrase = target.passphrase
      // 私钥认证失败时允许回退到口令（若同时提供了口令）
      if (target.password) config.password = target.password
    } else {
      if (!target.password) {
        settle(() => reject(new SshError('AUTH_FAILED', '缺少登录口令')))
        return
      }
      config.password = target.password
    }

    if (knownHosts) {
      config.hostVerifier = (rawKey: Buffer): boolean => {
        const keyType = hostKeyTypeOf(rawKey)
        const fp = fingerprint(rawKey)
        hostKeyFingerprint = fp
        hostKeyType = keyType

        const verdict = knownHosts.verify(
          target.host,
          target.port,
          keyType,
          fp,
          acceptHostKeyMismatch === true,
        )

        if (verdict.status === 'mismatch') {
          settle(() =>
            reject(new HostKeyMismatchError(verdict.known.fingerprint, fp, keyType)),
          )
          return false
        }
        if (verdict.status === 'trusted-new') {
          warnings.push(`首次连接该主机，已记录主机密钥指纹（${keyType}，${fp}）`)
          logger?.info({ host: target.host, fp, keyType }, '已记录新主机密钥')
        }
        return true
      }
    }

    try {
      client.connect(config)
    } catch (err) {
      settle(() => reject(err))
    }
  })
}

/**
 * 建立 SSH 连接（含算法自动降级）。
 * 所有失败路径都会抛出 SshError，便于上层直接映射为错误码。
 */
export async function establishConnection(
  opts: EstablishOptions,
): Promise<EstablishedConnection> {
  const profiles = resolveProfiles(opts.legacyCompat ?? 'auto')
  const failures: Array<{ profile: string; error: unknown }> = []

  for (let i = 0; i < profiles.length; i += 1) {
    const profile = profiles[i]
    if (!profile) continue
    const isLast = i === profiles.length - 1

    try {
      const result = await attemptConnect(opts, profile)
      if (profile.legacy && profiles.length > 1) {
        result.warnings.push(
          `现代算法协商失败，已自动降级到 legacy 算法档案（kex=${result.negotiation.kex}）`,
        )
      }
      return result
    } catch (err) {
      failures.push({ profile: profile.name, error: err })

      // 主机密钥不一致是安全事件，绝不通过换算法绕过
      if (err instanceof HostKeyMismatchError) {
        throw new SshError('HOST_KEY_REJECTED', err.message, {
          hint: '该主机的密钥指纹与本地记录不一致。若你确认设备确实更换过密钥，请在连接设置中清除该主机的指纹记录后重试。',
          cause: err,
        })
      }

      if (!isLast && isAlgorithmError(err)) {
        opts.logger?.warn(
          { profile: profile.name, err: err instanceof Error ? err.message : String(err) },
          '算法协商失败，尝试下一个算法档案',
        )
        continue
      }

      throw classifySshError(err)
    }
  }

  // 所有档案都失败：合并各次尝试的错误信息，便于排障
  const detail = failures
    .map((f) => `  [${f.profile}] ${f.error instanceof Error ? f.error.message : String(f.error)}`)
    .join('\n')
  const last = failures[failures.length - 1]?.error
  const classified = classifySshError(last)
  throw new SshError(
    classified.code,
    `所有算法档案均协商失败：\n${detail}`,
    { hint: classified.hint, level: classified.level },
  )
}

/** 供 /api/capabilities 展示的档案概要（实现在 algorithms.ts，此处仅转导出便于就近引用） */
export { describeProfiles } from './algorithms.js'

/* ------------------------------------------------------------------ */
/* 跳板链（ProxyJump）                                                  */
/* ------------------------------------------------------------------ */

/** 链上的一跳：跳板或最终目标 */
export interface ChainNode {
  target: SshTarget
  legacyCompat?: 'auto' | 'always' | 'never'
}

/**
 * 经 forwardOut 逐跳打通到最终目标：
 * conn(A).forwardOut(B) → sock → conn(B over sock).forwardOut(C) → sock → conn(C over sock)
 *
 * 每一跳都独立走算法降级与主机密钥校验（TOFU 按跳记录）。
 * 中间跳失败时，已建立的连接会被显式关闭，不留悬挂 socket。
 */
export async function establishConnectionChain(
  nodes: ChainNode[],
  shared: Pick<EstablishOptions, 'knownHosts' | 'logger'>,
): Promise<{ connection: EstablishedConnection; intermediate: EstablishedConnection[] }> {
  if (nodes.length === 0) {
    throw new SshError('INVALID_CONFIG', '连接链为空')
  }
  if (nodes.length > 5) {
    throw new SshError('INVALID_CONFIG', '跳板链最深支持 5 级，当前层级过多')
  }

  const intermediate: EstablishedConnection[] = []
  let upstreamSock: import('node:stream').Readable | undefined

  try {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      if (!node) throw new SshError('INVALID_CONFIG', `连接链第 ${i + 1} 跳缺失`)
      const isLast = i === nodes.length - 1

      const conn = await establishConnection({
        target: node.target,
        legacyCompat: node.legacyCompat ?? 'auto',
        knownHosts: shared.knownHosts,
        logger: shared.logger,
        sock: upstreamSock,
        keyboardInteractivePassword: node.target.password,
      })

      if (isLast) {
        return { connection: conn, intermediate }
      }

      intermediate.push(conn)
      shared.logger?.debug(
        { hop: i + 1, next: `${node.target.host}:${node.target.port}` },
        '打通到下一跳的转发通道',
      )

      const next = nodes[i + 1]
      if (!next) throw new SshError('INVALID_CONFIG', `连接链第 ${i + 2} 跳缺失`)
      upstreamSock = await forwardThrough(conn, next.target)
    }
    throw new SshError('INVALID_CONFIG', '不可达：连接链遍历异常')
  } catch (err) {
    // 失败时清理整条链，防止中间跳的 socket 泄漏占用远端资源
    for (const conn of intermediate) {
      try {
        conn.client.end()
      } catch {
        /* 忽略 */
      }
    }
    throw err
  }
}

/** 在已就绪的连接上打开到目标的 direct-tcpip 通道（即 forwardOut） */
function forwardThrough(conn: EstablishedConnection, target: SshTarget): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new SshError(
          'FORWARD_TIMEOUT',
          `通过跳板打开到 ${target.host}:${target.port} 的转发通道超时`,
        ),
      )
    }, SSH_READY_TIMEOUT_MS)

    conn.client.forwardOut(
      '127.0.0.1',
      0,
      target.host,
      target.port,
      (err, stream) => {
        clearTimeout(timer)
        if (err) {
          reject(
            new SshError(
              'FORWARD_REJECTED',
              `跳板机拒绝转发到 ${target.host}:${target.port}：${err.message}`,
            ),
          )
          return
        }
        resolve(stream)
      },
    )
  })
}
