/**
 * SSH 算法档案（Algorithm Profile）。
 *
 * 为什么需要这一层：
 * ssh2 v1 出于安全考虑，把 `diffie-hellman-group14-sha1`、`ssh-rsa`、`ssh-dss`
 * 等 legacy 算法从「默认启用」中移除了，但它们仍在 `SUPPORTED_*` 列表内（可显式启用）。
 * 而大量网络设备（华为 / H3C / 老旧交换机路由器）只支持这些算法，
 * 直接连会报 `no matching key exchange algorithm`。
 *
 * 因此这里定义两档档案：
 * - modern：完全交给 ssh2 默认值，安全性最好
 * - legacy：显式补齐 legacy 算法，并把兼容性最好的算法排在前面
 *
 * 连接的策略是「按顺序尝试 + 只在算法类错误上降级」，见 connection.ts。
 *
 * 实现细节：算法名清单不硬编码，而是与 ssh2 运行时的 `SUPPORTED_*` 取交集，
 * 这样 ssh2 升级后移除某个算法时，我们不会拿着已不支持的算法名去请求而报错。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

interface Ssh2Constants {
  SUPPORTED_KEX: string[]
  SUPPORTED_SERVER_HOST_KEY: string[]
  SUPPORTED_CIPHER: string[]
  SUPPORTED_MAC: string[]
  SUPPORTED_COMPRESSION: string[]
}

/** 加载 ssh2 的算法支持列表；失败时退化为空数组（此时仅使用 modern 档案） */
function loadSsh2Constants(): Ssh2Constants {
  try {
    const mod = require('ssh2/lib/protocol/constants.js') as Partial<Ssh2Constants>
    return {
      SUPPORTED_KEX: mod.SUPPORTED_KEX ?? [],
      SUPPORTED_SERVER_HOST_KEY: mod.SUPPORTED_SERVER_HOST_KEY ?? [],
      SUPPORTED_CIPHER: mod.SUPPORTED_CIPHER ?? [],
      SUPPORTED_MAC: mod.SUPPORTED_MAC ?? [],
      SUPPORTED_COMPRESSION: mod.SUPPORTED_COMPRESSION ?? [],
    }
  } catch {
    return {
      SUPPORTED_KEX: [],
      SUPPORTED_SERVER_HOST_KEY: [],
      SUPPORTED_CIPHER: [],
      SUPPORTED_MAC: [],
      SUPPORTED_COMPRESSION: [],
    }
  }
}

const SSH2 = loadSsh2Constants()

