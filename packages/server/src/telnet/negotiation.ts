/**
 * Telnet 选项协商状态机。
 *
 * 职责：把 TCP 上的原始字节流拆成「真正的用户数据」与「协议控制序列」两部分，
 * 并按 RFC 854 的规则回应协商请求。上层只需要拿到干净的 data，
 * 完全不必关心 IAC 转义、子协商这些细节。
 *
 * 三个容易踩的坑，这里都显式处理了：
 *
 * 1. **必须回应，否则对端会一直等**。RFC 规定收到 DO/WILL 就要给出 WILL/WONT 或 DO/DONT。
 *    早期自制客户端常见的问题是「不认识的选项就当没看见」，
 *    结果设备停在协商阶段不吐任何输出，表现为「连上了但黑屏」。
 *    本实现默认「不支持就明确拒绝」。
 *
 * 2. **协商回环**。收到 DO X → 回 WONT X → 对端回 DONT X → 再回 WONT X ……
 *    经典的无限循环。这里用 sentLocal / sentRemote 记住「上一次对该选项表过的态」，
 *    同一态度不重复发送，循环在第二个来回就断开。
 *
 * 3. **IAC 在数据里的转义**。数据中出现 0xFF 时发送方必须写两遍；
 *    解析时要把 `IAC IAC` 还原成单个 0xFF，否则二进制内容（比如图片经 `cat` 输出）
 *    会被静默截断。
 *
 * 性能上的取舍：数据段走「找出 IAC 位置 → 整段切片」的快路径，
 * 而不是逐字节 push 数组 —— 否则 `cat` 一个大文件时光是拷贝字节就够 CPU 忙的。
 */
import type { TelnetNegotiationSummary } from '@webterm/shared'
import {
  DO,
  DONT,
  IAC,
  LOCAL_SUPPORTED,
  OPT,
  REMOTE_WANTED,
  SB,
  SE,
  TTYPE_IS,
  TTYPE_SEND,
  WILL,
  WONT,
  optionName,
} from './constants.js'

enum State {
  DATA,
  IAC,
  OPTION,
  SB_OPTION,
  SB_DATA,
  SB_IAC,
}

export interface TelnetParseResult {
  /** 去掉全部控制序列后的用户数据 */
  data: Buffer
  /** 需要回写给对端的控制序列（协商应答、子协商） */
  replies: Buffer
}

const EMPTY = Buffer.alloc(0)

export class TelnetNegotiator {
  private state = State.DATA
  private pendingCommand = 0
  private subOption = 0
  private subBytes: number[] = []

  /** 本端已同意的选项（我们回过 WILL） */
  private readonly localEnabled = new Set<number>()
  /** 对端已同意的选项（对端发过 WILL） */
  private readonly remoteEnabled = new Set<number>()
  /** 本端对每个选项 last 表明的态度，用于打断协商回环 */
  private readonly sentLocal = new Map<number, number>()
  private readonly sentRemote = new Map<number, number>()

  private term: string
  private cols: number
  private rows: number
  /** 是否已把终端类型回给对端（排障面板展示用） */
  private sentTerminalType = false

  constructor(opts: { term: string; cols: number; rows: number }) {
    this.term = opts.term
    this.cols = opts.cols
    this.rows = opts.rows
  }

  /**
   * 建连后本端主动发出的协商。
   *
   * 只声明「抑制继续」：这是唯一一个需要我们主动开口的选项 ——
   * 否则半双工设备会等我们发 GA 才接收输入，表现为「打字没反应」。
   * 其余（终端类型、窗口尺寸、回显）都等服务端来要，不抢着表态。
   */
  initialReplies(): Buffer {
    const out: number[] = []
    if (!this.sentLocal.has(OPT.SGA)) {
      out.push(IAC, WILL, OPT.SGA)
      this.sentLocal.set(OPT.SGA, WILL)
      this.localEnabled.add(OPT.SGA)
    }
    return out.length > 0 ? Buffer.from(out) : EMPTY
  }

  /** 终端类型变化（理论上不会变，保留给未来的「重协商」） */
  setTerm(term: string): void {
    this.term = term
  }

