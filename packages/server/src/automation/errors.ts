/**
 * 自动化子系统的统一错误类型。
 *
 * 与 SshError / TelnetError 同样携带 `code` 与可选 `hint`，
 * REST 层据此映射 HTTP 状态码、前端据此给出针对性提示 —— 三套错误
 * 在结构上保持一致，错误处理链路不需要为每个子系统写一遍。
 */
export type AutomationFailureCode =
  /** 脚本 / 宏执行超时，已被强制中断 */
  | 'TIMEOUT'
  /** 沙箱相关的失败：语法错误、越权访问被拒 */
  | 'SANDBOX'
  /** 脚本运行期抛出的异常（用户代码的问题） */
  | 'RUNTIME'
  /** 宿主终端已关闭或不存在 */
  | 'SESSION_CLOSED'
  /** 需要 SSH 才能完成的操作却发生在 Telnet 会话上 */
  | 'SESSION_NOT_SSH'
  /** 该协议不支持该能力（例如对 Telnet 做批量 exec） */
  | 'UNSUPPORTED'
  /** SFTP 操作失败 */
  | 'SFTP'
  /** 目标不存在（脚本 / 宏 / 触发器 / 会话） */
  | 'NOT_FOUND'
  /** 参数非法或执行前提不满足（例如宏正在运行时再次触发） */
  | 'INVALID'
  /** 该宿主终端上已有同类任务在运行 */
  | 'BUSY'

export class AutomationFailure extends Error {
  constructor(
    readonly code: AutomationFailureCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'AutomationFailure'
  }
}

/** 脚本被强制中断（同步死循环被 vm timeout 打断）时使用的固定文案 */
export const SCRIPT_TIMEOUT_MESSAGE =
  '脚本执行超时，已被强制中断。请检查是否存在死循环或长时间未返回的等待。'
