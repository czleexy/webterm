/**
 * 行缓冲：把终端的字节流切成「逻辑行」，供触发器做正则/文本匹配。
 *
 * 为什么不能直接在 chunk 上匹配：一次 `read()` 拿到什么完全取决于 TCP 分片。
 * `(yes/no)? ` 这两个字节序列极可能被拆成 `(yes` 与 `/no)? ` 两块，
 * 逐块匹配就会全部落空 —— 触发器「时灵时不灵」几乎都源于此。
 *
 * 三类特殊情形在这里一次性收口：
 *
 * 1. **尾部（还没换行的那一段）**
 *    形如 `(yes/no)? ` 的提示不会自己换行。收到数据就立刻匹配会在分片到达时
 *    匹配到半截内容，所以尾部要等「对端安静下来」再匹配（见 tailDelayMs）。
 *
 * 2. **行内 `\r` 覆盖**
 *    进度条靠 `10%\r20%\r30%` 刷新同一行。终端语义是「回到行首覆盖」，
 *    因此一个逻辑行只保留最后一个 `\r` 之后的内容 —— 既符合用户所见，
 *    也避免进度条把缓冲撑爆。行尾的 `\r\r`（`\r\n` 遇上 TTY 的 ONLCR）
 *    要先整体剥掉，否则末尾那个 `\r` 会被误判成「覆盖成空」而丢掉整行。
 *
 * 3. **只触发一次**
 *    尾部匹配命中后，同一段内容会在换行时再次成为「完整行」。
 *    若不处理，「命中 → 自动应答 → 远端回显 → 完整行再次命中」会形成自激，
 *    屏幕上的提示会被应答刷屏。这里用一个「已触发的尾部快照」把后续行标记为
 *    `carriedOver`，调用方据此跳过匹配。
 */
import { TRIGGER_MAX_LINE_CHARS, TRIGGER_TAIL_DEBOUNCE_MS } from '@webterm/shared'

/**
 * `\x1b[31m` 一类的 CSI/OSC 转义序列。
 * 匹配前必须剥掉：`\x1b[31merror\x1b[0m:` 里的颜色码会把
 * `/error:/` 这种再普通不过的正则直接打断，而这恰恰是用户最常写的规则。
 */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/** 除 `\t` `\n` `\r` 之外的控制字符（告警音、退格、响铃等）一律丢弃 */
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function stripTerminalControl(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '')
}

/**
 * 取一行里「最终可见」的内容。终端语义决定了这里必须做两件事：
 *
 * 1. **剥掉全部行尾 CR**。`\r\r\n` 是极常见的组合 —— 程序自己写了 `\r\n`，
 *    而 TTY 的 ONLCR 又把其中的 `\n` 补成 `\r\n`，于是一行以 `\r\r` 收尾。
 *    只剥一个字符的话，剩下的那个 `\r` 会被当成「回到行首覆盖」，
 *    整行内容被判为空而**被丢弃**：输出在终端里显示完全正常，触发器却对
 *    这些行完全看不见 —— 顺着「规则为什么没触发」查会非常难定位。
 * 2. **按 `\r` 覆盖语义取最后一个 `\r` 之后的内容**：进度条靠
 *    `10%\r20%\r30%` 刷新同一行，取最后一段才符合用户所见，也免得缓冲被撑爆。
 *
 * 导出来给「试匹配」接口复用：两处口径一旦分叉，用户在弹窗里试出来的结果
 * 就会和真实运行不一致，而这种偏差几乎不可能被手工发现。
 */
export function visibleLine(raw: string): string {
  const trimmed = raw.replace(/\r+$/, '')
  const cr = trimmed.lastIndexOf('\r')
  return cr >= 0 ? trimmed.slice(cr + 1) : trimmed
}

export interface LineEvent {
  /** 供匹配使用的文本（已剥离转义序列、已按 `\r` 覆盖语义取最终可见内容） */
  text: string
  /** complete = 已换行；tail = 对端静默后仍未换行的结尾 */
  kind: 'complete' | 'tail'
  /**
   * 这一行是「此前已触发过的尾部」的延续（例如提示后面跟了用户输入的回显）。
   * true 时调用方应跳过匹配，否则会自激。
   */
  carriedOver: boolean
}

