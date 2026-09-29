/**
 * 阶段 6（自动化与批量运维）端到端验证。
 *
 * 自管 5 台 mock SSH、1 台 mock Telnet 与一个服务端实例：
 *   2441..2445  mock SSH（MOCK_NAME=h1..h5），用于批量执行与多主机会话
 *   2451        mock Telnet（用于验证「Telnet 不能批量执行」）
 *   8112        服务端（独立数据目录，不影响开发用的 8080）
 *
 * 覆盖阶段 6 的四个验收点，以及各模块最容易翻车的边界：
 *   1. 触发器：`(yes/no)?` 自动回 `yes`+回车（含跨 chunk 与尾部防抖）
 *   2. 脚本：向 5 台主机并发 `df -h`，汇总表格正确
 *   3. 脚本内 `require('fs')` 抛错（沙箱生效）
 *   4. 死循环脚本超时后被强制终止，且不影响服务
 *
 * 另有几块专门验证「设计是否真的按文档生效」：
 *   - 触发器作用域隔离（全局规则命中所有会话、会话级规则只命中自己）
 *   - 自激抑制（自动应答的回显不能再次触发同一条规则）
 *   - 同会话互斥（两个脚本不能同时写一个 PTY）
 *   - 批量执行借用已登录连接（mock 侧的「认证通过」次数不增加）
 *   - 批量并发度真的生效（并发 5 与并发 1 的耗时差异）
 *   - 输出截断（256 KB 上限）
 *
 * 运行：npm run build && node data/tmp/e2e-automation.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
/**
 * 每次运行使用独立的数据目录。
 * 不复用同一个目录并「先清空」：保险库、会话库、触发器规则都会落库，
 * 残留状态会让「初始为空」这类断言直接失真；而清空一个几百文件的目录
 * 又会撞上沙箱的批量删除保护，得不偿失。
 */
const RUN_ID = process.env.E2E_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(ROOT, 'data/tmp/automation-e2e', RUN_ID)
const PORT = 8112
const API = `http://127.0.0.1:${PORT}`
const WS_BASE = `ws://127.0.0.1:${PORT}`

/** 批量执行的 5 台「主机」 */
const HOSTS = [
  { port: 2441, name: 'h1' },
  { port: 2442, name: 'h2' },
  { port: 2443, name: 'h3' },
  { port: 2444, name: 'h4' },
  { port: 2445, name: 'h5' },
]
const MAIN = HOSTS[0]
const MOCK_TELNET = 2451

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
const section = (title) => console.log(`\n${title}`)

/* ------------------------------------------------------------------ */
/* 进程与端口                                                          */
/* ------------------------------------------------------------------ */

const children = []

/** 启动一个 mock SSH，并把它的 stdout 按行留存（用于「认证通过」次数这类断言） */
function startMockSsh({ port, name }) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_NAME: name },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.logLines = []
  let buffer = ''
  child.stdout.on('data', (d) => {
    buffer += d.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim()) child.logLines.push(line)
    }
    if (process.env.MOCK_DEBUG) process.stdout.write(`  [${name}] ${d}`)
  })
  child.stderr.on('data', (d) => process.stdout.write(`  [${name}!] ${d}`))
  child.countLog = (needle) => child.logLines.filter((l) => l.includes(needle)).length
  children.push(child)
  return child
}

function startMockTelnet(port) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-telnet-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.env.MOCK_DEBUG && process.stdout.write(`  [telnet] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [telnet!] ${d}`))
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

/* ------------------------------------------------------------------ */
/* REST 工具                                                            */
/* ------------------------------------------------------------------ */

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

async function expectError(pathname, init) {
  try {
    await api(pathname, init)
    return null
  } catch (err) {
    return err instanceof ApiError ? err : null
  }
}

/** 轮询直到条件成立（服务端状态变化不是同步的） */
async function waitUntil(fn, timeoutMs = 8000, stepMs = 40) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) return undefined
    await sleep(stepMs)
  }
}

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1

/* ------------------------------------------------------------------ */
/* 终端 + WebSocket                                                     */
/* ------------------------------------------------------------------ */

const sshConfig = (port, overrides = {}) => ({
  protocol: 'ssh',
  target: {
    host: '127.0.0.1',
    port,
    username: 'demo',
    authMethod: 'password',
    password: 'demo',
  },
  terminal: { cols: 120, rows: 30, encoding: 'utf8', term: 'xterm-256color', ...overrides },
  legacyCompat: 'auto',
})

const telnetConfig = (port) => ({
  protocol: 'telnet',
  target: { host: '127.0.0.1', port },
  terminal: { cols: 120, rows: 30, encoding: 'utf8', term: 'xterm-256color' },
})

const openTerminals = []

/** 建一个终端并挂上 WebSocket，返回带输出/控制帧收集器的对象 */
async function openTerminal(body, label) {
  const created = await api('/terminals', json('POST', body))
  const ws = new WebSocket(
    `${WS_BASE}${created.wsPath}?token=${encodeURIComponent(created.attachToken)}`,
  )
  const collector = {
    label: label ?? created.title,
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
  openTerminals.push(collector)

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

  await waitUntil(() => collector.control.some((m) => m.t === 'ready'), 6000)
  return collector
}

const sendInput = (collector, text) => collector.ws.send(Buffer.from(text))

async function waitText(collector, needle, timeoutMs = 8000) {
  const found = await waitUntil(() => collector.text.includes(needle), timeoutMs)
  return Boolean(found)
}

const controlOf = (collector, type) => collector.control.filter((m) => m.t === type)

/** 断言失败时的现场快照：光看「没命中」是查不出原因的 */
function dumpTerminal(collector, note) {
  const tail = collector.text.slice(-400).replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  const kinds = collector.control.map((m) => `${m.t}:${m.phase ?? ''}`).join(' ')
  console.log(`      · [${note}] 控制帧=[${kinds}]`)
  console.log(`      · [${note}] 输出尾部=${JSON.stringify(tail)}`)
}

async function waitControl(collector, type, predicate, timeoutMs = 8000) {
  return waitUntil(() => collector.control.find((m) => m.t === type && (!predicate || predicate(m))), timeoutMs)
}

/* ------------------------------------------------------------------ */
/* 脚本运行记录                                                         */
/* ------------------------------------------------------------------ */

const listRuns = async () => (await api('/automation/script-runs')).runs
const findRun = async (runId) => (await listRuns()).find((r) => r.runId === runId)

/** 跑一段临时脚本并等它结束，返回运行记录 */
async function runInline(terminalId, code, timeoutMs) {
  const { runId } = await api(
    '/automation/scripts/run',
    json('POST', { terminalId, code, ...(timeoutMs ? { timeoutMs } : {}) }),
  )
  const record = await waitUntil(async () => {
    const run = await findRun(runId)
    return run && run.phase !== 'running' ? run : undefined
  }, 30_000)
  return { runId, record }
}

/* ================================================================== */

const mocks = HOSTS.map((h) => startMockSsh(h))
const mockTelnet = startMockTelnet(MOCK_TELNET)

fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true })
console.log(`[e2e] 数据目录 ${WORK}`)

const server = startServer()

