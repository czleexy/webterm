/**
 * 终端输出读取缓冲：脚本 API 中 `waitFor` / `expect` / `readUntil` 的实现基础。
 *
 * 与触发器用的 LineBuffer 目标不同，因此没有复用：
 * - LineBuffer 关心「切成一行行」，并且**丢弃**已经匹配过的内容
 * - TerminalTap 关心「保留原始流」，脚本要能读回一段区间、
 *   也要能在同一个缓冲区上先后做多次等待
 *
 * 两个容易踩的点在这里处理掉：
 * 1. **等待只能看到注册之后的输出**。否则上一条命令的残留提示符会立刻满足新的
 *    `waitFor('$')`，脚本从此读到错位的内容。每个等待都记下注册时的游标。
 * 2. **缓冲有上限**。一台狂刷日志的机器会让脚本期间的输出无限累积，
 *    超出上限时头部被丢弃，所有游标同步左移。
 */
import { SCRIPT_DEFAULT_WAIT_MS, SCRIPT_READ_BUFFER_CHARS } from '@webterm/shared'
import { AutomationFailure } from './errors.js'
import { stripTerminalControl } from './line-buffer.js'

export interface WaitOptions {
  timeoutMs?: number
  /** true 时按正则解释模式 */
  regex?: boolean
}

export interface ExpectResult {
  /** 命中模式在传入数组中的下标 */
  index: number
  pattern: string
  matched: string
}

interface Waiter {
  patterns: string[]
  regexes: RegExp[] | null
  /** 只看这个位置之后的输出 */
  fromIndex: number
  resolve: (hit: MatchHit) => void
  reject: (err: unknown) => void
  timer: NodeJS.Timeout
}

interface MatchHit {
  patternIndex: number
  /** 命中区间在缓冲中的起点 */
  start: number
  /** 命中区间在缓冲中的终点（不含） */
  end: number
  matched: string
}

const MAX_WAIT_MS = 10 * 60_000

function clampWait(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SCRIPT_DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.trunc(value)))
}

export class TerminalTap {
  private buffer = ''
  /** 「已被脚本消费到」的位置，供 read / readUntil 推进 */
  private readCursor = 0
  private waiters: Waiter[] = []
  private disposed = false
  private disposedReason = '会话已关闭'

  /** 当前缓冲内容（排障用） */
  get content(): string {
    return this.buffer
  }

  feed(text: string): void {
    if (this.disposed) return
    const cleaned = stripTerminalControl(text)
    if (cleaned.length === 0) return

    this.buffer += cleaned

    if (this.buffer.length > SCRIPT_READ_BUFFER_CHARS) {
      const removed = this.buffer.length - SCRIPT_READ_BUFFER_CHARS
      this.buffer = this.buffer.slice(removed)
      this.readCursor = Math.max(0, this.readCursor - removed)
      for (const waiter of this.waiters) {
        waiter.fromIndex = Math.max(0, waiter.fromIndex - removed)
      }
    }

    this.settle()
  }

  /** 取出缓冲区里已有的全部输出（不等待），并把读取游标推进到末尾 */
  read(): string {
    const start = Math.min(this.readCursor, this.buffer.length)
    const text = this.buffer.slice(start)
    this.readCursor = this.buffer.length
    return text
  }

  /** 丢弃已有输出（常用于丢掉上一条命令的残留） */
  clear(): void {
    this.buffer = ''
    this.readCursor = 0
    // 正在等待的调用从「现在」开始看，而不是被清空这件事弄挂
    for (const waiter of this.waiters) waiter.fromIndex = 0
  }

  /** 等待任意一个模式出现 */
  expect(patterns: string[], opts: WaitOptions = {}): Promise<ExpectResult> {
    return this.expectHit(patterns, opts).then(({ hit, pattern }) => ({
      index: hit.patternIndex,
      pattern,
      matched: hit.matched,
    }))
  }

  /** 等待单个模式出现，返回匹配到的文本 */
  async waitFor(pattern: string, opts: WaitOptions = {}): Promise<string> {
    const { hit } = await this.expectHit([pattern], opts)
    return hit.matched
  }

