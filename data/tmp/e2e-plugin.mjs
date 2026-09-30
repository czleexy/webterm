/**
 * 阶段 9（插件机制）端到端验证。
 *
 * 自管一个 mock SSH 与一个服务端实例：
 *   2450  mock SSH（用来产生真实会话，验证会话事件扇出）
 *   8106  服务端（独立数据目录，不影响开发用的 8080）
 *
 * 验证重点（插件系统最容易翻车的地方）：
 *   1. 发现与容错：清单非法 / 入口抛错 / 注册项重名 / 目录里缺 plugin.json
 *      都只让**这一个**插件进入 error 并留下原因，其它插件照常
 *   2. 注册项齐全：触发器动作 / 命令 / 面板 / 事件订阅
 *   3. Host API：notify（走全局事件通道）、sessions.list/get/send、
 *      日志、配置（含类型转换与越界钳制）
 *   4. 配置**热更新**：改配置不重载插件，loadedAt 不变、插件内存状态不丢
 *   5. 启停：停用后注册项消失、调用返回 409、定时器与事件订阅真的停掉
 *   6. 会话事件扇出：opened / output / closed
 *   7. 触发器动作：命中真实规则 → 插件动作执行；插件缺失 / 插件被停用 /
 *      插件动作抛错三种失败都写进规则统计，且**不影响终端输出**
 *   8. 重启后启用状态从库里读回
 *
 * 运行：npm run build && node data/tmp/e2e-plugin.mjs
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
const WORK = path.join(ROOT, 'data/tmp/plugin-e2e')
const DATA_DIR = path.join(WORK, 'data')
const PLUGIN_DIR = path.join(DATA_DIR, 'plugins')
const PORT = 8106
const MOCK_SSH = 2450
const API = `http://127.0.0.1:${PORT}`
const WS_BASE = `ws://127.0.0.1:${PORT}`

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

/* ================================================================== */
/* 进程管理                                                            */
/* ================================================================== */

const children = []

