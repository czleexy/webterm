import {
  API_PREFIX,
  type ApiError,
  type BatchResult,
  type CapabilitiesResponse,
  type CreateCredentialRequest,
  type CreateLibraryNodeRequest,
  type CreateMacroRequest,
  type CreateScriptRequest,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type CreateTriggerRequest,
  type CreateTunnelRequest,
  type CredentialSummary,
  type HealthResponse,
  type LibraryNode,
  type LibraryTreeResponse,
  type ListCredentialsResponse,
  type ListMacrosResponse,
  type ListScriptsResponse,
  type ListTerminalsResponse,
  type ListTriggersResponse,
  type ListTunnelsResponse,
  type ListLogFilesResponse,
  type LogPreviewResponse,
  type LoggingSettings,
  type QueryAuditResponse,
  type LogFileInfo,
  type AuditEntry,
  type AuditEventType,
  type RedactionRule,
  type SessionLogSettings,
  type MacroDefinition,
  type MacroStep,
  type ProbeSessionRequest,
  type ProbeSessionResponse,
  type RunBatchRequest,
  type RunBatchResponse,
  type RunMacroRequest,
  type RunMacroResponse,
  type RunScriptRequest,
  type RunScriptResponse,
  type ScriptDefinition,
  type ScriptLogEntry,
  type ScriptRunRecord,
  type SessionConfig,
  type SshSessionConfig,
  type SshTarget,
  type TelnetSessionConfig,
  type TelnetTarget,
  type TestTriggerRequest,
  type TestTriggerResponse,
  type TriggerAction,
  type TriggerRule,
  type TriggerStats,
  type TunnelInfo,
  type TunnelSpec,
  type UpdateCredentialRequest,
  type UpdateLibraryNodeRequest,
  type UpdateMacroRequest,
  type UpdateScriptRequest,
  type UpdateTriggerRequest,
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

/* ------------------------------------------------------------------ */
/* 阶段 5：端口转发与隧道                                               */
/* ------------------------------------------------------------------ */

export function listTunnels(): Promise<ListTunnelsResponse> {
  return request<ListTunnelsResponse>('/tunnels')
}

export function createTunnel(body: CreateTunnelRequest): Promise<{ tunnel: TunnelInfo }> {
  return request<{ tunnel: TunnelInfo }>('/tunnels', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function startTunnel(id: string): Promise<{ tunnel: TunnelInfo }> {
  return request<{ tunnel: TunnelInfo }>(`/tunnels/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  })
}

export function stopTunnel(id: string): Promise<{ tunnel: TunnelInfo }> {
  return request<{ tunnel: TunnelInfo }>(`/tunnels/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  })
}

export function deleteTunnel(id: string): Promise<void> {
  return request<void>(`/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/* ------------------------------------------------------------------ */
/* 阶段 6：自动化与批量运维                                             */
/* ------------------------------------------------------------------ */

/* ---------------- 触发器 ---------------- */

export function listTriggers(): Promise<ListTriggersResponse> {
  return request<ListTriggersResponse>('/automation/triggers')
}

export function createTrigger(body: CreateTriggerRequest): Promise<{ rule: TriggerRule }> {
  return request<{ rule: TriggerRule }>('/automation/triggers', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateTrigger(
  id: string,
  body: UpdateTriggerRequest,
): Promise<{ rule: TriggerRule }> {
  return request<{ rule: TriggerRule }>(`/automation/triggers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteTrigger(id: string): Promise<void> {
  return request<void>(`/automation/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * 试匹配。
 * 走服务端而不是在浏览器里 `new RegExp`：一来两边必须用同一套行切分逻辑
 * （尾行去抖、`\r` 覆盖语义），二来避免用户写错正则把页面卡死。
 */
export function testTrigger(body: TestTriggerRequest): Promise<TestTriggerResponse> {
  return request<TestTriggerResponse>('/automation/triggers/test', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/* ---------------- 按钮栏 / 宏 ---------------- */

export function listMacros(): Promise<ListMacrosResponse> {
  return request<ListMacrosResponse>('/automation/macros')
}

export function createMacro(body: CreateMacroRequest): Promise<{ macro: MacroDefinition }> {
  return request<{ macro: MacroDefinition }>('/automation/macros', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateMacro(
  id: string,
  body: UpdateMacroRequest,
): Promise<{ macro: MacroDefinition }> {
  return request<{ macro: MacroDefinition }>(`/automation/macros/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteMacro(id: string): Promise<void> {
  return request<void>(`/automation/macros/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 执行宏：立即返回 runId，进度经该终端的 WebSocket 推送（`t: 'macro'`） */
export function runMacro(body: RunMacroRequest): Promise<RunMacroResponse> {
  return request<RunMacroResponse>('/automation/macros/run', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/* ---------------- 脚本 ---------------- */

export function listScripts(): Promise<ListScriptsResponse> {
  return request<ListScriptsResponse>('/automation/scripts')
}

export function createScript(body: CreateScriptRequest): Promise<{ script: ScriptDefinition }> {
  return request<{ script: ScriptDefinition }>('/automation/scripts', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateScript(
  id: string,
  body: UpdateScriptRequest,
): Promise<{ script: ScriptDefinition }> {
  return request<{ script: ScriptDefinition }>(`/automation/scripts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/** 删除脚本；返回值里带「被引用次数」，用于提示用户哪些地方会随之失效 */
export function deleteScript(id: string): Promise<{ removed: boolean; references: number }> {
  return request<{ removed: boolean; references: number }>(
    `/automation/scripts/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

/** 运行脚本：立即返回 runId，日志与结果经 WebSocket 推送（`t: 'script'`） */
export function runScript(body: RunScriptRequest): Promise<RunScriptResponse> {
  return request<RunScriptResponse>('/automation/scripts/run', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface ScriptValidationResponse {
  ok: boolean
  error?: string
  /** 出错行号（从 1 开始），拿不到时缺省 */
  line?: number
}

/** 只编译不执行：编辑器保存前的语法闸门 */
export function validateScript(code: string): Promise<ScriptValidationResponse> {
  return request<ScriptValidationResponse>('/automation/scripts/validate', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function listScriptRuns(): Promise<{ runs: ScriptRunRecord[] }> {
  return request<{ runs: ScriptRunRecord[] }>('/automation/script-runs')
}

/* ---------------- 批量执行 ---------------- */

/**
 * 批量执行。
 * 这里是**同步**返回完整结果表的：批量任务的语义就是「等这一批跑完再给我一张表」，
 * 若改成异步推送，前端还要额外维护「哪一批到哪一步了」的状态，得不偿失。
 * 目标数上限 50、默认单目标超时 30s，故最坏也在可接受范围内。
 */
export function runBatch(body: RunBatchRequest): Promise<RunBatchResponse> {
  return request<RunBatchResponse>('/automation/batch', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/* ------------------------------------------------------------------ */
/* 阶段 7：日志与审计                                                   */
/* ------------------------------------------------------------------ */

export function getLoggingSettings(): Promise<LoggingSettings> {
  return request<LoggingSettings>('/logs/settings')
}

export function updateLoggingSettings(
  body: Partial<Pick<LoggingSettings, 'retentionDays' | 'redactionRules'>>,
): Promise<{ settings: LoggingSettings }> {
  return request<{ settings: LoggingSettings }>('/logs/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function listLogFiles(params?: {
  sessionId?: string
  date?: string
}): Promise<ListLogFilesResponse> {
  const search = new URLSearchParams()
  if (params?.sessionId) search.set('sessionId', params.sessionId)
  if (params?.date) search.set('date', params.date)
  const qs = search.toString()
  return request<ListLogFilesResponse>(`/logs/files${qs ? `?${qs}` : ''}`)
}

export function previewLogFile(
  id: string,
  start: number,
  count = 500,
): Promise<LogPreviewResponse> {
  return request<LogPreviewResponse>(
    `/logs/files/${encodeURIComponent(id)}/preview?start=${start}&count=${count}`,
  )
}

/** 删除单个日志文件 */
export function deleteLogFile(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/logs/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 清空某个会话目录的全部日志；返回删除的文件数 */
export function deleteLogSession(dir: string): Promise<{ ok: boolean; files: number }> {
  return request<{ ok: boolean; files: number }>(
    `/logs/sessions/${encodeURIComponent(dir)}`,
    { method: 'DELETE' },
  )
}

/** 下载链接（直接交给 <a href> / window.open，浏览器自己处理流式下载） */
export function logFileDownloadUrl(id: string): string {
  return `${API_PREFIX}/logs/files/${encodeURIComponent(id)}/download`
}

export function queryAudit(params?: {
  event?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}): Promise<QueryAuditResponse> {
  const search = new URLSearchParams()
  if (params?.event) search.set('event', params.event)
  if (params?.from) search.set('from', params.from)
  if (params?.to) search.set('to', params.to)
  if (params?.page) search.set('page', String(params.page))
  if (params?.pageSize) search.set('pageSize', String(params.pageSize))
  const qs = search.toString()
  return request<QueryAuditResponse>(`/audit${qs ? `?${qs}` : ''}`)
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
  BatchResult,
  MacroDefinition,
  MacroStep,
  ScriptDefinition,
  ScriptLogEntry,
  ScriptRunRecord,
  SessionConfig,
  SshSessionConfig,
  TelnetSessionConfig,
  SshTarget,
  TelnetTarget,
  CreateTerminalResponse,
  TriggerAction,
  TriggerRule,
  TriggerStats,
  TunnelInfo,
  TunnelSpec,
  LoggingSettings,
  LogFileInfo,
  LogPreviewResponse,
  AuditEntry,
  AuditEventType,
  QueryAuditResponse,
  RedactionRule,
  SessionLogSettings,
}
