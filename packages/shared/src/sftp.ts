/**
 * 阶段 3：SFTP 文件传输的 REST / WebSocket 契约。
 *
 * 双栏模型的两侧都定义在**服务端所在机器**上：
 * - `local`  = 服务端进程受限的本地根目录（默认用户家目录），有防 `..` 逃逸的路径校验
 * - `remote` = SSH 目标主机的文件系统，通过 SFTP 子系统访问
 *
 * 之所以不做「浏览器本地磁盘」这一侧：浏览器的安全模型不允许随意读写本地路径。
 * 而 WebTerm 的典型部署就是把服务跑在自己机器上、用浏览器访问 localhost ——
 * 此时服务端的本地磁盘就是用户的磁盘，双栏体验与桌面客户端完全一致。
 * 需要真正跨机器搬运时，另提供浏览器上传/下载接口（见本文件末尾的 upload / download 段）。
 */
import type { SshTarget } from './api.js'

/* ================================================================== */
/* 会话                                                               */
/* ================================================================== */

export type SftpSide = 'local' | 'remote'

export interface CreateSftpSessionRequest {
  /** 引用会话库中已保存的会话；与 config 二选一 */
  sessionId?: string
  /** 快速连接直传参数；与 sessionId 二选一 */
  config?: {
    target: SshTarget
    legacyCompat?: 'auto' | 'always' | 'never'
  }
  /**
   * 借用该终端已有的 SSH 连接（在该连接上开 SFTP 通道）。
   * 目的是避免对同一台设备重复登录 —— 老设备的 VTY 线路往往只有几条。
   * 若该终端已结束或目标不一致，服务端会退化为新建独立连接。
   */
  terminalId?: string
  title?: string
}

export interface CreateSftpSessionResponse {
  sftpId: string
  /** 一次性附加令牌，WebSocket 建连必须携带 */
  attachToken: string
  wsPath: string
  title: string
  host: string
  port: number
  username: string
  /** 远端初始目录（服务端 realpath('.') 的结果，通常是家目录） */
  remoteHome: string
  /** 本地受限根目录，前端据此限制向上导航 */
  localRoot: string
  /** 本地初始目录（通常是家目录本身） */
  localHome: string
  /** 是否复用了终端连接（false 表示本会话独占一条 SSH 连接） */
  reusedConnection: boolean
}

/* ================================================================== */
/* 目录列举                                                           */
/* ================================================================== */

export interface SftpEntry {
  name: string
  /** 完整路径；local 为平台绝对路径，remote 为 POSIX 绝对路径 */
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  /** 目录项不含子树大小，这里为目录自身的元数据长度（通常 0/4096） */
  size: number
  /** 最后修改时间，epoch 毫秒 */
  mtime: number
  /** 权限位（如 0o644 → 420） */
  mode: number
  /** 便于直接展示的权限文本，如 drwxr-xr-x */
  modeText: string
  /** 符号链接指向的目标（仅 type = link 时有值） */
  target?: string
  /** 从权限位推断的当前用户可读/可写（仅作 UI 提示，不做安全判断） */
  readable: boolean
  writable: boolean
}

export interface SftpListResponse {
  side: SftpSide
  /** 实际列举的绝对路径（可能是 realpath 归一化后的结果） */
  path: string
  /** 上级目录；已在根目录（local 侧受限于 localRoot，remote 侧为 /）时为 null */
  parent: string | null
  /** local 侧：允许向上导航的最深目录 */
  root?: string
  /** remote 侧：家目录，供「跳回家目录」使用 */
  home?: string
  entries: SftpEntry[]
}

/* ================================================================== */
/* 文件操作                                                           */
/* ================================================================== */

export interface SftpOpTarget {
  side: SftpSide
  path: string
}

export interface SftpOkResponse {
  ok: boolean
}

export interface SftpMkdirRequest extends SftpOpTarget {
  /** 相对父目录的新目录名；缺省时 path 直接作为待创建目录 */
  name?: string
}

export interface SftpRenameRequest {
  side: SftpSide
  from: string
  to: string
}

export interface SftpChmodRequest extends SftpOpTarget {
  /** 八进制权限字符串，如 '644' 或 '0755' */
  mode: string
}

export interface SftpRemoveRequest {
  side: SftpSide
  paths: string[]
}

/* ================================================================== */
/* 文本预览与远程编辑                                                 */
/* ================================================================== */

/** 预览时最多读取的字节数 */
export const SFTP_PREVIEW_MAX_BYTES = 256 * 1024

export interface SftpPreviewRequest {
  path: string
  maxBytes?: number
}

export interface SftpPreviewResponse {
  path: string
  size: number
  /** 远端文件修改时间（epoch 毫秒），保存时用于冲突检测 */
  mtime: number
  mode: number
  /** 判定结果：binary 时前端不给编辑器 */
  kind: 'text' | 'binary'
  content: string
  encoding: 'utf8' | 'latin1'
  /** 文件超过 maxBytes，内容被截断，此时禁止直接保存 */
  truncated: boolean
  /** 是否可保存（截断或二进制时为 false） */
  editable: boolean
  /** 不能编辑的原因 */
  reason?: string
}

