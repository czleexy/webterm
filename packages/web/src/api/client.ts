import { API_PREFIX, type ApiError, type HealthResponse } from '@webterm/shared'

export class ApiRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

/** 统一的 REST 请求封装：拼接 API 前缀、注入 JSON 头、归一化错误。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const payload = (await response.json()) as Partial<ApiError>
      if (typeof payload.message === 'string' && payload.message.trim()) {
        message = payload.message
      }
    } catch {
      // 响应体不是 JSON，沿用状态码文本
    }
    throw new ApiRequestError(message, response.status)
  }

  return (await response.json()) as T
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}