  /**
   * 窗口尺寸变化。
   * 仅在 NAWS 已协商成功时才发子协商 —— 未经协商就发，对端会当成噪声。
   */
  setSize(cols: number, rows: number): Buffer {
    this.cols = cols
    this.rows = rows
    if (!this.localEnabled.has(OPT.NAWS)) return EMPTY
    return Buffer.from(this.buildNaws())
  }

  /** 当前尺寸是否已上报（NAWS 协商成功即为已上报） */
  get nawsAgreed(): boolean {
    return this.localEnabled.has(OPT.NAWS)
  }

  get summary(): TelnetNegotiationSummary {
    return {
      remoteEcho: this.remoteEnabled.has(OPT.ECHO),
      suppressGoAhead:
        this.remoteEnabled.has(OPT.SGA) && this.localEnabled.has(OPT.SGA),
      terminalTypeRequested: this.sentTerminalType,
      windowSizeReported: this.localEnabled.has(OPT.NAWS),
      remoteOptions: [...this.remoteEnabled].sort((a, b) => a - b).map(optionName),
      localOptions: [...this.localEnabled].sort((a, b) => a - b).map(optionName),
    }
  }

  /**
   * 解析一段 TCP 数据。
   * 返回值里的 data 直接投递给终端，replies 必须尽快写回对端。
   */
  process(chunk: Buffer): TelnetParseResult {
    if (chunk.length === 0) return { data: EMPTY, replies: EMPTY }

    const dataChunks: Buffer[] = []
    const replies: number[] = []
    // 普通数据段的起点；-1 表示当前不在数据段里
    let runStart = -1

    const flushRun = (end: number): void => {
      if (runStart >= 0 && end > runStart) dataChunks.push(chunk.subarray(runStart, end))
      runStart = -1
    }

    let i = 0
    while (i < chunk.length) {
      const byte = chunk[i]!

      if (this.state === State.DATA) {
        if (byte === IAC) {
          flushRun(i)
          this.state = State.IAC
          i += 1
          continue
        }
        if (runStart < 0) runStart = i
        i += 1
        continue
      }

      // 非数据状态：这里都是低频的控制序列，逐字节处理即可
      switch (this.state) {
        case State.IAC: {
          if (byte === IAC) {
            // IAC IAC = 数据里的一个 0xFF
            dataChunks.push(Buffer.from([IAC]))
            this.state = State.DATA
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.pendingCommand = byte
            this.state = State.OPTION
          } else if (byte === SB) {
            this.state = State.SB_OPTION
          } else {
            // GA / NOP / DM / BRK … 一律忽略即可，不必回话
            this.state = State.DATA
          }
          i += 1
          break
        }

        case State.OPTION: {
          this.handleNegotiation(this.pendingCommand, byte, replies)
          this.state = State.DATA
          i += 1
          break
        }

        case State.SB_OPTION: {
          this.subOption = byte
          this.subBytes = []
          this.state = State.SB_DATA
          i += 1
          break
        }

        case State.SB_DATA: {
          if (byte === IAC) {
            this.state = State.SB_IAC
          } else {
            // 子协商内容有上限，避免异常对端灌爆内存
            if (this.subBytes.length < 1024) this.subBytes.push(byte)
          }
          i += 1
          break
        }

        case State.SB_IAC: {
          if (byte === SE) {
            this.handleSubnegotiation(replies)
            this.state = State.DATA
          } else if (byte === IAC) {
            // 子协商数据里的 0xFF
            if (this.subBytes.length < 1024) this.subBytes.push(IAC)
            this.state = State.SB_DATA
          } else {
            // 协议异常，丢弃本段子协商
            this.state = State.SB_DATA
          }
          i += 1
          break
        }

        default: {
          this.state = State.DATA
          i += 1
        }
      }
    }

    flushRun(chunk.length)

    return {
      data: dataChunks.length === 0 ? EMPTY : Buffer.concat(dataChunks),
      replies: replies.length === 0 ? EMPTY : Buffer.from(replies),
    }
  }

