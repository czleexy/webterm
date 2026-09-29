/**
 * 开发用 SSH 测试服务端。
 *
 * 用途：在没有可用远端主机时，为终端链路（WS ↔ SSH PTY ↔ xterm）提供端到端验证目标。
 * 包含一个极简的行编辑式 shell，支持若干专门用于验证的指令：
 *
 *   help        列出可用指令
 *   echo <文本> 回显（验证基本输入输出）
 *   cols        报告当前 PTY 尺寸（验证窗口尺寸同步）
 *   big <KB>    连续输出 N KB（验证背压：不暂停会把服务端内存打爆）
 *   utf8        输出中文 UTF-8 文本（验证编码直通）
 *   gbk         输出 GBK 编码的中文（配合 encoding=gbk 验证服务端转码）
 *   sleep <秒>  静默 N 秒
 *   exit        结束会话
 *
 * 环境变量：
 *   MOCK_PORT    监听端口，默认 2222
 *   MOCK_USER    用户名，默认 demo
 *   MOCK_PASS    口令，默认 demo
 *   MOCK_LEGACY  设为 1 时只提供 legacy 算法，用于验证客户端的自动降级逻辑
 *   MOCK_AUTH    password（默认）| publickey，验证密钥认证链路
 *   MOCK_SFTP_ROOT  SFTP 子系统的根目录（默认 data/tmp/mock-sftp-root）
 *   MOCK_NO_SFTP  设为 1 时拒绝 sftp 子系统，用于验证客户端对「不支持 SFTP」的提示
 *
 * 跳板链支持：本服务端接受 direct-tcpip 通道请求（即 ssh -L/-W 的服务端行为），
 * 因此把多个实例串联即可验证 ProxyJump：A(2222) → B(2223) → C(2224)。
 * 公钥认证模式下公钥经 stdin 传入（一行 base64），避免密钥落盘。
 *
 * 端口转发（阶段 5）支持：
 *   - 本地转发 / 动态转发：走 direct-tcpip（与跳板链同一套通道），无需额外开关
 *   - 远程转发：接受 tcpip-forward 全局请求，真的在对应地址上监听，
 *     再把每个入站连接用 forwarded-tcpip 通道回送给客户端，与真实 sshd 行为一致
 *
 * SFTP 子系统：见 mock-sftp.mjs —— 真机测试主机拒绝 shell/exec/subsystem，
 * 文件传输链路只能靠这里的自实现后端来验证。
 *
 * 仅用于本地开发与测试，切勿部署到生产环境。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachSftpServer } from './mock-sftp.mjs'

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')

const _here = path.dirname(fileURLToPath(import.meta.url))
const SFTP_ROOT = path.resolve(
  process.env.MOCK_SFTP_ROOT || path.join(_here, '../../data/tmp/mock-sftp-root'),
)
const SFTP_ENABLED = process.env.MOCK_NO_SFTP !== '1'

const PORT = Number(process.env.MOCK_PORT || 2222)
const HOST = process.env.MOCK_HOST || '127.0.0.1'
const USER = process.env.MOCK_USER || 'demo'
const PASS = process.env.MOCK_PASS || 'demo'
const LEGACY_ONLY = process.env.MOCK_LEGACY === '1'
const AUTH_MODE = process.env.MOCK_AUTH || 'password'

/** 远程转发（-R）时由本服务端建立的监听器；key = `bindAddr:port` */
const remoteListeners = new Map()

/** 关闭一个远程转发监听并断开其上所有连接（cancel 与连接结束时都要调） */
function closeRemoteListener(entry) {
  if (!entry) return
  try {
    entry.server.close()
  } catch {
    /* 忽略 */
  }
  for (const conn of entry.conns) {
    try {
      conn.destroy()
    } catch {
      /* 忽略 */
    }
  }
  entry.conns.clear()
}

/** 一次性客户端公钥（公钥认证模式）：经 stdin 传入一行 base64 */
const authorizedPubKeys = []
if (AUTH_MODE === 'publickey') {
  process.stdin.setEncoding('utf8')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  for (const line of chunks.join('').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) authorizedPubKeys.push(Buffer.from(trimmed, 'base64'))
  }
  console.log(`[mock-ssh] 公钥认证模式，已装载 ${authorizedPubKeys.length} 把公钥`)
}

/** 生成一次性主机密钥（仅开发用；生产客户端应使用持久化密钥） */
const hostKey = utils.generateKeyPairSync('rsa', { bits: 2048 })

if (LEGACY_ONLY) {
  console.log('[mock-ssh] 已启用 legacy-only 模式：仅提供 SHA-1 类算法，用于测试客户端降级')
}