export interface SftpSaveRequest {
  path: string
  content: string
  /**
   * 打开预览时记录的 mtime。
   * 若远端文件的当前 mtime 与之不符，说明期间被别人改过，返回 409 而不是静默覆盖。
   */
  expectedMtime?: number
  /** 远端文件权限，保存时尽量沿用原权限 */
  mode?: number
}

export interface SftpSaveResponse {
  ok: boolean
  mtime: number
  size: number
}

/* ================================================================== */
/* 传输任务                                                           */
/* ================================================================== */

/**
 * 方向语义以**远端主机**为参照：
 * - upload   = 本地 → 远端（上传）
 * - download = 远端 → 本地（下载）
 */
export type TransferDirection = 'upload' | 'download'

export type TransferState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'canceled'

export interface TransferTask {
  id: string
  direction: TransferDirection
  /** 源路径（upload 为本地路径，download 为远端路径） */
  source: string
  /** 目标绝对路径（含文件名） */
  target: string
  /** 展示用名称（路径最后一段） */
  name: string
  state: TransferState
  /** 总字节数；目录为递归聚合值（聚合失败时为 0，表示未知） */
  size: number
  /** 已完成字节数（含续传时已跳过的部分） */
  transferred: number
  /** 滑动平均速度，字节/秒 */
  speed: number
  /** 预计剩余秒数；无法估算时为 null */
  etaSec: number | null
  /** 目录传输时的文件计数 */
  filesTotal: number
  filesDone: number
  /** 是否为目录传输（递归） */
  isDirectory: boolean
  /** 失败原因 */
  error?: string
  /** 是否支持断点续传（目录整体不支持，其内部单个文件由队列自动处理） */
  resumable: boolean
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface CreateTransferRequest {
  direction: TransferDirection
  /**
   * 待传输的绝对路径列表。
   * upload 时为本地路径，download 时为远端路径。
   */
  sources: string[]
  /** 目标目录（upload 为远端目录，download 为本地目录） */
  targetDir: string
  /** 目标已存在时的行为：false 时任务直接失败并提示 */
  overwrite?: boolean
  /** 源为目录时是否递归传输 */
  recursive?: boolean
  /** 是否沿用源文件权限（默认 true） */
  preserveMode?: boolean
}

export interface CreateTransferResponse {
  tasks: TransferTask[]
}

export interface ListTransfersResponse {
  tasks: TransferTask[]
  /** 当前并发上限 */
  concurrency: number
}

export type TransferAction = 'pause' | 'resume' | 'cancel' | 'retry'

/* ================================================================== */
/* WebSocket 协议（/ws/sftp/:sftpId?token=...）                        */
/* ================================================================== */

/** 客户端 → 服务端 */
export type SftpClientMessage = { t: 'ping' }

/** 服务端 → 客户端 */
export type SftpServerMessage =
  | { t: 'ready'; sftpId: string; remoteHome: string; localRoot: string }
  /** 全量快照（附加时下发一次，避免增量事件丢包导致状态漂移） */
  | { t: 'transfers'; tasks: TransferTask[] }
  /** 单个任务的状态更新 */
  | { t: 'transfer'; task: TransferTask }
  /** 任务被移除 */
  | { t: 'removed'; taskId: string }
  | { t: 'error'; code: string; message: string; fatal: boolean }
  | { t: 'pong' }

export function parseSftpClientControl(raw: string): SftpClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const t = (parsed as { t?: unknown }).t
    if (t === 'ping') return { t: 'ping' }
    return null
  } catch {
    return null
  }
}

/* ================================================================== */
/* 浏览器上传 / 下载（真正跨机器搬运）                                 */
/* ================================================================== */

/**
 * POST /api/sftp/sessions/:id/upload?path=<远端路径>&offset=<字节>
 * 请求体为 application/octet-stream 的原始文件流。
 *
 * 为什么不用 multipart：单文件流式直传不需要 multipart 的分隔与表单开销，
 * 而且 `offset` 以请求头/查询参数表达，天然支持断点续传。
 */
export interface UploadStreamQuery {
  path: string
  /** 已传输字节数；> 0 时服务端以 r+ 打开远端文件并从该位置写入 */
  offset?: number
  /** 传输结束后是否把 mtime 设为当前时间 */
  touch?: boolean
}

export interface UploadStreamResponse {
  ok: boolean
  path: string
  /** 本次追加写入的字节数 */
  written: number
  /** 写入后远端文件的总大小 */
  size: number
}

/** GET /api/sftp/sessions/:id/download?path=<远端路径>，支持 HTTP Range 断点续传 */
export interface DownloadStreamQuery {
  path: string
}

