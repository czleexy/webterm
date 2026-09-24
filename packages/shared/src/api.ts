/**
 * REST 接口的请求 / 响应契约。
 * 阶段 0 仅包含健康检查；后续阶段在此文件追加 sessions / sftp / forwards 等类型。
 */

/** 统一错误响应体 */
export interface ApiError {
  error: string
  message: string
  /** 可选的字段级校验错误 */
  details?: Array<{ path: string; message: string }>
}

/** GET /api/health */
export interface HealthResponse {
  ok: boolean
  name: string
  version: string
  /** 进程已运行秒数 */
  uptimeSec: number
  /** 如 v22.22.2 */
  nodeVersion: string
  /** ISO 8601 */
  startedAt: string
  /** 当前活跃终端标签数（阶段 1 起生效） */
  activeTabs: number
}
