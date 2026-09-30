/**
 * 会话日志写入器：把一个活跃终端的输出按天落成文件。
 *
 * 两种工作模式（与会话配置的 format 对应）：
 * - **流式模式**（plain / timestamped）：`write(text)` 在输出到达时就追加写盘，
 *   内容先过脱敏规则并剥离 ANSI 控制序列。文件名 `{date}.log`，
 *   超过 LOG_ROTATE_BYTES 切分到 `{date}.part{n}.log`。
 * - **快照模式**（html）：前端定期上传整份序列化结果，
 *   `pushHtmlChunk` 分片接收，`final` 时原子替换当天的 `{date}.html` ——
 *   文件里永远是一份完整、可直接在浏览器打开回放色彩的转录。
 *
 * 写盘走串行队列：终端输出是高频事件，appendFile 之间必须保持顺序，
 * 否则「上一条还没写完下一条插进来」会产生交错的乱序行。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { RedactionRule, SessionLogSettings } from '@webterm/shared'
import {
  LOG_HTML_MAX_BYTES,
  LOG_ROTATE_BYTES,
  sanitizeLogDirName,
  stripAnsiSequences,
} from '@webterm/shared'
import type { TerminalLogger } from '../terminal/terminal-session.js'

/** 目录名清洗的兜底：即使 shared 层已有清洗，这里再防一次路径分量异常 */
function safeDirComponent(name: string): string {
  const cleaned = sanitizeLogDirName(name)
  if (cleaned === '.' || cleaned === '..') return 'session'
  return cleaned
}

/** 编译脱敏规则；非法正则直接跳过（设置层会就地报错，这里静默容错） */
function compileRules(rules: RedactionRule[]): Array<{ re: RegExp; replacement: string }> {
  const compiled: Array<{ re: RegExp; replacement: string }> = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      // g 修饰符在这里是必要的：一条输出里出现多次都要替换。
      // 编译结果缓存在 writer 上，规则集合变更时由上层重建 writer。
      compiled.push({ re: new RegExp(rule.pattern, 'g'), replacement: rule.replacement })
    } catch {
      /* 非法正则：跳过 */
    }
  }
  return compiled
}

function applyRedactions(text: string, rules: Array<{ re: RegExp; replacement: string }>): string {
  let out = text
  for (const { re, replacement } of rules) {
    out = out.replace(re, replacement)
  }
  return out
}

function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function localTime(d = new Date()): string {
  return d.toTimeString().slice(0, 8)
}

export interface SessionLogWriterOptions {
  logsRoot: string
  /** 会话展示名（决定目录名，冲突时追加短哈希） */
  sessionName: string
  /** 会话库节点 id；参与目录名去重，保证同一会话多次连接落进同一目录 */
  sessionId?: string
  settings: SessionLogSettings
  redactionRules: RedactionRule[]
  logger: TerminalLogger
}

export class SessionLogWriter {
  readonly dir: string
  private readonly logsRoot: string
  private readonly settings: SessionLogSettings
  private readonly rules: Array<{ re: RegExp; replacement: string }>
  private readonly logger: TerminalLogger

  /** 当前写目标（随日期与轮转变化） */
  private currentDay = ''
  private currentFile: string | null = null
  private currentBytes = 0
  private partIndex = 0

  /** 串行写队列的尾指针 */
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * 尚未换行的残行（stripAnsi 之后、脱敏之前的原始内容）。
   * 脱敏与时间戳都必须「行对齐」后才做：脱敏正则的锚点（如 `\S+`）
   * 在 chunk 边界会被切断，逐片替换会把敏感内容残留在日志里 —— 这是行缓冲存在的根本原因。
   */
  private pendingLine: string = ''

  /** 残行缓冲上限：超过则强制落盘，防止无换行的大块输出把缓冲撑爆 */
  private static readonly MAX_PENDING_CHARS = 65_536

  /** 批量写缓冲（enqueue 攒片，flushBatch 统一落盘） */
  private batchBuf: string[] = []
  private batchBytes = 0
  private batchTimer: NodeJS.Timeout | undefined
  private static readonly BATCH_FLUSH_BYTES = 256 * 1024
  private static readonly BATCH_FLUSH_MS = 200