const server = new Server(
  {
    hostKeys: [hostKey.private],
    ...(LEGACY_ONLY
      ? {
          algorithms: {
            kex: ['diffie-hellman-group14-sha1'],
            serverHostKey: ['ssh-rsa'],
            cipher: ['aes256-cbc', 'aes128-cbc'],
            hmac: ['hmac-sha1'],
            compress: ['none'],
          },
        }
      : {}),
  },
  (client) => {
    let authed = false

    client.on('authentication', (ctx) => {
      if (AUTH_MODE === 'publickey') {
        // ssh2 服务端会先以无签名方式询问该公钥是否可接受，再带签名重发一次；
        // 我们只按「key blob 是否在授权列表」判断，签名校验由 ssh2 自行完成
        if (ctx.method === 'publickey' && ctx.key && !ctx.signature) {
          const acceptable = authorizedPubKeys.some((p) => p.equals(ctx.key.data))
          return acceptable ? ctx.accept() : ctx.reject()
        }
        if (ctx.method === 'publickey' && ctx.key && ctx.signature) {
          const ok = authorizedPubKeys.some((p) => p.equals(ctx.key.data))
          if (ok && ctx.username === USER) {
            authed = true
            return ctx.accept()
          }
        }
        return ctx.reject(['publickey'])
      }

      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) {
        authed = true
        return ctx.accept()
      }
      if (ctx.method === 'none') return ctx.reject(['password'])
      return ctx.reject(['password'])
    })

    client.on('ready', () => {
      console.log('[mock-ssh] 客户端认证通过')

      // 跳板链支持：接受 direct-tcpip，把流量转发到目标地址。
      // 注意：ssh2 服务端 emit 的事件名是 'tcpip'（不是协议层的通道类型名 'direct-tcpip'），
      // 且 info 为 { destIP, destPort, srcIP, srcPort }。注册错名字会导致握手期即被拒绝。
      client.on('tcpip', (accept, reject, info) => {
        console.log(`[mock-ssh] direct-tcpip -> ${info.destIP}:${info.destPort}`)
        const upstream = net.connect(info.destPort, info.destIP, () => {
          const channel = accept()
          upstream.pipe(channel).pipe(upstream)
          const cleanup = () => {
            try {
              upstream.destroy()
              channel.close()
            } catch {
              /* 忽略 */
            }
          }
          upstream.on('error', cleanup)
          channel.on('close', cleanup)
        })
        upstream.on('error', (err) => {
          console.log(`[mock-ssh] direct-tcpip 上游连接失败: ${err.message}`)
          try {
            reject()
          } catch {
            /* 忽略 */
          }
        })
      })

      // 远程转发（-R）支持：接受 tcpip-forward 全局请求，真的在对应地址上监听，
      // 再把每个入站连接通过 forwarded-tcpip 通道回送给客户端 ——
      // 这正是真实 sshd 的行为，因此 -R 链路可以端到端验证，而不必假装成功。
      //
      // 注意 accept(chosenPort) 只在请求端口为 0（由服务端分配）时才需要传，
      // ssh2 会把它写进请求应答；固定端口时传了也无害。
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const bindAddr = info.bindAddr
          const wanted = info.bindPort
          const conns = new Set()
          const server = net.createServer((socket) => {
            conns.add(socket)
            socket.on('close', () => conns.delete(socket))
            const actual = server.address()?.port ?? wanted
            client.forwardOut(
              bindAddr,
              actual,
              socket.remoteAddress ?? '127.0.0.1',
              socket.remotePort ?? 0,
              (err, channel) => {
                if (err) {
                  console.log(`[mock-ssh] forwarded-tcpip 回连失败: ${err.message}`)
                  socket.destroy()
                  return
                }
                socket.pipe(channel).pipe(socket)
                const cleanup = () => {
                  try {
                    socket.destroy()
                    channel.close()
                  } catch {
                    /* 忽略 */
                  }
                }
                socket.on('error', cleanup)
                channel.on('close', cleanup)
              },
            )
          })
          server.on('error', (err) => {
            console.log(`[mock-ssh] tcpip-forward 监听失败: ${err.message}`)
            try {
              reject?.()
            } catch {
              /* 忽略 */
            }
          })
          server.listen(wanted, bindAddr, () => {
            const actual = server.address().port
            remoteListeners.set(`${bindAddr}:${actual}`, { server, conns })
            console.log(`[mock-ssh] tcpip-forward 已在 ${bindAddr}:${actual} 监听`)
            accept?.(actual)
          })
          return
        }
        if (name === 'cancel-tcpip-forward') {
          const key = `${info.bindAddr}:${info.bindPort}`
          const entry = remoteListeners.get(key)
          if (entry) {
            remoteListeners.delete(key)
            closeRemoteListener(entry)
            console.log(`[mock-ssh] cancel-tcpip-forward ${key}`)
          }
          accept?.()
          return
        }
        reject?.()
      })

      client.on('session', (accept) => {
        const session = accept()
        // 注意：必须原地修改该对象，不能重新赋值。
        // shell 处理器会把同一个对象引用传下去，重新赋值会让它看不到尺寸变化。
        const pty = { cols: 80, rows: 24, term: 'unknown' }

        session.on('pty', (acceptPty, _reject, info) => {
          pty.cols = info.cols
          pty.rows = info.rows
          pty.term = info.term
          console.log(`[mock-ssh] pty-req term=${info.term} ${info.cols}x${info.rows}`)
          acceptPty?.()
        })

        session.on('window-change', (acceptChange, _reject, info) => {
          pty.cols = info.cols
          pty.rows = info.rows
          console.log(`[mock-ssh] window-change -> ${info.cols}x${info.rows}`)
          acceptChange?.()
        })

        session.on('shell', (acceptShell) => {
          if (!authed) return
          console.log('[mock-ssh] shell 请求已接受')
          const stream = acceptShell()
          attachShell(stream, pty)
        })

        session.on('exec', (acceptExec, _reject, info) => {
          if (!authed) return
          console.log(`[mock-ssh] exec: ${info.command}`)
          const stream = acceptExec()
          stream.write(`exec 命令执行结果：${info.command}\r\n`)
          stream.exit(0)
          stream.end()
        })

        // SFTP 子系统：把请求落到 SFTP_ROOT 下的临时目录
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (!authed || !SFTP_ENABLED) {
            console.log('[mock-ssh] 拒绝 sftp 子系统请求')
            try {
              rejectSftp?.()
            } catch {
              /* 忽略 */
            }
            return
          }
          fs.mkdirSync(SFTP_ROOT, { recursive: true })
          console.log(`[mock-ssh] sftp 子系统已开启，根目录 ${SFTP_ROOT}`)
          const sftp = acceptSftp()
          attachSftpServer(sftp, SFTP_ROOT, (line) => {
            if (process.env.MOCK_DEBUG) console.log(line)
          })
        })
      })
    })

    client.on('error', (err) => {
      console.log('[mock-ssh] 客户端错误:', err.message)
    })

    // 连接断开时清掉本连接建立的远程转发监听，否则端口会一直被占着
    client.on('close', () => {
      for (const key of [...remoteListeners.keys()]) {
        const entry = remoteListeners.get(key)
        remoteListeners.delete(key)
        closeRemoteListener(entry)
      }
    })
  },
)