export function getSsh2Version(): string {
  try {
    const pkg = require('ssh2/package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 按期望顺序过滤出 ssh2 实际支持的算法；若支持列表为空则原样返回（兼容加载失败的情况） */
function pick(wanted: readonly string[], supported: readonly string[]): string[] {
  if (supported.length === 0) return [...wanted]
  return wanted.filter((algo) => supported.includes(algo))
}

/* ------------------------------------------------------------------ */
/* legacy 档案的期望算法顺序（越靠前优先级越高）                          */
/* ------------------------------------------------------------------ */

/**
 * KEX：现代算法仍然排在前面（能谈成就用强的），把 legacy 垫在后面兜底。
 * `diffie-hellman-group14-sha1` 是 RFC 4253 的 REQUIRED 算法，几乎必然存在，
 * 因此它是老设备最可靠的兜底选项。
 */
const LEGACY_KEX_WANTED = [
  'curve25519-sha256',
  'curve25519-sha256@libssh.org',
  'ecdh-sha2-nistp256',
  'ecdh-sha2-nistp384',
  'ecdh-sha2-nistp521',
  'diffie-hellman-group-exchange-sha256',
  'diffie-hellman-group16-sha512',
  'diffie-hellman-group18-sha512',
  'diffie-hellman-group14-sha256',
  'diffie-hellman-group15-sha512',
  'diffie-hellman-group17-sha512',
  // ↓ legacy 兜底
  'diffie-hellman-group14-sha1',
  'diffie-hellman-group-exchange-sha1',
  'diffie-hellman-group1-sha1',
] as const

/**
 * 主机密钥：与 KEX 不同，这里必须把 `ssh-rsa` 提到 `ecdsa-sha2-nistp*` 之前。
 *
 * 原因是实测发现的真实问题：部分设备的主机密钥算法清单里同时通告了
 * `ecdsa-sha2-nistp521` 和 `ssh-rsa`，但用 ecdsa-sha2-nistp521 时会因为
 * 签名编码不规范导致客户端签名校验失败（OpenSSH 能通过，ssh2 会报
 * `signature verification failed`）。把 ssh-rsa 提前可绕开该问题。
 *
 * 密钥交换仍会协商出强算法；主机密钥算法只影响「如何验证服务端身份」，
 * 对这条自用链路而言，优先可用性更合理。
 */
const LEGACY_HOST_KEY_WANTED = [
  'ssh-ed25519',
  'rsa-sha2-512',
  'rsa-sha2-256',
  // ↓ 兼容老设备，刻意排在 ecdsa 之前
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-dss',
] as const

const LEGACY_CIPHER_WANTED = [
  'chacha20-poly1305@openssh.com',
  'aes256-gcm@openssh.com',
  'aes128-gcm@openssh.com',
  'aes256-ctr',
  'aes192-ctr',
  'aes128-ctr',
  // ↓ legacy 兜底
  'aes256-cbc',
  'aes192-cbc',
  'aes128-cbc',
  '3des-cbc',
] as const

const LEGACY_MAC_WANTED = [
  'hmac-sha2-256-etm@openssh.com',
  'hmac-sha2-512-etm@openssh.com',
  'hmac-sha1-etm@openssh.com',
  'hmac-sha2-256',
  'hmac-sha2-512',
  'hmac-sha1',
  // ↓ legacy 兜底
  'hmac-sha2-256-96',
  'hmac-sha1-96',
  'hmac-md5',
  'hmac-md5-96',
] as const

const COMPRESS_WANTED = ['none', 'zlib@openssh.com', 'zlib'] as const

/* ------------------------------------------------------------------ */

export interface AlgorithmProfileAlgorithms {
  kex: string[]
  serverHostKey: string[]
  cipher: string[]
  hmac: string[]
  compress: string[]
}

export interface AlgorithmProfile {
  name: string
  description: string
  legacy: boolean
  /**
   * 传给 ssh2 的 algorithms 配置。
   * 为 undefined 表示使用 ssh2 内置默认值（modern 档案）。
   */
  algorithms: AlgorithmProfileAlgorithms | undefined
}

const MODERN_PROFILE: AlgorithmProfile = {
  name: 'modern',
  description: 'ssh2 内置默认算法，不使用任何 legacy 项，安全性优先',
  legacy: false,
  algorithms: undefined,
}

const LEGACY_PROFILE: AlgorithmProfile = {
  name: 'legacy',
  description:
    '在现代算法基础上补齐 SHA-1 / CBC / DSS 等 legacy 算法，并把 ssh-rsa 主机密钥提前，兼容老旧网络设备',
  legacy: true,
  algorithms: {
    kex: pick(LEGACY_KEX_WANTED, SSH2.SUPPORTED_KEX),
    serverHostKey: pick(LEGACY_HOST_KEY_WANTED, SSH2.SUPPORTED_SERVER_HOST_KEY),
    cipher: pick(LEGACY_CIPHER_WANTED, SSH2.SUPPORTED_CIPHER),
    hmac: pick(LEGACY_MAC_WANTED, SSH2.SUPPORTED_MAC),
    compress: pick(COMPRESS_WANTED, SSH2.SUPPORTED_COMPRESSION),
  },
}

/** 按尝试顺序排列的档案列表 */
export const ALGORITHM_PROFILES: readonly [AlgorithmProfile, AlgorithmProfile] = [
  MODERN_PROFILE,
  LEGACY_PROFILE,
]

export function getProfile(name: string): AlgorithmProfile | undefined {
  return ALGORITHM_PROFILES.find((p) => p.name === name)
}

/**
 * 根据兼容策略解析出要尝试的档案序列。
 * - auto：先 modern 再 legacy（推荐）
 * - always：只用 legacy
 * - never：只用 modern
 */
export function resolveProfiles(
  policy: 'auto' | 'always' | 'never' = 'auto',
): AlgorithmProfile[] {
  switch (policy) {
    case 'always':
      return [LEGACY_PROFILE]
    case 'never':
      return [MODERN_PROFILE]
    case 'auto':
    default:
      return [MODERN_PROFILE, LEGACY_PROFILE]
  }
}

/**
 * 输出可序列化的档案描述，供 GET /api/capabilities 展示。
 * modern 档案的算法列表为空数组，表示「由 ssh2 内置默认值决定」——
 * 这样升级 ssh2 后，界面展示不会与真实行为不一致。
 */
export function describeProfiles(): Array<{
  name: string
  description: string
  legacy: boolean
  kex: string[]
  serverHostKey: string[]
  cipher: string[]
  mac: string[]
  compress: string[]
}> {
  return ALGORITHM_PROFILES.map((p) => ({
    name: p.name,
    description: p.description,
    legacy: p.legacy,
    kex: p.algorithms?.kex ?? [],
    serverHostKey: p.algorithms?.serverHostKey ?? [],
    cipher: p.algorithms?.cipher ?? [],
    mac: p.algorithms?.hmac ?? [],
    compress: p.algorithms?.compress ?? [],
  }))
}