  /** 读取输出直到命中模式，返回这一段文本（含匹配部分）并消费掉 */
  async readUntil(pattern: string, opts: WaitOptions = {}): Promise<string> {
    const { hit } = await this.expectHit([pattern], opts)
    const start = Math.min(this.readCursor, this.buffer.length)
    // 缓冲可能在上限处被截断，因此终点要做兜底，不能让 slice 反过来
    const end = Math.max(start, Math.min(hit.end, this.buffer.length))
    const text = this.buffer.slice(start, end)
    this.readCursor = end
    return text
  }

  /** 强制结束（会话关闭 / 脚本被中断），让所有在途等待立即失败 */
  dispose(reason = '会话已关闭'): void {
    if (this.disposed) return
    this.disposed = true
    this.disposedReason = reason
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new AutomationFailure('SESSION_CLOSED', reason))
    }
    this.waiters = []
    this.buffer = ''
    this.readCursor = 0
  }

  /* ------------------------------------------------------------------ */

  /**
   * 等待原语：返回命中区间在缓冲中的位置。
   * `expect` / `waitFor` / `readUntil` 都建在它之上 —— 只有它能拿到
   * 「匹配到哪一段」，其余三个只是对结果的取舍不同。
   */
  private expectHit(
    patterns: string[],
    opts: WaitOptions,
  ): Promise<{ hit: MatchHit; pattern: string }> {
    if (this.disposed) {
      return Promise.reject(new AutomationFailure('SESSION_CLOSED', this.disposedReason))
    }
    if (patterns.length === 0) {
      return Promise.reject(new AutomationFailure('INVALID', 'expect 至少需要一个模式'))
    }

    let regexes: RegExp[] | null = null
    if (opts.regex) {
      try {
        regexes = patterns.map((p) => new RegExp(p))
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return Promise.reject(new AutomationFailure('INVALID', `正则表达式非法：${detail}`))
      }
    }

    const timeoutMs = clampWait(opts.timeoutMs)

    return new Promise<{ hit: MatchHit; pattern: string }>((resolve, reject) => {
      const waiter: Waiter = {
        patterns,
        regexes,
        fromIndex: this.readCursor,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(
            new AutomationFailure(
              'TIMEOUT',
              `等待输出「${patterns.join(' | ')}」超时（${timeoutMs}ms）`,
            ),
          )
        }, timeoutMs),
        resolve: (hit) => resolve({ hit, pattern: patterns[hit.patternIndex] ?? '' }),
        reject,
      }
      waiter.timer.unref?.()
      this.waiters.push(waiter)
      this.settle()
    })
  }

  private settle(): void {
    if (this.waiters.length === 0) return
    const remaining: Waiter[] = []
    for (const waiter of this.waiters) {
      const hit = this.findMatch(waiter.patterns, waiter.regexes, waiter.fromIndex)
      if (hit) {
        clearTimeout(waiter.timer)
        waiter.resolve(hit)
      } else {
        remaining.push(waiter)
      }
    }
    this.waiters = remaining
  }

  private findMatch(patterns: string[], regexes: RegExp[] | null, fromIndex: number): MatchHit | null {
    const start = Math.min(fromIndex, this.buffer.length)
    const haystack = this.buffer.slice(start)

    for (let i = 0; i < patterns.length; i += 1) {
      const pattern = patterns[i]
      if (pattern === undefined) continue

      if (regexes) {
        const regex = regexes[i]
        if (!regex) continue
        // 模式可能带 g（用户写的），显式重置避免 lastIndex 残留
        regex.lastIndex = 0
        const match = regex.exec(haystack)
        if (match) {
          return {
            patternIndex: i,
            start: start + match.index,
            end: start + match.index + match[0].length,
            matched: match[0],
          }
        }
        continue
      }

      const idx = haystack.indexOf(pattern)
      if (idx >= 0) {
        return {
          patternIndex: i,
          start: start + idx,
          end: start + idx + pattern.length,
          matched: pattern,
        }
      }
    }

    return null
  }
}
