/**
 * 阶段 5 浏览器端到端：在真实 UI 里把 -L / -R / -D 三条链路全部走通。
 *
 * 与服务端 E2E 的分工：
 *   服务端 E2E 证明「隧道本身对」（协议、计数、背压、生命周期）；
 *   本脚本证明「用户能用」—— 从界面上点出来的隧道，确实能被本机的
 *   普通 TCP 客户端 / SOCKS5 客户端连上，且关掉会话后端口立刻消失。
 *
 * 自管两个业务 mock + 一个 mock SSH + 一个生产模式服务端：
 *   2423  mock SSH（同时充当「远端」：接受 tcpip-forward，与真实 sshd 一致）
 *   2471  带问候语的回显服务（本地转发的目标）
 *   2472  裸回显服务（远程转发 / SOCKS5 的目标，便于精确比对字节）
 *   8101  服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 关键断言用的是**外部真实客户端**，而不是读接口返回值：
 *   隧道「显示为运行中」不等于「流量真的通」。只有外部客户端连上去
 *   拿到业务响应，才证明 -L / -R / -D 真的成立。
 *
 * 运行（需要先 npm run build）：
 *   NODE_PATH=".../node/workspace/node_modules" node data/tmp/e2e-browser-tunnel.mjs
 */
import { createRequire } from 'node:module'
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
const WORK = path.join(ROOT, 'data/tmp/e2e-tunnel-browser')
const PORT = 8101
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_SSH = 2423
const SVC_GREET = 2471
const SVC_RAW = 2472
const SHOT_DIR = path.join(ROOT, 'data/browser-e2e-shots')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MASTER = 'master-pass-2026'

/** 隧道监听端口（高位端口，避开常用服务与开发用的端口段） */
const L_LOCAL = 13701
const SOCKS = 13710
const LIB_LOCAL = 13702

const GREETING = 'svc-greeting-ok'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ */
/* 准备数据与环境                                                      */
/* ------------------------------------------------------------------ */

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const children = []
const services = []

/** 业务服务：greet 模式带问候语，raw 模式纯字节回环 */
function startService(port, { greet } = {}) {
  const server = net.createServer((socket) => {
    if (greet) socket.write(`${GREETING}\n`)
    socket.on('data', (chunk) => {
      socket.write(greet ? `echo:${chunk.toString().trim()}\n` : chunk)
    })
    socket.on('error', () => {
      /* 客户端粗暴断开是测试常态 */
    })
  })
  server.on('error', (err) => console.log(`  [svc:${port}!] ${err.message}`))
  server.listen(port, '127.0.0.1')
  services.push(server)
  return server
}

function startMockSsh() {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(MOCK_SSH) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`  [ssh] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [ssh!] ${d}`))
  children.push(child)
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
  child.stdout.on('data', (d) => process.stdout.write(`  [webterm] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [webterm!] ${d}`))
  children.push(child)
}

function killAll() {
  for (const server of services) {
    try {
      server.close()
    } catch {
      /* 忽略 */
    }
  }
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }
}

async function waitHealthy(timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {
      /* 未就绪 */
    }
    if (Date.now() - started > timeoutMs) throw new Error('服务端启动超时')
    await sleep(200)
  }
}

/* ------------------------------------------------------------------ */
/* 端口与转发探测工具                                                  */
/* ------------------------------------------------------------------ */

/** netstat 里该端口是否处于 LISTENING（验收条件点名要求的口径） */
function netstatListening(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true })
    const re = new RegExp(`[:.]${port}\\s`)
    return out
      .split(/\r?\n/)
      .some((line) => /LISTENING/i.test(line) && re.test(line))
  } catch {
    return false
  }
}