/** 返回 true 表示这次事件被消费了（有规则命中），尾部快照据此建立 */
export type LineSink = (event: LineEvent) => boolean

export interface LineBufferOptions {
  maxChars?: number
  tailDelayMs?: number
}

export class LineBuffer {
  /** 尚未换行的内容 */
  private buffer = ''
  /**
   * 已经触发过的尾部快照。
   * 只有「尾部匹配真的命中了」才会被设置 —— 没命中就设上，会让后续完整行
   * 被误判为重复而漏掉真正的触发。
   */
  private firedTail: string | null = null
  private tailTimer: NodeJS.Timeout | undefined
  private readonly maxChars: number
  private readonly tailDelayMs: number

  constructor(
    private readonly sink: LineSink,
    opts: LineBufferOptions = {},
  ) {
    this.maxChars = opts.maxChars ?? TRIGGER_MAX_LINE_CHARS
    this.tailDelayMs = opts.tailDelayMs ?? TRIGGER_TAIL_DEBOUNCE_MS
  }

  /** 当前尚未成行的内容（排障用） */
  get pending(): string {
    return this.buffer
  }

  push(text: string): void {
    if (text.length === 0) return
    const cleaned = stripTerminalControl(text)
    if (cleaned.length === 0) return

    this.buffer += cleaned

    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const raw = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.cancelTailTimer()
      // 换行意味着「这一行结束了」，尾部快照随之失效
      const carriedOver = this.firedTail !== null && raw.startsWith(this.firedTail)
      this.firedTail = null
      const visible = this.visibleOf(raw)
      if (visible.length > 0) this.sink({ text: visible, kind: 'complete', carriedOver })
    }

    // 未见换行却已经很长（`cat` 一个没有换行的二进制文件）：切一刀丢掉，
    // 否则缓冲会无限增长。切走的内容对匹配已无价值。
    if (this.buffer.length >= this.maxChars) {
      const visible = this.visibleOf(this.buffer)
      this.buffer = ''
      this.firedTail = null
      this.cancelTailTimer()
      if (visible.length > 0) this.sink({ text: visible, kind: 'complete', carriedOver: false })
      return
    }

    this.scheduleTail()
  }

  /** 清空全部状态（会话关闭时调用） */
  reset(): void {
    this.cancelTailTimer()
    this.buffer = ''
    this.firedTail = null
  }

  dispose(): void {
    this.reset()
  }

  /**
   * 取一行里「最终可见」的内容（口径见 visibleLine）。
   * 这里只多一层长度兜底。
   */
  private visibleOf(raw: string): string {
    const line = visibleLine(raw)
    return line.length > this.maxChars ? safeTail(line, this.maxChars) : line
  }

  /**
   * 尾部匹配的防抖。
   * 内容没有继续增长（仍以已触发的尾部开头）时不必重排定时器，
   * 否则每收到一个字节都会把匹配推迟一次，提示永远等不到。
   */
  private scheduleTail(): void {
    const pending = this.buffer
    if (pending.length === 0) return
    if (this.firedTail !== null && pending.startsWith(this.firedTail)) return

    this.cancelTailTimer()
    this.tailTimer = setTimeout(() => {
      this.tailTimer = undefined
      // 期间又来了数据：push 会自行重排，这里直接让位
      if (this.buffer !== pending) return
      if (this.firedTail === pending) return
      const visible = this.visibleOf(pending)
      if (visible.length === 0) return
      const consumed = this.sink({ text: visible, kind: 'tail', carriedOver: false })
      if (consumed) this.firedTail = pending
    }, this.tailDelayMs)
    this.tailTimer.unref?.()
  }

  private cancelTailTimer(): void {
    if (!this.tailTimer) return
    clearTimeout(this.tailTimer)
    this.tailTimer = undefined
  }
}

/** 按字符截尾；不要把一个代理对切成两半，否则会渲染出乱码方块 */
function safeTail(text: string, maxChars: number): string {
  let start = text.length - maxChars
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return text.slice(start)
}
