/**
 * 开发用 Mock Telnet 设备。
 *
 * 目的是在没有真实网络设备时验证 WebTerm 的 Telnet 客户端实现：
 * 选项协商、终端类型上报、窗口尺寸（NAWS）、回显归属、以及 IAC 转义。
 *
 * 行为尽量贴近真实的老设备：
 *   - 连上先发一轮协商请求（DO TERMINAL-TYPE / DO NAWS / WILL ECHO / WILL SGA）
 *   - 索要终端类型，并把收到的值记下来
 *   - 维护一个行缓冲，支持几条命令；`size` 会回显最近一次收到的窗口尺寸，
 *     这是验证 NAWS 是否真的发出来的最直接手段
 *
 * 环境变量：
 *   MOCK_PORT                  监听端口（默认 2323）
 *   MOCK_HOST                  监听地址（默认 127.0.0.1）
 *   MOCK_TELNET_ECHO=0         不声明也不执行回显（用于验证本端本地回显兜底）
 *   MOCK_TELNET_NO_NEGOTIATION=1  完全不做选项协商（模拟极简实现）
 *   MOCK_TELNET_NAME           设备名（默认 MockTelnet）
 *
 * 运行：node packages/server/dev/mock-telnet-server.mjs
 */
import net from 'node:net'

const PORT = Number(process.env.MOCK_PORT || 2323)
const HOST = process.env.MOCK_HOST || '127.0.0.1'
const DEVICE_NAME = process.env.MOCK_TELNET_NAME || 'MockTelnet'
const ECHO_ENABLED = process.env.MOCK_TELNET_ECHO !== '0'
const NO_NEGOTIATION = process.env.MOCK_TELNET_NO_NEGOTIATION === '1'

const IAC = 255
const SE = 240
const SB = 250
const WILL = 251
const WONT = 252
const DO = 253
const DONT = 254

const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31, LINEMODE: 34 }
const OPT_NAME = {
  [OPT.BINARY]: '二进制传输',
  [OPT.ECHO]: '回显',
  [OPT.SGA]: '抑制继续',
  [OPT.TTYPE]: '终端类型',
  [OPT.NAWS]: '窗口尺寸',
  [OPT.LINEMODE]: '行模式',
}
const COMMAND_NAME = { [WILL]: 'WILL', [WONT]: 'WONT', [DO]: 'DO', [DONT]: 'DONT' }