/** 端口当前是否空闲（能 bind 才算真的释放） */
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** 建立一次普通 TCP 往返：连上后发一条，等回显里出现它 */
function roundTrip(port, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok ? buffer : null)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false))
    socket.on('connect', () => socket.write(`${payload}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes(payload)) finish(true)
    })
  })
}

/**
 * 走 SOCKS5 代理完成一次 CONNECT 并做往返。
 *
 * 手写而不引第三方库，是因为这里要验证的正是我们自己实现的协议细节：
 * 方法协商、ATYP 域名寻址、REP 码 —— 用现成客户端会把问题掩盖掉。
 */
function socks5RoundTrip(proxyPort, dstHost, dstPort, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, '127.0.0.1')
    let buf = Buffer.alloc(0)
    let echoed = ''
    let stage = 'method'
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok ? echoed : null)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)

    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false))
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])

      if (stage === 'method') {
        if (buf.length < 2) return
        const ver = buf[0]
        const method = buf[1]
        buf = buf.subarray(2)
        if (ver !== 0x05 || method !== 0x00) return finish(false)
        stage = 'reply'
        const host = Buffer.from(dstHost, 'utf8')
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
            host,
            Buffer.from([(dstPort >> 8) & 0xff, dstPort & 0xff]),
          ]),
        )
      }

      if (stage === 'reply') {
        if (buf.length < 4) return
        const rep = buf[1]
        const atyp = buf[3]
        let need
        if (atyp === 0x01) need = 4 + 4 + 2
        else if (atyp === 0x04) need = 4 + 16 + 2
        else if (atyp === 0x03) {
          if (buf.length < 5) return
          need = 4 + 1 + buf[4] + 2
        } else return finish(false)
        if (buf.length < need) return
        buf = buf.subarray(need)
        if (rep !== 0x00) return finish(false)
        stage = 'echo'
        socket.write(Buffer.from(payload, 'utf8'))
      }

      if (stage === 'echo') {
        echoed += buf.toString('utf8')
        buf = Buffer.alloc(0)
        if (echoed.includes(payload)) finish(true)
      }
    })
  })
}

startService(SVC_GREET, { greet: true })
startService(SVC_RAW, {})
startMockSsh()
startServer()
await waitHealthy()

const api = (p) => fetch(`${BASE}${p}`).then((r) => r.json())
const tunnels = async () => (await api('/api/tunnels')).tunnels
const tunnelOf = async (kind, port) =>
  (await tunnels()).find((t) => t.spec.type === kind && t.spec.bindPort === port)

let browser
const jsErrors = []

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1500, height: 940 },
  })
  const page = await browser.newPage()

  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // 业务上的 4xx（未解锁、端口冲突、校验失败）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(t)) return
    jsErrors.push(t)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/tunnel-${n}.png` }).catch(() => {})

  const hasText = async (t, timeout = 8000) => {
    try {
      await page.waitForFunction((x) => document.body?.innerText?.includes(x), { timeout }, t)
      return true
    } catch {
      return false
    }
  }

  const clickText = (t, scope = 'body') =>
    page.evaluate(
      (x, s) => {
        const root = document.querySelector(s) ?? document.body
        const all = [...root.querySelectorAll('button, a')]
        const el =
          all.find((e) => (e.textContent || '').trim() === x) ??
          all.find((e) => (e.textContent || '').includes(x))
        if (!el) return false
        el.click()
        return true
      },
      t,
      scope,
    )

  const clickTestId = (id) =>
    page.evaluate((x) => {
      const el = document.querySelector(`[data-testid="${x}"]`)
      if (!el) return false
      el.click()
      return true
    }, id)

  /** 面板内的按钮：按可见文本点，避免误点页面其它位置的同名按钮 */
  const clickPanelText = (t) =>
    page.evaluate((x) => {
      const panel = document.querySelector('[data-testid="tunnel-panel"]')
      if (!panel) return false
      const el = [...panel.querySelectorAll('button')].find((b) =>
        (b.textContent || '').trim().includes(x),
      )
      if (!el) return false
      el.click()
      return true
    }, t)

  const setInput = (sel, value) =>
    page.evaluate(
      (s, v) => {
        const el = document.querySelector(s)
        if (!el) return false
        const proto =
          el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      sel,
      value,
    )

  const inputValue = (sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel)
  const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel)

  const panelText = () =>
    page.evaluate(() => document.querySelector('[data-testid="tunnel-panel"]')?.innerText ?? '')

  /** 隧道列表里每一行的可见文本 */
  const rowTexts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="tunnel-row"]')].map((e) => e.innerText),
    )

  /** 轮询列表直到满足条件；返回满足时的行文本，超时返回 null */
  async function waitRows(predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const rows = await rowTexts()
      if (predicate(rows)) return rows
      if (Date.now() > deadline) return null
      await sleep(250)
    }
  }

  const activePaneSel = '[data-testid="terminal-pane"][data-active="true"]'

  const termText = () =>
    page.evaluate((sel) => {
      const pane = document.querySelector(sel)
      const rows = pane?.querySelector('.xterm-rows')
      if (!rows) return ''
      return [...rows.children].map((el) => el.textContent || '').join('\n')
    }, activePaneSel)

  async function waitTermText(sub, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((await termText()).includes(sub)) return true
      if (Date.now() > deadline) return false
      await sleep(200)
    }
  }

  /** 打开隧道面板（已完成保险库初始化后才可用） */
  async function openPanel() {
    if (await exists('[data-testid="tunnel-panel"]')) return true
    const ok = await clickTestId('open-tunnels')
    if (!ok) return false
    return hasText('端口转发 / 隧道', 8000)
  }

  async function closePanel() {
    const ok = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="tunnel-panel"]')
      const btn = panel?.querySelector('button[aria-label="关闭"]')
      if (!btn) return false
      btn.click()
      return true
    })
    if (ok) await sleep(400)
    return ok
  }

  /** 填表并创建一条隧道 */
  async function createTunnel(type, bindPort, targetHost, targetPort) {
    const typeOk = await clickTestId(`tunnel-type-${type}`)
    if (!typeOk) return false
    await sleep(200)
    if (!(await setInput('[data-testid="tunnel-bind-host"]', '127.0.0.1'))) return false
    if (!(await setInput('[data-testid="tunnel-bind-port"]', String(bindPort)))) return false
    if (type !== 'dynamic') {
      if (!(await setInput('[data-testid="tunnel-target-host"]', targetHost))) return false
      if (!(await setInput('[data-testid="tunnel-target-port"]', String(targetPort)))) return false
    }
    await sleep(150)
    return clickTestId('tunnel-create')
  }

  /* ---------------- 1. 保险库与主界面 ---------------- */
  console.log('\n[1] 保险库与主界面')
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20_000 })
  await sleep(600)
  check('首屏渲染出保险库门禁', await hasText('设置主密码', 10_000))
  const pw = await page.$$('[data-testid="vault-gate"] input[type="password"]')
  if (pw.length === 2) {
    await pw[0].type(MASTER)
    await pw[1].type(MASTER)
    await clickText('设置并解锁')
  }
  check('设置主密码后进入主界面', await hasText('会话库', 12_000))
  check('欢迎页声明完成阶段 0 ~ 6', await hasText('已完成阶段 0 ~ 6'))
  check('欢迎页列出自动化与批量运维', await hasText('自动化与批量运维'))
  check('欢迎页列出端口转发阶段', await hasText('端口转发与隧道'))
  check('头部出现隧道入口', await exists('[data-testid="open-tunnels"]'))
  await shot('01-main')

  /* ---------------- 2. 建一条 SSH 会话 ---------------- */
  console.log('\n[2] 建立 SSH 会话（隧道宿主）')
  check('点击「快速连接」', await clickText('快速连接'))
  await sleep(500)
  check(
    '填写 SSH 目标',
    (await setInput('input[name="host"]', '127.0.0.1')) &&
      (await setInput('input[name="port"]', String(MOCK_SSH))) &&
      (await setInput('input[name="username"]', 'demo')) &&
      (await setInput('input[name="password"]', 'demo')) &&
      (await setInput('input[name="title"]', 'tunnel-host')),
  )
  check('点击「连接」', await clickTestId('connect-session'))
  const readyOk = await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="terminal-pane"][data-active="true"]')?.dataset
          .status === 'ready',
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('SSH 终端状态变为 ready', readyOk)

  const terminals = (await api('/api/terminals')).terminals
  const sshTerminal = terminals.find((t) => t.protocol === 'ssh')
  check('服务端存在 1 个 SSH 终端', Boolean(sshTerminal), JSON.stringify(terminals.map((t) => t.protocol)))

  /* ---------------- 3. 打开隧道面板 ---------------- */
  console.log('\n[3] 隧道面板')
  check('点击头部「隧道」入口', await openPanel())
  check('面板出现空态提示', await exists('[data-testid="tunnel-empty"]'))
  check('空态给出 -L 用法示例', await hasText('-L 13306:10.0.0.5:3306'))
  check('空态给出 -D 用法示例', await hasText('-D 1080'))
  check('头部隧道入口显示 0 个运行中（无徽标）', !(await hasText('隧道\n0')))
  const hostOptions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="tunnel-terminal"] option')].map((o) => o.textContent),
  )
  check(
    '宿主会话下拉已列出 SSH 会话',
    hostOptions.some((o) => (o || '').includes('127.0.0.1')),
    JSON.stringify(hostOptions),
  )
  check('默认转发类型为本地转发', await hasText('ssh -L'))
  await shot('02-panel-empty')

  /* ---------------- 4. 本地转发（-L）---------------- */
  console.log('\n[4] 本地转发 -L')
  check('填写并创建本地转发', await createTunnel('local', L_LOCAL, '127.0.0.1', SVC_GREET))
  const localRows = await waitRows((rows) =>
    rows.some((r) => r.includes('本地转发') && r.includes('运行中')),
  )
  check('列表出现「运行中」的本地转发', localRows !== null, localRows?.join(' | ') ?? '超时')
  check('行内展示监听与目标', (localRows ?? []).some((r) => r.includes(`127.0.0.1:${L_LOCAL} → 127.0.0.1:${SVC_GREET}`)), localRows?.join(' | ') ?? '')
  check('行内标注宿主会话', (localRows ?? []).some((r) => r.includes('tunnel-host')), localRows?.join(' | ') ?? '')
  await shot('03-local-created')

  // 验收条件：外部普通 TCP 客户端连本机端口，流量到达远端网络里的目标
  const localEcho = await roundTrip(L_LOCAL, 'through-local-forward')
  check('外部客户端经本地转发拿到业务响应', Boolean(localEcho), localEcho ? localEcho.replace(/\n/g, ' ⏎ ').trim() : '连接失败')
  check('响应里带上目标服务的问候语', Boolean(localEcho?.includes(GREETING)))
  check('netstat 显示监听端口已就绪', netstatListening(L_LOCAL))

  // 统计：连接数与字节数要能被面板看到（每 2 秒轮询一次）
  const statsRows = await waitRows(
    (rows) => rows.some((r) => /连接 \d+／[1-9]\d*/.test(r) && /↑ \d/.test(r) && /↓ \d/.test(r)),
    6000,
  )
  check('面板统计出连接数', (statsRows ?? []).some((r) => /连接 \d+／[1-9]\d*/.test(r)), (statsRows ?? []).join(' | '))
  check(
    '面板统计出上下行字节数',
    (statsRows ?? []).some((r) => /↑ [1-9]/.test(r) && /↓ [1-9]/.test(r)),
    (statsRows ?? []).join(' | '),
  )

  /* ---------------- 5. 端口占用要给出可操作提示 ---------------- */
  console.log('\n[5] 端口冲突')
  check('用同一端口再建一条', await createTunnel('local', L_LOCAL, '127.0.0.1', SVC_GREET))
  check('表单就地报出「端口已被占用」', await hasText('端口已被占用', 10_000))
  const errText = await page.evaluate(
    () => document.querySelector('[data-testid="tunnel-error"]')?.innerText ?? '',
  )
  check('提示里给出端口号', errText.includes(`${L_LOCAL}`), errText.replace(/\n/g, ' ').slice(0, 160))
  check('提示里给出处置建议', errText.includes('换一个监听端口') || errText.includes('先关闭占用'), errText.replace(/\n/g, ' ').slice(0, 200))
  const afterConflict = await rowTexts()
  check('失败的创建没有留下幽灵记录', afterConflict.length === 1, `行数 ${afterConflict.length}`)
  check('原隧道仍在运行中', afterConflict[0]?.includes('运行中') === true, afterConflict[0] ?? '')
  await shot('04-port-conflict')

  /* ---------------- 6. 动态转发（-D）---------------- */
  console.log('\n[6] 动态转发 -D（SOCKS5）')
  check('填写并创建动态转发', await createTunnel('dynamic', SOCKS, '', ''))
  const socksRows = await waitRows((rows) =>
    rows.some((r) => r.includes('动态转发') && r.includes('运行中')),
  )
  check('列表出现「运行中」的动态转发', socksRows !== null, socksRows?.join(' | ') ?? '超时')
  check('动态转发不展示目标地址', (socksRows ?? []).some((r) => r.includes(`127.0.0.1:${SOCKS}`) && !r.includes('→')), socksRows?.join(' | ') ?? '')

  const socksEcho = await socks5RoundTrip(SOCKS, '127.0.0.1', SVC_RAW, `socks-${Date.now()}`)
  check('SOCKS5 客户端经代理拿到业务响应', Boolean(socksEcho), socksEcho ?? '握手或连接失败')
  const socksBad = await socks5RoundTrip(SOCKS, '127.0.0.1', 2459, 'nope')
  check('目标不可达时 SOCKS5 返回失败（REP≠0）', socksBad === null)
  await shot('05-socks')

  /* ---------------- 7. 远程转发（-R）---------------- */
  console.log('\n[7] 远程转发 -R')
  check('填写并创建远程转发（端口填 0 由远端分配）', await createTunnel('remote', 0, '127.0.0.1', SVC_RAW))
  const remoteRows = await waitRows((rows) =>
    rows.some((r) => r.includes('远程转发') && r.includes('运行中')),
  )
  check('列表出现「运行中」的远程转发', remoteRows !== null, remoteRows?.join(' | ') ?? '超时')
  const remoteInfo = (await tunnels()).find((t) => t.spec.type === 'remote')
  const remotePort = remoteInfo?.boundPort ?? 0
  check('远端返回了真实监听端口', remotePort > 0, `boundPort=${remotePort}`)
  check('行内展示实际分配到的端口', (remoteRows ?? []).some((r) => r.includes(`127.0.0.1:${remotePort}`)), remoteRows?.join(' | ') ?? '')
  check('行内标注的是本机侧目标', (remoteRows ?? []).some((r) => r.includes(`→ 127.0.0.1:${SVC_RAW}`)), remoteRows?.join(' | ') ?? '')

  // 验收条件：从「远端」连进去，流量被送回本机目标
  const remoteEcho = remotePort ? await roundTrip(remotePort, 'through-remote-forward') : null
  check('「远端」侧连接可直达本机目标', Boolean(remoteEcho), remoteEcho ? remoteEcho.replace(/\n/g, ' ').trim() : '连接失败')
  await shot('06-remote')

  const allThree = await tunnels()
  check('服务端同时存在 3 条隧道', allThree.length === 3, allThree.map((t) => t.spec.type).join(','))
  check('三条都为 active', allThree.every((t) => t.status === 'active'), allThree.map((t) => `${t.spec.type}:${t.status}`).join(','))
  const badge = await page.evaluate(
    () => document.querySelector('[data-testid="open-tunnels"]')?.innerText ?? '',
  )
  check('头部入口显示运行中数量 3', badge.includes('3'), badge.replace(/\n/g, ' '))

  /* ---------------- 8. 停止 / 启动 / 删除 ---------------- */
  console.log('\n[8] 停止、重启与删除')
  // 关掉面板再看端口状态：避免面板的轮询把「已停止」又刷新成别的样子
  check('关闭面板', await closePanel())
  check('停止前端口处于监听', netstatListening(L_LOCAL))

  check('重新打开面板', await openPanel())
  const stopOk = await page.evaluate((port) => {
    const row = [...document.querySelectorAll('[data-testid="tunnel-row"]')].find((el) =>
      el.innerText.includes(`127.0.0.1:${port}`),
    )
    const btn = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => (b.textContent || '').trim() === '停止',
    )
    if (!btn) return false
    btn.click()
    return true
  }, L_LOCAL)
  check('点击「停止」', stopOk)
  const stoppedRows = await waitRows((rows) =>
    rows.some((r) => r.includes(`127.0.0.1:${L_LOCAL}`) && r.includes('已停止')),
  )
  check('行状态变为「已停止」', stoppedRows !== null, stoppedRows?.join(' | ') ?? '超时')
  await sleep(400)
  check('netstat 中监听已消失', !netstatListening(L_LOCAL))
  check('端口可被重新绑定', await canBind(L_LOCAL))
  check('停止后外部连接不再通', (await roundTrip(L_LOCAL, 'after-stop', 2500)) === null)
  await shot('07-stopped')

  const startOk = await page.evaluate((port) => {
    const row = [...document.querySelectorAll('[data-testid="tunnel-row"]')].find((el) =>
      el.innerText.includes(`127.0.0.1:${port}`),
    )
    const btn = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => (b.textContent || '').trim() === '启动',
    )
    if (!btn) return false
    btn.click()
    return true
  }, L_LOCAL)
  check('点击「启动」', startOk)
  const restartedRows = await waitRows((rows) =>
    rows.some((r) => r.includes(`127.0.0.1:${L_LOCAL}`) && r.includes('运行中')),
  )
  check('行状态回到「运行中」', restartedRows !== null, restartedRows?.join(' | ') ?? '超时')
  check('重启后端口重新监听', netstatListening(L_LOCAL))
  const afterRestart = await roundTrip(L_LOCAL, 'after-restart')
  check('重启后链路再次可用', Boolean(afterRestart), afterRestart ? afterRestart.trim() : '连接失败')

  const delOk = await page.evaluate((port) => {
    const row = [...document.querySelectorAll('[data-testid="tunnel-row"]')].find((el) =>
      el.innerText.includes(`127.0.0.1:${port}`),
    )
    const btn = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => (b.textContent || '').trim() === '删除',
    )
    if (!btn) return false
    btn.click()
    return true
  }, SOCKS)
  check('删除动态转发', delOk)
  const afterDelete = await waitRows((rows) => !rows.some((r) => r.includes('动态转发')))
  check('列表中不再有动态转发', afterDelete !== null, (afterDelete ?? []).join(' | '))
  check('动态转发的端口已释放', await canBind(SOCKS))
  const remaining = await tunnels()
  check('服务端只剩 2 条隧道', remaining.length === 2, remaining.map((t) => t.spec.type).join(','))
  await shot('08-after-delete')

  /* ---------------- 9. 会话库：随会话自动启动 ---------------- */
  console.log('\n[9] 会话库中的隧道配置')
  check('关闭面板', await closePanel())
  check('点击「+会话」新建会话库节点', await clickText('+会话'))
  await sleep(500)
  check('会话弹窗打开', await exists('[data-testid="session-dialog"]'))
  check(
    '填写 SSH 会话记录',
    (await setInput('[data-testid="session-name"]', '带隧道的设备')) &&
      (await setInput('[data-testid="session-host"]', '127.0.0.1')) &&
      (await setInput('[data-testid="session-port"]', String(MOCK_SSH))) &&
      (await setInput('[data-testid="session-username"]', 'demo')),
  )
  // SSH 会话必须有凭据才能保存（保存按钮是禁用态），走内联新建凭据
  check(
    '内联新建凭据',
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        (b.textContent || '').includes('+ 新建凭据'),
      )
      if (!btn) return false
      btn.click()
      return true
    }),
  )
  check(
    '填写凭据',
    (await setInput('[data-testid="cred-name"]', 'demo-pass')) &&
      (await setInput('[data-testid="cred-password"]', 'demo')),
  )
  check('存在「+ 添加隧道」入口', await exists('[data-testid="add-tunnel"]'))
  check('点击添加一条隧道', await clickTestId('add-tunnel'))
  const tunnelRowForm = await exists('[data-testid="session-tunnel-row"]')
  check('出现隧道行表单', tunnelRowForm)
  // 默认类型是本地转发，按 [类型][监听地址][监听端口] + [目标主机][目标端口] 的顺序填
  const fillRow = await page.evaluate(
    (bindPort, targetHost, targetPort) => {
      const row = document.querySelector('[data-testid="session-tunnel-row"]')
      if (!row) return false
      const select = row.querySelector('select')
      const inputs = [...row.querySelectorAll('input')]
      const set = (el, v) => {
        const proto = window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (select) {
        const proto = window.HTMLSelectElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(select, 'local')
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (inputs.length < 4) return false
      set(inputs[0], '127.0.0.1')
      set(inputs[1], String(bindPort))
      set(inputs[2], targetHost)
      set(inputs[3], String(targetPort))
      return true
    },
    LIB_LOCAL,
    '127.0.0.1',
    SVC_GREET,
  )
  check('隧道行已填好', fillRow)
  await shot('09-session-dialog')
  check('保存会话', await clickTestId('session-save'))
  check('会话出现在会话库', await hasText('带隧道的设备', 10_000))

  const tree = await api('/api/library')
  const saved = tree?.nodes?.find((n) => n.name === '带隧道的设备')
  check('服务端已落库隧道定义', Array.isArray(saved?.session?.tunnels) && saved.session.tunnels.length === 1, JSON.stringify(saved?.session?.tunnels))
  check(
    '落库的隧道定义内容正确',
    saved?.session?.tunnels?.[0]?.type === 'local' &&
      saved?.session?.tunnels?.[0]?.bindPort === LIB_LOCAL &&
      saved?.session?.tunnels?.[0]?.targetPort === SVC_GREET,
    JSON.stringify(saved?.session?.tunnels?.[0]),
  )

  /* ---------------- 10. 从会话库连接 → 自动启动 ---------------- */
  console.log('\n[10] 随会话自动启动')
  check(
    '单击会话名即可连接',
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="library-node"]')].find(
        (n) => n.dataset.name === '带隧道的设备',
      )
      const span = el?.querySelector('[role="button"]')
      if (!span) return false
      span.click()
      return true
    }),
  )
  const readyLib = await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="terminal-pane"][data-status="ready"]').length >= 2,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('会话库发起的 SSH 终端就绪', readyLib)

  const autoTunnel = await (async () => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const found = (await tunnels()).find(
        (t) => t.spec.type === 'local' && t.spec.bindPort === LIB_LOCAL,
      )
      if (found && found.status === 'active') return found
      if (Date.now() > deadline) return null
      await sleep(300)
    }
  })()
  check('会话建立后隧道自动启动', Boolean(autoTunnel), JSON.stringify(autoTunnel?.status))
  check('自动启动的隧道被标记 autoStarted', autoTunnel?.autoStarted === true)
  check('终端里没有出现隧道失败提示', !(await waitTermText('端口转发启动失败', 1500)))
  check('自动启动的隧道端口已监听', netstatListening(LIB_LOCAL))
  const libEcho = await roundTrip(LIB_LOCAL, 'auto-started')
  check('自动启动的链路可用', Boolean(libEcho), libEcho ? libEcho.trim() : '连接失败')

  check('打开面板核对标记', await openPanel())
  const autoRows = await waitRows((rows) => rows.some((r) => r.includes('随会话启动')))
  check('面板里标注「随会话启动」', autoRows !== null, (autoRows ?? []).join(' | '))
  await shot('10-auto-started')
  check('关闭面板', await closePanel())

  /* ---------------- 11. 关闭会话 → 端口立即释放 ---------------- */
  console.log('\n[11] 关闭会话后释放端口')
  // 先关掉「带隧道的设备」这个标签（它是当前活动标签）
  const closedLib = await page.evaluate(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')
    const btn = [...(tab?.querySelectorAll('button') ?? [])].find((b) =>
      (b.getAttribute('aria-label') || '').startsWith('关闭'),
    )
    if (!btn) return false
    btn.click()
    return true
  })
  check('关闭会话库发起的标签', closedLib)
  const releasedLib = await (async () => {
    const deadline = Date.now() + 12_000
    for (;;) {
      const list = await tunnels()
      const gone = !list.some((t) => t.spec.type === 'local' && t.spec.bindPort === LIB_LOCAL)
      if (gone && !netstatListening(LIB_LOCAL)) return true
      if (Date.now() > deadline) return false
      await sleep(300)
    }
  })()
  check('该会话的隧道被回收', releasedLib)
  check('netstat 中端口已消失', !netstatListening(LIB_LOCAL))
  check('端口可被重新绑定', await canBind(LIB_LOCAL))

  // 再关掉第一条 SSH 会话，剩下的两条隧道也应随之消失
  const closedHost = await page.evaluate(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')
    const btn = [...(tab?.querySelectorAll('button') ?? [])].find((b) =>
      (b.getAttribute('aria-label') || '').startsWith('关闭'),
    )
    if (!btn) return false
    btn.click()
    return true
  })
  check('关闭第一个 SSH 会话', closedHost)
  const allGone = await (async () => {
    const deadline = Date.now() + 12_000
    for (;;) {
      if ((await tunnels()).length === 0 && !netstatListening(L_LOCAL)) return true
      if (Date.now() > deadline) return false
      await sleep(300)
    }
  })()
  check('全部隧道随会话一起回收', allGone)
  check('服务端的隧道列表已清空', (await tunnels()).length === 0)
  check('本地转发端口已释放（netstat 验证）', !netstatListening(L_LOCAL))
  check('端口可被重新绑定', await canBind(L_LOCAL))
  const listAfter = await api('/api/terminals')
  check('服务端终端已回收', (listAfter?.terminals ?? []).length === 0, String((listAfter?.terminals ?? []).length))
  await shot('11-closed')

  check('全程无未捕获的前端错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' / '))
} catch (err) {
  check(`执行异常：${err.message}`, false)
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n阶段 5 隧道浏览器端到端：${passed}/${results.length} 通过`)
if (passed !== results.length) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`)
}
process.exit(passed === results.length ? 0 : 1)