  /** html 快照装配状态 */
  private htmlChunks: string[] = []
  private htmlBytes = 0
  private htmlNextSeq = 0

  constructor(opts: SessionLogWriterOptions) {
    this.logsRoot = opts.logsRoot
    this.settings = opts.settings
    this.logger = opts.logger
    this.rules = compileRules(opts.redactionRules)

    const base = safeDirComponent(opts.sessionName)
    if (opts.sessionId) {
      // 同名会话会产生同名目录：把 sessionId 的短哈希并进目录名做稳定区分
      const short = createHash('sha256').update(opts.sessionId).digest('hex').slice(0, 6)
      this.dir = `${base}-${short}`
    } else {
      // 快速连接：用随机短串，保证不同连接互不混写
      const short = createHash('sha256')
        .update(`${opts.sessionName}:${Date.now()}:${Math.random()}`)
        .digest('hex')
        .slice(0, 6)
      this.dir = `${base}-${short}`
    }
    fs.mkdirSync(path.join(this.logsRoot, this.dir), { recursive: true })
  }

  /* ---------------------------------------------------------------- */
  /* 流式写入（plain / timestamped）                                    */
  /* ---------------------------------------------------------------- */

  write(text: string): void {
    if (this.closed || this.settings.format === 'html') return

    const content = stripAnsiSequences(text)
    if (content.length === 0) return

    // 行缓冲：只有完整行（以 \n 结尾）才做脱敏与落盘
    const combined = this.pendingLine + content
    this.pendingLine = ''
    if (!combined.includes('\n')) {
      this.pendingLine = combined
      this.flushOversizedPending()
      return
    }

    const segments = combined.split('\n')
    // 最后一段是残行（后面没有换行），留到下一片
    const rest = segments.pop() ?? ''

    const lines = segments.map((seg) => this.finishLine(seg + '\n'))
    this.enqueue(lines.join(''))

    if (rest !== '') {
      this.pendingLine = rest
      this.flushOversizedPending()
    }
  }

  /**
   * 完成一个完整行：脱敏 → （timestamped 模式加时间戳）。
   * 时间戳取「行变得完整」的时刻 —— 对逐行到达的输出而言即行首到达时刻。
   */
  private finishLine(lineWithNewline: string): string {
    let line = applyRedactions(lineWithNewline, this.rules)
    if (this.settings.format === 'timestamped') {
      line = `[${localTime()}] ${line}`
    }
    return line
  }

  /** 残行超长时强制脱敏落盘（无换行的巨型输出不能无限缓冲） */
  private flushOversizedPending(): void {
    if (this.pendingLine.length < SessionLogWriter.MAX_PENDING_CHARS) return
    const forced = this.finishLine(this.pendingLine)
    this.pendingLine = ''
    this.enqueue(forced)
  }