  /** 处理 DO / DONT / WILL / WONT */
  private handleNegotiation(command: number, option: number, replies: number[]): void {
    switch (command) {
      case DO: {
        if (LOCAL_SUPPORTED.has(option)) {
          if (!this.localEnabled.has(option)) {
            this.localEnabled.add(option)
            this.sentLocal.set(option, WILL)
            replies.push(IAC, WILL, option)
            // 终端类型：等对端用 SB SEND 来取，这里只在被问到时才回
            if (option === OPT.TERMINAL_TYPE) this.sentTerminalType = true
            // 窗口尺寸：同意之后要立刻把当前尺寸送过去，否则设备按默认 80 列折行
            if (option === OPT.NAWS) replies.push(...this.buildNaws())
          } else if (this.sentLocal.get(option) !== WILL) {
            // 之前拒绝过，现在对端再次坚持（或我们重启了协商）—— 重新同意
            this.sentLocal.set(option, WILL)
            replies.push(IAC, WILL, option)
          }
          return
        }
        if (this.sentLocal.get(option) !== WONT) {
          this.sentLocal.set(option, WONT)
          this.localEnabled.delete(option)
          replies.push(IAC, WONT, option)
        }
        return
      }

      case DONT: {
        // 对端要求我们关闭；只有确实开着才需要回答，否则会陷入 WONT/DONT 回环
        if (this.localEnabled.has(option)) {
          this.localEnabled.delete(option)
          this.sentLocal.set(option, WONT)
          replies.push(IAC, WONT, option)
        }
        return
      }

      case WILL: {
        if (REMOTE_WANTED.has(option)) {
          if (!this.remoteEnabled.has(option)) {
            this.remoteEnabled.add(option)
            this.sentRemote.set(option, DO)
            replies.push(IAC, DO, option)
          }
          return
        }
        if (this.sentRemote.get(option) !== DONT) {
          this.sentRemote.set(option, DONT)
          this.remoteEnabled.delete(option)
          replies.push(IAC, DONT, option)
        }
        return
      }

      case WONT: {
        if (this.remoteEnabled.has(option)) {
          this.remoteEnabled.delete(option)
          this.sentRemote.set(option, DONT)
          replies.push(IAC, DONT, option)
        }
        return
      }

      default:
        return
    }
  }

  /** 处理子协商：目前只响应「终端类型查询」 */
  private handleSubnegotiation(replies: number[]): void {
    if (this.subOption !== OPT.TERMINAL_TYPE) return
    // TTYPE 只有 SEND（对端索要）与 IS（本端回答）两种动作
    if (this.subBytes[0] !== TTYPE_SEND) return
    replies.push(
      IAC,
      SB,
      OPT.TERMINAL_TYPE,
      TTYPE_IS,
      ...Buffer.from(this.term, 'ascii'),
      IAC,
      SE,
    )
  }

  /** 组装 NAWS 子协商：16 位大端的列数与行数 */
  private buildNaws(): number[] {
    const cols = clampDimension(this.cols)
    const rows = clampDimension(this.rows)
    const bytes = [IAC, SB, OPT.NAWS, (cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff, IAC, SE]
    // 子协商内容里的 0xFF 必须加倍（当尺寸恰好有字节为 255 时）
    return doubleIacInsideSubnegotiation(bytes)
  }

  /** 输入方向：数据里的 0xFF 必须写成两遍，否则会被对端当成命令起始 */
  static escape(data: Buffer): Buffer {
    if (!data.includes(IAC)) return data
    const out = Buffer.allocUnsafe(data.length * 2)
    let n = 0
    for (const byte of data) {
      out[n++] = byte
      if (byte === IAC) out[n++] = IAC
    }
    return out.subarray(0, n)
  }
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(65535, Math.trunc(value)))
}

/**
 * 子协商体里出现 0xFF 要加倍。
 * 只处理 SB 与 SE 之间的内容，外层的 IAC SB / IAC SE 本身不能被改动。
 */
function doubleIacInsideSubnegotiation(bytes: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!
    out.push(byte)
    // 跳过 S IAC SE 这个收尾三元组
    const isClosing = i === bytes.length - 2 && byte === IAC && bytes[i + 1] === SE
    if (!isClosing && i >= 3 && i < bytes.length - 2 && byte === IAC) out.push(IAC)
  }
  return out
}
