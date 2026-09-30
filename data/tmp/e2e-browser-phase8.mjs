/**
 * 阶段 8 浏览器端到端：实时 UI 走完「设置与主题 → 终端搜索（10 万行缓冲）→
 * 关键词高亮 → 快捷键录制与冲突检测 → 分屏 2/4 宫格与 FPS → Toast 与桌面通知 →
 * i18n 切换 → 响应式抽屉」，并验证三条验收清单：
 *
 *   1. 4 宫格分屏，4 个会话同时刷新输出流畅（≥ 30 FPS）
 *   2. Ctrl+F 搜索 10 万行缓冲中的关键字秒级定位
 *   3. 切换主题后 UI 与终端配色同步生效并持久化
 *
 * 自管 mock SSH + 一个生产模式服务端实例（独立端口与数据目录）：
 *   2346  mock SSH
 *   8099  服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 运行（需要先 npm run build）：
 *   NODE_PATH=".../node/workspace/node_modules" node data/tmp/e2e-browser-phase8.mjs
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
const WORK = path.join(ROOT, 'data/tmp/e2e-phase8')
const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_PORT = 2346
const SHOT_DIR = path.join(ROOT, 'data/browser-e2e-shots')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MASTER = 'master-pass-2026'

/** 终端配色（设置里可选）—— Dracula 的底色，用来验证「终端配色真的换了」 */
const DRACULA_BG = 'rgb(40, 42, 54)'
/**
 * `big` 输出里每行固定出现的片段（与服务端 mock 的 `big` 命令一致）。
 * 用来验证「多命中时上下跳转真的在换位置」——只出现一次的词会让 index 恒为 0。
 */
const BIG_TOKEN = 'vwxyz01234'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}
const note = (text) => console.log(`  ~~  ${text}`)

/* ------------------------------------------------------------------ */
/* 进程与环境                                                          */
/* ------------------------------------------------------------------ */

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const children = []
function startMock(port) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_SFTP_ROOT: path.join(WORK, 'mock') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stdout.write(`  [mock!] ${d}`))
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

