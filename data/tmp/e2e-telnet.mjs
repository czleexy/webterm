/**
 * Telnet 功能端到端验证。
 *
 * 自管三个 mock Telnet 设备与一个服务端实例：
 *   2331  常规设备（声明 WILL ECHO，自己回显）
 *   2332  不回显设备（MOCK_TELNET_ECHO=0，用于验证本端本地回显兜底）
 *   2333  不做任何协商的极简设备（MOCK_TELNET_NO_NEGOTIATION=1）
 *   8099  服务端（独立数据目录，不影响开发用的 8080）
 *
 * 验证重点（都是 Telnet 实现里最容易出问题的地方）：
 *   1. 选项协商是否真的发出去了（DO TERMINAL-TYPE / DO NAWS / WILL SGA）
 *   2. 终端类型与窗口尺寸是否按 RFC 1073/1091 上报
 *   3. IAC 控制序列是否从用户数据里剥干净、数据里的 0xFF 是否正确还原
 *   4. 设备不回显时是否有本地回显兜底（否则用户「打字看不见」）
 *   5. 错误分类（端口不通）与协议边界（Telnet 不能开 SFTP、不能配跳板链）
 *
 * 运行：npm run build && node data/tmp/e2e-telnet.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
const WORK = path.join(ROOT, 'data/tmp/telnet-e2e')
const PORT = 8099
const API = `http://127.0.0.1:${PORT}`
const WS_BASE = `ws://127.0.0.1:${PORT}`

const MOCK_ECHO = 2331
const MOCK_NO_ECHO = 2332
const MOCK_NO_NEG = 2333
const DEAD_PORT = 2399 // 没有任何监听的端口

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const failures = []
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}${extra ? `  ${extra}` : ''}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`)
  }
}

const children = []

/** 启动一个 mock 设备，并把它的结构化日志按行收集起来供断言使用 */
function startMock(port, env = {}) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-telnet-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(port), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.events = []
  let buffer = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    buffer += d.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        child.events.push(JSON.parse(line))
      } catch {
        child.events.push({ event: 'raw', line })
      }
    }
    if (process.env.MOCK_DEBUG) process.stdout.write(`  [${port}] ${d}`)
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
    process.stdout.write(`  [${port}!] ${d}`)
  })
  child.getStderr = () => stderr
  children.push(child)
  return child
}

function startServer() {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dist/index.js`], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WEBTERM_PORT: String(PORT),
      WEBTERM_DATA_DIR: path.join(WORK, 'data'),
      WEBTERM_LOCAL_ROOT: path.join(WORK, 'local'),
      WEBTERM_LOG_LEVEL: 'warn',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  child.getLog = () => log
  children.push(child)
  return child
}

async function waitHealthy(timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${API}/api/health`)
      if (r.ok) return
    } catch {
      /* 未就绪 */
    }
    if (Date.now() - started > timeoutMs) throw new Error('服务端启动超时')
    await sleep(200)
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`)
    this.status = status
    this.code = body?.error
    this.body = body
  }
}

async function api(pathname, init = {}) {
  const response = await fetch(`${API}/api${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (response.status === 204) return undefined
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = { raw: text }
  }
  if (!response.ok) throw new ApiError(response.status, body)
  return body
}

const json = (method, body) => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

/** 轮询 mock 的事件流，直到出现满足条件的记录 */
async function waitEvent(mock, predicate, timeoutMs = 5000, label = '事件') {
  const started = Date.now()
  for (;;) {
    const found = mock.events.find(predicate)
    if (found) return found
    if (Date.now() - started > timeoutMs) return undefined
    await sleep(30)
  }
}

const optionEvent = (mock, command, option) =>
  mock.events.find((e) => e.event === 'option' && e.command === command && e.option === option)

/** 建立一个终端并附加 WebSocket，返回收集器 */
async function openTerminal(config, title) {
  const created = await api('/terminals', json('POST', { config, title }))
  const ws = new WebSocket(
    `${WS_BASE}${created.wsPath}?token=${encodeURIComponent(created.attachToken)}`,
  )
  const collector = {
    created,
    ws,
    chunks: [],
    control: [],
    errors: [],
    get text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once('close', () => resolve())
        ws.close()
      }),
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) collector.chunks.push(Buffer.from(data))
    else {
      try {
        collector.control.push(JSON.parse(data.toString()))
      } catch {
        /* 忽略非法控制帧 */
      }
    }
  })
  ws.on('error', (err) => collector.errors.push(err))

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 附加超时')), 10_000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  // 等 ready 控制消息，其中携带协商摘要
  const started = Date.now()
  while (!collector.control.some((m) => m.t === 'ready')) {
    if (Date.now() - started > 5000) break
    await sleep(30)
  }
  return collector
}