  private enqueue(content: string): void {
    // 批量合并：终端输出是高频小片（一行甚至几个字符），
    // 逐片 appendFile 会把一次会话变成几十万次系统调用。
    // 攒到 256 KB 或 200 ms 定时到点再统一落盘 —— 顺序性由串行队列保证。
    this.batchBuf.push(content)
    this.batchBytes += Buffer.byteLength(content, 'utf8')
    if (this.batchBytes >= SessionLogWriter.BATCH_FLUSH_BYTES) {
      this.flushBatch()
      return
    }
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined
        this.flushBatch()
      }, SessionLogWriter.BATCH_FLUSH_MS)
      this.batchTimer.unref?.()
    }
  }

  /** 把攒下的批量内容排进串行写队列 */
  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    if (this.batchBuf.length === 0) return
    const content = this.batchBuf.join('')
    this.batchBuf = []
    this.batchBytes = 0
    this.tail = this.tail
      .then(() => this.appendChunk(content))
      .catch((err) => {
        this.logger.warn({ err: String(err) }, '会话日志写入失败')
      })
  }

  private async appendChunk(content: string): Promise<void> {
    if (content.length === 0 || this.closed) return

    const day = localDate()
    if (day !== this.currentDay || this.currentFile === null) {
      // 跨天（或首写）：切到新日期文件；已有同名文件则续写
      this.currentDay = day
      this.partIndex = 0
      this.currentFile = path.join(this.dir, `${day}.log`)
      this.currentBytes = await this.existingSize(day)
    } else if (this.currentBytes + Buffer.byteLength(content, 'utf8') > LOG_ROTATE_BYTES) {
      this.partIndex += 1
      this.currentFile = path.join(this.dir, `${day}.part${this.partIndex}.log`)
      this.currentBytes = 0
    }

    const absolute = path.join(this.logsRoot, this.currentFile)
    try {
      await fs.promises.appendFile(absolute, content, 'utf8')
      this.currentBytes += Buffer.byteLength(content, 'utf8')
    } catch (err) {
      this.logger.warn({ err: String(err), file: this.currentFile }, '会话日志追加失败')
    }
  }

  /** 主文件已存在时返回其大小（续写），否则 0 */
  private async existingSize(day: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(path.join(this.logsRoot, this.dir, `${day}.log`))
      return stat.size
    } catch {
      return 0
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTML 快照（html）                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * 接收一个快照分片。分片从 seq=0 开始、严格递增；
   * `final = true` 时装配完成并原子替换当天的 `.html`。
   * 乱序或超限都会丢弃本次装配 —— 下一次完整快照（seq=0）会重新开始。
   */
  pushHtmlChunk(seq: number, final: boolean, data: string): void {
    if (this.closed || this.settings.format !== 'html') return

    if (seq === 0) {
      this.htmlChunks = []
      this.htmlBytes = 0
      this.htmlNextSeq = 0
    } else if (seq !== this.htmlNextSeq) {
      this.logger.warn({ seq, expected: this.htmlNextSeq }, 'HTML 快照分片乱序，丢弃本次快照')
      this.htmlChunks = []
      this.htmlBytes = 0
      this.htmlNextSeq = 0
      return
    }

    this.htmlNextSeq = seq + 1
    this.htmlChunks.push(data)
    this.htmlBytes += Buffer.byteLength(data, 'utf8')

    if (this.htmlBytes > LOG_HTML_MAX_BYTES) {
      this.logger.warn({ bytes: this.htmlBytes }, 'HTML 快照超过上限，丢弃本次快照')
      this.htmlChunks = []
      this.htmlBytes = 0
      this.htmlNextSeq = 0
      return
    }

    if (final) {
      const html = this.htmlChunks.join('')
      this.htmlChunks = []
      this.htmlBytes = 0
      this.htmlNextSeq = 0
      // 排在流式写入队列之后，保证磁盘操作的顺序性
      this.tail = this.tail.then(() => this.writeHtmlSnapshot(html)).catch((err) => {
        this.logger.warn({ err: String(err) }, 'HTML 快照写入失败')
      })
    }
  }

  private async writeHtmlSnapshot(html: string): Promise<void> {
    if (this.closed) return
    const absolute = path.join(this.logsRoot, this.dir, `${localDate()}.html`)
    const tmp = `${absolute}.tmp`
    try {
      await fs.promises.writeFile(tmp, html, 'utf8')
      await fs.promises.rename(tmp, absolute)
    } catch (err) {
      this.logger.warn({ err: String(err), file: absolute }, 'HTML 快照写入失败')
    }
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 收尾并等待已排队的写盘完成。之后 writer 不可再写。
   * timestamped 模式下的残行在此落盘（会话已结束，不会再有后续行拼接）。
   */
  async close(): Promise<void> {
    if (this.closed) return
    if (this.pendingLine !== '') {
      // 会话已结束，不会再有后续内容拼接：把残行脱敏后直接落盘
      const rest = this.finishLine(this.pendingLine)
      this.pendingLine = ''
      this.enqueue(rest)
    }
    this.flushBatch()
    const done = this.tail
    this.closed = true
    await done.catch(() => {})
  }
}