/** 把回车换行统一为 CRLF，终端渲染才正确 */
function w(stream, text) {
  stream.write(text.replace(/\n/g, '\r\n'))
}

/**
 * 把行缓冲的原始字节解码为字符串。
 * 优先按 UTF-8 解码；若出现替换字符（说明是 GBK 等其它编码），再按 GBK 解一次。
 * 这样客户端无论用 utf8 还是 gbk 编码发送，测试服务端都能正确识别。
 */
function decodeLine(bytes) {
  if (bytes.length === 0) return ''
  const buf = Buffer.from(bytes)
  const asUtf8 = buf.toString('utf8')
  if (!asUtf8.includes('\ufffd')) return asUtf8
  try {
    const iconv = require('iconv-lite')
    return iconv.decode(buf, 'gbk')
  } catch {
    return asUtf8
  }
}

function attachShell(stream, pty) {
  let lineBytes = []
  let quitting = false

  const prompt = () => w(stream, '\r\n$ ')

  w(
    stream,
    `WebTerm 测试 SSH 服务端\r\n` +
      `终端类型 ${pty.term}，初始尺寸 ${pty.cols}x${pty.rows}\r\n` +
      `输入 help 查看指令，exit 退出。\r\n`,
  )
  prompt()

  stream.on('data', (chunk) => {
    for (const byte of chunk) {
      // Ctrl+C
      if (byte === 0x03) {
        lineBytes = []
        w(stream, '^C')
        prompt()
        continue
      }
      // Ctrl+D
      if (byte === 0x04) {
        w(stream, '\r\n再见。\r\n')
        stream.exit(0)
        stream.end()
        return
      }
      // 退格 / DEL
      if (byte === 0x7f || byte === 0x08) {
        if (lineBytes.length > 0) {
          const removed = lineBytes.pop()
          // 按 UTF-8 前导字节判断该字符占几字节，退格时一并抹掉，避免留下半个汉字
          const width = removed >= 0xf0 ? 4 : removed >= 0xe0 ? 3 : removed >= 0xc0 ? 2 : 1
          for (let i = 1; i < width && lineBytes.length > 0; i += 1) lineBytes.pop()
          // 用「退格+空格+退格」擦除整字符宽度（终端按显示宽度计算，汉字占 2 列）
          const erase = '\b \b'.repeat(removed >= 0xc0 ? 2 : 1)
          stream.write(erase)
        }
        continue
      }
      // 回车
      if (byte === 0x0d || byte === 0x0a) {
        stream.write('\r\n')
        const cmd = decodeLine(lineBytes).trim()
        lineBytes = []
        if (cmd.length === 0) {
          prompt()
          continue
        }
        // 指令返回 'no-prompt' 表示它会自行输出提示符或已结束会话
        const outcome = handleCommand(stream, cmd, pty, () => {
          quitting = true
        })
        if (quitting) return
        if (outcome !== 'no-prompt') prompt()
        continue
      }
      // 可打印 ASCII 与多字节字符的原始字节：回显并入行缓冲
      if ((byte >= 0x20 && byte < 0x7f) || byte >= 0x80) {
        lineBytes.push(byte)
        stream.write(Buffer.from([byte]))
      }
      // 其余（方向键等转义序列）忽略
    }
  })

  stream.on('close', () => console.log('[mock-ssh] shell 通道已关闭'))
  stream.on('error', () => {
    /* 客户端断开时忽略 */
  })
}

