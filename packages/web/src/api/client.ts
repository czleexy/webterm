import {
  API_PREFIX,
  type ApiError,
  type CapabilitiesResponse,
  type CreateCredentialRequest,
  type CreateLibraryNodeRequest,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type CredentialSummary,
  type HealthResponse,
  type LibraryNode,
  type LibraryTreeResponse,
  type ListCredentialsResponse,
  type ListTerminalsResponse,
  type ProbeSessionRequest,
  type ProbeSessionResponse,
  type SessionConfig,
  type SshSessionConfig,
  type SshTarget,
  type TelnetSessionConfig,
  type TelnetTarget,
  type UpdateCredentialRequest,
  type UpdateLibraryNodeRequest,
  type VaultStatusResponse,
} from '@webterm/shared'

export class ApiRequestError extends Error {
  readonly status: number
  /** 服务端返回的错误码（如 AUTH_FAILED），用于针对性提示 */
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
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
    let code: string | undefined
    try {
      const payload = (await response.json()) as Partial<ApiError>
      if (typeof payload.message === 'string' && payload.message.trim()) {
        message = payload.message
      }
      if (typeof payload.error === 'string') code = payload.error
    } catch {
      // 响应体不是 JSON，沿用状态码文本
    }
    throw new ApiRequestError(message, response.status, code)
  }

  // 204 无响应体
  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

export function fetchCapabilities(): Promise<CapabilitiesResponse> {
  return request<CapabilitiesResponse>('/capabilities')
}

export function listTerminals(): Promise<ListTerminalsResponse> {
  return request<ListTerminalsResponse>('/terminals')
}

/** 连接探测：只验证连通性与认证，不开终端会话 */
export function probeSession(body: ProbeSessionRequest): Promise<ProbeSessionResponse> {
  return request<ProbeSessionResponse>('/sessions/probe', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 创建终端（服务端此时已建立真实 SSH 连接） */
export function createTerminal(body: CreateTerminalRequest): Promise<CreateTerminalResponse> {
  return request<CreateTerminalResponse>('/terminals', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function closeTerminal(terminalId: string): Promise<void> {
  return request<void>(`/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' })
}

/* ---------------- 阶段 2：保险库 / 凭据 / 会话库 ---------------- */

export function fetchVaultStatus(): Promise<VaultStatusResponse> {
  return request<VaultStatusResponse>('/vault/status')
}

export function setupVault(masterPassword: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/vault/setup', {
    method: 'POST',
    body: JSON.stringify({ masterPassword }),
  })
}

export function unlockVault(masterPassword: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/vault/unlock', {
    method: 'POST',
    body: JSON.stringify({ masterPassword }),
  })
}

export function lockVault(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/vault/lock', { method: 'POST' })
}

export function listCredentials(): Promise<ListCredentialsResponse> {
  return request<ListCredentialsResponse>('/credentials')
}

export function createCredential(body: CreateCredentialRequest): Promise<CredentialSummary> {
  return request<CredentialSummary>('/credentials', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateCredential(
  id: string,
  body: UpdateCredentialRequest,
): Promise<CredentialSummary> {
  return request<CredentialSummary>(`/credentials/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteCredential(id: string): Promise<void> {
  return request<void>(`/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function fetchLibrary(): Promise<LibraryTreeResponse> {
  return request<LibraryTreeResponse>('/library')
}

export function createLibraryNode(body: CreateLibraryNodeRequest): Promise<LibraryNode> {
  return request<LibraryNode>('/library', { method: 'POST', body: JSON.stringify(body) })
}

export function updateLibraryNode(
  id: string,
  body: UpdateLibraryNodeRequest,
): Promise<LibraryNode> {
  return request<LibraryNode>(`/library/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteLibraryNode(id: string): Promise<void> {
  return request<void>(`/library/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 由浏览器当前地址推导 WebSocket 基址，兼容开发态 Vite 代理与生产态同源部署 */
export function resolveWsBase(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

/** 组装终端 WebSocket 的完整地址 */
export function buildTerminalWsUrl(wsPath: string, attachToken: string): string {
  return `${resolveWsBase()}${wsPath}?token=${encodeURIComponent(attachToken)}`
}

/** 便捷类型导出，供组件直接引用 */
export type {
  SessionConfig,
  SshSessionConfig,
  TelnetSessionConfig,
  SshTarget,
  TelnetTarget,
  CreateTerminalResponse,
}