try {
  await waitHealthy()
  await sleep(300)

  /* ================================================================ */
  section('[A] 能力声明与空态')
  /* ================================================================ */
  {
    const caps = await api('/capabilities')
    const a = caps.automation
    check('capabilities 暴露 automation 段', Boolean(a))
    check(
      '脚本可用全局与沙箱一致',
      Array.isArray(a?.scriptGlobals) &&
        ['session', 'sftp', 'log', 'console', 'sleep'].every((g) => a.scriptGlobals.includes(g)),
      JSON.stringify(a?.scriptGlobals),
    )
    check(
      '触发器修饰符白名单不含 g / y',
      Array.isArray(a?.supportedTriggerFlagChars) &&
        !a.supportedTriggerFlagChars.includes('g') &&
        !a.supportedTriggerFlagChars.includes('y'),
      JSON.stringify(a?.supportedTriggerFlagChars),
    )
    check('批量默认并发为 5', a?.defaultBatchConcurrency === 5, String(a?.defaultBatchConcurrency))

    const t = await api('/automation/triggers')
    check('初始无触发器规则', t.rules.length === 0 && t.stats.length === 0)
    check('初始无按钮', (await api('/automation/macros')).macros.length === 0)
    check('初始无脚本', (await api('/automation/scripts')).scripts.length === 0)
    check('初始无脚本运行记录', (await listRuns()).length === 0)
  }

  /* ================================================================ */
  section('[B] 触发器 CRUD 与试匹配')
  /* ================================================================ */
  let goodRuleId
  {
    // 坏正则必须在入口被挡住，而不是运行期静默跳过
    const bad = await expectError(
      '/automation/triggers',
      json('POST', {
        name: '坏正则',
        pattern: '(((',
        actions: [{ type: 'send', text: 'x' }],
      }),
    )
    check('无法编译的正则被拒(400)', bad?.status === 400, `${bad?.status} ${bad?.code}`)

    const noSession = await expectError(
      '/automation/triggers',
      json('POST', {
        name: '缺会话',
        scope: 'session',
        pattern: 'x',
        actions: [{ type: 'send', text: 'x' }],
      }),
    )
    check('会话级规则缺 sessionId 被拒(400)', noSession?.status === 400)

    const noAction = await expectError(
      '/automation/triggers',
      json('POST', { name: '无动作', pattern: 'x', actions: [] }),
    )
    check('动作列表为空被拒(400)', noAction?.status === 400)

    const created = await api(
      '/automation/triggers',
      json('POST', {
        name: '磁盘错误高亮',
        pattern: 'failed with code=(\\d+)',
        flags: 'sm', // 故意打乱顺序并混入未支持的 g
        matchMode: 'regex',
        cooldownMs: 0,
        actions: [
          { type: 'highlight', color: 'red' },
          { type: 'send', text: 'dump $1', enter: false },
        ],
      }),
    )
    goodRuleId = created.rule.id
    check('创建规则(201) 并返回规则体', typeof goodRuleId === 'string')
    check(
      '修饰符被规范化（去 g、按固定顺序）',
      created.rule.flags === 'ms',
      created.rule.flags,
    )
    check('cooldownMs 落库', created.rule.cooldownMs === 0, String(created.rule.cooldownMs))

    const patched = await api(
      `/automation/triggers/${goodRuleId}`,
      json('PATCH', { name: '磁盘错误高亮 v2', enabled: false }),
    )
    check('更新规则生效', patched.rule.name === '磁盘错误高亮 v2' && patched.rule.enabled === false)

    // 试匹配：正则 + 捕获组 + $1 展开
    const test1 = await api(
      '/automation/triggers/test',
      json('POST', {
        pattern: 'failed with code=(\\d+)',
        matchMode: 'regex',
        flags: 'i',
        sample: 'ok\n[ fail ] disk0 校验 FAILED with code=5001\nno match here',
        previewTemplate: 'dump $1',
      }),
    )
    check('试匹配命中一行', test1.valid === true && test1.matches.length === 1, `${test1.matches.length} 行`)
    check('命中行号正确（从 1 开始）', test1.matches[0]?.line === 2, String(test1.matches[0]?.line))
    check(
      'groups[0] 是整个匹配（与 $0 对齐）',
      test1.matches[0]?.groups?.[0] === 'FAILED with code=5001',
      JSON.stringify(test1.matches[0]?.groups),
    )
    check(
      'groups[1] 是第 1 个捕获组（与 $1 对齐）',
      test1.matches[0]?.groups?.[1] === '5001',
      JSON.stringify(test1.matches[0]?.groups),
    )
    check('$1 展开正确', test1.matches[0]?.expanded === 'dump 5001', test1.matches[0]?.expanded)

    // 试匹配：text 模式免转义（这是给 `(yes/no)?` 这类提示准备的）
    const test2 = await api(
      '/automation/triggers/test',
      json('POST', {
        pattern: '(yes/no)?',
        matchMode: 'text',
        sample: 'Are you sure? (yes/no)? ',
      }),
    )
    check('text 模式无需用户转义', test2.valid === true && test2.matches.length === 1)

    const test3 = await api(
      '/automation/triggers/test',
      json('POST', { pattern: '(((', matchMode: 'regex', sample: 'x' }),
    )
    check(
      '试匹配对坏正则不抛错而是回 valid=false',
      test3.ok === false && test3.valid === false && Boolean(test3.error),
      test3.error,
    )

    const test4 = await api(
      '/automation/triggers/test',
      json('POST', { pattern: '(YES/NO)?', matchMode: 'text', flags: 'i', sample: 'are you sure? (yes/no)?' }),
    )
    check('text 模式支持忽略大小写', test4.matches.length === 1)

    const list = await api('/automation/triggers')
    check('列表能取回规则', list.rules.length === 1 && list.rules[0].id === goodRuleId)
  }

  /* ================================================================ */
  section('[C] 行缓冲 / 触发器引擎（单元级，确定性地模拟跨 chunk 分片）')
  /* ================================================================ */
  {
    const { LineBuffer, stripTerminalControl, visibleLine } = await import(
      pathToFileURL(path.join(ROOT, 'packages/server/dist/automation/line-buffer.js')).href
    )
    const { TriggerEngine } = await import(
      pathToFileURL(path.join(ROOT, 'packages/server/dist/automation/triggers.js')).href
    )

    // --- 行尾 CR 的两种形态：单个 CRLF 与「CRLF 撞上 ONLCR」得到的 CR CR LF ---
    // 后者曾在真实设备上让整行输出对触发器隐身（被误判成「覆盖成空」）
    check('单个 CRLF 行尾', visibleLine('abc\r') === 'abc', JSON.stringify(visibleLine('abc\r')))
    check('CR CR LF 行尾不丢内容', visibleLine('abc\r\r') === 'abc', JSON.stringify(visibleLine('abc\r\r')))
    check(
      'CR CR LF 行尾的进度条仍取最后一段',
      visibleLine('10%\r20%\r\r') === '20%',
      JSON.stringify(visibleLine('10%\r20%\r\r')),
    )
    check('纯 CR 视为空行', visibleLine('\r\r') === '', JSON.stringify(visibleLine('\r\r')))
    check('进度条覆盖语义', visibleLine('10%\r20%\r100%') === '100%')

    const crcrlf = []
    const crb = new LineBuffer((e) => {
      crcrlf.push(e)
      return false
    })
    crb.push('disk0 failed code=5001\r\r\n')
    check(
      'CR CR LF 结尾的行会作为完整行发出',
      crcrlf.length === 1 && crcrlf[0].kind === 'complete' && crcrlf[0].text === 'disk0 failed code=5001',
      JSON.stringify(crcrlf[0]),
    )
    crb.dispose()

    // --- 跨 chunk：把提示切成 3 段推入，只在最后一段之后才应触发 ---
    const events = []
    const buffer = new LineBuffer((e) => {
      events.push(e)
      return false
    })
    buffer.push('Are you su')
    buffer.push('re? (yes/')
    buffer.push('no)? ')
    check('半截内容不会立刻触发', events.length === 0, `${events.length} 次`)
    await sleep(120)
    check(
      '对端静默后尾行才作为一行发出',
      events.length === 1 && events[0].kind === 'tail' && events[0].text === 'Are you sure? (yes/no)? ',
      JSON.stringify(events[0]),
    )
    buffer.dispose()

    // --- ANSI 必须剥离，否则 `/error:/` 这种最普通的规则会被颜色码打断 ---
    check(
      'ANSI 颜色码被剥离',
      stripTerminalControl('\u001b[31merror\u001b[0m: boom') === 'error: boom',
      JSON.stringify(stripTerminalControl('\u001b[31merror\u001b[0m: boom')),
    )

    // --- 进度条：同一逻辑行只保留最后一个 \r 之后的内容 ---
    const progress = []
    const pb = new LineBuffer((e) => {
      progress.push(e)
      return false
    })
    pb.push('10%\r20%\r100%\r\n')
    check(
      '回车覆盖语义（进度条只留最终值）',
      progress.length === 1 && progress[0].text === '100%',
      JSON.stringify(progress[0]),
    )
    pb.dispose()

    // --- 尾行命中后，同一内容在换行时不得再次触发（自激抑制）---
    // 远端回显会把用户输入接在提示后面，于是同一行以「提示」开头再次出现
    const carried = []
    const cb = new LineBuffer((e) => {
      carried.push(e)
      return e.kind === 'tail' // 模拟「尾行命中」
    })
    cb.push('Are you sure? (yes/no)? ')
    await sleep(120)
    cb.push('yes\r\n')
    check('尾行命中一次', carried.length === 2, `${carried.length} 次`)
    check(
      '随后的完整行（提示 + 回显）被标记为 carriedOver',
      carried[1]?.carriedOver === true,
      JSON.stringify(carried[1]),
    )
    check(
      '该行的可见内容是「提示 + 回显」而不是裸回显',
      carried[1]?.text === 'Are you sure? (yes/no)? yes',
      JSON.stringify(carried[1]?.text),
    )
    cb.dispose()

    // --- 超长无换行输出要截断，且不能切开代理对 ---
    const long = []
    const lb = new LineBuffer((e) => {
      long.push(e)
      return false
    }, { maxChars: 16 })
    lb.push('😀'.repeat(4) + 'x'.repeat(40))
    await sleep(120)
    check('超长无换行被截断', long.length === 1 && long[0].text.length <= 16, String(long[0]?.text?.length))
    check(
      '截断不会切出半个代理对',
      !/[\uD800-\uDBFF]$/.test(long[0]?.text ?? ''),
      JSON.stringify(long[0]?.text),
    )
    lb.dispose()

    // --- 引擎级：分片喂入也要命中且只命中一次，动作真的写回远端 ---
    const sent = []
    const uiEvents = []
    const engine = new TriggerEngine(
      [
        {
          id: 'unit-1',
          name: '确认应答',
          enabled: true,
          scope: 'global',
          pattern: '(yes/no)?',
          matchMode: 'text',
          flags: '',
          actions: [{ type: 'send', text: 'yes' }],
          cooldownMs: 0,
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        sendToRemote: (text) => sent.push(text),
        emitUi: (payload) => uiEvents.push(payload),
        resolveScript: () => undefined,
        runScript: () => {},
      },
    )
    engine.feed('Are you ')
    engine.feed('sure? (yes/')
    engine.feed('no)? ')
    await sleep(150)
    check('引擎跨分片命中并发送应答', sent.length === 1 && sent[0] === 'yes\r', JSON.stringify(sent))
    engine.feed('yes\r\n') // 远端回显
    await sleep(120)
    check('回显不再引发第二次应答（自激抑制）', sent.length === 1, `${sent.length} 次`)
    check('控制消息只发一次', uiEvents.length === 1, `${uiEvents.length} 次`)
    engine.dispose()
  }

  /* ================================================================ */
  section('[D] 验收 1：终端出现 (yes/no)? 自动回 yes 并回车')
  /* ================================================================ */
  let autoRuleId
  let mainTerminal
  {
    const created = await api(
      '/automation/triggers',
      json('POST', {
        name: '确认提示自动应答',
        pattern: '(yes/no)?',
        matchMode: 'text',
        cooldownMs: 0,
        actions: [{ type: 'send', text: 'yes' }],
      }),
    )
    autoRuleId = created.rule.id

    mainTerminal = await openTerminal({ config: sshConfig(MAIN.port), title: '自动化主会话' }, '主会话')
    check('主会话建立', await waitText(mainTerminal, 'WebTerm 测试 SSH 服务端'))

    sendInput(mainTerminal, 'confirm\r')
    const answered = await waitText(mainTerminal, 'OK, proceeding (answer=yes)')
    check('出现 (yes/no)? 后自动回 yes 并回车', answered)
    check(
      '应答文本出现在同一行提示之后',
      /Are you sure\? \(yes\/no\)\? yes/.test(mainTerminal.text),
      JSON.stringify(mainTerminal.text.slice(-160)),
    )

    await sleep(700)
    check(
      '提示只出现一次（未出现应答刷屏的自激）',
      countOccurrences(mainTerminal.text, 'Are you sure?') === 1,
      `${countOccurrences(mainTerminal.text, 'Are you sure?')} 次`,
    )
    check(
      '确认结果只处理一次',
      countOccurrences(mainTerminal.text, 'OK, proceeding') === 1,
      `${countOccurrences(mainTerminal.text, 'OK, proceeding')} 次`,
    )

    const triggerMsg = await waitControl(mainTerminal, 'trigger', (m) => m.ruleId === autoRuleId, 4000)
    check('推送了 trigger 控制消息', Boolean(triggerMsg))
    check(
      '控制消息说明「已自动应答」',
      (triggerMsg?.performed ?? []).some((p) => p.includes('自动应答')),
      JSON.stringify(triggerMsg?.performed),
    )
    check('控制消息带命中行与匹配片段', triggerMsg?.line?.includes('(yes/no)?') === true, triggerMsg?.matched)

    const stats = (await api('/automation/triggers')).stats.find((s) => s.ruleId === autoRuleId)
    check('命中统计被记录', (stats?.hitCount ?? 0) >= 1, `hitCount=${stats?.hitCount}`)
    check('记录最近触发时间', typeof stats?.lastFiredAt === 'string', stats?.lastFiredAt)

    // 再来一次，确认冷却为 0 时不会被「只触发一次」的机制挡住
    sendInput(mainTerminal, 'confirm\r')
    const twice = await waitUntil(
      () => countOccurrences(mainTerminal.text, 'OK, proceeding') === 2,
      8000,
    )
    check('同一规则可重复触发（cooldown=0）', Boolean(twice))
    check(
      '第二次的提示同样只被应答一次',
      countOccurrences(mainTerminal.text, 'Are you sure?') === 2,
      `${countOccurrences(mainTerminal.text, 'Are you sure?')} 次`,
    )
  }

  /* ================================================================ */
  section('[E] 分页自动翻页（--More-- 是不换行的尾行）')
  /* ================================================================ */
  let pagerRuleId
  {
    const created = await api(
      '/automation/triggers',
      json('POST', {
        name: '分页自动翻页',
        pattern: '--More--',
        matchMode: 'text',
        cooldownMs: 0,
        sortOrder: 10,
        actions: [{ type: 'send', text: '' }], // 只发一个回车
      }),
    )
    pagerRuleId = created.rule.id

    sendInput(mainTerminal, 'pager 24\r')
    const finished = await waitText(mainTerminal, '(文件结束)', 10_000)
    check('--More-- 被自动翻页直到文件结束', finished)
    check(
      '最后一页真的输出了（第 24 行）',
      mainTerminal.text.includes('第 24 / 24 行'),
      '第 24 / 24 行',
    )
    check(
      '每页只翻一次（无重复翻页）',
      countOccurrences(mainTerminal.text, '(文件结束)') === 1,
      `${countOccurrences(mainTerminal.text, '(文件结束)')} 次`,
    )

    await api(`/automation/triggers/${pagerRuleId}`, { method: 'DELETE' })
  }

  /* ================================================================ */
  section('[F] 触发器作用域：全局 vs 会话级')
  /* ================================================================ */
  let scopedTerminal
  let otherTerminal
  {
    // 建保险库与凭据（会话库里的会话必须引用凭据，不能内联口令）
    const vaultStatus = await api('/vault/status')
    if (!vaultStatus.initialized) {
      await api('/vault/setup', json('POST', { masterPassword: 'automation-e2e-master' }))
    }
    if (!(await api('/vault/status')).unlocked) {
      await api('/vault/unlock', json('POST', { masterPassword: 'automation-e2e-master' }))
    }
    check('保险库已解锁', (await api('/vault/status')).unlocked === true)
    const cred = await api(
      '/credentials',
      json('POST', { name: '自动化测试口令', type: 'password', password: 'demo' }),
    )
    const folder = await api('/library', json('POST', { kind: 'folder', name: '自动化测试' }))
    const node = await api(
      '/library',
      json('POST', {
        kind: 'session',
        name: 'h1（会话库）',
        parentId: folder.id,
        session: {
          host: '127.0.0.1',
          port: MAIN.port,
          username: 'demo',
          credentialId: cred.id,
          encoding: 'utf8',
          term: 'xterm-256color',
          legacyCompat: 'auto',
          jumpChain: [],
        },
      }),
    )

    const unknown = await expectError(
      '/automation/triggers',
      json('POST', {
        name: '不存在的会话',
        scope: 'session',
        sessionId: 'node_nope',
        pattern: 'x',
        actions: [{ type: 'send', text: 'x' }],
      }),
    )
    check('会话级规则引用不存在的会话被拒(404)', unknown?.status === 404, `${unknown?.status}`)

    // 会话级规则：只在它所属的会话上生效
    const scoped = await api(
      '/automation/triggers',
      json('POST', {
        name: '仅本会话应答',
        scope: 'session',
        sessionId: node.id,
        pattern: '仅此会话',
        matchMode: 'text',
        cooldownMs: 0,
        actions: [{ type: 'label', label: 'scoped-fired' }],
      }),
    )
    check('创建会话级规则(201)', Boolean(scoped.rule.id) && scoped.rule.scope === 'session')
    check('会话级规则记录了 sessionId', scoped.rule.sessionId === node.id)

    scopedTerminal = await openTerminal({ sessionId: node.id }, '会话库会话')
    check('从会话库建会话成功（凭据解密走通）', await waitText(scopedTerminal, 'WebTerm 测试 SSH 服务端'))

    // 另开一个快速连接会话（不属于任何会话库节点）
    otherTerminal = await openTerminal(
      { config: sshConfig(MAIN.port), title: '快速连接' },
      '快速连接',
    )
    await waitText(otherTerminal, 'WebTerm 测试 SSH 服务端')

    // 当前生效规则：全局「确认提示自动应答」+ 会话级「仅本会话应答」（h1 与快速连接都在同一台 mock 上）
    sendInput(scopedTerminal, 'echo 仅此会话\r')
    const scopedHit = await waitControl(
      scopedTerminal,
      'trigger',
      (m) => m.ruleId === scoped.rule.id,
      5000,
    )
    check('会话级规则在所属会话上命中', Boolean(scopedHit))

    sendInput(otherTerminal, 'echo 仅此会话\r')
    await sleep(600)
    check(
      '会话级规则不泄漏到其他会话',
      controlOf(otherTerminal, 'trigger').every((m) => m.ruleId !== scoped.rule.id),
      JSON.stringify(controlOf(otherTerminal, 'trigger').map((m) => m.ruleName)),
    )

    sendInput(otherTerminal, 'confirm\r')
    const globalHit = await waitControl(
      otherTerminal,
      'trigger',
      (m) => m.ruleId === autoRuleId,
      6000,
    )
    check('全局规则对所有会话生效', Boolean(globalHit))

    // 禁用全局规则后，新会话不应再自动应答；已建立的会话靠 refreshAll 即时生效
    await api(`/automation/triggers/${autoRuleId}`, json('PATCH', { enabled: false }))
    const beforeDisabled = countOccurrences(otherTerminal.text, 'OK, proceeding')
    sendInput(otherTerminal, 'confirm\r')
    await sleep(900)
    check(
      '禁用规则后立即不再自动应答（refreshAll 生效）',
      countOccurrences(otherTerminal.text, 'OK, proceeding') === beforeDisabled,
      `${beforeDisabled} → ${countOccurrences(otherTerminal.text, 'OK, proceeding')}`,
    )
    await api(`/automation/triggers/${autoRuleId}`, json('PATCH', { enabled: true }))
    sendInput(otherTerminal, 'yes\r')
    await sleep(400)
  }

  /* ================================================================ */
  section('[G] 按钮栏 / 多步宏')
  /* ================================================================ */
  let macroId
  {
    const bad = await expectError(
      '/automation/macros',
      json('POST', { name: '空步骤', steps: [{ enter: true }] }),
    )
    check('步骤必须至少含 send/delay/expect 之一(400)', bad?.status === 400)

    const created = await api(
      '/automation/macros',
      json('POST', {
        name: '确认并拒绝',
        description: '先等确认提示，再回答 no',
        steps: [
          { send: 'confirm', expect: '(yes/no)?', expectTimeoutMs: 6000 },
          { send: 'no', expect: 'Aborted', expectTimeoutMs: 6000 },
        ],
      }),
    )
    macroId = created.macro.id
    check('创建多步宏(201)', created.macro.steps.length === 2)

    const patched = await api(`/automation/macros/${macroId}`, json('PATCH', { description: '改过的说明' }))
    check('更新宏生效', patched.macro.description === '改过的说明')
    check('宏列表可取回', (await api('/automation/macros')).macros.length === 1)

    // 用一个不属任何规则的会话跑宏，避免自动应答规则抢先回答
    await api(`/automation/triggers/${autoRuleId}`, json('PATCH', { enabled: false }))
    const macroTerminal = await openTerminal(
      { config: sshConfig(MAIN.port), title: '宏宿主' },
      '宏宿主',
    )
    await waitText(macroTerminal, 'WebTerm 测试 SSH 服务端')

    const accepted = await api('/automation/macros/run', json('POST', { terminalId: macroTerminal.created.terminalId, macroId }))
    check('运行宏返回 202 + accepted', accepted.accepted === true && Boolean(accepted.runId))

    const aborted = await waitText(macroTerminal, 'Aborted (answer=no)', 12_000)
    check('宏按步骤执行到底（等到提示再回答）', aborted)
    check(
      '宏期间不会有规则抢答（规则已禁用）',
      !macroTerminal.text.includes('OK, proceeding'),
      '未见 OK, proceeding',
    )

    const macroMsgs = controlOf(macroTerminal, 'macro')
    check(
      '宏进度事件完整（start → step → done）',
      macroMsgs.some((m) => m.phase === 'start') &&
        macroMsgs.some((m) => m.phase === 'step') &&
        macroMsgs.some((m) => m.phase === 'done'),
      macroMsgs.map((m) => m.phase).join(','),
    )
    check(
      'step 事件带步序号与总数',
      macroMsgs.some((m) => m.phase === 'step' && m.stepIndex === 1 && m.stepCount === 2),
      JSON.stringify(macroMsgs.find((m) => m.phase === 'step')),
    )

    // expect 等不到时必须失败，而不是静默进入下一步
    const timeoutRun = await api(
      '/automation/macros/run',
      json('POST', {
        terminalId: macroTerminal.created.terminalId,
        macroName: '注定超时',
        steps: [{ send: 'echo x', expect: '这个字符串绝不会出现', expectTimeoutMs: 400 }],
      }),
    )
    const failed = await waitControl(
      macroTerminal,
      'macro',
      (m) => m.runId === timeoutRun.runId && m.phase === 'error',
      8000,
    )
    check('expect 超时按失败处理', Boolean(failed))
    check('失败消息可读', typeof failed?.error === 'string' && failed.error.length > 4, failed?.error)

    // 内联步骤（「临时执行」）不落库
    const inlineRun = await api(
      '/automation/macros/run',
      json('POST', {
        terminalId: macroTerminal.created.terminalId,
        macroName: '临时宏',
        steps: [{ send: 'echo inline-macro', expect: 'inline-macro', expectTimeoutMs: 5000 }],
      }),
    )
    const inlineDone = await waitControl(
      macroTerminal,
      'macro',
      (m) => m.runId === inlineRun.runId && m.phase === 'done',
      8000,
    )
    check('内联步骤可直接执行', Boolean(inlineDone))
    check('内联宏不落库', (await api('/automation/macros')).macros.length === 1)

    // 同一会话互斥
    const busyRun = await api(
      '/automation/macros/run',
      json('POST', {
        terminalId: macroTerminal.created.terminalId,
        steps: [{ delayMs: 1500 }],
      }),
    )
    const conflict = await expectError(
      '/automation/macros/run',
      json('POST', {
        terminalId: macroTerminal.created.terminalId,
        steps: [{ send: 'x' }],
      }),
    )
    check('同一会话的第二个自动化任务被拒(409)', conflict?.status === 409, `${conflict?.status}`)
    check('互斥错误码为 BUSY', conflict?.code === 'BUSY', conflict?.code)
    await waitControl(macroTerminal, 'macro', (m) => m.runId === busyRun.runId && m.phase === 'done', 8000)

    const removed = await expectError(`/automation/macros/${macroId}`, { method: 'DELETE' })
    check('删除宏返回 204', removed === null)
    check('删除后列表为空', (await api('/automation/macros')).macros.length === 0)

    await api(`/automation/triggers/${autoRuleId}`, json('PATCH', { enabled: true }))
  }

  /* ================================================================ */
  section('[H] 脚本引擎：注入的 API 与会话读写')
  /* ================================================================ */
  let logScriptId
  {
    const okSyntax = await api(
      '/automation/scripts/validate',
      json('POST', { code: 'log("hi")\nreturn 1' }),
    )
    check('语法校验通过', okSyntax.ok === true)

    const badSyntax = await api(
      '/automation/scripts/validate',
      json('POST', { code: 'const a = 1\nif (a {\n' }),
    )
    check('语法错误被识别', badSyntax.ok === false && typeof badSyntax.error === 'string', badSyntax.error)
    check('给出出错行号', typeof badSyntax.line === 'number' && badSyntax.line >= 2, String(badSyntax.line))

    const rejected = await expectError(
      '/automation/scripts',
      json('POST', { name: '语法坏脚本', code: 'function ( {' }),
    )
    check('语法错误的脚本无法入库(400)', rejected?.status === 400 && rejected.code === 'SANDBOX', rejected?.code)

    const created = await api(
      '/automation/scripts',
      json('POST', {
        name: '会话自检',
        description: '读一下会话信息并跑一条命令',
        code: [
          'log("自检开始");',
          'const info = session.info;',
          'const out = await session.run("echo script-run-ok");',
          'console.warn("第二行日志");',
          'return { host: info.host, title: info.title, sawOutput: out.includes("script-run-ok") };',
        ].join('\n'),
        timeoutMs: 20_000,
        runOnConnect: false,
      }),
    )
    logScriptId = created.script.id
    check('创建脚本(201)', Boolean(logScriptId))

    const runsBefore = (await listRuns()).length
    await api(
      '/automation/scripts/run',
      json('POST', { terminalId: otherTerminal.created.terminalId, scriptId: logScriptId }),
    )
    const record = await waitUntil(async () => {
      const r = (await listRuns()).find((x) => x.scriptId === logScriptId && x.phase !== 'running')
      return r
    }, 25_000)
    check('通过 scriptId 运行脚本并落记录', Boolean(record), record?.phase)
    check('运行记录挂在正确的会话上', record?.terminalId === otherTerminal.created.terminalId)
    check('运行记录带耗时', typeof record?.elapsedMs === 'number' && record.elapsedMs >= 0)
    check(
      '日志被收集（log()）',
      (record?.logs ?? []).some((l) => l.message.includes('自检开始')),
      JSON.stringify(record?.logs?.map((l) => l.message)),
    )
    check('运行记录数增加', (await listRuns()).length === runsBefore + 1)

    const result = record?.result
    check('脚本返回值可结构化回传', result?.host === '127.0.0.1', JSON.stringify(result))
    check('session.run 拿到了命令输出', result?.sawOutput === true, JSON.stringify(result))

    // 脚本走 WS 推送了完整的生命周期
    const scriptMsgs = controlOf(otherTerminal, 'script')
    check(
      '脚本事件完整（start → log → done）',
      scriptMsgs.some((m) => m.phase === 'start') &&
        scriptMsgs.some((m) => m.phase === 'log') &&
        scriptMsgs.some((m) => m.phase === 'done'),
      scriptMsgs.map((m) => m.phase).join(','),
    )
    check(
      'log 事件带级别与消息',
      scriptMsgs.some((m) => m.phase === 'log' && m.level === 'info' && m.message.includes('自检开始')),
    )

    // 临时脚本（不落库）
    const inline = await runInline(
      otherTerminal.created.terminalId,
      'log("临时脚本"); return { ok: true, n: 42 };',
      15_000,
    )
    check('临时脚本可直接运行', inline.record?.phase === 'done', inline.record?.phase)
    check('临时脚本返回值正确', inline.record?.result?.n === 42, JSON.stringify(inline.record?.result))
    check('临时脚本不落库', (await api('/automation/scripts')).scripts.length === 1)

    // 参数与 target 全局
    const withParams = await runInline(
      otherTerminal.created.terminalId,
      'return { target: target.host, got: params.answer, missing: params.nope === undefined };',
      15_000,
    )
    check(
      'target / params 注入正确',
      withParams.record?.result?.target === '127.0.0.1' && withParams.record?.result?.missing === true,
      JSON.stringify(withParams.record?.result),
    )

    // 等待只能看到「已被消费的位置之后」的输出：
    // run() 消费到提示符为止，之后再 waitFor 同一个提示符必须等不到
    const stale = await runInline(
      otherTerminal.created.terminalId,
      [
        'const first = await session.run("echo first-marker");',
        'const t0 = Date.now();',
        'let timedOut = false;',
        'try { await session.waitFor("$ ", { timeoutMs: 500 }); } catch (e) { timedOut = e.code === "TIMEOUT"; }',
        'return { timedOut, waited: Date.now() - t0, first };',
      ].join('\n'),
      15_000,
    )
    check(
      'run() 拿到了命令输出',
      stale.record?.result?.first?.includes('first-marker') === true,
      JSON.stringify(stale.record?.result?.first)?.slice(0, 120),
    )
    check(
      'waitFor 不会被已消费的旧提示符立刻满足',
      stale.record?.result?.timedOut === true,
      JSON.stringify(stale.record?.result),
    )
  }

  /* ================================================================ */
  section('[I] 验收 3：脚本内 require("fs") 抛错（沙箱生效）')
  /* ================================================================ */
  {
    const cases = [
      ['require', 'return require("fs").readFileSync("/etc/passwd");', 'require'],
      ['process', 'return process.env;', 'process'],
      ['module', 'return module.exports;', 'module'],
    ]
    for (const [label, code, needle] of cases) {
      const { record } = await runInline(otherTerminal.created.terminalId, code, 15_000)
      check(
        `沙箱不提供 ${label}`,
        record?.phase === 'error' && (record?.error ?? '').includes(needle),
        `${record?.phase} ${record?.error ?? ''}`.slice(0, 140),
      )
    }

    const evalRun = await runInline(
      otherTerminal.created.terminalId,
      'return new Function("return 1")();',
      15_000,
    )
    check(
      '动态执行代码被禁止',
      evalRun.record?.phase === 'error' &&
        /动态执行代码|Code generation/.test(evalRun.record?.error ?? ''),
      `${evalRun.record?.phase} ${evalRun.record?.error ?? ''}`.slice(0, 140),
    )

    const normal = await runInline(otherTerminal.created.terminalId, 'return 1 + 1;', 15_000)
    check('沙箱内正常脚本仍可运行', normal.record?.result === 2, JSON.stringify(normal.record?.result))

    const health = await fetch(`${API}/api/health`)
    check('沙箱报错不影响服务', health.ok)
  }

  /* ================================================================ */
  section('[J] 验收 4：死循环脚本超时被强制终止，且不影响服务')
  /* ================================================================ */
  {
    const loops = [
      ['同步死循环 while(true){}', 'while (true) {}'],
      ['await 之后的同步死循环', 'await sleep(20); while (true) {}'],
      ['微任务死循环', 'for (;;) { await Promise.resolve(); }'],
      ['永不 settle 的 Promise', 'await new Promise(() => {});'],
      // 带真实 IO 的死循环：vm 的超时只覆盖首个同步段，这一条必然落到硬终止。
      // 每轮都 await，因此写入量是有限的（不会把终端刷屏）
      ['带 IO 死循环', 'for (;;) { await session.send("echo tick"); }'],
    ]

    for (const [label, code] of loops) {
      const started = Date.now()
      const { record } = await runInline(otherTerminal.created.terminalId, code, 1000)
      const elapsed = Date.now() - started
      check(
        `超时终止：${label}`,
        record?.phase === 'timeout',
        `${record?.phase} ${record?.error ?? ''}`.slice(0, 120),
      )
      check(
        `终止及时：${label}`,
        elapsed < 6000,
        `${elapsed}ms`,
      )
      const health = await fetch(`${API}/api/health`)
      check(`服务仍可用：${label}`, health.ok)
    }

    // 被终止后互斥锁必须释放，否则该会话从此再也跑不了脚本
    const after = await runInline(otherTerminal.created.terminalId, 'return "alive";', 15_000)
    check(
      '强杀后互斥锁已释放，同一会话可继续跑脚本',
      after.record?.phase === 'done' && after.record?.result === 'alive',
      `${after.record?.phase}`,
    )

    // 其他会话完全不受影响
    const other = await runInline(scopedTerminal.created.terminalId, 'return "still-fine";', 15_000)
    check('其他会话不受死循环影响', other.record?.result === 'still-fine')
  }

  /* ================================================================ */
  section('[K] 脚本绑定：会话登录脚本与触发器动作')
  /* ================================================================ */
  {
    const startup = await api(
      '/automation/scripts',
      json('POST', {
        name: '登录自检脚本',
        code: 'log("登录脚本已执行 " + session.info.title);\nreturn session.info.title;',
        timeoutMs: 15_000,
        runOnConnect: true,
      }),
    )
    check('创建随会话运行的脚本(201)', startup.script.runOnConnect === true)

    const terminal = await openTerminal(
      { config: sshConfig(MAIN.port), title: '带登录脚本的会话' },
      '带登录脚本',
    )
    const ran = await waitUntil(
      async () => (await listRuns()).find((r) => r.scriptId === startup.script.id && r.terminalId === terminal.created.terminalId),
      15_000,
    )
    check('会话建立后自动运行登录脚本', Boolean(ran), ran?.phase)
    check('登录脚本跑在正确的会话上', ran?.terminalId === terminal.created.terminalId)

    // 关闭「随会话运行」：否则后面每个新会话都会被登录脚本占住互斥锁，
    // 触发器动作里的脚本提交就会以 BUSY 被拒（那是另一条用例，不该在这里串扰）
    await api(`/automation/scripts/${startup.script.id}`, json('PATCH', { runOnConnect: false }))

    // 触发器动作执行脚本
    const beacon = await api(
      '/automation/scripts',
      json('POST', {
        name: '命中后记一笔',
        code: 'log("触发器命中：" + params.trigger.matched);\nreturn params.trigger.matched;',
        timeoutMs: 15_000,
      }),
    )
    const rule = await api(
      '/automation/triggers',
      json('POST', {
        name: '自检错误触发脚本',
        pattern: 'code=(\\d+)',
        matchMode: 'regex',
        cooldownMs: 0,
        actions: [
          { type: 'highlight', color: 'amber' },
          { type: 'label', label: 'auto-check' },
          { type: 'notify', title: '发现错误码', body: '命中 $1' },
          { type: 'script', scriptId: beacon.script.id },
        ],
      }),
    )
    const ruleTerminal = await openTerminal(
      { config: sshConfig(MAIN.port), title: '触发器脚本宿主' },
      '触发器脚本',
    )
    await waitText(ruleTerminal, 'WebTerm 测试 SSH 服务端')
    sendInput(ruleTerminal, 'errors\r')

    const hit = await waitControl(ruleTerminal, 'trigger', (m) => m.ruleId === rule.rule.id, 8000)
    check('多动作规则命中', Boolean(hit))
    if (!hit) {
      dumpTerminal(ruleTerminal, 'K')
      console.log(`      · 规则 id=${rule.rule.id} 规则列表=${JSON.stringify((await api('/automation/triggers')).rules.map((r) => `${r.id}/${r.scope}/${r.enabled}`))}`)
    }
    check(
      '高亮 / 通知 / 标签三种动作都推给了渲染端',
      (hit?.ui ?? []).some((a) => a.type === 'highlight') &&
        (hit?.ui ?? []).some((a) => a.type === 'notify') &&
        (hit?.ui ?? []).some((a) => a.type === 'label'),
      JSON.stringify(hit?.ui),
    )
    check(
      '通知正文展开了捕获组',
      (hit?.ui ?? []).some((a) => a.type === 'notify' && a.body.includes('5001')),
      JSON.stringify((hit?.ui ?? []).find((a) => a.type === 'notify')),
    )
    check(
      'performed 里包含执行脚本',
      (hit?.performed ?? []).some((p) => p.includes('执行脚本')),
      JSON.stringify(hit?.performed),
    )

    // 必须等到 phase 离开 running 再断言 result —— 运行记录在脚本一开始执行时就落库了，
    // 只等「记录出现」会稳定地拿到一条还没有返回值的记录
    const scriptRun = await waitUntil(
      async () =>
        (await listRuns()).find(
          (r) => r.scriptId === beacon.script.id && r.phase !== 'running',
        ),
      15_000,
    )
    check('触发器动作真的跑起了脚本', Boolean(scriptRun))
    check(
      '脚本拿到了触发器上下文',
      scriptRun?.result === 'code=5001',
      JSON.stringify(scriptRun?.result),
    )

    // 引用已被删除的脚本 → 规则仍在，但记录明确的错误
    const ghostScript = await api(
      '/automation/scripts',
      json('POST', { name: '待删除脚本', code: 'return 1;', timeoutMs: 15_000 }),
    )
    const ghostRule = await api(
      '/automation/triggers',
      json('POST', {
        name: '引用幽灵脚本',
        pattern: '幽灵标记',
        matchMode: 'text',
        cooldownMs: 0,
        actions: [{ type: 'script', scriptId: ghostScript.script.id }],
      }),
    )
    const removed = await api(`/automation/scripts/${ghostScript.script.id}`, { method: 'DELETE' })
    check('删除脚本返回引用次数', removed?.removed === true && removed.references >= 1, String(removed?.references))

    sendInput(ruleTerminal, 'echo 幽灵标记\r')
    const ghostHit = await waitControl(ruleTerminal, 'trigger', (m) => m.ruleId === ghostRule.rule.id, 8000)
    check('脚本被删后规则仍可命中（不静默消失）', Boolean(ghostHit))
    const ghostStats = (await api('/automation/triggers')).stats.find((s) => s.ruleId === ghostRule.rule.id)
    check(
      '失效引用被记进 lastError',
      typeof ghostStats?.lastError === 'string' && ghostStats.lastError.includes('脚本'),
      ghostStats?.lastError,
    )

    // 会话库节点的启动脚本引用（用 startupScripts 字段）
    await api(`/automation/triggers/${ghostRule.rule.id}`, { method: 'DELETE' })
  }

  /* ================================================================ */
  section('[L] 验收 2：向 5 台主机并发执行 df -h，汇总表格正确')
  /* ================================================================ */
  const hostTerminals = []
  {
    // 先把会干扰的规则清干净，批量执行用的是 exec 通道，与触发器无关，
    // 但保留它们会让「其他断言」变得难以解释
    await api(`/automation/triggers/${autoRuleId}`, { method: 'DELETE' })
    const all = await api('/automation/triggers')
    for (const rule of all.rules) await api(`/automation/triggers/${rule.id}`, { method: 'DELETE' })

    for (const host of HOSTS) {
      const t = await openTerminal(
        { config: sshConfig(host.port), title: `批量 ${host.name}` },
        host.name,
      )
      await waitText(t, 'WebTerm 测试 SSH 服务端')
      hostTerminals.push(t)
    }
    check('5 台主机都已建立会话', hostTerminals.length === 5)

    const authBefore = mocks.map((m) => m.countLog('客户端认证通过'))

    const batch = await api(
      '/automation/batch',
      json('POST', {
        targets: hostTerminals.map((t) => ({ terminalId: t.created.terminalId })),
        command: 'df -h',
        concurrency: 5,
        timeoutMs: 15_000,
      }),
    )
    check('批量执行返回 5 行结果', batch.results.length === 5)
    check('汇总：成功 5 / 失败 0', batch.succeeded === 5 && batch.failed === 0, `${batch.succeeded}/${batch.failed}`)
    check('每行都带退出码 0', batch.results.every((r) => r.exitCode === 0 && r.ok === true))
    check('每行都带耗时', batch.results.every((r) => typeof r.elapsedMs === 'number'))

    // 汇总表格：主机名 + 文件系统 + 使用率
    const table = batch.results.map((r) => {
      const rows = r.stdout
        .split('\n')
        .map((line) => /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(\S+)$/.exec(line.trim()))
        .filter(Boolean)
        .map((m) => ({ fs: m[1], size: m[2], use: Number(m[5]), mount: m[6] }))
      return { host: r.target, rows }
    })
    check(
      '表格：识别出主机名（标题）',
      table.every((row) => row.host.startsWith('批量 ')),
      table.map((r) => r.host).join(','),
    )
    check(
      '表格：每台主机解析出 2 个挂载点',
      table.every((row) => row.rows.length === 2),
      JSON.stringify(table.map((r) => r.rows.length)),
    )
    check(
      '表格：使用率解析正确（32 / 47）',
      table.every((row) => row.rows[0]?.use === 32 && row.rows[1]?.use === 47),
      JSON.stringify(table[0]?.rows),
    )
    check(
      '表格：挂载点解析正确',
      table.every((row) => row.rows[0]?.mount === '/' && row.rows[1]?.mount === '/data'),
    )
    check(
      '表格：stdout 用 LF 而不是 CRLF（exec 没有 PTY 层）',
      batch.results.every((r) => !r.stdout.includes('\r')),
    )
    check('表格：stderr 为空', batch.results.every((r) => r.stderr === ''))

    // 借用已登录连接：mock 侧的「认证通过」次数不应增加
    const authAfter = mocks.map((m) => m.countLog('客户端认证通过'))
    check(
      '批量借用已登录连接，不新建 SSH 连接（不占 VTY）',
      authAfter.every((n, i) => n === authBefore[i]),
      `${authBefore.join(',')} → ${authAfter.join(',')}`,
    )

    // 结果顺序与输入一致，便于界面按原顺序展示
    check(
      '结果顺序与目标顺序一致',
      batch.results.every((r, i) => r.terminalId === hostTerminals[i].created.terminalId),
    )
    check(
      '每条结果都带 protocol=ssh',
      batch.results.every((r) => r.protocol === 'ssh'),
    )
  }

  /* ================================================================ */
  section('[M] 批量执行：退出码、失败、并发与边界')
  /* ================================================================ */
  {
    const targets5 = hostTerminals.map((t) => ({ terminalId: t.created.terminalId }))

    // 退出码来自协议层，不是猜的
    const exits = await api(
      '/automation/batch',
      json('POST', { targets: targets5.slice(0, 3), command: 'exit 7', concurrency: 3 }),
    )
    check('非零退出码被如实带回', exits.results.every((r) => r.exitCode === 7))
    check('非零退出码标记为失败', exits.results.every((r) => r.ok === false))

    const failed = await api(
      '/automation/batch',
      json('POST', { targets: targets5.slice(0, 2), command: 'boom', concurrency: 2 }),
    )
    check('失败命令退出码为 3', failed.results.every((r) => r.exitCode === 3))
    check(
      'stderr 与 stdout 分离',
      failed.results.every((r) => r.stderr.includes('command failed') && r.stdout === ''),
      JSON.stringify(failed.results[0]?.stderr),
    )

    // 并发度真的生效：5 台各睡 2 秒
    const parallel = await api(
      '/automation/batch',
      json('POST', { targets: targets5, command: 'sleep 2', concurrency: 5, timeoutMs: 20_000 }),
    )
    check('并发 5：5 个目标全部成功', parallel.succeeded === 5)
    check(
      '并发 5：总耗时接近单次（而不是 5 倍）',
      parallel.elapsedMs < 4200,
      `${parallel.elapsedMs}ms`,
    )

    const serial = await api(
      '/automation/batch',
      json('POST', { targets: targets5, command: 'sleep 2', concurrency: 1, timeoutMs: 30_000 }),
    )
    check('并发 1：总耗时接近 5 倍', serial.elapsedMs >= 8500, `${serial.elapsedMs}ms`)

    // 单目标超时：只影响这一行
    const timedOut = await api(
      '/automation/batch',
      json('POST', {
        targets: [{ terminalId: hostTerminals[0].created.terminalId }, { terminalId: hostTerminals[1].created.terminalId }],
        command: 'sleep 5',
        concurrency: 2,
        timeoutMs: 1000,
      }),
    )
    check('超时目标标记为 ok=false', timedOut.results.every((r) => r.ok === false))
    check(
      '超时说明可读',
      timedOut.results.every((r) => (r.error ?? '').includes('超时')),
      timedOut.results[0]?.error,
    )
    check('超时时间受控', timedOut.elapsedMs < 3000, `${timedOut.elapsedMs}ms`)

    // 不存在的终端：变成一行失败，不影响其他行
    const mixed = await api(
      '/automation/batch',
      json('POST', {
        targets: [
          { terminalId: 'term_nope', label: '幽灵主机' },
          { terminalId: hostTerminals[2].created.terminalId },
        ],
        command: 'hostname',
      }),
    )
    check('未知目标不影响其他目标', mixed.succeeded === 1 && mixed.failed === 1)
    check(
      '未知目标保留了自定义展示名',
      mixed.results[0]?.target === '幽灵主机' && mixed.results[0]?.ok === false,
      mixed.results[0]?.target,
    )
    check(
      '未知目标给出可读错误',
      (mixed.results[0]?.error ?? '').includes('终端不存在'),
      mixed.results[0]?.error,
    )
    check(
      'hostname 返回 mock 主机名（自定义标签）',
      mixed.results[1]?.stdout.trim() === 'h3',
      JSON.stringify(mixed.results[1]?.stdout),
    )

    // Telnet 会话没有 exec 通道：明确拒绝，而不是给一个不可信的成功
    const telnetTerminal = await openTerminal({ config: telnetConfig(MOCK_TELNET) }, 'telnet')
    await waitText(telnetTerminal, 'MockTelnet')
    const telnetBatch = await api(
      '/automation/batch',
      json('POST', {
        targets: [{ terminalId: telnetTerminal.created.terminalId }, { terminalId: hostTerminals[3].created.terminalId }],
        command: 'df -h',
      }),
    )
    const telnetRow = telnetBatch.results[0]
    check('Telnet 目标被拒绝', telnetRow?.ok === false, JSON.stringify(telnetRow?.error))
    check(
      '拒绝理由说明「没有 exec 通道」',
      (telnetRow?.error ?? '').includes('exec'),
      telnetRow?.error,
    )
    check('Telnet 行标注 protocol=telnet', telnetRow?.protocol === 'telnet', telnetRow?.protocol)
    check('同批次的 SSH 目标不受影响', telnetBatch.results[1]?.ok === true)

    // 大输出截断
    const big = await api(
      '/automation/batch',
      json('POST', {
        targets: [{ terminalId: hostTerminals[0].created.terminalId }],
        command: 'big 400',
        timeoutMs: 20_000,
      }),
    )
    const bigRow = big.results[0]
    check('400 KB 输出被截断', bigRow?.truncated === true, `len=${bigRow?.stdout?.length}`)
    check(
      '截断后不超过 256 KB',
      Buffer.byteLength(bigRow?.stdout ?? '') <= 256 * 1024 + 8,
      `${Buffer.byteLength(bigRow?.stdout ?? '')} 字节`,
    )
    check('截断不影响退出码', bigRow?.exitCode === 0 && bigRow?.ok === true)

    // 请求级边界
    const noTargets = await expectError('/automation/batch', json('POST', { targets: [], command: 'df' }))
    check('目标为空被拒(400)', noTargets?.status === 400)
    const noCommand = await expectError(
      '/automation/batch',
      json('POST', { targets: targets5.slice(0, 1), command: '   ' }),
    )
    check('命令为空被拒(400)', noCommand?.status === 400)
    const tooMany = await expectError(
      '/automation/batch',
      json('POST', {
        targets: Array.from({ length: 51 }, () => ({ terminalId: 'term_x' })),
        command: 'df',
      }),
    )
    check('目标数超过上限被拒(400)', tooMany?.status === 400, `${tooMany?.status}`)
    const badConcurrency = await expectError(
      '/automation/batch',
      json('POST', { targets: targets5.slice(0, 1), command: 'df', concurrency: 21 }),
    )
    check('并发度超过上限被拒(400)', badConcurrency?.status === 400)
    const noTargetField = await expectError(
      '/automation/batch',
      json('POST', { targets: [{ label: '只有名字' }], command: 'df' }),
    )
    check('目标既无 sessionId 也无 terminalId 被拒(400)', noTargetField?.status === 400)

    // 关闭会话后目标应立刻不可用，而不是产生悬挂结果
    await hostTerminals[4].close()
    await api(`/terminals/${hostTerminals[4].created.terminalId}`, { method: 'DELETE' })
    const afterClose = await api(
      '/automation/batch',
      json('POST', {
        targets: [{ terminalId: hostTerminals[4].created.terminalId }],
        command: 'df -h',
      }),
    )
    check(
      '已关闭的会话被识别为不可用',
      afterClose.results[0]?.ok === false,
      afterClose.results[0]?.error,
    )
  }

  /* ================================================================ */
  section('[N] 脚本运行记录与容量')
  /* ================================================================ */
  {
    const runs = await listRuns()
    check('运行记录按最新在前排序', runs.length > 1 && runs[0].startedAt >= runs[runs.length - 1].startedAt)
    check(
      '每条记录都带阶段与时间',
      runs.every((r) => typeof r.phase === 'string' && typeof r.startedAt === 'string'),
    )
    check(
      '日志条数有上限（防脚本刷爆内存）',
      runs.every((r) => r.logs.length <= 500),
      `max=${Math.max(...runs.map((r) => r.logs.length))}`,
    )

    const spam = await runInline(
      otherTerminal.created.terminalId,
      'for (let i = 0; i < 620; i += 1) log("line " + i);\nreturn "spam-done";',
      20_000,
    )
    check('大量日志的脚本正常结束', spam.record?.phase === 'done', spam.record?.phase)
    check('日志被截断并计数', (spam.record?.logs.length ?? 0) <= 500, `logs=${spam.record?.logs.length}`)
    check(
      '超出的日志被计入 droppedLogs',
      (spam.record?.droppedLogs ?? 0) > 0,
      String(spam.record?.droppedLogs),
    )
  }

  /* ================================================================ */
  section('[O] 服务端存活与错误边界')
  /* ================================================================ */
  {
    const health = await fetch(`${API}/api/health`)
    check('服务端健康检查通过', health.ok)

    const notFound = await expectError('/automation/triggers/trg_nope', json('PATCH', { name: 'x' }))
    check('更新不存在的规则返回 404', notFound?.status === 404)

    const delMissing = await expectError('/automation/scripts/scr_nope', { method: 'DELETE' })
    check('删除不存在的脚本返回 404', delMissing?.status === 404)

    const runMissing = await expectError(
      '/automation/scripts/run',
      json('POST', { terminalId: 'term_nope', code: 'return 1' }),
    )
    check('在不存在的终端上跑脚本返回 404', runMissing?.status === 404, `${runMissing?.status}`)

    const runMissingScript = await expectError(
      '/automation/scripts/run',
      json('POST', { terminalId: otherTerminal.created.terminalId, scriptId: 'scr_nope' }),
    )
    check('引用不存在的脚本返回 404', runMissingScript?.status === 404)

    const neither = await expectError(
      '/automation/scripts/run',
      json('POST', { terminalId: otherTerminal.created.terminalId }),
    )
    check('scriptId 与 code 都缺省被拒(400)', neither?.status === 400)

    check('服务端日志无未捕获异常', !/UnhandledPromiseRejection|Unhandled rejection/.test(server.getLog()))
  }

  /* ================================================================ */
  section('[P] 会话关闭后的清理')
  /* ================================================================ */
  {
    // 给主会话挂一条规则，然后关掉会话，再重建会话，确认引擎被正确重建
    const rule = await api(
      '/automation/triggers',
      json('POST', {
        name: '清理验证规则',
        pattern: '清理标记',
        matchMode: 'text',
        cooldownMs: 0,
        actions: [{ type: 'label', label: 'cleanup' }],
      }),
    )
    sendInput(mainTerminal, 'echo 清理标记\r')
    const first = await waitControl(mainTerminal, 'trigger', (m) => m.ruleId === rule.rule.id, 6000)
    check('关闭前规则正常工作', Boolean(first))
    if (!first) dumpTerminal(mainTerminal, 'P')

    await mainTerminal.close()
    await api(`/terminals/${mainTerminal.created.terminalId}`, { method: 'DELETE' })
    await sleep(300)

    const revived = await openTerminal({ config: sshConfig(MAIN.port), title: '重建会话' }, '重建')
    await waitText(revived, 'WebTerm 测试 SSH 服务端')
    sendInput(revived, 'echo 清理标记\r')
    const second = await waitControl(revived, 'trigger', (m) => m.ruleId === rule.rule.id, 6000)
    check('会话重建后规则重新生效', Boolean(second))

    const stats = (await api('/automation/triggers')).stats.find((s) => s.ruleId === rule.rule.id)
    check('命中统计跨会话累计', (stats?.hitCount ?? 0) >= 2, `hitCount=${stats?.hitCount}`)

    // 触发器规则在会话关闭后不应留下悬挂的延迟发送定时器
    const delayed = await api(
      '/automation/triggers',
      json('POST', {
        name: '延迟应答',
        pattern: '延迟标记',
        matchMode: 'text',
        cooldownMs: 0,
        actions: [{ type: 'send', text: 'pong', delayMs: 2000 }],
      }),
    )
    const doomed = await openTerminal({ config: sshConfig(MAIN.port), title: '即将关闭' }, '即将关闭')
    await waitText(doomed, 'WebTerm 测试 SSH 服务端')
    sendInput(doomed, 'echo 延迟标记\r')
    await waitUntil(() => controlOf(doomed, 'trigger').some((m) => m.ruleId === delayed.rule.id), 6000)
    await doomed.close()
    await api(`/terminals/${doomed.created.terminalId}`, { method: 'DELETE' })
    await sleep(2500)
    const health = await fetch(`${API}/api/health`)
    check('会话在延迟应答前关闭不会打挂服务', health.ok)
  }

  /* ================================================================ */
  console.log(`\n${'='.repeat(64)}`)
  console.log(`阶段 6 服务端端到端：${pass} 通过 / ${failures.length} 失败`)
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`)
    const serverLog = server.getLog().split('\n').slice(-25).join('\n')
    console.log(`\n--- 服务端日志尾部 ---\n${serverLog}`)
  }
  console.log('='.repeat(64))
  process.exitCode = failures.length === 0 ? 0 : 1
} finally {
  for (const collector of openTerminals) {
    try {
      collector.ws.close()
    } catch {
      /* 忽略 */
    }
  }
  cleanup()
}
