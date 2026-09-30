/**
 * 插件子系统的统一错误类型。
 *
 * 与 SshError / TelnetError / AutomationFailure 保持同一结构：
 * 携带 `code` 与可选 `hint`，REST 层据此映射状态码，界面据此给处置建议。
 */
export type PluginFailureCode =
  /** 插件目录不存在 / 插件 id 未知 */
  | 'NOT_FOUND'
  /** 清单缺失、JSON 非法、字段不合法、apiVersion 不匹配 */
  | 'MANIFEST'
  /** 插件入口抛错、注册项非法、处理器抛错 */
  | 'RUNTIME'
  /** 插件处于 error / disabled 状态，无法执行该操作 */
  | 'UNAVAILABLE'
  /** 参数非法（如配置值类型不符） */
  | 'INVALID'
  /** 重名注册项（id 在同插件内重复） */
  | 'DUPLICATE'

export class PluginFailure extends Error {
  constructor(
    readonly code: PluginFailureCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'PluginFailure'
  }
}
