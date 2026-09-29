/**
 * 协议相关的收窄与展示助手。
 *
 * 会话配置在 shared 里是判别联合（SshSessionConfig | TelnetSessionConfig）。
 * 前端有些地方（标签栏、侧栏、SFTP 入口）需要「能不能开 SFTP」「显示哪个协议标签」
 * 这类判断，散落在各组件里迟早会漂移，集中放在这里。
 */
import {
  PROTOCOL_LABEL,
  type ConnectionProtocol,
  type SessionConfig,
  type SshSessionConfig,
  type SshTarget,
} from '@webterm/shared'

/** 收窄为 SSH 配置；Telnet 配置返回 null（调用方据此禁用 SSH 专有能力） */
export function asSshConfig(config: SessionConfig | undefined): SshSessionConfig | null {
  if (!config) return null
  return config.protocol === 'ssh' ? config : null
}

/** 取 SSH 目标；Telnet 配置返回 null。用于 SFTP 等只支持 SSH 的场景 */
export function sshTargetOf(config: SessionConfig | undefined): SshTarget | null {
  return asSshConfig(config)?.target ?? null
}

/** 是否为明文 Telnet 会话（用于展示风险提示） */
export function isPlaintextProtocol(protocol: ConnectionProtocol | undefined): boolean {
  return protocol === 'telnet'
}

export function protocolLabel(protocol: ConnectionProtocol | undefined): string {
  return PROTOCOL_LABEL[protocol ?? 'ssh']
}

/** 协议小标签的配色，Telnet 用琥珀色刻意区别于 SSH，提示它是明文协议 */
export const PROTOCOL_CHIP_CLASS: Record<ConnectionProtocol, string> = {
  ssh: 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-400',
  telnet: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400',
}