/** 结构化日志：E2E 脚本按行解析，避免用正则去猜自由文本 */
function log(obj) {
  process.stdout.write(`${JSON.stringify({ ts: Date.now(), ...obj })}\n`)
}

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`
  socket.setNoDelay(true)
  log({ event: 'connect', peer, echo: ECHO_ENABLED, negotiation: !NO_NEGOTIATION })

  let state = 'data'
  let pendingCommand = 0
  let subOption = 0
  let subBytes = []
  let lineBuffer = ''
  let lastSize = null
  let terminalType = null

  const send = (...bytes) => socket.write(Buffer.from(bytes))

  /* ---------------- 协商 ---------------- */

  if (!NO_NEGOTIATION) {
    const greeting = [IAC, DO, OPT.TTYPE, IAC, DO, OPT.NAWS, IAC, WILL, OPT.SGA]
    // 需要回显的设备才声明 WILL ECHO；不需要的保持沉默，让客户端接管本地回显
    if (ECHO_ENABLED) greeting.push(IAC, WILL, OPT.ECHO)
    socket.write(Buffer.from(greeting))
  }

  const showBanner = () => {
    socket.write(
      `\r\n${DEVICE_NAME} (mock) ready.\r\nType 'help' for commands.\r\n\r\n${DEVICE_NAME}> `,
    )
  }

  /* ---------------- 命令 ---------------- */

  const runCommand = (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch ((cmd || '').toLowerCase()) {
      case '':
        socket.write(`\r\n${DEVICE_NAME}> `)
        return
      case 'help':
        socket.write(
          '\r\ncommands: help ping echo <text> size ttype iac big <KB> legacy quit\r\n' +
            `${DEVICE_NAME}> `,
        )
        return
      case 'ping':
        socket.write(`\r\npong\r\n${DEVICE_NAME}> `)
        return
      case 'echo':
        socket.write(`\r\n${arg}\r\n${DEVICE_NAME}> `)
        return
      case 'size':
        // 回显最近一次收到的 NAWS 尺寸，用于验证窗口尺寸协商
        socket.write(
          lastSize
            ? `\r\nsize=${lastSize.cols}x${lastSize.rows}\r\n${DEVICE_NAME}> `
            : `\r\nsize=unknown\r\n${DEVICE_NAME}> `,
        )
        return
      case 'ttype':
        socket.write(
          `\r\nttype=${terminalType ?? 'unknown'}\r\n${DEVICE_NAME}> `,
        )
        return
      case 'iac':
        // 故意输出一个裸 0xFF。发送方必须把它写成 FF FF ——
        // 不转义的话对端会把 IAC 后面的字节当成命令吃掉，这也正是这条用例要验证的
        socket.write(escapeIac(Buffer.from([0x0d, 0x0a, 0xff, 0x0d, 0x0a])))
        socket.write(`${DEVICE_NAME}> `)
        return
      case 'big': {
        const kb = Math.min(Number.parseInt(arg, 10) || 64, 4096)
        socket.write(`\r\nstreaming ${kb} KB\r\n`)
        const chunk = Buffer.alloc(8192, 'x')
        let sent = 0
        const target = kb * 1024
        const pump = () => {
          while (sent < target) {
            const isLast = sent + chunk.length >= target
            socket.write(chunk)
            sent += chunk.length
            if (isLast) {
              socket.write(`\r\n${DEVICE_NAME}> `)
              return
            }
            // 让出事件循环，避免一次写满内核缓冲
            if (socket.writableLength > 512 * 1024) {
              socket.once('drain', pump)
              return
            }
          }
        }
        pump()
        return
      }
      case 'legacy':
        // 老设备常见的「先按回车才出提示符」行为
        socket.write(`\r\n${DEVICE_NAME}> `)
        return
      case 'quit':
        socket.write('\r\nbye\r\n')
        socket.end()
        return
      default:
        socket.write(`\r\nunknown command: ${cmd}\r\n${DEVICE_NAME}> `)
    }
  }

  /* ---------------- 输入解析 ---------------- */

  const handleNegotiation = (command, option) => {
    log({
      event: 'option',
      peer,
      command: COMMAND_NAME[command] ?? String(command),
      option,
      name: OPT_NAME[option] ?? `选项${option}`,
    })
    if (command === WILL && option === OPT.TTYPE) {
      // 客户端愿意上报终端类型 —— 那就问它要
      send(IAC, SB, OPT.TTYPE, 1 /* SEND */, IAC, SE)
      return
    }
    if (command === DO && option === OPT.NAWS) {
      // 客户端请我们开窗口尺寸？我们不需要，明确拒绝（避免它等）
      send(IAC, WONT, OPT.NAWS)
    }
  }

  const handleSubnegotiation = (option, bytes) => {
    if (option === OPT.TTYPE) {
      // 0 = IS
      if (bytes[0] === 0) {
        terminalType = Buffer.from(bytes.slice(1)).toString('ascii')
        log({ event: 'ttype', peer, value: terminalType })
      }
      return
    }
    if (option === OPT.NAWS) {
      if (bytes.length >= 4) {
        lastSize = { cols: (bytes[0] << 8) | bytes[1], rows: (bytes[2] << 8) | bytes[3] }
        log({ event: 'naws', peer, ...lastSize })
      }
    }
  }

  /**
   * 行结束符处理。
   *
   * 真实设备（包括把 CR 映射成 NL 的 telnetd）对 CR 与 LF 都认，但浏览器里
   * xterm 的 Enter 只发一个 CR —— 早先这里只认 LF，结果「按回车毫无反应」。
   * CRLF 必须算作**一次**换行，因此记住刚吃过 CR，紧随其后的 LF 直接吞掉。
   */
  let pendingCr = false
  const endLine = () => {
    const line = lineBuffer
    lineBuffer = ''
    log({ event: 'line', peer, line })
    runCommand(line)
  }

  const handleData = (chunk) => {
    for (const byte of chunk) {
      if (byte === 0x0d) {
        pendingCr = true
        endLine()
        continue
      }
      if (byte === 0x0a) {
        if (pendingCr) {
          pendingCr = false
          continue
        }
        endLine()
        continue
      }
      if (byte === 0x7f || byte === 0x08) {
        lineBuffer = lineBuffer.slice(0, -1)
        continue
      }
      lineBuffer += String.fromCharCode(byte)
    }
  }

  socket.on('data', (chunk) => {
    const dataChunks = []
    let runStart = -1
    const flushRun = (end) => {
      if (runStart >= 0 && end > runStart) dataChunks.push(chunk.subarray(runStart, end))
      runStart = -1
    }

    let i = 0
    while (i < chunk.length) {
      const byte = chunk[i]
      if (state === 'data') {
        if (byte === IAC) {
          flushRun(i)
          state = 'iac'
          i += 1
          continue
        }
        if (runStart < 0) runStart = i
        i += 1
        continue
      }
      if (state === 'iac') {
        if (byte === IAC) {
          dataChunks.push(Buffer.from([IAC]))
          state = 'data'
        } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
          pendingCommand = byte
          state = 'option'
        } else if (byte === SB) {
          state = 'sb-option'
        } else {
          state = 'data'
        }
        i += 1
        continue
      }
      if (state === 'option') {
        handleNegotiation(pendingCommand, byte)
        state = 'data'
        i += 1
        continue
      }
      if (state === 'sb-option') {
        subOption = byte
        subBytes = []
        state = 'sb-data'
        i += 1
        continue
      }
      if (state === 'sb-data') {
        if (byte === IAC) state = 'sb-iac'
        else subBytes.push(byte)
        i += 1
        continue
      }
      if (state === 'sb-iac') {
        if (byte === SE) {
          handleSubnegotiation(subOption, subBytes)
          state = 'data'
        } else if (byte === IAC) {
          subBytes.push(IAC)
          state = 'sb-data'
        } else {
          state = 'data'
        }
        i += 1
        continue
      }
      i += 1
    }
    flushRun(chunk.length)

    if (dataChunks.length === 0) return
    const data = dataChunks.length === 1 ? dataChunks[0] : Buffer.concat(dataChunks)
    log({ event: 'input', peer, data: data.toString('utf8') })
    if (ECHO_ENABLED) {
      // 设备回显：把收到的字节原样送回去（0xFF 需要转义）
      socket.write(escapeIac(data))
    }
    handleData(data)
  })

  socket.on('close', () => log({ event: 'disconnect', peer }))
  socket.on('error', (err) => log({ event: 'socket-error', peer, message: err.message }))

  showBanner()
})

function escapeIac(buf) {
  if (!buf.includes(IAC)) return buf
  const out = []
  for (const byte of buf) {
    out.push(byte)
    if (byte === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}

server.listen(PORT, HOST, () => {
  log({ event: 'listening', host: HOST, port: PORT })
})