function startMock() {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: {
      ...process.env,
      MOCK_PORT: String(MOCK_SSH),
      MOCK_SFTP_ROOT: path.join(WORK, 'mock-sftp'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.env.MOCK_DEBUG && process.stdout.write(`  ${d}`))
  child.stderr.on('data', (d) => process.env.MOCK_DEBUG && process.stdout.write(`  ! ${d}`))
  children.push(child)
  return child
}

function startServer() {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dist/index.js`], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WEBTERM_PORT: String(PORT),
      WEBTERM_DATA_DIR: DATA_DIR,
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

async function waitHealthy(timeoutMs = 25_000) {
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

async function stopServer(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return 0
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill(signal)
  const ok = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!ok) child.kill('SIGKILL')
  return ok ? 1 : -1
}

/* ================================================================== */
/* REST 工具                                                           */
/* ================================================================== */

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

async function waitFor(fn, timeoutMs = 6000, intervalMs = 100) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) return undefined
    await sleep(intervalMs)
  }
}

const pluginBy = (list, id) => list.plugins.find((p) => p.id === id)
const pluginLogs = (info) => info.logs.map((l) => l.message).join('\n')

/* ================================================================== */
/* 全局事件通道（/ws/events）                                           */
/* ================================================================== */

function openEventChannel() {
  const ws = new WebSocket(`${WS_BASE}/ws/events`)
  const state = { messages: [], errors: [] }
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    try {
      state.messages.push(JSON.parse(data.toString()))
    } catch {
      /* 忽略 */
    }
  })
  ws.on('error', (err) => state.errors.push(err))
  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('事件通道连接超时')), 10_000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  state.notifications = () => state.messages.filter((m) => m.t === 'plugin-notify')
  /** 等一条满足条件的通知 */
  state.waitNotify = (predicate, timeoutMs = 8000) =>
    waitFor(() => state.notifications().find(predicate), timeoutMs)
  state.close = () => new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve()
    ws.once('close', () => resolve())
    ws.close()
  })
  return state
}

/* ================================================================== */
/* 终端收集器                                                          */
/* ================================================================== */

async function openTerminal(config) {
  const created = await api('/terminals', json('POST', { config, title: 'PluginE2E' }))
  const ws = new WebSocket(`${WS_BASE}${created.wsPath}?token=${encodeURIComponent(created.attachToken)}`)
  const collector = {
    created,
    ws,
    chunks: [],
    control: [],
    unacked: 0,
    get text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
  }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      collector.chunks.push(Buffer.from(data))
      collector.unacked += data.length
      if (collector.unacked >= 32 * 1024) {
        ws.send(JSON.stringify({ t: 'ack', bytes: collector.unacked }))
        collector.unacked = 0
      }
    } else {
      try {
        collector.control.push(JSON.parse(data.toString()))
      } catch {
        /* 忽略 */
      }
    }
  })
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
  await waitFor(() => collector.control.some((m) => m.t === 'ready'), 8000)
  return collector
}

const sendInput = (collector, text) => collector.ws.send(Buffer.from(text))

async function closeTerminal(collector) {
  await new Promise((resolve) => {
    if (collector.ws.readyState === collector.ws.CLOSED) return resolve()
    collector.ws.once('close', () => resolve())
    collector.ws.close()
  })
  await api(`/terminals/${collector.created.terminalId}`, { method: 'DELETE' }).catch(() => {})
}

/** 等待某个正则/字面量出现在终端输出里 */
const waitText = (collector, needle, timeoutMs = 8000) =>
  waitFor(() => collector.text.includes(needle), timeoutMs)

/* ================================================================== */
/* 测试夹具：往插件目录里放几个插件                                     */
/* ================================================================== */

const HELLO_MANIFEST = {
  id: 'hello-plugin',
  name: 'Hello 插件',
  version: '2.1.0',
  description: '端到端测试用的合成插件：把宿主 API 的每个入口都走一遍。',
  author: 'e2e',
  apiVersion: 1,
  main: 'main.js',
  permissions: ['session:read', 'session:write', 'notify'],
  config: [
    { key: 'greeting', label: '问候语', type: 'string', default: '你好' },
    { key: 'threshold', label: '阈值', type: 'number', default: 10, min: 1, max: 100 },
    { key: 'loud', label: '大声点', type: 'boolean', default: false },
  ],
}

const HELLO_ENTRY = `/**
 * 合成测试插件：每个宿主 API 都用到一次，并把计数暴露在面板上供断言。
 */
const state = { opened: 0, closed: 0, outputChars: 0, pings: 0, params: '(未收到)', lastClosed: '' }
let tick = 0

host.on('session:opened', (e) => { state.opened += 1 })
host.on('session:closed', (e) => { state.closed += 1; state.lastClosed = e.title + '/' + e.reason })
host.on('session:output', (e) => {
  state.outputChars += e.text.length
  if (e.text.indexOf('PING-ME') >= 0) {
    state.pings += 1
    host.notify('检测到 PING-ME', '第 ' + state.pings + ' 次')
  }
})

// 定时器：停用插件之后必须不再响 —— 这是「资源真的被回收」的判据
setInterval(() => {
  tick += 1
  host.notify('定时器滴答', 'tick=' + tick)
}, 400)

host.registerTriggerAction({ id: 'echo-params', label: '回显参数（测试用）', description: '把动作参数写到面板与日志' }, (ctx) => {
  state.params = ctx.params || '(空)'
  ctx.log('info', '收到参数：' + state.params + ' / 命中行：' + ctx.line)
  ctx.send('echo plugin-action-ok\\r')
})

host.registerTriggerAction({ id: 'explode', label: '故意抛错（测试用）' }, () => {
  throw new Error('插件动作炸了')
})

host.registerTriggerAction({ id: 'async-explode', label: '异步抛错（测试用）' }, async () => {
  await new Promise((r) => setTimeout(r, 20))
  throw new Error('插件异步动作炸了')
})

host.registerCommand({ id: 'hello', label: '打招呼' }, () => {
  const loud = host.getConfig('loud', false)
  return (loud ? '!! ' : '') + host.config.greeting + '，阈值 ' + host.getConfig('threshold', 0)
})

host.registerCommand({ id: 'boom', label: '抛错' }, () => {
  throw new Error('命令炸了')
})

host.registerCommand({ id: 'notify-me', label: '发个通知' }, () => {
  host.notify('来自 Hello 插件', '手动触发的通知', 'warn')
  return '已发送'
})

host.registerPanel({ id: 'stats', title: '插件状态' }, () => ({
  columns: ['指标', '值'],
  rows: [
    ['session:opened', String(state.opened)],
    ['session:closed', String(state.closed)],
    ['output 字符数', String(state.outputChars)],
    ['PING-ME 次数', String(state.pings)],
    ['最近关闭', state.lastClosed || '(无)'],
  ],
  note: 'params=' + state.params,
}))

host.registerPanel({ id: 'big', title: '超量数据' }, () => ({
  columns: ['i'],
  rows: Array.from({ length: 900 }, (_, i) => [String(i)]),
}))

host.registerPanel({ id: 'boom', title: '取数会失败的面板' }, () => {
  throw new Error('面板取数失败')
})

host.log('info', 'Hello 插件已就绪')
`

function writeFixtures() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })

  // 1. 真实示例插件（从仓库里拷，验证「示例插件能被加载」这条验收）
  fs.cpSync(path.join(ROOT, 'data/plugins/heartbeat-monitor'), path.join(PLUGIN_DIR, 'heartbeat-monitor'), {
    recursive: true,
  })

  // 2. 合成插件：宿主 API 全量走一遍
  const hello = path.join(PLUGIN_DIR, 'hello-plugin')
  fs.mkdirSync(hello, { recursive: true })
  fs.writeFileSync(path.join(hello, 'plugin.json'), JSON.stringify(HELLO_MANIFEST, null, 2))
  fs.writeFileSync(path.join(hello, 'main.js'), HELLO_ENTRY)

  // 3. 清单 apiVersion 不匹配
  const badApi = path.join(PLUGIN_DIR, 'bad-apiversion')
  fs.mkdirSync(badApi, { recursive: true })
  fs.writeFileSync(
    path.join(badApi, 'plugin.json'),
    JSON.stringify({ id: 'bad-apiversion', name: '版本不符', version: '1.0.0', apiVersion: 99 }),
  )

  // 4. 清单 JSON 语法错误
  const badJson = path.join(PLUGIN_DIR, 'bad-json')
  fs.mkdirSync(badJson, { recursive: true })
  fs.writeFileSync(path.join(badJson, 'plugin.json'), '{ "id": "bad-json", }')

  // 5. 入口抛错
  const broken = path.join(PLUGIN_DIR, 'broken-entry')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(
    path.join(broken, 'plugin.json'),
    JSON.stringify({ id: 'broken-entry', name: '入口抛错', version: '1.0.0', apiVersion: 1 }),
  )
  fs.writeFileSync(path.join(broken, 'index.js'), 'throw new Error("入口第一行就炸了")\n')

  // 6. 注册项重名
  const dup = path.join(PLUGIN_DIR, 'duplicate-ids')
  fs.mkdirSync(dup, { recursive: true })
  fs.writeFileSync(
    path.join(dup, 'plugin.json'),
    JSON.stringify({ id: 'duplicate-ids', name: '重名注册', version: '1.0.0', apiVersion: 1 }),
  )
  fs.writeFileSync(
    path.join(dup, 'index.js'),
    'host.registerCommand({ id: "dup", label: "A" }, () => {})\n' +
      'host.registerCommand({ id: "dup", label: "B" }, () => {})\n',
  )

  // 7. 目录里没有 plugin.json
  fs.mkdirSync(path.join(PLUGIN_DIR, 'no-manifest'), { recursive: true })

  // 8. main 指向目录外（路径安全）
  const escape = path.join(PLUGIN_DIR, 'escape-main')
  fs.mkdirSync(escape, { recursive: true })
  fs.writeFileSync(
    path.join(escape, 'plugin.json'),
    JSON.stringify({ id: 'escape-main', name: '越界入口', version: '1.0.0', apiVersion: 1, main: '../../outside.js' }),
  )
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

const sshConfig = {
  protocol: 'ssh',
  target: {
    host: '127.0.0.1',
    port: MOCK_SSH,
    username: 'demo',
    authMethod: 'password',
    password: 'demo',
  },
  terminal: { cols: 100, rows: 30, encoding: 'utf8', term: 'xterm-256color' },
  legacyCompat: 'auto',
}

let server = null
let events = null

try {
  writeFixtures()
  startMock()
  await sleep(500)
  server = startServer()
  await waitHealthy()

  events = openEventChannel()
  await events.ready

  /* ---------------- A. 发现与容错 ---------------- */
  console.log('\n[A] 插件发现与容错')

  let list = await api('/plugins')
  const ids = list.plugins.map((p) => p.id).sort()
  check(
    '扫描出全部 8 个插件目录',
    ids.length === 8,
    ids.join(','),
  )
  check('插件根目录在响应中返回', list.dir === PLUGIN_DIR, list.dir)
  check('API 版本为 1', list.apiVersion === 1)

  const heartbeat = pluginBy(list, 'heartbeat-monitor')
  check('示例插件 heartbeat-monitor 加载成功', heartbeat?.state === 'ready', heartbeat?.state)
  check(
    '示例插件清单字段完整',
    heartbeat?.name === '心跳监视器' && heartbeat?.version === '1.0.0' && heartbeat?.author === 'WebTerm 示例',
  )
  check('示例插件声明 6 个配置项', heartbeat?.configFields.length === 6, `${heartbeat?.configFields.length}`)
  check(
    '配置生效值 = 清单默认值',
    heartbeat?.config.intervalMs === 60000 && heartbeat?.config.notifyOnRecover === true,
    JSON.stringify(heartbeat?.config),
  )

  const badApi = pluginBy(list, 'bad-apiversion')
  check('apiVersion 不符 → error', badApi?.state === 'error')
  check('apiVersion 错误原因可读', /apiVersion/.test(badApi?.error ?? ''), (badApi?.error ?? '').slice(0, 60))

  const badJson = pluginBy(list, 'bad-json')
  check('清单 JSON 非法 → error', badJson?.state === 'error')
  check('JSON 错误提示指向常见原因', /JSON/.test(badJson?.error ?? ''))

  const brokenEntry = pluginBy(list, 'broken-entry')
  check('入口抛错 → error', brokenEntry?.state === 'error')
  check('入口错误带上原始信息', /入口第一行就炸了/.test(brokenEntry?.error ?? ''))

  const dupIds = pluginBy(list, 'duplicate-ids')
  check('注册项重名 → error', dupIds?.state === 'error')
  check('重名错误指明是哪个 id', /dup/.test(dupIds?.error ?? ''))

  const noManifest = pluginBy(list, 'no-manifest')
  check('目录缺 plugin.json → error（不是被静默忽略）', noManifest?.state === 'error')
  check('缺清单提示给出示例', /plugin\.json/.test(noManifest?.error ?? ''))

  const escapeMain = pluginBy(list, 'escape-main')
  check('main 指向目录外被拒', escapeMain?.state === 'error' && /插件目录内/.test(escapeMain?.error ?? ''))

  check('坏插件不影响好插件（示例插件仍 ready）', pluginBy(list, 'heartbeat-monitor')?.state === 'ready')

  /* ---------------- B. 注册项 ---------------- */
  console.log('\n[B] 注册项')

  const hello = pluginBy(list, 'hello-plugin')
  check('合成插件 ready', hello?.state === 'ready', hello?.error ?? '')
  check(
    '触发器动作注册齐全（含 label 与 description）',
    hello?.triggerActions.length === 3 &&
      hello.triggerActions.some((a) => a.id === 'echo-params' && a.label.includes('回显参数')),
    JSON.stringify(hello?.triggerActions.map((a) => a.id)),
  )
  check('命令注册齐全', hello?.commands.length === 3, JSON.stringify(hello?.commands.map((c) => c.id)))
  check('面板注册齐全', hello?.panels.length === 3, JSON.stringify(hello?.panels.map((p) => p.id)))
  check(
    '事件订阅齐全',
    hello?.subscriptions.length === 3 && hello.subscriptions.includes('session:output'),
    JSON.stringify(hello?.subscriptions),
  )
  check(
    '示例插件注册了 1 个触发器动作供下拉使用',
    heartbeat?.triggerActions.length === 1 && heartbeat.triggerActions[0].id === 'mark-alive',
  )
  check('错误插件不暴露任何注册项', (badJson?.triggerActions.length ?? -1) === 0 && (badJson?.panels.length ?? -1) === 0)
  check('插件加载日志可见', /Hello 插件已就绪/.test(pluginLogs(hello)))

  /* ---------------- C. REST 行为 ---------------- */
  console.log('\n[C] REST 行为与配置')

  const single = await api('/plugins/hello-plugin')
  check('单个插件详情与列表一致', single.plugin.id === 'hello-plugin' && single.plugin.state === 'ready')

  const loadedAtBefore = hello.loadedAt

  // 配置热更新：类型按清单声明转换，"20" → 20、"true" → true
  const patched = await api('/plugins/hello-plugin', json('PATCH', { config: { greeting: '嗨', threshold: '20', loud: 'true' } }))
  check('配置字符串被转成 number', patched.plugin.config.threshold === 20, String(patched.plugin.config.threshold))
  check('配置字符串被转成 boolean', patched.plugin.config.loud === true, String(patched.plugin.config.loud))
  check('配置热更新**不重载**插件（loadedAt 不变、内存状态保留）', patched.plugin.loadedAt === loadedAtBefore)

  const greet = await api('/plugins/hello-plugin/commands/hello', { method: 'POST' })
  check('命令读到的就是新配置（热更新真的进了沙箱）', /嗨/.test(greet.message ?? '') && /20/.test(greet.message ?? ''), greet.message)
  check('boolean 配置生效', /!!/.test(greet.message ?? ''), greet.message)

  // 越界值在**落库前**就被钳到范围内（不是读的时候才钳）
  const clamped = await api('/plugins/hello-plugin', json('PATCH', { config: { greeting: '嗨', threshold: '9999', loud: 'true' } }))
  check('配置越界被钳到 max', clamped.plugin.config.threshold === 100, String(clamped.plugin.config.threshold))
  const upper = await api('/plugins/hello-plugin/commands/hello', { method: 'POST' })
  check('越界钳制对插件生效', /阈值 100/.test(upper.message ?? ''), upper.message)

  // 整体替换语义：界面提交的是完整表单，没提交的项回到清单默认值
  const replaced = await api('/plugins/hello-plugin', json('PATCH', { config: { threshold: '50' } }))
  check(
    '配置提交是整体替换（未提交项回到清单默认值）',
    replaced.plugin.config.greeting === '你好' && replaced.plugin.config.loud === false && replaced.plugin.config.threshold === 50,
    JSON.stringify(replaced.plugin.config),
  )
  const restored = await api('/plugins/hello-plugin', json('PATCH', { config: { greeting: '嗨', threshold: '50', loud: 'true' } }))
  check('恢复成完整配置', restored.plugin.config.greeting === '嗨' && restored.plugin.config.threshold === 50)

  const badConfig = await expectError('/plugins/hello-plugin', json('PATCH', { config: { x: { nested: 1 } } }))
  check('配置值给了对象 → 400', badConfig?.status === 400, `${badConfig?.status}`)

  const noReloadAfterBad = await api('/plugins/hello-plugin')
  check('非法配置被拒后原配置不受影响', noReloadAfterBad.plugin.config.greeting === '嗨')

  const emptyPatch = await expectError('/plugins/hello-plugin', json('PATCH', {}))
  check('空 PATCH → 400', emptyPatch?.status === 400, `${emptyPatch?.status}`)

  const unknownPlugin = await expectError('/plugins/nope')
  check('不存在的插件 → 404', unknownPlugin?.status === 404, `${unknownPlugin?.status}`)

  const unknownCommand = await expectError('/plugins/hello-plugin/commands/nope', { method: 'POST' })
  check('不存在的命令 → 404', unknownCommand?.status === 404, `${unknownCommand?.status}`)

  const unknownPanel = await expectError('/plugins/hello-plugin/panels/nope')
  check('不存在的面板 → 404', unknownPanel?.status === 404, `${unknownPanel?.status}`)

  const boomCommand = await api('/plugins/hello-plugin/commands/boom', { method: 'POST' })
  check('命令抛错 → 200 + ok:false（是业务结果不是接口错误）', boomCommand.ok === false && /命令炸了/.test(boomCommand.message ?? ''), JSON.stringify(boomCommand))

  const notifyCommand = await api('/plugins/hello-plugin/commands/notify-me', { method: 'POST' })
  check('命令返回值作为结果提示', notifyCommand.ok === true && notifyCommand.message === '已发送', notifyCommand.message)
  const notified = await events.waitNotify((m) => m.title === '来自 Hello 插件')
  check('host.notify 经全局事件通道送达', notified?.level === 'warn' && notified.pluginName === 'Hello 插件', JSON.stringify(notified))
  check('通知带上来源插件 id', notified?.pluginId === 'hello-plugin')

  const stats = await api('/plugins/hello-plugin/panels/stats')
  check('面板返回表格数据', stats.panel.columns.length === 2 && stats.panel.rows.length === 5)
  check('面板 note 由插件提供', /params=/.test(stats.panel.note ?? ''), stats.panel.note)

  const big = await api('/plugins/hello-plugin/panels/big')
  check('超量面板被截断到 500 行并给出提示', big.panel.rows.length === 500 && /截断/.test(big.panel.note ?? ''), big.panel.note)

  const boomPanel = await api('/plugins/hello-plugin/panels/boom')
  check('面板取数失败 → 空表 + 原因（不是 500）', boomPanel.panel.rows.length === 0 && /面板取数失败/.test(boomPanel.panel.note ?? ''), boomPanel.panel.note)

  /* ---------------- D. 会话事件扇出 ---------------- */
  console.log('\n[D] 会话事件扇出')

  const terminal = await openTerminal(sshConfig)
  await waitFor(() => terminal.text.includes('MOCK-SHELL-READY'), 8000)

  const afterOpen = await waitFor(async () => {
    const panel = await api('/plugins/hello-plugin/panels/stats')
    return Number(panel.panel.rows[0][1]) >= 1 ? panel : undefined
  }, 6000)
  check('session:opened 扇出到插件（面板计数 ≥ 1）', afterOpen !== undefined, afterOpen ? afterOpen.panel.rows[0].join('=') : '未收到')

  const heartbeatAfterOpen = (await api('/plugins/heartbeat-monitor')).plugin
  check(
    '示例插件开始监视新会话',
    /开始监视/.test(pluginLogs(heartbeatAfterOpen)),
    pluginLogs(heartbeatAfterOpen).split('\n').filter((l) => l.includes('开始监视'))[0] ?? '',
  )

  sendInput(terminal, 'echo PING-ME\r')
  const pingNotify = await events.waitNotify((m) => m.title === '检测到 PING-ME', 8000)
  check('session:output 扇出到插件（输出里出现关键字即通知）', pingNotify !== undefined, JSON.stringify(pingNotify?.body))

  const outputStats = await api('/plugins/hello-plugin/panels/stats')
  const outputChars = Number(outputStats.panel.rows[2][1])
  check('面板反映输出字符数在增长', outputChars > 0, String(outputChars))

  /* ---------------- E. 触发器动作 ---------------- */
  console.log('\n[E] 触发器动作')

  await api('/automation/triggers', json('POST', {
    name: '心跳确认',
    enabled: true,
    scope: 'global',
    pattern: 'HEARTBEAT-OK',
    matchMode: 'text',
    actions: [{ type: 'plugin', pluginId: 'heartbeat-monitor', actionId: 'mark-alive', label: '心跳确认' }],
  }))
  await api('/automation/triggers', json('POST', {
    name: '插件参数回显',
    enabled: true,
    scope: 'global',
    pattern: 'PARAM-TEST',
    matchMode: 'text',
    actions: [{ type: 'plugin', pluginId: 'hello-plugin', actionId: 'echo-params', label: '回显参数（测试用）', params: 'P=42' }],
  }))

  sendInput(terminal, 'echo HEARTBEAT-OK\r')
  const markedAlive = await waitFor(async () => {
    const info = (await api('/plugins/heartbeat-monitor')).plugin
    return /被规则「心跳确认」标记为存活/.test(pluginLogs(info)) ? info : undefined
  }, 8000)
  check('规则命中 → 插件动作执行（插件侧日志留痕）', markedAlive !== undefined)

  const triggerUi = await waitFor(
    () => terminal.control.filter((m) => m.t === 'trigger').find((m) => m.performed?.some((p) => p.includes('插件'))),
    6000,
  )
  check('命中回执里写明「已交给插件」', triggerUi !== undefined, triggerUi?.performed?.join(' | '))

  sendInput(terminal, 'echo PARAM-TEST\r')
  const paramPanel = await waitFor(async () => {
    const panel = await api('/plugins/hello-plugin/panels/stats')
    return /params=P=42/.test(panel.panel.note ?? '') ? panel : undefined
  }, 8000)
  check('动作参数透传到插件', paramPanel !== undefined, paramPanel?.panel.note)
  check('插件通过 ctx.send 写回了终端', (await waitText(terminal, 'plugin-action-ok', 6000)) !== undefined)

  // 三种失败：插件不存在 / 插件被停用 / 动作抛错
  await api('/automation/triggers', json('POST', {
    name: '引用不存在的插件',
    enabled: true,
    scope: 'global',
    pattern: 'MISSING-PLUGIN',
    matchMode: 'text',
    actions: [{ type: 'plugin', pluginId: 'ghost-plugin', actionId: 'x' }],
  }))
  await api('/automation/triggers', json('POST', {
    name: '引用不存在的动作',
    enabled: true,
    scope: 'global',
    pattern: 'MISSING-ACTION',
    matchMode: 'text',
    actions: [{ type: 'plugin', pluginId: 'hello-plugin', actionId: 'ghost-action' }],
  }))
  await api('/automation/triggers', json('POST', {
    name: '插件动作抛错',
    enabled: true,
    scope: 'global',
    pattern: 'PLUGIN-BOOM',
    matchMode: 'text',
    actions: [{ type: 'plugin', pluginId: 'hello-plugin', actionId: 'explode', label: '故意抛错' }],
  }))
  await api('/automation/triggers', json('POST', {
    name: '插件异步动作抛错',
    enabled: true,
    scope: 'global',
    pattern: 'PLUGIN-ASYNC-BOOM',
    matchMode: 'text',
    actions: [{ type: 'plugin', pluginId: 'hello-plugin', actionId: 'async-explode', label: '异步抛错' }],
  }))

  const beforeErrorRun = terminal.text.length
  sendInput(terminal, 'echo MISSING-PLUGIN\r')
  sendInput(terminal, 'echo MISSING-ACTION\r')
  sendInput(terminal, 'echo PLUGIN-BOOM\r')
  sendInput(terminal, 'echo PLUGIN-ASYNC-BOOM\r')
  await waitText(terminal, 'PLUGIN-ASYNC-BOOM', 8000)

  const rules = await api('/automation/triggers')
  const ruleByName = (name) => rules.rules.find((r) => r.name === name)
  const statOf = (rule) => rules.stats.find((s) => s.ruleId === rule.id)
  check('引用不存在的插件 → 规则统计写明原因', /插件不存在/.test(statOf(ruleByName('引用不存在的插件'))?.lastError ?? ''), statOf(ruleByName('引用不存在的插件'))?.lastError)
  check('引用不存在的动作 → 规则统计写明原因', /插件动作不存在/.test(statOf(ruleByName('引用不存在的动作'))?.lastError ?? ''), statOf(ruleByName('引用不存在的动作'))?.lastError)
  check('插件动作同步抛错 → 规则统计写明原因', /插件动作炸了/.test(statOf(ruleByName('插件动作抛错'))?.lastError ?? ''), statOf(ruleByName('插件动作抛错'))?.lastError)

  const asyncError = await waitFor(async () => {
    const info = (await api('/plugins/hello-plugin')).plugin
    return /异步动作炸了/.test(pluginLogs(info)) ? info : undefined
  }, 6000)
  check('插件异步动作抛错不吞掉（进插件日志）', asyncError !== undefined, pluginLogs(asyncError ?? { logs: [] }).split('\n').find((l) => l.includes('异步动作')))

  check('插件失败不影响终端输出', terminal.text.length > beforeErrorRun + 20, `${beforeErrorRun} → ${terminal.text.length}`)

  const asyncNotified = await events.waitNotify((m) => /异步抛错/.test(m.title), 6000)
  check('插件异步失败也发通知（用户不盯日志也能知道）', asyncNotified !== undefined, asyncNotified?.title)

  /* ---------------- F. 示例插件的心跳闭环 ---------------- */
  console.log('\n[F] 示例插件心跳闭环')

  await api('/plugins/heartbeat-monitor', json('PATCH', {
    config: {
      intervalMs: '5000',
      timeoutMs: '10000',
      failureThreshold: '1',
      heartbeatCommand: 'echo SILENT-NOW',
      responseMarker: 'HEARTBEAT-OK',
    },
  }))
  await api('/plugins/heartbeat-monitor/commands/reset', { method: 'POST' })

  const alert = await events.waitNotify((m) => /疑似失联/.test(m.title), 20_000)
  check('长时间收不到心跳 → 告警（示例插件的核心能力）', alert !== undefined, JSON.stringify(alert?.body))
  check('告警通知带 warn 级别', alert?.level === 'warn', alert?.level)

  const alertRow = await waitFor(async () => {
    const panel = await api('/plugins/heartbeat-monitor/panels/sessions')
    return panel.panel.rows.find((r) => r[6] === '已告警')
  }, 6000)
  check('面板上该会话标记为「已告警」', alertRow !== undefined, alertRow?.join(' | '))

  sendInput(terminal, 'echo HEARTBEAT-OK\r')
  const recovered = await events.waitNotify((m) => /已恢复/.test(m.title), 10_000)
  check('心跳恢复后发出「已恢复」通知', recovered !== undefined, JSON.stringify(recovered?.body))

  const aliveRow = await waitFor(async () => {
    const panel = await api('/plugins/heartbeat-monitor/panels/sessions')
    return panel.panel.rows.find((r) => r[6] === '正常')
  }, 8000)
  check(
    '恢复后未回应次数清零、状态回到正常',
    aliveRow !== undefined && aliveRow[4] === '0',
    aliveRow?.join(' | '),
  )
  check(
    '面板记录了「最后一次回应来源」便于排障',
    /触发器确认|收到心跳回应/.test(aliveRow?.[3] ?? ''),
    aliveRow?.[3],
  )

  /* ---------------- G. 停用与资源回收 ---------------- */
  console.log('\n[G] 停用与资源回收')

  await api('/plugins/hello-plugin', json('PATCH', { enabled: false }))
  const disabled = await api('/plugins/hello-plugin')
  check('停用后 state=disabled', disabled.plugin.state === 'disabled')
  check('停用后注册项从接口消失（界面下拉里也就没有了）', disabled.plugin.triggerActions.length === 0 && disabled.plugin.commands.length === 0)

  const disabledCommand = await expectError('/plugins/hello-plugin/commands/hello', { method: 'POST' })
  check('停用后调用命令 → 409', disabledCommand?.status === 409, `${disabledCommand?.status}`)
  const disabledPanel = await expectError('/plugins/hello-plugin/panels/stats')
  check('停用后取面板 → 409', disabledPanel?.status === 409, `${disabledPanel?.status}`)

  // 定时器与输出订阅是否真的停掉：先让计数稳定下来，再观察是否还有新通知
  await sleep(1200)
  const ticksBefore = events.notifications().filter((m) => m.title === '定时器滴答').length
  const pingsBefore = events.notifications().filter((m) => m.title === '检测到 PING-ME').length
  sendInput(terminal, 'echo PING-ME-AGAIN\r')
  await sleep(1600)
  check(
    '停用后插件的 setInterval 真的停了',
    events.notifications().filter((m) => m.title === '定时器滴答').length === ticksBefore,
    `${ticksBefore} → ${events.notifications().filter((m) => m.title === '定时器滴答').length}`,
  )
  check(
    '停用后输出订阅真的退掉了（关键：它必须查不到 PING-ME 了）',
    events.notifications().filter((m) => m.title === '检测到 PING-ME').length === pingsBefore,
    `${pingsBefore} → ${events.notifications().filter((m) => m.title === '检测到 PING-ME').length}`,
  )

  // 停用后引用它的规则会明确报「不可用」
  sendInput(terminal, 'echo PARAM-TEST\r')
  const unavailable = await waitFor(async () => {
    const fresh = await api('/automation/triggers')
    const rule = fresh.rules.find((r) => r.name === '插件参数回显')
    const st = fresh.stats.find((s) => s.ruleId === rule.id)
    return /不可用/.test(st?.lastError ?? '') ? st : undefined
  }, 6000)
  check('插件被停用后，引用它的规则报「不可用」', unavailable !== undefined, unavailable?.lastError)

  await api('/plugins/hello-plugin', json('PATCH', { enabled: true }))
  const reEnabled = await api('/plugins/hello-plugin')
  check('重新启用后恢复 ready', reEnabled.plugin.state === 'ready')
  check('重新启用后配置保留（用户改过的值不丢）', reEnabled.plugin.config.greeting === '嗨', JSON.stringify(reEnabled.plugin.config))

  /* ---------------- H. 重载与会话关闭 ---------------- */
  console.log('\n[H] 重载与会话关闭')

  const beforeReload = (await api('/plugins/hello-plugin')).plugin
  // 先制造一份可观测的内存状态：清空与否要看得到
  sendInput(terminal, 'echo RELOAD-PROBE\r')
  const statsBeforeReload = await waitFor(async () => {
    const panel = await api('/plugins/hello-plugin/panels/stats')
    return Number(panel.panel.rows[2][1]) > 0 ? panel : undefined
  }, 6000)
  check('重载前插件确实持有内存状态', statsBeforeReload !== undefined, statsBeforeReload?.panel.rows[2].join('='))
  await sleep(1100) // 让文件 mtime 明显不同
  fs.appendFileSync(path.join(PLUGIN_DIR, 'hello-plugin', 'main.js'), '\nhost.log("info", "重载后追加的一行")\n')
  const reloaded = await api('/plugins/hello-plugin/reload', { method: 'POST' })
  check('重载后 loadedAt 更新', reloaded.plugin.loadedAt !== beforeReload.loadedAt)
  check('重载后读到新代码', /重载后追加的一行/.test(pluginLogs(reloaded.plugin)))

  const statsAfterReload = await api('/plugins/hello-plugin/panels/stats')
  check(
    '重载清空插件内存状态（输出计数归零）',
    statsAfterReload.panel.rows[2][1] === '0' && statsAfterReload.panel.note === 'params=(未收到)',
    statsAfterReload.panel.rows[2].join('=') + ' / ' + statsAfterReload.panel.note,
  )
  check(
    '重载后不补发历史事件（会话早已开着，session:opened 仍是 0）',
    statsAfterReload.panel.rows[0][1] === '0',
    statsAfterReload.panel.rows[0].join('='),
  )

  // 重载后事件订阅与输出订阅必须仍然有效（历史上这里漏过一次同步）
  const secondTerminal = await openTerminal(sshConfig)
  await waitText(secondTerminal, 'MOCK-SHELL-READY', 8000)
  const reopened = await waitFor(async () => {
    const panel = await api('/plugins/hello-plugin/panels/stats')
    return panel.panel.rows[0][1] === '1' ? panel : undefined
  }, 6000)
  check('重载后新会话仍然扇出到插件', reopened !== undefined, reopened?.panel.rows[0].join('='))

  const pingsBeforeReloadOutput = events.notifications().filter((m) => m.title === '检测到 PING-ME').length
  sendInput(secondTerminal, 'echo PING-ME\r')
  const pingAfterReload = await waitFor(
    () => events.notifications().filter((m) => m.title === '检测到 PING-ME').length > pingsBeforeReloadOutput,
    6000,
  )
  check('重载后输出订阅仍然有效（这是最容易漏的一处）', pingAfterReload !== undefined)

  await closeTerminal(secondTerminal)
  await closeTerminal(terminal)
  const closedSeen = await waitFor(async () => {
    const info = (await api('/plugins/heartbeat-monitor')).plugin
    return /停止监视/.test(pluginLogs(info)) ? info : undefined
  }, 8000)
  check('session:closed 扇出到插件', closedSeen !== undefined)

  const helloClosed = await waitFor(async () => {
    const panel = await api('/plugins/hello-plugin/panels/stats')
    return panel.panel.rows[1][1] === '2' ? panel : undefined
  }, 6000)
  check('关闭计数进面板', helloClosed !== undefined, helloClosed?.panel.rows[1].join('='))

  const rescanList = await api('/plugins/rescan', { method: 'POST' })
  check('rescan 不报错且仍在扫描 8 个目录', rescanList.plugins.length === 8, String(rescanList.plugins.length))

  /* ---------------- I. 重启后状态持久化 ---------------- */
  console.log('\n[I] 重启后状态持久化')

  await api('/plugins/hello-plugin', json('PATCH', { enabled: false }))
  const exitOk = await stopServer(server)
  check('SIGTERM 后服务端在 5 秒内退出（插件定时器不阻塞退出）', exitOk === 1, `exit=${exitOk}`)
  server = startServer()
  await waitHealthy()

  const afterRestart = await api('/plugins')
  const helloAfter = pluginBy(afterRestart, 'hello-plugin')
  const heartbeatAfter = pluginBy(afterRestart, 'heartbeat-monitor')
  check('重启后停用状态被读回（本插件仍是 disabled）', helloAfter?.state === 'disabled', helloAfter?.state)
  check('重启后未改动的插件照常加载', heartbeatAfter?.state === 'ready', heartbeatAfter?.state)
  check('重启后配置覆盖值仍保留', helloAfter?.config.greeting === '嗨', JSON.stringify(helloAfter?.config))
  check('重启后错误插件仍然如实报错（不因缓存而假装正常）', pluginBy(afterRestart, 'bad-json')?.state === 'error')
} finally {
  if (events) await events.close().catch(() => {})
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }
  }
}

console.log(`\n===== 阶段 9 插件端到端：${pass} 通过 / ${failures.length} 失败 =====`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