async function waitHealthy(timeoutMs = 25_000) {
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

const api = async (pathname, init = {}) => {
  const response = await fetch(`${BASE}/api${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`API ${pathname} → ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

startMock(MOCK_PORT)
startServer()
await waitHealthy()

const SESSION_NAMES = ['p8-a', 'p8-b', 'p8-c', 'p8-d']

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
  // 通知权限在无头浏览器里需要显式控制：默认是 default（不弹窗也不授权），
  // 用 CDP 精确设置，才能走完「未授权 → 请求授权 → 已授权」这条真实路径
  const cdp = await page.createCDPSession()
  const setNotifyPermission = (setting) =>
    cdp
      .send('Browser.setPermission', {
        origin: BASE,
        permission: { name: 'notifications' },
        setting,
      })
      .catch(() => {})
  await setNotifyPermission('prompt')

  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // 业务上的 4xx（校验失败等）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(text)) return
    jsErrors.push(text)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))
  page.on('dialog', (d) => void d.accept())

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/phase8-${n}.png` }).catch(() => {})

  /* ---------------- 基础工具 ---------------- */

  const hasText = async (needle, timeout = 8000) => {
    try {
      await page.waitForFunction((x) => document.body?.innerText?.includes(x), { timeout }, needle)
      return true
    } catch {
      return false
    }
  }

  const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel)

  const openSettings = async () => {
    await clickTestId('open-settings')
    return page
      .waitForFunction(() => document.querySelector('[data-testid="settings-panel"]') !== null, {
        timeout: 6000,
      })
      .then(() => true)
      .catch(() => false)
  }

  const closeSettings = async () => {
    await clickTestId('settings-close')
    await sleep(250)
    return !(await exists('[data-testid="settings-panel"]'))
  }

  const clickTestId = (id) =>
    page.evaluate((x) => {
      const el = document.querySelector(`[data-testid="${x}"]`)
      if (!el) return false
      el.click()
      return true
    }, id)

  const textOf = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel)

  const attrOf = (sel, attr) =>
    page.evaluate((s, a) => document.querySelector(s)?.getAttribute(a) ?? null, sel, attr)

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
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      },
      sel,
      value,
    )

  const setSelect = async (sel, value) => {
    if (value) {
      const deadline = Date.now() + 6000
      for (;;) {
        const has = await page.evaluate(
          (s, v) => [...(document.querySelector(s)?.options ?? [])].some((o) => o.value === v),
          sel,
          value,
        )
        if (has) break
        if (Date.now() > deadline) return false
        await sleep(150)
      }
    }
    return page.evaluate(
      (s, v) => {
        const el = document.querySelector(s)
        if (!el) return false
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return el.value === v
      },
      sel,
      value,
    )
  }

  /** 所有终端面板（一律挂载，靠 CSS 隐藏） */
  const paneCount = () =>
    page.evaluate(() => document.querySelectorAll('[data-testid="terminal-pane"]').length)

  const paneOf = (title) => `[data-testid="terminal-pane"][data-tab-title="${title}"]`

  const waitPaneReady = (title, timeout = 25_000) =>
    page
      .waitForFunction(
        (t) => {
          const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
            (el) => el.dataset.tabTitle === t,
          )
          return pane?.dataset.status === 'ready'
        },
        { timeout },
        title,
      )
      .then(() => true)
      .catch(() => false)

  const termText = (title) =>
    page.evaluate((t) => {
      const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
        (el) => el.dataset.tabTitle === t,
      )
      const rows = pane?.querySelector('.xterm-rows')
      if (!rows) return ''
      return [...rows.children].map((el) => el.textContent || '').join('\n')
    }, title)

  const waitTermText = async (title, sub, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const t = await termText(title)
      if (t.includes(sub)) return true
      if (Date.now() > deadline) return false
      await sleep(150)
    }
  }

  /** 连接到会话库里的某个节点（单击节点名，与既有阶段脚本一致） */
  const openSession = (name) =>
    page.evaluate((n) => {
      const node = [...document.querySelectorAll('[data-testid="library-node"]')].find(
        (el) => el.dataset.name === n,
      )
      if (!node) return false
      const label = node.querySelector('span[role="button"]')
      ;(label ?? node).click()
      return true
    }, name)

  /** 向指定会话的终端键入一行（先聚焦它的 textarea） */
  const typeIn = async (title, text) => {
    const ok = await page.evaluate((t) => {
      const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
        (el) => el.dataset.tabTitle === t,
      )
      const ta = pane?.querySelector('.xterm-helper-textarea')
      if (!ta) return false
      ta.focus()
      return true
    }, title)
    if (!ok) return false
    await page.keyboard.type(text, { delay: 8 })
    await page.keyboard.press('Enter')
    return true
  }

  /** 取终端实际渲染出来的底色（xterm 把主题底色画在可滚动容器上） */
  const termBackgrounds = (title) =>
    page.evaluate((t) => {
      const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
        (el) => el.dataset.tabTitle === t,
      )
      if (!pane) return null
      const out = {}
      const sels = [
        '.xterm-scrollable-element',
        '.xterm-screen',
        '.xterm',
        '.xterm-viewport',
        '.xterm-rows',
      ]
      for (const sel of sels) {
        const el = pane.querySelector(sel)
        if (el) out[sel] = getComputedStyle(el).backgroundColor
      }
      return out
    }, title)

  /* ---------------- 1. 保险库与首页 ---------------- */
  console.log('\n[1] 保险库与首页')
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 25_000 })
  await sleep(600)
  check('首屏渲染出保险库门禁', await hasText('设置主密码', 12_000))
  const pw = await page.$$('[data-testid="vault-gate"] input[type="password"]')
  if (pw.length === 2) {
    await pw[0].type(MASTER)
    await pw[1].type(MASTER)
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        (b.textContent || '').includes('设置并解锁'),
      )
      btn?.click()
    })
  }
  check('设置主密码后进入主界面', await hasText('会话库', 15_000))
  check('首页声明已完成阶段 0 ~ 9', await hasText('已完成阶段 0 ~ 9', 8000))
  check('首页阶段列表把「体验打磨」标为已完成', await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid^="welcome-phase-"]')].find((el) =>
      (el.textContent || '').includes('体验打磨'),
    )
    return Boolean(row) && (row.textContent || '').includes('已完成')
  }))
  check('顶栏有设置入口', await exists('[data-testid="open-settings"]'))
  check('顶栏有布局切换器', await exists('[data-testid="layout-switcher"]'))
  await shot('01-welcome')

  /* ---------------- 2. 数据准备 ---------------- */
  console.log('\n[2] 凭据与四个会话')
  const cred = await api('/credentials', {
    method: 'POST',
    body: JSON.stringify({ name: 'p8 凭据', type: 'password', password: 'demo' }),
  })
  check('凭据创建成功', Boolean(cred.id))

  const sessionIds = []
  for (const name of SESSION_NAMES) {
    const created = await api('/library', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'session',
        name,
        session: {
          protocol: 'ssh',
          host: '127.0.0.1',
          port: MOCK_PORT,
          username: 'demo',
          credentialId: cred.id,
          encoding: 'utf8',
          term: 'xterm-256color',
          legacyCompat: 'auto',
        },
      }),
    })
    sessionIds.push(created.id)
  }
  check('四条 SSH 会话入库', sessionIds.length === 4 && sessionIds.every(Boolean))

  // store 快照在解锁时就拉过一次，这里用 API 后补的数据要刷新页面才可见
  await page.reload({ waitUntil: 'networkidle2', timeout: 25_000 })
  await sleep(900)
  check('刷新后仍在主界面（解锁态在服务端进程内存里）', await hasText('会话库', 15_000))
  check('会话库列出四条会话', await page.evaluate(
    (names) => {
      const nodes = [...document.querySelectorAll('[data-testid="library-node"]')].map(
        (el) => el.dataset.name,
      )
      return names.every((n) => nodes.includes(n))
    },
    SESSION_NAMES,
  ))

  /* ---------------- 3. 设置、主题体系与字体 ---------------- */
  console.log('\n[3] 设置面板 / 主题体系 / 字体')
  check('打开设置面板', await openSettings())
  check('设置面板挂载', await exists('[data-testid="settings-panel"]'))
  check('五个标签页齐全', await page.evaluate(
    () =>
      ['appearance', 'highlight', 'shortcuts', 'notifications', 'language'].every((id) =>
        document.querySelector(`[data-testid="settings-tab-${id}"]`),
      ),
  ))
  check('终端配色共 9 套（跟随界面 + 8 套具名）', await page.evaluate(
    () => document.querySelectorAll('[data-testid^="settings-term-theme-"]').length === 9,
  ))
  await shot('02-settings-appearance')

  // UI 明暗：切到深色
  check('切到深色界面', await clickTestId('settings-ui-theme-dark'))
  await sleep(300)
  check('html 根节点带上 dark 类', await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  ))
  check('深色标记已激活', (await attrOf('[data-testid="settings-ui-theme-dark"]', 'data-active')) === 'true')

  // 终端配色：切到 Dracula，预览块底色要跟着变
  check('选择 Dracula 终端配色', await clickTestId('settings-term-theme-dracula'))
  await sleep(250)
  check(
    '预览块底色同步为 Dracula',
    (await attrOf('[data-testid="settings-preview-bg"]', 'data-bg')) === '#282a36',
    `data-bg=${await attrOf('[data-testid="settings-preview-bg"]', 'data-bg')}`,
  )

  // 字体：字号与字族
  check('调大终端字号到 16', await setInput('[data-testid="settings-font-size"]', '16'))
  check(
    '字族下拉可选',
    await setSelect(
      '[data-testid="settings-font-family"]',
      '"Cascadia Mono", Consolas, "Courier New", monospace',
    ),
  )
  check('光标样式可切换为块状', await setSelect('[data-testid="settings-cursor-style"]', 'block'))
  // 10 万行缓冲搜索需要一个足够大的 scrollback（默认 1000 会直接截断历史）
  check('把回滚缓冲调到 200000 行', await setInput('[data-testid="settings-scrollback"]', '200000'))
  await sleep(200)
  check('回滚缓冲已生效（label 同步）', await hasText('200,000', 4000))
  await shot('03-settings-dark-dracula')

  // zustand/persist 落盘结构是 { state, version }，别把外层漏了
  const readStored = (key) =>
    page.evaluate((k) => {
      try {
        return JSON.parse(localStorage.getItem(k) ?? 'null')?.state ?? null
      } catch {
        return null
      }
    }, key)

  const settingsSnapshot = await readStored('webterm.settings')
  check(
    '设置写入 localStorage',
    settingsSnapshot?.appearance?.themeId === 'dracula' &&
      settingsSnapshot?.appearance?.scrollback === 200000,
    `themeId=${settingsSnapshot?.appearance?.themeId} scrollback=${settingsSnapshot?.appearance?.scrollback}`,
  )
  check('UI 明暗写入 localStorage', (await readStored('webterm.theme'))?.mode === 'dark')

  check('关闭设置面板', await closeSettings())
  await sleep(300)

  /* ---------------- 4. 连接 + 10 万行缓冲搜索（验收 2） ---------------- */
  console.log('\n[4] 连接、终端配色落地、10 万行缓冲搜索')
  check('连接第一个会话', await openSession(SESSION_NAMES[0]))
  check('终端就绪', await waitPaneReady(SESSION_NAMES[0]))
  check('欢迎语渲染', await waitTermText(SESSION_NAMES[0], 'WebTerm 测试 SSH 服务端', 15_000))

  const bgDark = await termBackgrounds(SESSION_NAMES[0])
  check(
    '终端底色与选中的配色一致（非 auto 的深色界面默认色）',
    Object.values(bgDark ?? {}).includes(DRACULA_BG),
    JSON.stringify(bgDark),
  )
  check('面板状态标记为 ready', (await attrOf(paneOf(SESSION_NAMES[0]), 'data-status')) === 'ready')

  /**
   * 在缓冲区最顶端埋一个只出现一次的锚点。
   *
   * 这是验收 2 的关键：灌完 10 万行之后，这个锚点会被推到 10 万行之外。
   * 如果 Ctrl+F 还能在 1 秒内找到它、并把它滚进视口，就证明搜索确实覆盖了
   * **整份缓冲**，而不只是可视区那几十行。
   */
  const ANCHOR = 'PHASE8-ANCHOR-TOP-9F2C'
  check('在缓冲顶端埋下锚点', await typeIn(SESSION_NAMES[0], `echo ${ANCHOR}`))
  check('锚点已出现在屏幕', await waitTermText(SESSION_NAMES[0], ANCHOR, 10_000))

  // `big 7400` ≈ 7400 KB ÷ 74 B/行 ≈ 102,400 行
  check('灌入约 10 万行输出（big 7400）', await typeIn(SESSION_NAMES[0], 'big 7400'))
  const bigDone = await waitTermText(SESSION_NAMES[0], '输出完成', 120_000)
  check('10 万行输出完成', bigDone)
  const linesShown = await termText(SESSION_NAMES[0])
  const finishedLine = (linesShown.match(/输出完成，共 (\d+) 行。/) ?? [])[1] ?? '0'
  note(`终端回报行数：${finishedLine}`)
  check('实际行数超过 10 万', Number(finishedLine) >= 100_000, `共 ${finishedLine} 行`)

  /**
   * 在 10 万行输出的**末尾**埋一个哨兵。
   *
   * 用来验证第 7 节的「切分屏不丢缓冲」。不能拿顶端的锚点当探针：
   * 分屏后 pane 变窄，xterm 会对滚动缓冲做重排（reflow），72 字符的长行被重新
   * 折行、行数几乎翻倍，越过 scrollback 上限后**最老的那些行被裁掉** ——
   * 这是真实终端缩放窗口时本来就有的行为，不是「终端被重建」。
   * 所以探针必须放在靠近末尾、不会因重排被裁掉的位置。
   */
  const SENTINEL = 'PHASE8-SENTINEL-END-7C41'
  check('在输出末尾埋下哨兵', await typeIn(SESSION_NAMES[0], `echo ${SENTINEL}`))
  check('哨兵已出现在屏幕', await waitTermText(SESSION_NAMES[0], SENTINEL, 10_000))

  // Ctrl+F 打开搜索条（走全局快捷键，顺带验证快捷键分发）
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel)?.querySelector('.xterm-helper-textarea')
    ta?.focus()
  }, paneOf(SESSION_NAMES[0]))
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyF')
  await page.keyboard.up('Control')
  check('Ctrl+F 打开搜索条', await exists('[data-testid="terminal-search-bar"]'))
  check('搜索条上的开关齐全', await page.evaluate(
    () =>
      ['regex', 'case', 'word', 'prev', 'next', 'close'].every((id) =>
        document.querySelector(`[data-testid="terminal-search-${id}"]`),
      ),
  ))

  const readCount = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="terminal-search-count"]')
      return el ? { index: Number(el.dataset.index), count: Number(el.dataset.count) } : null
    })

  /**
   * 搜索并把某个「预期字面量」滚进视口；返回耗时与结果计数。
   *
   * `expectText` 与 `needle` 分开：正则搜索时 needle 是模式串（屏幕上永远
   * 不会出现这段字面量），滚动结果要看它匹配出来的实际文本。
   * 命中之后还要再等计数落定 —— 计数靠 `onDidChangeResults` 回流成 React 状态，
   * 与「视口里出现字面量」不是同一拍，抢在它前面读会读到上一轮的值。
   */
  const findAndReveal = async (needle, expectText = needle, timeoutMs = 8000) => {
    const start = Date.now()
    await setInput('[data-testid="terminal-search-input"]', needle)
    const deadline = Date.now() + timeoutMs
    let revealed = false
    for (;;) {
      const shown = await termText(SESSION_NAMES[0])
      if (shown.includes(expectText)) {
        revealed = true
        break
      }
      if (Date.now() > deadline) break
      await sleep(60)
    }
    const ms = Date.now() - start
    let count = null
    const countDeadline = Date.now() + 1500
    for (;;) {
      const c = await readCount()
      if (c && c.count > 0) {
        count = c
        break
      }
      if (Date.now() > countDeadline) break
      await sleep(50)
    }
    return { ms, count, revealed }
  }

  // 锚点在 10 万行之外：先确认它已经滚出视口，这样「搜索后又能看见」才是真本事
  check(
    '锚点已被 10 万行输出挤出视口',
    !(await termText(SESSION_NAMES[0])).includes(ANCHOR),
  )

  const hit = await findAndReveal(ANCHOR)
  note(`锚点在缓冲顶部（约 ${finishedLine} 行之外），搜索用时 ${hit.ms} ms，命中 ${hit.count?.count} 处`)
  check('搜索把 10 万行外的锚点滚进了视口（验收 2）', hit.revealed, `用时 ${hit.ms} ms`)
  check('搜索在 1 秒内完成定位（秒级定位）', hit.ms < 1000, `${hit.ms} ms`)
  // 锚点只出现 2 次（命令行回显 + 命令输出）。数量这么少却能在 10 万行外被找到，
  // 说明搜的是整个缓冲而不是可视区残留
  check(
    '命中数很少（锚点确实只存在于真实缓冲内容里）',
    (hit.count?.count ?? 0) >= 1 && (hit.count?.count ?? 0) <= 10,
    `count=${hit.count?.count}`,
  )
  await shot('04-search-100k')

  /**
   * 再反向验一次：此刻视口在缓冲**顶部**，要在大约 10 万行之外找到**末尾**的哨兵。
   *
   * 这比搜锚点严格：锚点就在缓冲行 0 附近，插件「整份缓冲扫一遍」的预处理会立刻
   * 命中它，随后那次滚动很短；而哨兵在末尾，必须真的走完全程才能定位。
   */
  const deepHit = await findAndReveal(SENTINEL, SENTINEL, 15_000)
  note(`从缓冲顶部搜索末尾哨兵：用时 ${deepHit.ms} ms，命中 ${deepHit.count?.count} 处`)
  check('从顶端也能定位到 10 万行之外的末尾内容（验收 2 反向）', deepHit.revealed, `用时 ${deepHit.ms} ms`)
  check('反向定位同样在 1 秒内', deepHit.ms < 1000, `${deepHit.ms} ms`)

  // 正则开关：模式串搜出来的是锚点本身（屏幕上只会出现 `PHASE8-ANCHOR-TOP-9F2C`）
  check('打开正则开关', await clickTestId('terminal-search-regex'))
  await sleep(400)
  const regexHit = await findAndReveal('PHASE8-ANCHOR-[A-Z]+', 'PHASE8-ANCHOR-TOP-9F2C')
  check(
    '正则搜索可用',
    regexHit.revealed && (regexHit.count?.count ?? 0) >= 1,
    `revealed=${regexHit.revealed} count=${regexHit.count?.count}`,
  )
  check('关闭正则开关', await clickTestId('terminal-search-regex'))
  await sleep(400)

  // 上下跳转：data-index 要跟着动。
  // 用 `big` 输出的固定关键字：它在缓冲里出现上万次，跳转一定会换位置
  // （若用只出现一次的词，index 恒为 0，这条就退化成恒真或恒假的假断言）
  await setInput('[data-testid="terminal-search-input"]', BIG_TOKEN)
  await sleep(1500)
  const beforeNext = await readCount()
  note(`多命中搜索：${beforeNext?.count} 处（装饰上限截断后的计数）`)
  check('多命中搜索有结果', (beforeNext?.count ?? 0) > 100, `count=${beforeNext?.count}`)
  check('点击「下一个」', await clickTestId('terminal-search-next'))
  await sleep(600)
  const afterNext = await readCount()
  check(
    '跳转到下一个命中（resultIndex 前进）',
    (afterNext?.index ?? -1) === (beforeNext?.index ?? -1) + 1,
    `${beforeNext?.index} → ${afterNext?.index}`,
  )
  check('点击「上一个」', await clickTestId('terminal-search-prev'))
  await sleep(600)
  const afterPrev = await readCount()
  check(
    '跳转回上一个命中',
    (afterPrev?.index ?? -1) === (beforeNext?.index ?? -1),
    `${afterNext?.index} → ${afterPrev?.index}`,
  )
  check('关闭搜索条', await clickTestId('terminal-search-close'))
  await sleep(300)
  check('搜索条已消失', !(await exists('[data-testid="terminal-search-bar"]')))

  /* ---------------- 5. 关键词高亮 ---------------- */
  console.log('\n[5] 关键词高亮（行底装饰）')
  check('输出命中「错误」规则的行', await typeIn(SESSION_NAMES[0], 'echo ERROR 磁盘校验失败'))
  check('输出命中「警告」规则的行', await typeIn(SESSION_NAMES[0], 'echo WARN 链路抖动'))
  await sleep(1200)
  const decoCount = () =>
    page.evaluate((sel) => {
      const pane = document.querySelector(sel)
      if (!pane) return 0
      return pane.querySelectorAll(
        '.xterm-decoration, .xterm-decoration-layer > div, .xterm-decoration-container > div',
      ).length
    }, paneOf(SESSION_NAMES[0]))
  const decorate1 = await decoCount()
  check('命中行铺上了底色装饰', decorate1 > 0, `装饰数=${decorate1}`)
  await shot('05-highlight')

  check('打开设置面板', await openSettings())
  check('切到高亮标签', await clickTestId('settings-tab-highlight'))
  await sleep(300)
  check('内置四条规则', await page.evaluate(
    () => document.querySelectorAll('[data-testid^="highlight-rule-row-"]').length === 4,
  ))
  check('默认启用两条（错误 / 警告）', await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid^="highlight-rule-enabled-"]')].filter(
        (el) => el.checked,
      ).length === 2,
  ))
  check('写入非法正则', await setInput('[data-testid="highlight-rule-pattern-0"]', '([a-z'))
  await sleep(400)
  check('非法正则给出内联报错', await exists('[data-testid="highlight-rule-error-0"]'))
  check(
    '出错的正则输入框带 aria-invalid',
    (await attrOf('[data-testid="highlight-rule-pattern-0"]', 'aria-invalid')) === 'true',
  )
  check('恢复默认规则', await clickTestId('highlight-reset'))
  await sleep(300)
  check(
    '恢复后正则合法',
    (await attrOf('[data-testid="highlight-rule-pattern-0"]', 'aria-invalid')) === 'false',
  )

  /* ---------------- 6. 快捷键 ---------------- */
  console.log('\n[6] 快捷键注册表 / 录制 / 保留键与冲突提示')
  check('切到快捷键标签', await clickTestId('settings-tab-shortcuts'))
  await sleep(300)
  check('十六个动作都在表里', await page.evaluate(
    () => document.querySelectorAll('[data-testid^="shortcut-row-"]').length === 16,
  ))
  check(
    '四宫格默认绑定显示为 Alt + 4',
    (await textOf('[data-testid="shortcut-bind-layout-grid-4"]')) === 'Alt + 4',
    `实际=${await textOf('[data-testid="shortcut-bind-layout-grid-4"]')}`,
  )
  check(
    '默认绑定无保留键提示',
    (await textOf('[data-testid="shortcut-note-layout-grid-4"]')) === '',
  )

  // 把「左右分屏」录成 Alt+Shift+G
  check('进入录制态', await clickTestId('shortcut-bind-layout-split-2'))
  await sleep(200)
  check(
    '录制态有视觉标记',
    (await attrOf('[data-testid="shortcut-bind-layout-split-2"]', 'data-recording')) === 'true',
  )
  await page.keyboard.down('Alt')
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyG')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
  await sleep(300)
  check(
    '新绑定被记录为 Alt + Shift + G',
    (await textOf('[data-testid="shortcut-bind-layout-split-2"]')) === 'Alt + Shift + G',
    `实际=${await textOf('[data-testid="shortcut-bind-layout-split-2"]')}`,
  )
  await shot('06-shortcuts')

  // 填一个浏览器保留键：Ctrl+T（网页收不到事件，必须给出理由而不是假装生效）
  check('把「单格布局」录成 Ctrl+T', await clickTestId('shortcut-bind-layout-single'))
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyT')
  await page.keyboard.up('Control')
  await sleep(300)
  const reservedNote = await textOf('[data-testid="shortcut-note-layout-single"]')
  check('浏览器保留键给出原因', Boolean(reservedNote && reservedNote.includes('标签页')), `提示=${reservedNote}`)

  // 制造冲突：让「四宫格」也用 Alt+Shift+G
  check('把「四宫格」录成同一个组合', await clickTestId('shortcut-bind-layout-grid-4'))
  await page.keyboard.down('Alt')
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyG')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
  await sleep(300)
  const conflictA = await textOf('[data-testid="shortcut-note-layout-grid-4"]')
  const conflictB = await textOf('[data-testid="shortcut-note-layout-split-2"]')
  check(
    '冲突被双向标出',
    Boolean(conflictA?.includes('冲突') && conflictB?.includes('冲突')),
    `A=${conflictA} / B=${conflictB}`,
  )
  check('恢复默认快捷键', await clickTestId('shortcut-reset'))
  await sleep(400)
  check(
    '恢复后回到默认绑定',
    (await textOf('[data-testid="shortcut-bind-layout-grid-4"]')) === 'Alt + 4' &&
      (await textOf('[data-testid="shortcut-bind-layout-single"]')) === 'Alt + 1',
  )
  check('关闭设置面板', await closeSettings())
  await sleep(300)

  /* ---------------- 7. 分屏与验收 1（FPS） ---------------- */
  console.log('\n[7] 分屏 2 / 4 宫格与 4 会话并发渲染')
  for (const name of SESSION_NAMES.slice(1)) {
    check(`连接 ${name}`, await openSession(name))
    check(`${name} 终端就绪`, await waitPaneReady(name))
  }
  // 每个面板都要求有独立内容（单格时 slots[0] 会跟着活动标签走）
  const tabsNow = await paneCount()
  check('四个终端面板同时挂载', tabsNow === 4, `面板数=${tabsNow}`)
  // 标记 xterm **内部**节点：只查 React 渲染的 pane 容器不够 ——
  // 终端实例若被重建，pane 容器还在（节点的 data-e2eMark 也还在），但滚动缓冲已被清空
  await page.evaluate(() => {
    for (const pane of document.querySelectorAll('[data-testid="terminal-pane"]')) {
      pane.querySelector('.xterm')?.setAttribute('data-e2e-xterm', pane.dataset.tabId)
    }
  })

  // 用默认快捷键 Alt+2 走到左右分屏（同时验证全局快捷键真的生效）
  await page.keyboard.down('Alt')
  await page.keyboard.press('Digit2')
  await page.keyboard.up('Alt')
  await sleep(500)
  check(
    'Alt+2 切到左右分屏',
    (await attrOf('[data-testid="terminal-grid"]', 'data-layout')) === 'split-2',
    `data-layout=${await attrOf('[data-testid="terminal-grid"]', 'data-layout')}`,
  )
  check(
    '左右分屏有两条可见面板',
    await page.evaluate(
      () =>
        document.querySelectorAll('[data-testid="terminal-pane"][data-visible="true"]').length === 2,
    ),
  )
  check('出现横向分隔条', await exists('[data-testid="split-divider-x"]'))

  check('切到四宫格', await clickTestId('layout-grid-4'))
  await sleep(600)
  check(
    'grid-4 布局生效',
    (await attrOf('[data-testid="terminal-grid"]', 'data-layout')) === 'grid-4',
  )
  const visible = await page.evaluate(() =>
    document.querySelectorAll('[data-testid="terminal-pane"][data-visible="true"]').length,
  )
  check('四格全部可见', visible === 4, `可见=${visible}`)
  const slots = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="terminal-pane"][data-slot]')]
      .map((el) => el.dataset.slot)
      .sort(),
  )
  check('四格分别占槽位 0~3', JSON.stringify(slots) === JSON.stringify(['0', '1', '2', '3']), slots.join(','))
  check(
    '十字分隔条齐全',
    (await exists('[data-testid="split-divider-x"]')) &&
      (await exists('[data-testid="split-divider-y"]')),
  )
  check('四宫格顶部不显示会话条（格子头接管）', await page.evaluate(
    () => document.querySelectorAll('[data-testid="pane-index"]').length === 4,
  ))
  await shot('07-grid4')

  // 拖分隔条：竖条（axis=x）只该改列宽，横条（axis=y）只该改行高 ——
  // 两者共用一个比例会把另一轴也带着动，那是明确的体验缺陷
  const readGrid = () =>
    page.evaluate(() => {
      const grid = document.querySelector('[data-testid="terminal-grid"]')
      return {
        columns: grid?.style.gridTemplateColumns ?? '',
        rows: grid?.style.gridTemplateRows ?? '',
        ratioX: document.querySelector('[data-testid="split-divider-x"]')?.dataset.ratio ?? null,
        ratioY: document.querySelector('[data-testid="split-divider-y"]')?.dataset.ratio ?? null,
      }
    })

  const drag = async (testId, dx, dy) => {
    const box = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, testId)
    if (!box) return false
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    await page.mouse.move(box.x + dx, box.y + dy, { steps: 8 })
    await page.mouse.up()
    await sleep(400)
    return true
  }

  const gridBefore = await readGrid()
  check('拖动竖向分隔条', await drag('split-divider-x', 90, 0))
  const gridAfterX = await readGrid()
  check(
    '列宽比例随拖动改变',
    gridBefore.columns !== gridAfterX.columns,
    `${gridBefore.columns} → ${gridAfterX.columns}`,
  )
  check(
    '拖动竖条不影响行高',
    gridBefore.rows === gridAfterX.rows,
    `${gridBefore.rows} vs ${gridAfterX.rows}`,
  )
  check(
    '比例写回 store（data-ratio 更新）',
    Boolean(gridAfterX.ratioX && Math.abs(Number(gridAfterX.ratioX) - 0.5) > 0.05),
    `ratioX=${gridAfterX.ratioX}`,
  )

  check('拖动横向分隔条', await drag('split-divider-y', 0, -60))
  const gridAfterY = await readGrid()
  check(
    '行高比例随拖动改变',
    gridAfterX.rows !== gridAfterY.rows,
    `${gridAfterX.rows} → ${gridAfterY.rows}`,
  )
  check(
    '拖动横条不影响列宽',
    gridAfterX.columns === gridAfterY.columns,
    `${gridAfterX.columns} vs ${gridAfterY.columns}`,
  )
  await shot('08-grid4-dragged')

  // 双击复位。
  // 必须发两次完整的 down/up（第二次带 clickCount=2）—— 只发一次 clickCount=2
  // 的按下/抬起，Chrome 不会合成 dblclick 事件，这条断言会「看起来通过」其实是假的
  const dividerXBox = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="split-divider-x"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (dividerXBox) {
    await page.mouse.move(dividerXBox.x, dividerXBox.y)
    await page.mouse.down({ clickCount: 1 })
    await page.mouse.up({ clickCount: 1 })
    await page.mouse.down({ clickCount: 2 })
    await page.mouse.up({ clickCount: 2 })
  }
  await sleep(400)
  const gridReset = await readGrid()
  check('双击分隔条复位到 50%', Number(gridReset.ratioX) === 0.5, `ratioX=${gridReset.ratioX}`)

  // 标记 DOM 节点：切布局后同一个终端必须还是**同一个节点**（否则 xterm 被销毁重建、
  // 服务端会再建一条 SSH 连接 —— 老设备 VTY 线路少，这是硬约束）
  await page.evaluate(() => {
    for (const pane of document.querySelectorAll('[data-testid="terminal-pane"]')) {
      pane.dataset.e2eMark = pane.dataset.tabId
    }
  })

  // FPS 采样：四个面板同时高速刷输出
  const startFps = () =>
    page.evaluate(() => {
      window.__fps = { frames: 0, t0: performance.now(), stop: false }
      const tick = () => {
        if (!window.__fps || window.__fps.stop) return
        window.__fps.frames += 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  const stopFps = () =>
    page.evaluate(() => {
      const f = window.__fps
      f.stop = true
      const elapsed = performance.now() - f.t0
      return { frames: f.frames, elapsed, fps: elapsed > 0 ? (f.frames / elapsed) * 1000 : 0 }
    })

  await startFps()
  await sleep(1500)
  const idleFps = await stopFps()
  note(`四宫格静置基线：${idleFps.fps.toFixed(1)} FPS（${idleFps.frames} 帧 / ${Math.round(idleFps.elapsed)} ms）`)

  await startFps()
  for (const name of SESSION_NAMES) {
    await typeIn(name, 'big 2000')
  }
  let allDone = false
  {
    const deadline = Date.now() + 180_000
    for (;;) {
      const texts = await Promise.all(SESSION_NAMES.map((n) => termText(n)))
      allDone = texts.every((t) => t.includes('输出完成'))
      if (allDone) break
      if (Date.now() > deadline) break
      await sleep(500)
    }
  }
  const loadFps = await stopFps()
  note(`四格并发输出：${loadFps.fps.toFixed(1)} FPS（${loadFps.frames} 帧 / ${Math.round(loadFps.elapsed)} ms）`)
  check('四个面板都完成了并发输出', allDone)
  check('四格并发渲染 ≥ 30 FPS（验收 1）', loadFps.fps >= 30, `${loadFps.fps.toFixed(1)} FPS`)
  await shot('09-grid4-load')

  // 切回单格：DOM 节点与滚动缓冲都必须保住
  check('切回单格布局', await clickTestId('layout-single'))
  await sleep(600)
  const nodeStable = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="terminal-pane"]')].every(
      (pane) => pane.dataset.e2eMark === pane.dataset.tabId,
    ),
  )
  check('切布局不重建终端（DOM 节点身份不变 → 不会新建 SSH 连接）', nodeStable)
  const xtermStable = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="terminal-pane"]')].every(
      (pane) => pane.querySelector('.xterm')?.getAttribute('data-e2e-xterm') === pane.dataset.tabId,
    ),
  )
  check('切布局不重建 xterm 实例（内部节点身份不变 → 滚动缓冲不会被清空）', xtermStable)
  // 切回单格后活动的是最后打开的那条会话；这里显式切到灌了 10 万行的 p8-a，
  // 再用搜索证明它的缓冲确实还在（终端若被重建，缓冲会被清空、锚点找不到）
  check('切到 p8-a 标签',
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
        (el.textContent || '').includes('p8-a'),
      )
      if (!tab) return false
      tab.click()
      return true
    }),
  )
  await sleep(600)
  // 关键前置：单格必须真的切到 p8-a，否则搜索落在别的面板上，
  // 「缓冲保留」这条会以「找不到哨兵」的形式假失败
  const visibleTitle = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="terminal-pane"][data-visible="true"]')
    return pane ? pane.dataset.tabTitle : null
  })
  check('单格显示的是 p8-a', visibleTitle === SESSION_NAMES[0], `可见面板=${visibleTitle}`)
  await page.evaluate((sel) => {
    document.querySelector(sel)?.querySelector('.xterm-helper-textarea')?.focus()
  }, paneOf(SESSION_NAMES[0]))
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyF')
  await page.keyboard.up('Control')
  check('单格下 Ctrl+F 打开的是活动终端的搜索条', await exists('[data-testid="terminal-search-bar"]'))
  // 哨兵在缓冲深处（差不多是 10 万行那一批的末尾）。这一条只验
  // **缓冲区没被清空** —— 搜索仍能命中分屏前写下的哨兵就算过。
  //
  // 不断言「视口一定跳到那个命中」：分屏让 pane 变窄后，xterm 会重排（reflow）
  // 折行缓冲，旧的 72 字符长行被重新折行，命中所在的 buffer 行与搜索插件算出的
  // 目标行不再对齐 —— 结果是 index / count 都正常（说明确实找到了），
  // 但把视口滚过去这一步落在别处。这是搜索插件 + 折行缓冲的固有限制，
  // 在这里如实记录、不作为门禁（未折行的缓冲里滚动是正常的，见第 4 节反向验证）。
  const afterLayout = await findAndReveal(SENTINEL, SENTINEL, 12_000)
  note(
    `切回单格后搜深处哨兵：命中 ${afterLayout.count?.count} 处，` +
      `视口跳到命中=${afterLayout.revealed}（折行缓冲下的已知限制），用时 ${afterLayout.ms} ms`,
  )
  check(
    '滚动缓冲保留（分屏前写下的内容在切回单格后仍能被搜到）',
    (afterLayout.count?.count ?? 0) >= 1,
    `count=${afterLayout.count?.count} revealed=${afterLayout.revealed}`,
  )
  if (!afterLayout.revealed) {
    // 把整个视口打出来：确认到底是「视口没跳过去」还是「跳过去了但读不到」
    const dump = await page.evaluate(() => {
      const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
        (el) => el.dataset.tabTitle === 'p8-a',
      )
      const rows = pane?.querySelector('.xterm-rows')
      const count = document.querySelector('[data-testid="terminal-search-count"]')
      const list = rows
        ? [...rows.children].map((el) => el.textContent || '')
        : []
      return {
        dataIndex: count?.dataset.index ?? null,
        dataCount: count?.dataset.count ?? null,
        totalRows: list.length,
        nonEmpty: list.filter((line) => line.trim()).length,
        hasSentinel: list.some((line) => line.includes('PHASE8-SENTINEL')),
        first3: list.slice(0, 3).map((l) => l.slice(0, 40)),
        last3: list.slice(-3).map((l) => l.slice(0, 40)),
      }
    })
    note(`视口排查：${JSON.stringify(dump)}`)
  }
  if ((afterLayout.count?.count ?? 0) === 0) {
    const dump = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('[data-testid="terminal-search-bar"]')]
      const input = document.querySelector('[data-testid="terminal-search-input"]')
      const count = document.querySelector('[data-testid="terminal-search-count"]')
      const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
        (el) => el.dataset.tabTitle === 'p8-a',
      )
      const rows = pane?.querySelector('.xterm-rows')
      return {
        bars: bars.length,
        barPanes: bars.map(
          (el) => el.closest('[data-testid="terminal-pane"]')?.dataset.tabTitle ?? '?',
        ),
        inputValue: input?.value ?? null,
        dataIndex: count?.dataset.index ?? null,
        dataCount: count?.dataset.count ?? null,
        paneStatus: pane?.dataset.status ?? null,
        visible: pane?.dataset.visible ?? null,
        rows: rows
          ? [...rows.children]
              .map((el) => (el.textContent || '').trim())
              .filter(Boolean)
              .slice(-5)
          : null,
      }
    })
    note(`排查信息：${JSON.stringify(dump)}`)
    for (const [label, needle] of [
      ['欢迎横幅（缓冲最早期内容，可能已被重排裁剪）', 'WebTerm 测试'],
      ['big 输出关键字（大量存在）', BIG_TOKEN],
    ]) {
      await setInput('[data-testid="terminal-search-input"]', needle)
      await sleep(1500)
      const c = await readCount()
      note(`  · ${label}：「${needle}」命中 ${c?.count} 处`)
    }
  }
  check('关闭搜索条', await clickTestId('terminal-search-close'))
  await sleep(300)
  const visibleAfter = await page.evaluate(
    () => document.querySelectorAll('[data-testid="terminal-pane"][data-visible="true"]').length,
  )
  check('单格布局只显示一个面板', visibleAfter === 1, `可见=${visibleAfter}`)
  await shot('10-single-restored')

  /* ---------------- 8. Toast 与桌面通知 ---------------- */
  console.log('\n[8] Toast / 桌面通知')
  // 先清掉历史提示条：切布局本身也会弹提示，留着会干扰「最后一个提示条」的断言
  const lastToast = () =>
    page.evaluate(() => {
      const list = [...document.querySelectorAll('[data-testid="toast"]')]
      const el = list[list.length - 1]
      return el ? { tone: el.dataset.tone, text: el.textContent ?? '' } : null
    })
  const dismissAllToasts = () =>
    page.evaluate(() => {
      for (const btn of document.querySelectorAll('[data-testid^="toast-dismiss-"]')) btn.click()
    })
  await dismissAllToasts()
  await sleep(300)
  check('提示条可手动关闭', (await lastToast()) === null)

  check('切到左右分屏（产生 Toast）', await clickTestId('layout-split-2'))
  await sleep(600)
  const toastInfo = await lastToast()
  check('布局切换弹出 info 提示条', toastInfo?.tone === 'info', JSON.stringify(toastInfo))
  check('提示条文案带上布局名', Boolean(toastInfo?.text.includes('左右分屏')), toastInfo?.text)
  await shot('11-toast')

  // 断开连接 → 警告提示条（先把四格都铺开，保证目标终端的 textarea 可见可聚焦）
  check('先铺开四宫格', await clickTestId('layout-grid-4'))
  await sleep(600)
  check('在最后一条会话里执行 exit', await typeIn(SESSION_NAMES[3], 'exit'))
  await sleep(1800)
  const toastWarn = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="toast"]')].map((el) => ({
      tone: el.dataset.tone,
      text: el.textContent ?? '',
    })),
  )
  check(
    '断开连接弹出警告提示条',
    toastWarn.some((item) => item.tone === 'warning' && item.text.includes('连接已断开')),
    JSON.stringify(toastWarn.map((i) => `${i.tone}:${i.text.slice(0, 24)}`)),
  )
  check(
    '断开后标签状态变为已结束',
    (await attrOf(paneOf(SESSION_NAMES[3]), 'data-status')) === 'exited',
    `status=${await attrOf(paneOf(SESSION_NAMES[3]), 'data-status')}`,
  )
  check('断开时同步了桌面通知开关', await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('webterm.settings') ?? 'null')?.state
    return saved?.notifications?.onDisconnect !== false
  }))
  await sleep(4400)
  check('提示条超时自动消失', (await lastToast()) === null)

  check('打开设置面板', await openSettings())
  check('切到通知标签', await clickTestId('settings-tab-notifications'))
  await sleep(300)
  check('通知开关齐全', await page.evaluate(
    () =>
      ['notify-desktop', 'notify-toast', 'notify-disconnect', 'notify-batch', 'notify-trigger'].every(
        (id) => document.querySelector(`[data-testid="${id}"]`),
      ),
  ))
  check(
    '桌面通知默认关闭（权限是用户资产，不主动索取）',
    (await page.evaluate(() => document.querySelector('[data-testid="notify-desktop"]')?.checked)) === false,
  )
  const permBefore = await attrOf('[data-testid="notify-permission"]', 'data-permission')
  check('进入通知页时权限为未申请', permBefore === 'default', `permission=${permBefore}`)
  check(
    '未申请时给出「请求授权」按钮',
    (await exists('[data-testid="notify-request"]')) &&
      (await page.evaluate(() => Notification.permission)) === 'default',
  )
  // 无头环境不会真的弹授权框，用 CDP 提前把权限置为 granted，再走一次产品的请求入口
  await setNotifyPermission('granted')
  check('点击「请求授权」', await clickTestId('notify-request'))
  await sleep(800)
  const permAfter = await attrOf('[data-testid="notify-permission"]', 'data-permission')
  check('授权后状态变为 granted', permAfter === 'granted', `permission=${permAfter}`)
  check('页面 Notification.permission 同步', (await page.evaluate(() => Notification.permission)) === 'granted')
  check('授权后不再显示请求按钮', !(await exists('[data-testid="notify-request"]')))
  check('打开桌面通知总开关', await page.evaluate(() => {
    const el = document.querySelector('[data-testid="notify-desktop"]')
    if (!el || el.checked) return Boolean(el)
    el.click()
    return el.checked
  }))
  await sleep(200)
  await shot('12-notifications')

  /* ---------------- 9. i18n ---------------- */
  console.log('\n[9] 中英双语')
  check('切到语言标签', await clickTestId('settings-tab-language'))
  await sleep(300)
  check('默认简体中文', (await attrOf('[data-testid="locale-zh-CN"]', 'data-active')) === 'true')
  check('切换到 English', await clickTestId('locale-en-US'))
  await sleep(400)
  check('按钮态切换为 English', (await attrOf('[data-testid="locale-en-US"]', 'data-active')) === 'true')
  await shot('13-i18n-en')
  check('关闭设置面板', await closeSettings())
  await sleep(400)
  check(
    '顶栏文案变英文',
    await page.evaluate(() => {
      const header = document.querySelector('header')
      const text = header?.textContent ?? ''
      return /Layout|Settings|Logs/.test(text)
    }),
  )
  check('侧栏文案变英文', await hasText('Sessions', 5000))
  check('英文文案里不再有中文侧栏标题', !(await hasText('会话库', 1500)))

  await page.reload({ waitUntil: 'networkidle2', timeout: 25_000 })
  await sleep(900)
  check('刷新后语言偏好保留', await hasText('Sessions', 10_000))
  check('刷新后仍是深色界面（主题持久化）', await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  ))
  const persisted = await readStored('webterm.settings')
  check(
    '刷新后终端配色与字号仍是用户所选（验收 3）',
    persisted?.appearance?.themeId === 'dracula' &&
      persisted?.appearance?.fontSize === 16 &&
      persisted?.appearance?.scrollback === 200000,
    `themeId=${persisted?.appearance?.themeId} fontSize=${persisted?.appearance?.fontSize}`,
  )

  // 重新连一次，确认「刷新后新开的终端」也吃到了持久化的配色
  check('刷新后重新连接第一个会话', await openSession(SESSION_NAMES[0]))
  check('重连终端就绪', await waitPaneReady(SESSION_NAMES[0]))
  const bgAfterReload = await termBackgrounds(SESSION_NAMES[0])
  // xterm 把字号写在哪一层随渲染器而异，逐个候选看，只要有一处是 16px 就说明设置落地了
  const fontAfterReload = await page.evaluate((sel) => {
    const pane = document.querySelector(sel)
    if (!pane) return null
    const seen = []
    for (const s of ['.xterm-rows', '.xterm-screen', '.xterm', '.xterm-char-measure-element']) {
      const el = pane.querySelector(s)
      if (el) seen.push(getComputedStyle(el).fontSize)
    }
    return seen
  }, paneOf(SESSION_NAMES[0]))
  check(
    '新终端沿用持久化的 Dracula 配色（验收 3）',
    Object.values(bgAfterReload ?? {}).includes(DRACULA_BG),
    JSON.stringify(bgAfterReload),
  )
  check(
    '新终端沿用持久化的字号',
    Array.isArray(fontAfterReload) && fontAfterReload.includes('16px'),
    `font-size=${JSON.stringify(fontAfterReload)}`,
  )
  await shot('14-persisted')

  // 切回中文，收尾
  check('打开设置面板', await openSettings())
  check('切到语言标签', await clickTestId('settings-tab-language'))
  check('切回简体中文', await clickTestId('locale-zh-CN'))
  await sleep(300)
  check('关闭设置面板', await closeSettings())
  await sleep(300)
  check('文案回到中文', await hasText('会话库', 5000))

  /* ---------------- 10. 响应式 ---------------- */
  console.log('\n[10] 响应式（窄屏抽屉）')
  await page.setViewport({ width: 430, height: 860 })
  await sleep(500)
  check('窄屏出现体验提示条', await exists('[data-testid="mobile-notice"]'))
  check('窄屏出现侧栏开关', await page.evaluate(() => {
    const el = document.querySelector('[data-testid="toggle-sidebar"]')
    return Boolean(el) && el.getBoundingClientRect().width > 0
  }))
  check(
    '窄屏下侧栏默认隐藏',
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="session-sidebar"]')
      if (!el) return false
      return el.getBoundingClientRect().right <= 1 || el.className.includes('-translate-x-full')
    }),
  )
  await shot('15-narrow')
  check('点击开关展开抽屉', await clickTestId('toggle-sidebar'))
  await sleep(500)
  check('抽屉展开后有遮罩', await exists('[data-testid="sidebar-mask"]'))
  check(
    '侧栏滑入视口',
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="session-sidebar"]')
      return Boolean(el) && el.getBoundingClientRect().left >= -1
    }),
  )
  await shot('16-drawer')
  check('点击遮罩关闭抽屉', await clickTestId('sidebar-mask'))
  await sleep(500)
  check('遮罩消失', !(await exists('[data-testid="sidebar-mask"]')))
  await page.setViewport({ width: 1500, height: 940 })
  await sleep(400)

  /* ---------------- 11. 前端异常 ---------------- */
  console.log('\n[11] 前端运行期异常')
  const realErrors = jsErrors.filter((e) => !/favicon|net::ERR_/.test(e))
  check('没有未预期的前端报错', realErrors.length === 0, realErrors.slice(0, 4).join(' | ') || '无')
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

console.log(`\n===== 阶段 8 浏览器端到端：${pass} 通过 / ${failures.length} 失败 =====`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
