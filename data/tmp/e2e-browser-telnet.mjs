/**
 * 阶段 4 浏览器端到端：真实 UI 走完「选 Telnet → 探测 → 连上设备 → 交互 → 会话库 → 关闭」。
 *
 * 自管两个 mock Telnet 设备 + 一个生产模式服务端实例（独立端口与数据目录），
 * 不触碰开发用的 8080 与 5173。
 *
 *   2341  正常设备（声明并执行远端回显）
 *   2342  不回显设备（MOCK_TELNET_ECHO=0，用于验证本端本地回显兜底）
 *   8099  服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 运行（需要先 npm run build）：
 *   NODE_PATH=".../node/workspace/node_modules" node data/tmp/e2e-browser-telnet.mjs
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
const WORK = path.join(ROOT, 'data/tmp/e2e-telnet-browser')
const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_PORT = 2341
const MOCK_NOECHO_PORT = 2342
const SHOT_DIR = path.join(ROOT, 'data/browser-e2e-shots')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MASTER = 'master-pass-2026'

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
function startMock(port, extraEnv, name) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-telnet-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_TELNET_NAME: name, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`  [${name}] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [${name}!] ${d}`))
  children.push(child)
}
function startServer() {
  // WEBTERM_LOCAL_ROOT 对应的目录必须存在，否则服务端启动即失败
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
}
function killAll() {
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

startMock(MOCK_PORT, {}, 'MockTelnet')
startMock(MOCK_NOECHO_PORT, { MOCK_TELNET_ECHO: '0' }, 'NoEchoDev')
startServer()
await waitHealthy()

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
    // 业务上的 4xx（未解锁、校验失败、Telnet 不支持 SFTP）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(t)) return
    jsErrors.push(t)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/telnet-${n}.png` }).catch(() => {})

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

  const inputValue = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.value ?? null, sel)

  const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel)

  /** 当前活动终端面板的 id（用于把断言限定在正在看的那个面板上） */
  const activePaneSel = '[data-testid="terminal-pane"][data-active="true"]'

  /** 读取活动终端面板里 xterm 渲染出的全部文本 */
  const termText = () =>
    page.evaluate((sel) => {
      const pane = document.querySelector(sel)
      if (!pane) return ''
      const rows = pane.querySelector('.xterm-rows')
      if (!rows) return ''
      return [...rows.children].map((el) => el.textContent || '').join('\n')
    }, activePaneSel)

  /** 向活动终端键入一段文本并回车 */
  async function typeLine(text) {
    const ok = await page.evaluate((sel) => {
      const pane = document.querySelector(sel)
      const ta = pane?.querySelector('.xterm-helper-textarea')
      if (!ta) return false
      ta.focus()
      return true
    }, activePaneSel)
    if (!ok) return false
    await page.keyboard.type(text, { delay: 12 })
    await page.keyboard.press('Enter')
    return true
  }

  /** 反复轮询终端文本，直到出现目标子串或超时 */
  async function waitTermText(sub, timeoutMs = 10_000, minCount = 1) {
    const deadline = Date.now() + timeoutMs
    let last = ''
    for (;;) {
      last = await termText()
      const count = last.split(sub).length - 1
      if (count >= minCount) return true
      if (Date.now() > deadline) return false
      await sleep(150)
    }
  }

  async function termTextWithRetry() {
    return termText()
  }

  /* ---------------- 1. 保险库初始化 ---------------- */
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
  // 不锁死具体数字：欢迎页的「已完成到第几阶段」会随开发推进（阶段 5 起是 0 ~ 5），
  // 这里只确认欢迎页确实声明了累计完成数，Telnet 阶段是否完成由下一条单独验证
  check('欢迎页声明了累计完成进度', await hasText('已完成阶段 0 ~ '))
  check('欢迎页列出 Telnet 阶段', await hasText('Telnet 明文终端'))
  await shot('01-main')

  /* ---------------- 2. 新建对话框的协议切换 ---------------- */
  console.log('\n[2] 协议选择器')
  check('点击「快速连接」', await clickText('快速连接'))
  await sleep(500)
  check('默认协议为 SSH（端口 22）', (await inputValue('input[name="port"]')) === '22', String(await inputValue('input[name="port"]')))
  check('SSH 模式存在用户名输入框', await exists('input[name="username"]'))
  check('SSH 模式存在「SFTP 文件」用途按钮', await exists('[data-testid="mode-sftp"]'))
  check('SSH 模式存在算法兼容策略', await hasText('算法兼容策略'))
  check('SSH 模式没有明文警示', !(await exists('[data-testid="telnet-warning"]')))

  check('切到 Telnet', await clickTestId('protocol-telnet'))
  await sleep(300)
  check('端口自动切换为 23', (await inputValue('input[name="port"]')) === '23', String(await inputValue('input[name="port"]')))
  check('Telnet 模式隐藏用户名输入框', !(await exists('input[name="username"]')))
  check('Telnet 模式隐藏「SFTP 文件」用途按钮', !(await exists('[data-testid="mode-sftp"]')))
  check('Telnet 模式隐藏认证方式', !(await hasText('登录口令')))
  check('Telnet 模式隐藏算法兼容策略', !(await hasText('算法兼容策略')))
  check('Telnet 模式显示明文警示', await exists('[data-testid="telnet-warning"]'))
  check('对话框标题变为 Telnet', await hasText('新建 Telnet 连接'))
  await shot('02-telnet-dialog')

  /* ---------------- 3. 探测 ---------------- */
  console.log('\n[3] 测试连接（探测）')
  check(
    '填写 Telnet 目标',
    (await setInput('input[name="host"]', '127.0.0.1')) &&
      (await setInput('input[name="port"]', String(MOCK_PORT))),
  )
  check('点击「测试连接」', await clickTestId('probe-session'))
  check('探测成功并给出 Telnet 专属结论', await hasText('TCP 端口可达，设备已响应', 12_000))
  check('探测结果展示设备欢迎语', await hasText('设备欢迎语'))
  check('欢迎语内容来自设备', await hasText('MockTelnet (mock) ready.', 8_000))
  check('给出明文风险警示', await hasText('Telnet 是明文协议'))
  // SSH 专有字段不该出现在 Telnet 探测结果里
  check('探测结果不展示密钥交换', !(await hasText('密钥交换')))
  await shot('03-probe')

  /* ---------------- 4. 连接并交互 ---------------- */
  console.log('\n[4] 建立 Telnet 终端')
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
  check('终端状态变为 ready', readyOk)
  check('终端面板标记为 telnet 协议', (await page.$eval(activePaneSel, (el) => el.dataset.protocol)) === 'telnet')
  check('标签出现 Telnet 协议徽标', await hasText('Telnet'))
  check('欢迎语渲染进终端', await waitTermText('MockTelnet (mock) ready.', 12_000))
  check('提示符渲染进终端', await waitTermText('MockTelnet> ', 8_000))
  await shot('04-terminal')

  // 交互：help
  check('键入 help', await typeLine('help'))
  check('设备返回命令列表', await waitTermText('commands: help ping echo', 10_000))

  // 交互：echo（设备回显 + 设备执行 echo，两处都会出现这段文本）
  check('键入 echo', await typeLine('echo browser-hello'))
  check('设备回显并执行 echo', await waitTermText('browser-hello', 10_000, 2))

  // 交互：size（NAWS 窗口尺寸上报）
  check('键入 size', await typeLine('size'))
  const sizeOk = await waitTermText('size=', 10_000)
  const sizeLine = (await termTextWithRetry()).split('\n').find((l) => l.includes('size=')) || ''
  check('窗口尺寸已通过 NAWS 上报给设备', sizeOk && /size=\d{2,4}x\d{1,3}/.test(sizeLine), sizeLine.trim())
  check('上报的宽高均非零', !/size=0x/.test(sizeLine) && !/x0\b/.test(sizeLine), sizeLine.trim())

  // 交互：ttype（TERMINAL-TYPE 选项）
  check('键入 ttype', await typeLine('ttype'))
  const ttypeOk = await waitTermText('ttype=', 10_000)
  const ttypeLine = (await termTextWithRetry()).split('\n').find((l) => l.includes('ttype=')) || ''
  check('终端类型经 TERMINAL-TYPE 上报', ttypeOk && /ttype=\S+/.test(ttypeLine) && !ttypeLine.includes('unknown'), ttypeLine.trim())

  // 交互：iac（设备输出裸 0xFF，两端都不能被吃掉）
  check('键入 iac（设备回送裸 0xFF）', await typeLine('iac'))
  await sleep(1000)
  check('紧接着键入 ping', await typeLine('ping'))
  check('裸 0xFF 未破坏后续命令解析（仍能拿到 pong）', await waitTermText('pong', 10_000))

  // 交互：big（背压路径）
  check('键入 big', await typeLine('big 128'))
  check('大流量输出完成且提示符回归', await waitTermText('MockTelnet> ', 25_000))

  /* ---------------- 5. Telnet 标签不提供 SFTP ---------------- */
  console.log('\n[5] SFTP 入口应按协议隐藏')
  const sftpTabButtons = await page.evaluate(() =>
    [...document.querySelectorAll('button[aria-label]')]
      .map((b) => b.getAttribute('aria-label') || '')
      .filter((l) => l.includes('打开 SFTP')),
  )
  check('Telnet 标签上没有「打开 SFTP」按钮', sftpTabButtons.length === 0, sftpTabButtons.join(' | '))
  await shot('04b-no-sftp-entry')

  /* ---------------- 6. 不回显设备 → 本地回显兜底 ---------------- */
  console.log('\n[6] 不回显设备（本地回显兜底）')
  check('再次点击「快速连接」', await clickText('快速连接'))
  await sleep(500)
  check('切到 Telnet', await clickTestId('protocol-telnet'))
  await sleep(300)
  check(
    '填写不回显设备',
    (await setInput('input[name="host"]', '127.0.0.1')) &&
      (await setInput('input[name="port"]', String(MOCK_NOECHO_PORT))) &&
      (await setInput('input[name="title"]', 'no-echo')),
  )
  check('点击「连接」', await clickTestId('connect-session'))
  const ready2 = await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="terminal-pane"][data-status="ready"]').length >= 2,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('第二个 Telnet 会话就绪', ready2)

  check('键入 echo（设备不回显，靠本端）', await typeLine('echo local-echo-probe'))
  const localEchoOk = await waitTermText('local-echo-probe', 12_000, 2)
  const noEchoText = await termText()
  check('本端回显兜底生效：键入内容可见且设备也回应了', localEchoOk, `出现 ${noEchoText.split('local-echo-probe').length - 1} 次`)
  check('不协商设备仍能拿到提示符', await waitTermText('NoEchoDev>', 10_000))
  await shot('05-noecho')

  /* ---------------- 7. 会话库保存 Telnet 会话 ---------------- */
  console.log('\n[7] 会话库中的 Telnet 会话')
  check('点击「+会话」新建会话库节点', await clickText('+会话'))
  await sleep(400)
  check('会话弹窗打开', await exists('[data-testid="session-dialog"]'))
  check('切到 Telnet 协议', await clickTestId('session-protocol-telnet'))
  await sleep(300)
  check('Telnet 会话隐藏用户名输入框', !(await exists('[data-testid="session-username"]')))
  check('Telnet 会话隐藏登录凭据', !(await hasText('登录凭据')))
  // 注意别直接断言文案「跳板链」：Telnet 的提示段落里也提到了这个词，会误判
  check('Telnet 会话隐藏跳板链', !(await hasText('+ 添加一跳')))
  check('Telnet 会话隐藏算法兼容', !(await hasText('算法兼容')))
  check('会话端口默认 23', (await inputValue('[data-testid="session-port"]')) === '23', String(await inputValue('[data-testid="session-port"]')))
  check(
    '填写会话库记录',
    (await setInput('[data-testid="session-name"]', 'Telnet 测试设备')) &&
      (await setInput('[data-testid="session-host"]', '127.0.0.1')) &&
      (await setInput('[data-testid="session-port"]', String(MOCK_PORT))),
  )
  await shot('06-session-dialog')
  check('保存会话', await clickTestId('session-save'))
  check('会话出现在会话库', await hasText('Telnet 测试设备', 10_000))

  const nodeMeta = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="library-node"]')].map((el) => ({
      name: el.dataset.name,
      kind: el.dataset.kind,
      protocol: el.dataset.protocol,
    })),
  )
  const telnetNode = nodeMeta.find((n) => n.name === 'Telnet 测试设备')
  check('节点元数据标记为 telnet', telnetNode?.protocol === 'telnet', JSON.stringify(telnetNode))

  // 服务端落库的协议字段
  const tree = await fetch(`${BASE}/api/library`).then((r) => r.json()).catch(() => null)
  const saved = tree?.nodes?.find((n) => n.name === 'Telnet 测试设备')
  check('服务端记录 protocol=telnet', saved?.session?.protocol === 'telnet', JSON.stringify(saved?.session))
  check('服务端记录不含 credentialId', saved?.session?.credentialId === undefined, JSON.stringify(saved?.session))
  check('服务端记录不含 username', saved?.session?.username === undefined, JSON.stringify(saved?.session))
  // zod 会用 .default([]) 补上 jumpChain 字段，但必须是空的 —— 有跳板配置才算真出问题
  check(
    '服务端记录的跳板链为空',
    Array.isArray(saved?.session?.jumpChain) && saved.session.jumpChain.length === 0,
    JSON.stringify(saved?.session?.jumpChain),
  )

  // 悬停操作里不应出现 SFTP 入口：直接检查该节点内部
  const nodeHasSftp = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="library-node"]')].find(
      (n) => n.dataset.name === 'Telnet 测试设备',
    )
    if (!el) return null
    return [...el.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
  })
  check('Telnet 会话节点没有 SFTP 按钮', Array.isArray(nodeHasSftp) && !nodeHasSftp.includes('SFTP'), JSON.stringify(nodeHasSftp))

  // 服务端也必须拒绝：用 Telnet 会话 id 去开 SFTP，只能得到明确的错误
  const sftpOnTelnet = await fetch(`${BASE}/api/sftp/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: saved?.id, title: 'n/a' }),
  }).catch(() => null)
  const sftpErr = sftpOnTelnet ? await sftpOnTelnet.json().catch(() => null) : null
  check(
    '服务端拒绝对 Telnet 会话开 SFTP',
    sftpOnTelnet?.status === 400 && sftpErr?.error === 'INVALID_CONFIG',
    `${sftpOnTelnet?.status} ${sftpErr?.error ?? ''}`,
  )

  /* ---------------- 8. 从会话库连接 ---------------- */
  console.log('\n[8] 从会话库发起 Telnet 连接')
  check(
    '单击会话名即可连接',
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="library-node"]')].find(
        (n) => n.dataset.name === 'Telnet 测试设备',
      )
      const span = el?.querySelector('[role="button"]')
      if (!span) return false
      span.click()
      return true
    }),
  )
  const ready3 = await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="terminal-pane"][data-status="ready"]').length >= 3,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('会话库发起的 Telnet 终端就绪', ready3)
  check('新终端标记为 telnet', (await page.$eval(activePaneSel, (el) => el.dataset.protocol)) === 'telnet')
  await shot('07-from-library')

  /* ---------------- 9. 关闭与回收 ---------------- */
  console.log('\n[9] 关闭与回收')
  const listBefore = await fetch(`${BASE}/api/terminals`).then((r) => r.json()).catch(() => null)
  const telnetBefore = (listBefore?.terminals ?? []).filter((t) => t.protocol === 'telnet')
  check('服务端存在 3 个 Telnet 终端', telnetBefore.length === 3, String(telnetBefore.length))
  check('列表项 username 为空串（Telnet 无登录名）', telnetBefore.every((t) => t.username === ''), JSON.stringify(telnetBefore.map((t) => t.username)))
  check('列表项协议字段正确', telnetBefore.every((t) => t.protocol === 'telnet'))

  // 关闭当前活动标签，逐个关到 0
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => {
      const active = document.querySelector('[data-testid="terminal-pane"][data-active="true"]')
      const tabBar = document.querySelector('[role="tab"][aria-selected="true"]')
      if (tabBar) {
        const btn = [...tabBar.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') || '').startsWith('关闭'),
        )
        btn?.click()
      }
      return Boolean(active && tabBar)
    })
    await sleep(1200)
  }
  const listAfter = await fetch(`${BASE}/api/terminals`).then((r) => r.json()).catch(() => null)
  check('关闭后服务端终端已回收', (listAfter?.terminals ?? []).length === 0, JSON.stringify((listAfter?.terminals ?? []).length))
  await shot('08-closed')

  check('全程无未捕获的前端错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' / '))
} catch (err) {
  check(`执行异常：${err.message}`, false)
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n阶段 4 Telnet 浏览器端到端：${passed}/${results.length} 通过`)
if (passed !== results.length) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`)
}
process.exit(passed === results.length ? 0 : 1)