/**
 * 执行一条指令。
 * @returns 'prompt' 表示由调用方输出提示符；'no-prompt' 表示本指令自行处理提示符或已结束会话
 */
function handleCommand(stream, cmd, pty, requestQuit) {  const [name, ...rest] = cmd.split(/\s+/)
  const arg = rest.join(' ')

  switch (name) {
    case 'help':
      w(
        stream,
        '可用指令：\r\n' +
          '  help           显示本帮助\r\n' +
          '  echo <文本>    回显文本\r\n' +
          '  cols           显示当前 PTY 尺寸\r\n' +
          '  big <KB>       连续输出 N KB 数据（背压测试）\r\n' +
          '  utf8           输出中文 UTF-8 文本\r\n' +
          '  gbk            输出 GBK 编码的中文（需把终端编码设为 gbk）\r\n' +
          '  sleep <秒>     静默指定秒数\r\n' +
          '  exit           结束会话\r\n',
      )
      break

    case 'echo':
      w(stream, arg || '(空)')
      break

    case 'cols':
      w(stream, `当前 PTY 尺寸：${pty.cols} 列 x ${pty.rows} 行`)
      break

    case 'big': {
      const kb = Math.min(Math.max(Number.parseInt(arg, 10) || 1024, 1), 64 * 1024)
      const lineText = '0123456789abcdefghijklmnopqrstuvwxyz'.repeat(2) + '\r\n'
      const lineBuf = Buffer.from(lineText)
      const total = kb * 1024
      const count = Math.ceil(total / lineBuf.length)
      w(stream, `开始输出约 ${kb} KB（${count} 行）…`)
      let written = 0
      let stopped = false

      const pump = () => {
        if (stopped) return
        // 一次写较多内容，模拟远端高速输出，用于触发背压
        while (written < count) {
          written += 1
          const ok = stream.write(lineBuf)
          if (written % 200 === 0) {
            // 让出事件循环，避免长时间阻塞（也给了背压生效的机会）
            setImmediate(pump)
            return
          }
          if (!ok) {
            stream.once('drain', pump)
            return
          }
        }
        w(stream, `输出完成，共 ${written} 行。`)
        stopped = true
        stream.write('$ ')
      }

      stream.on('close', () => {
        stopped = true
      })
      setImmediate(pump)
      // 该指令自己输出提示符
      return 'no-prompt'
    }

    case 'utf8':
      w(stream, 'UTF-8 中文测试：你好，世界 —— 终端编码直通验证 ✅')
      break

    case 'gbk': {
      // 以 GBK 字节写出中文：若客户端编码设为 utf8 会显示乱码，设为 gbk 则正常
      const iconv = require('iconv-lite')
      stream.write(iconv.encode('\r\nGBK 中文测试：你好，世界 —— 服务端转码验证 ✅\r\n', 'gbk'))
      break
    }

    case 'sleep': {
      const sec = Math.min(Math.max(Number.parseInt(arg, 10) || 1, 1), 60)
      w(stream, `静默 ${sec} 秒…`)
      setTimeout(() => {
        w(stream, '结束静默。')
        stream.write('$ ')
      }, sec * 1000)
      return 'no-prompt'
    }

    case 'exit':
      w(stream, '再见。')
      stream.exit(0)
      stream.end()
      requestQuit()
      return 'no-prompt'

    default:
      w(stream, `未知指令：${name}（输入 help 查看可用指令）`)
  }
  return 'prompt'
}

server.listen(PORT, HOST, () => {
  console.log(`[mock-ssh] 已监听 ${HOST}:${PORT}`)
  console.log(`[mock-ssh] 用户名 ${USER} / 口令 ${PASS}`)
  console.log(
    `[mock-ssh] SFTP 子系统：${SFTP_ENABLED ? `已启用（根目录 ${SFTP_ROOT}）` : '已禁用（MOCK_NO_SFTP=1）'}`,
  )
})
