/**
 * 会话记录 → 可连接参数的解析器。
 *
 * 这是「持久化数据」与「连接执行」之间的唯一桥梁：
 * 从会话库取出 SessionRecord，从保险库解出凭据明文，组装成 SshTarget。
 * 明文秘密只在这一步存在，用完即被 GC。
 */
import type { SshTarget, SessionRecord } from '@webterm/shared'
import { VaultError } from '../security/vault.js'
import { LibraryError } from '../db/library.js'
import type { CredentialStore } from '../security/credential-store.js'

export interface ResolvedConnectPlan {
  target: SshTarget
  /** 跳板链明文 target，按连接顺序 */
  jumpChain: SshTarget[]
}

export class SessionResolver {
  constructor(private readonly credentials: CredentialStore) {}

  resolve(record: SessionRecord): ResolvedConnectPlan {
    // Telnet 会话没有凭据这一层，走到这里说明调用方判断错了协议
    if ((record.protocol ?? 'ssh') === 'telnet') {
      throw new LibraryError('NOT_A_SESSION', 'Telnet 会话没有 SSH 凭据可解析')
    }

    const target = this.buildTarget(record)
    const jumpChain = (record.jumpChain ?? []).map((hop, i) =>
      this.buildTarget(
        {
          host: hop.host,
          port: hop.port,
          username: hop.username,
          credentialId: hop.credentialId,
        },
        `跳板链第 ${i + 1} 跳`,
      ),
    )
    return { target, jumpChain }
  }

  private buildTarget(
    ref: Pick<SessionRecord, 'host' | 'port' | 'username' | 'credentialId'>,
    label = '登录',
  ): SshTarget {
    // username / credentialId 在类型上是可选的（Telnet 记录没有它们），
    // 因此在这里补齐「SSH 场景必填」这一约束，而不是把可选性一路带到 SSH 层
    if (!ref.credentialId) {
      throw new LibraryError('CREDENTIAL_MISSING', `${label}：该会话没有配置凭据`)
    }
    if (!ref.username) {
      throw new LibraryError('CREDENTIAL_MISSING', `${label}：该会话没有配置用户名`)
    }
    const secret = this.requireSecret(ref.credentialId, label)
    return {
      host: ref.host,
      port: ref.port,
      username: ref.username,
      authMethod: secret.privateKey ? 'privateKey' : 'password',
      password: secret.password,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
    }
  }

  private requireSecret(credentialId: string, label: string) {
    try {
      return this.credentials.resolveSecret(credentialId)
    } catch (err) {
      if (err instanceof VaultError) {
        throw new VaultError(err.code, `${label}：${err.message}`)
      }
      throw err
    }
  }
}