const sendInput = (collector, text) => collector.ws.send(Buffer.from(text))
const sendControl = (collector, msg) => collector.ws.send(JSON.stringify(msg))

/** 等待前端侧收到包含指定文本的输出 */
async function waitText(collector, needle, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    if (collector.text.includes(needle)) return true
    if (Date.now() - started > timeoutMs) return false
    await sleep(30)
  }
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

/* ================================================================== */

const telnetConfig = (port, overrides = {}) => ({
  protocol: 'telnet',
  target: { host: '127.0.0.1', port },
  terminal: { cols: 120, rows: 30, encoding: 'utf8', term: 'xterm-256color', ...overrides },
})

const mockEcho = startMock(MOCK_ECHO)
const mockNoEcho = startMock(MOCK_NO_ECHO, { MOCK_TELNET_ECHO: '0' })
const mockNoNeg = startMock(MOCK_NO_NEG, { MOCK_TELNET_NO_NEGOTIATION: '1' })

// 服务端要求「本地」面板的根目录必须已存在，否则启动即退出
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
const server = startServer()

try {
  await waitHealthy()
  await sleep(300)

  /* ---------------- A. 选项协商 ---------------- */
  console.log('\n[A] 选项协商')
  {
    const terminal = await openTerminal(telnetConfig(MOCK_ECHO), undefined)

    check('Telnet 终端创建成功', typeof terminal.created.terminalId === 'string')
    check(
      '默认标题为 host:port（非 23 端口不省略）',
      terminal.created.title === `127.0.0.1:${MOCK_ECHO}`,
      terminal.created.title,
    )

    const ready = terminal.control.find((m) => m.t === 'ready')
    check('ready 消息标明协议为 telnet', ready?.info?.protocol === 'telnet', ready?.info?.protocol)
    check('ready 消息不含 SSH 算法字段值', ready?.info?.kex === '—', ready?.info?.kex)

    // 客户端主动声明「抑制继续」
    check('客户端主动发出 WILL SGA', Boolean(optionEvent(mockEcho, 'WILL', 3)))
    // 回应设备的 DO TERMINAL-TYPE / DO NAWS
    check('客户端回应 WILL TERMINAL-TYPE', Boolean(optionEvent(mockEcho, 'WILL', 24)))
    check('客户端回应 WILL NAWS', Boolean(optionEvent(mockEcho, 'WILL', 31)))
    // 回应设备的 WILL ECHO / WILL SGA
    check('客户端回应 DO ECHO', Boolean(optionEvent(mockEcho, 'DO', 1)))
    check('客户端回应 DO SGA', Boolean(optionEvent(mockEcho, 'DO', 3)))

    // 终端类型：设备索要后必须回答
    const ttype = await waitEvent(mockEcho, (e) => e.event === 'ttype')
    check('终端类型已上报（TERMINAL-TYPE IS）', ttype?.value === 'xterm-256color', ttype?.value)

    // 窗口尺寸：同意 NAWS 后必须立刻报送当前尺寸
    const naws = await waitEvent(mockEcho, (e) => e.event === 'naws')
    check(
      '窗口尺寸已上报（NAWS）',
      naws?.cols === 120 && naws?.rows === 30,
      naws ? `${naws.cols}x${naws.rows}` : '无',
    )

    check(
      '协商结果里 remoteEcho 为 true',
      ready?.info?.telnetOptions?.remoteEcho === true,
      JSON.stringify(ready?.info?.telnetOptions),
    )
    check(
      '协商结果里列出已启用的本端选项',
      Array.isArray(ready?.info?.telnetOptions?.localOptions) &&
        ready.info.telnetOptions.localOptions.length >= 3,
      JSON.stringify(ready?.info?.telnetOptions?.localOptions),
    )

    const detail = await api(`/terminals/${terminal.created.terminalId}`)
    check('终端详情标明协议', detail.terminal.protocol === 'telnet')
    check('Telnet 终端没有登录名', detail.terminal.username === '')

    /* ---------------- B. 数据通道 ---------------- */
    console.log('\n[B] 数据通道与 IAC 处理')
    check('收到设备欢迎语', await waitText(terminal, 'MockTelnet (mock) ready.'))

    const beforeHelp = terminal.text.length
    sendInput(terminal, 'help\r\n')
    check('命令回显与响应正常', await waitText(terminal, 'commands: help'))
    const helpSegment = terminal.text.slice(beforeHelp)
    check(
      '用户数据里不含 IAC 控制字节',
      !helpSegment.includes('\u00ff'),
      `len=${helpSegment.length}`,
    )

    sendInput(terminal, 'echo 你好世界\r\n')
    check('中文内容原样返回', await waitText(terminal, '你好世界'))

    // IAC 转义：设备输出裸 0xFF，客户端必须还原成单个 0xFF
    terminal.chunks.length = 0
    sendInput(terminal, 'iac\r\n')
    await sleep(400)
    const iacBytes = terminal.chunks.reduce((sum, c) => sum + countByte(c, 0xff), 0)
    check('数据里被转义的 0xFF 正确还原为单字节', iacBytes === 1, `0xFF 出现 ${iacBytes} 次`)

    // 回显归属：设备声明了 WILL ECHO，客户端不应再本地回显（否则字符会重复两遍）
    sendInput(terminal, 'ping\r\n')
    await waitText(terminal, 'pong')
    const pingEchoCount = countOccurrences(terminal.text, 'ping')
    check(
      '设备回显时本端不重复回显（ping 只出现 1 次）',
      pingEchoCount === 1,
      `"ping" 出现 ${pingEchoCount} 次`,
    )

    /* ---------------- C. 窗口尺寸重协商 ---------------- */
    console.log('\n[C] 窗口尺寸变化')
    const nawsBefore = mockEcho.events.filter((e) => e.event === 'naws').length
    sendControl(terminal, { t: 'resize', cols: 100, rows: 40 })
    const resized = await waitEvent(
      mockEcho,
      (e) => e.event === 'naws' && e.cols === 100 && e.rows === 40,
    )
    check(
      'resize 后重新上报 NAWS',
      Boolean(resized) && mockEcho.events.filter((e) => e.event === 'naws').length > nawsBefore,
      resized ? `${resized.cols}x${resized.rows}` : '无',
    )
    sendInput(terminal, 'size\r\n')
    check('设备侧看到的尺寸已更新', await waitText(terminal, 'size=100x40'))

    // 关闭浏览器侧连接不等于结束终端 —— 服务端会保留会话等待重连（见 terminal-manager 的回收策略）。
    // 真正让设备侧断开的是 DELETE /terminals/:id。
    await terminal.close()
    await sleep(200)
    check(
      '仅断开渲染端不会关闭到设备的连接',
      !mockEcho.events.some((e) => e.event === 'disconnect'),
    )
    await api(`/terminals/${terminal.created.terminalId}`, { method: 'DELETE' })
    const closed = await waitEvent(mockEcho, (e) => e.event === 'disconnect')
    check('删除终端后设备侧连接断开', Boolean(closed))
  }

  /* ---------------- D. 本地回显兜底 ---------------- */
  console.log('\n[D] 设备不回显时的本地回显')
  {
    const terminal = await openTerminal(telnetConfig(MOCK_NO_ECHO), undefined)
    const ready = terminal.control.find((m) => m.t === 'ready')
    check('未协商回显时 remoteEcho 为 false', ready?.info?.telnetOptions?.remoteEcho === false)

    terminal.chunks.length = 0
    sendInput(terminal, 'ab')
    check('本端补上回显，用户能看见输入', await waitText(terminal, 'ab'), JSON.stringify(terminal.text))
    const inputEvent = await waitEvent(mockNoEcho, (e) => e.event === 'input' && e.data === 'ab')
    check('输入字节确实送达设备（回显只是本端补的）', Boolean(inputEvent))
    check(
      '设备侧没有回显任何内容',
      !mockNoEcho.events.some((e) => e.event === 'input' && e.data === 'abab'),
    )

    // 退格应当只退掉已回显的字符，不能退到提示符上
    terminal.chunks.length = 0
    sendInput(terminal, '\x7fab')
    await sleep(250)
    const backspaceText = terminal.text
    check(
      '退格回显为 \\b \\b 且不越界',
      backspaceText.startsWith('\b \b') && backspaceText.endsWith('ab'),
      JSON.stringify(backspaceText),
    )

    await terminal.close()
  }

  /* ---------------- E. 不做协商的极简设备 ---------------- */
  console.log('\n[E] 不做协商的极简设备')
  {
    const terminal = await openTerminal(telnetConfig(MOCK_NO_NEG), undefined)
    check('依然连得上并拿到欢迎语', await waitText(terminal, 'MockTelnet (mock) ready.'))
    sendInput(terminal, 'ping\r\n')
    check('交互正常', await waitText(terminal, 'pong'))
    const ready = terminal.control.find((m) => m.t === 'ready')
    check(
      '未协商时本端启用本地回显',
      ready?.info?.telnetOptions?.remoteEcho === false &&
        (ready?.info?.telnetOptions?.remoteOptions ?? []).length === 0,
      JSON.stringify(ready?.info?.telnetOptions),
    )
    await terminal.close()
  }

  /* ---------------- F. 探测 ---------------- */
  console.log('\n[F] 测试连接（probe）')
  {
    const probe = await api(
      '/sessions/probe',
      json('POST', { protocol: 'telnet', target: { host: '127.0.0.1', port: MOCK_ECHO } }),
    )
    check('Telnet 探测成功', probe.ok === true && probe.protocol === 'telnet')
    check('探测带回设备欢迎语', typeof probe.banner === 'string' && probe.banner.includes('MockTelnet'), probe.banner?.slice(0, 40))
    check(
      '探测明确提示明文风险',
      probe.warnings.some((w) => w.includes('明文')),
    )
    check(
      '探测没有 SSH 专有字段',
      probe.negotiation === undefined && probe.hostKeyFingerprint === undefined,
    )

    const probeNoEcho = await api(
      '/sessions/probe',
      json('POST', { protocol: 'telnet', target: { host: '127.0.0.1', port: MOCK_NO_ECHO } }),
    )
    check(
      '不回显设备在探测结果里被指出',
      probeNoEcho.warnings.some((w) => w.includes('回显')),
    )

    const probeNoNeg = await api(
      '/sessions/probe',
      json('POST', { protocol: 'telnet', target: { host: '127.0.0.1', port: MOCK_NO_NEG } }),
    )
    check(
      '未协商设备在探测结果里被指出',
      probeNoNeg.warnings.some((w) => w.includes('选项协商')),
    )

    let deadError
    try {
      await api(
        '/sessions/probe',
        json('POST', { protocol: 'telnet', target: { host: '127.0.0.1', port: DEAD_PORT } }),
      )
    } catch (err) {
      deadError = err
    }
    check(
      '探测端口不通 → 502 UNREACHABLE',
      deadError?.status === 502 && deadError?.code === 'UNREACHABLE',
      `${deadError?.status} ${deadError?.code}`,
    )
    check(
      '错误提示指出设备侧要开启 Telnet',
      typeof deadError?.message === 'string' && deadError.message.includes('Telnet'),
      deadError?.message?.split('\n')[0],
    )
  }

  /* ---------------- G. 协议边界与会话库校验 ---------------- */
  console.log('\n[G] 协议边界与会话库校验')
  {
    let createError
    try {
      await api('/terminals', json('POST', { config: telnetConfig(DEAD_PORT) }))
    } catch (err) {
      createError = err
    }
    check(
      '创建终端端口不通 → 502 UNREACHABLE',
      createError?.status === 502 && createError?.code === 'UNREACHABLE',
      `${createError?.status} ${createError?.code}`,
    )

    // Telnet 会话记录：不需要凭据
    const node = await api(
      '/library',
      json('POST', {
        kind: 'session',
        name: '交换机 2331',
        session: {
          protocol: 'telnet',
          host: '127.0.0.1',
          port: MOCK_ECHO,
          encoding: 'utf8',
          term: 'xterm-256color',
        },
      }),
    )
    check('会话库可保存 Telnet 会话（无需凭据）', node.kind === 'session' && node.session.protocol === 'telnet')

    let credError
    try {
      await api(
        '/library',
        json('POST', {
          kind: 'session',
          name: '带凭据的 telnet',
          session: {
            protocol: 'telnet',
            host: '127.0.0.1',
            port: MOCK_ECHO,
            credentialId: 'cred_not_exists',
            encoding: 'utf8',
            term: 'xterm-256color',
          },
        }),
      )
    } catch (err) {
      credError = err
    }
    check(
      'Telnet 会话携带凭据被拒',
      credError?.status === 400,
      `${credError?.status} ${credError?.code}`,
    )

    let jumpError
    try {
      await api(
        '/library',
        json('POST', {
          kind: 'session',
          name: '带跳板的 telnet',
          session: {
            protocol: 'telnet',
            host: '127.0.0.1',
            port: MOCK_ECHO,
            encoding: 'utf8',
            term: 'xterm-256color',
            jumpChain: [
              {
                host: '127.0.0.1',
                port: 2222,
                username: 'demo',
                credentialId: 'cred_not_exists',
              },
            ],
          },
        }),
      )
    } catch (err) {
      jumpError = err
    }
    check('Telnet 会话携带跳板链被拒', jumpError?.status === 400, `${jumpError?.status}`)

    let sshMissingCred
    try {
      await api(
        '/library',
        json('POST', {
          kind: 'session',
          name: '缺凭据的 ssh',
          session: {
            protocol: 'ssh',
            host: '127.0.0.1',
            port: 2222,
            username: 'demo',
            encoding: 'utf8',
            term: 'xterm-256color',
          },
        }),
      )
    } catch (err) {
      sshMissingCred = err
    }
    check(
      'SSH 会话缺凭据仍被拒（校验按协议分支）',
      sshMissingCred?.status === 400,
      `${sshMissingCred?.status} ${sshMissingCred?.code}`,
    )

    /* ---------------- H. 会话库引用 ---------------- */
    console.log('\n[H] 从会话库打开 Telnet')
    const fromLibrary = await api('/terminals', json('POST', { sessionId: node.id }))
    check('引用会话库可创建 Telnet 终端', typeof fromLibrary.terminalId === 'string')
    check(
      '标题按 host:port 推导',
      fromLibrary.title === `127.0.0.1:${MOCK_ECHO}`,
      fromLibrary.title,
    )

    const list = await api('/library')
    const saved = list.nodes.find((n) => n.id === node.id)
    check('会话库返回的协议字段正确', saved?.session?.protocol === 'telnet')

    let sftpError
    try {
      await api('/sftp/sessions', json('POST', { sessionId: node.id }))
    } catch (err) {
      sftpError = err
    }
    check(
      'Telnet 会话不能开 SFTP',
      sftpError?.status === 400 && sftpError?.code === 'INVALID_CONFIG',
      `${sftpError?.status} ${sftpError?.code}`,
    )
    check(
      '拒绝理由说明了原因',
      typeof sftpError?.message === 'string' && sftpError.message.includes('文件'),
      sftpError?.message,
    )

    /* ---------------- I. 关闭与回收 ---------------- */
    console.log('\n[I] 关闭与回收')
    const before = mockEcho.events.filter((e) => e.event === 'disconnect').length
    await api(`/terminals/${fromLibrary.terminalId}`, { method: 'DELETE' })
    const after = await waitEvent(
      mockEcho,
      () => mockEcho.events.filter((e) => e.event === 'disconnect').length > before,
    )
    check('DELETE 后设备侧连接断开', Boolean(after))

    let goneError
    try {
      await api(`/terminals/${fromLibrary.terminalId}`)
    } catch (err) {
      goneError = err
    }
    check('关闭后终端详情 404', goneError?.status === 404, `${goneError?.status}`)
  }
} catch (err) {
  console.error('\n执行过程中抛出异常：', err)
  failures.push(`异常：${err?.message ?? err}`)
} finally {
  console.log(`\n服务端日志尾部：\n${server.getLog().split('\n').slice(-8).join('\n')}`)
  cleanup()
  await sleep(200)
  try {
    fs.rmSync(WORK, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

console.log(`\n==> Telnet E2E：${pass} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}

function countByte(buf, byte) {
  let n = 0
  for (const b of buf) if (b === byte) n += 1
  return n
}

function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
