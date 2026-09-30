/**
 * 阶段 7 浏览器端到端：真实 UI 走完「启用日志 → 终端交互 → HTML 快照上传 →
 * 日志页预览/下载/删除 → 审计页 → 设置页」，并验证验收条件
 * 「HTML 日志在浏览器打开颜色正确」。
 *
 * 自管 mock SSH + 一个生产模式服务端实例（独立端口与数据目录）：
 *   2345  mock SSH
 *   8098  服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 运行（需要先 npm run build）：
 *   NODE_PATH=".../node/workspace/node_modules" node data/tmp/e2e-browser-logging.mjs
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
const WORK = path.join(ROOT, 'data/tmp/e2e-logging-browser')
const PORT = 8098
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_PORT = 2345
const SHOT_DIR = path.join(ROOT, 'data/browser-e2e-shots')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MASTER = 'master-pass-2026'

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
    // 业务上的 4xx（校验失败等）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(t)) return
    jsErrors.push(t)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))
  page.on('dialog', (d) => void d.accept())

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/logging-${n}.png` }).catch(() => {})

  const hasText = async (t, timeout = 8000) => {
    try {
      await page.waitForFunction((x) => document.body?.innerText?.includes(x), { timeout }, t)
      return true
    } catch {
      return false
    }
  }

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

  /**
   * 设置 React 受控 select（走 change 事件）。
   * value 非空时必须先等该 option 出现 —— 凭据下拉是异步加载的，
   * 对不存在 option 赋值会被浏览器静默置空，导致「选择凭据」假通过、保存时校验失败。
   */
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

  /** 按标题点击工作区标签（typeLine 只作用于 data-active="true" 的终端） */
  const selectTab = (title) =>
    page.evaluate((t) => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
        (el.textContent || '').includes(t),
      )
      if (!tab) return false
      tab.click()
      return true
    }, title)

  const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel)
  const clickChecked = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el || el.disabled) return false
      if (!el.checked) el.click()
      return el.checked
    }, sel)

  const activePaneSel = '[data-testid="terminal-pane"][data-active="true"]'
  const typeLine = async (text) => {
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
  const termText = () =>
    page.evaluate((sel) => {
      const pane = document.querySelector(sel)
      const rows = pane?.querySelector('.xterm-rows')
      if (!rows) return ''
      return [...rows.children].map((el) => el.textContent || '').join('\n')
    }, activePaneSel)
  const waitTermText = async (sub, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const text = await termText()
      if (text.includes(sub)) return true
      if (Date.now() > deadline) return false
      await sleep(150)
    }
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
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('设置并解锁'))
      btn?.click()
    })
  }
  check('设置主密码后进入主界面', await hasText('会话库', 12_000))
  check('顶部有「日志」入口', await exists('[data-testid="open-logs"]'))
  // 首页实施进度要与真实交付状态一致（阶段 9 完成，全部阶段收口）
  check('首页进度标注「已完成阶段 0 ~ 9」', await hasText('已完成阶段 0 ~ 9', 6000))
  check(
    '首页收口说明发布形态已就绪',
    (await hasText('发布形态已就绪', 4000)) || (await hasText('npm 全局包', 2000)),
  )
  check('首页阶段列表把「日志与审计」标为已完成', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid^="welcome-phase-"]')]
    const row = rows.find((el) => (el.textContent || '').includes('日志与审计'))
    return Boolean(row) && (row.textContent || '').includes('已完成')
  }))
  check('首页阶段列表把「体验打磨」标为已完成', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid^="welcome-phase-"]')]
    const row = rows.find((el) => (el.textContent || '').includes('体验打磨'))
    return Boolean(row) && (row.textContent || '').includes('已完成')
  }))

  /* ---------------- 2. 准备凭据与会话 ---------------- */
  console.log('\n[2] 凭据与会话库记录')
  const cred = await api('/credentials', {
    method: 'POST',
    body: JSON.stringify({ name: 'e2e 凭据', type: 'password', password: 'demo' }),
  })
  check('凭据创建成功', Boolean(cred.id))

  // 会话弹窗的凭据下拉读的是 store 快照，而 store 只在解锁 / 删除后刷新。
  // 这里用 API 在解锁之后才建凭据，能否被下拉看到取决于竞态 —— 刷一次页面让 store 重新拉取。
  // （解锁态存在服务端进程内存里，刷新浏览器不会要求重新解锁）
  await page.reload({ waitUntil: 'networkidle2', timeout: 20_000 })
  await sleep(800)
  check('刷新后仍在主界面（解锁态不随刷新丢失）', await hasText('会话库', 12_000))
  check('刷新后弹窗可用的凭据已就绪', await page.evaluate(async () => {
    const res = await fetch('/api/credentials')
    if (!res.ok) return false
    const data = await res.json()
    return (data.credentials ?? []).length >= 1
  }))

  check('点击「+会话」', await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('+会话'))
    btn?.click()
    return Boolean(btn)
  }))
  await sleep(400)
  check('会话弹窗打开', await exists('[data-testid="session-dialog"]'))
  check('弹窗里有「会话日志」组', await hasText('会话日志（按天归档到服务端'))
  check('日志开关默认关闭', await page.$eval('[data-testid="session-log-enabled"]', (el) => !el.checked))
  check(
    '填写 SSH 会话',
    (await setInput('[data-testid="session-name"]', '浏览器日志会话')) &&
      (await setInput('[data-testid="session-host"]', '127.0.0.1')) &&
      (await setInput('[data-testid="session-port"]', String(MOCK_PORT))) &&
      (await setInput('[data-testid="session-username"]', 'demo')),
  )
  check('选择凭据', await setSelect('[data-testid="session-credential"]', cred.id))
  check('未启用日志时格式选择隐藏', !(await exists('[data-testid="session-log-format"]')))
  check('勾选启用会话日志', await clickChecked('[data-testid="session-log-enabled"]'))
  await sleep(200)
  check('启用后出现格式选择', await exists('[data-testid="session-log-format"]'))
  check(
    '格式选为 HTML（保留色彩）',
    await setSelect('[data-testid="session-log-format"]', 'html'),
  )
  await shot('01-session-dialog')
  check('保存会话', await clickTestId('session-save'))
  const savedOk = await hasText('浏览器日志会话', 10_000)
  if (!savedOk) {
    const diag = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="session-dialog"]')
      const form = {
        name: document.querySelector('[data-testid="session-name"]')?.value ?? '—',
        host: document.querySelector('[data-testid="session-host"]')?.value ?? '—',
        port: document.querySelector('[data-testid="session-port"]')?.value ?? '—',
        user: document.querySelector('[data-testid="session-username"]')?.value ?? '—',
        cred: document.querySelector('[data-testid="session-credential"]')?.value ?? '—',
        credOptions: [...(document.querySelector('[data-testid="session-credential"]')?.options ?? [])].map(
          (o) => o.value,
        ).join(','),
        logEnabled: document.querySelector('[data-testid="session-log-enabled"]')?.checked ?? null,
        logFormat: document.querySelector('[data-testid="session-log-format"]')?.value ?? '—',
      }
      // 内联报错：样式里带 red / rose 的文本节点
      const errs = [...document.querySelectorAll('[data-testid="session-dialog"] *')]
        .filter((el) => /red|rose/.test(el.className) && el.textContent && el.children.length === 0)
        .map((el) => el.textContent.trim())
        .filter(Boolean)
      return { open: Boolean(d), form, errs }
    })
    console.log(`  [诊断] 弹窗仍打开=${diag.open} 表单=${JSON.stringify(diag.form)} 报错=${JSON.stringify(diag.errs)}`)
  }
  check('会话出现在会话库', savedOk)

  /* ---------------- 3. 连接并产生输出 ---------------- */
  console.log('\n[3] 连接与终端交互')
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('[data-testid="library-node"]')].find(
      (el) => el.dataset.name === '浏览器日志会话',
    )
    // 连接方式是单击节点名称（role=button 的 span）
    const name = node?.querySelector('span[role="button"]')
    ;(name ?? node)?.click()
    return Boolean(name)
  })
  const ready = await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="terminal-pane"][data-active="true"]')?.dataset
          .status === 'ready',
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('终端就绪', ready)
  check('欢迎语渲染', await waitTermText('WebTerm 测试 SSH 服务端', 12_000))
  check('键入 color 命令', await typeLine('color'))
  check('彩色输出到达终端', await waitTermText('GREEN-COLOR-MARKER', 10_000))
  check('键入敏感命令', await typeLine('echo password=secret999'))
  check('敏感输出到达终端（原文）', await waitTermText('secret999', 10_000))
  await shot('02-terminal')

  /* ---------------- 4. HTML 快照上传（15 秒定时） ---------------- */
  console.log('\n[4] HTML 快照上传')
  const htmlFile = await (async () => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const list = await api('/logs/files').catch(() => ({ files: [] }))
      const hit = list.files.find((f) => f.id.endsWith('.html'))
      if (hit) return hit
      if (Date.now() > deadline) return null
      await sleep(1000)
    }
  })()
  check('前端定期上传的 HTML 快照落盘', Boolean(htmlFile), htmlFile?.id ?? '30s 内未出现')
  check('列表展示会话名', htmlFile?.sessionName === '浏览器日志会话')

  /* ---------------- 5. 日志页：列表 / 预览 / 下载 / 删除 ---------------- */
  console.log('\n[5] 日志管理页')
  check('点击「日志」入口', await clickTestId('open-logs'))
  check('日志面板打开', await hasText('会话日志', 6000))
  check('文件行出现', await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="logs-file-row"]').length > 0,
    { timeout: 8000 },
  ).then(() => true).catch(() => false))
  await shot('03-logs-files')

  // 预览：验证快照内容与颜色标记
  check('打开预览', await page.evaluate(() => {
    const row = document.querySelector('[data-testid^="logs-preview-"]')
    row?.click()
    return Boolean(row)
  }))
  check('预览弹窗出现', await page.waitForFunction(
    () => document.querySelector('[data-testid="logs-preview-content"]') !== null,
    { timeout: 6000 },
  ).then(() => true).catch(() => false))
  // 等加载完成（内容不再显示「加载中…」）
  const previewText = await (async () => {
    const deadline = Date.now() + 8000
    for (;;) {
      const text = await page.evaluate(() =>
        document.querySelector('[data-testid="logs-preview-content"]')?.textContent ?? '',
      )
      if (text && !text.includes('加载中')) return text
      if (Date.now() > deadline) return text
      await sleep(200)
    }
  })()
  check('预览内容是快照本体（<!doctype html>）', previewText.startsWith('<!doctype html>'), previewText.slice(0, 60))
  check('预览包含彩色标记内容', previewText.includes('RED-COLOR-MARKER'))
  check('html 快照不做脱敏（忠实回放，文档已注明）', previewText.includes('secret999'))
  await shot('04-preview')
  check('关闭预览', await clickTestId('logs-preview-close'))

  // 下载：直接请求下载端点（浏览器下载行为不易断言，验证端点即可）
  const downloadRes = await fetch(`${BASE}/api/logs/files/${encodeURIComponent(htmlFile.id)}/download`)
  const downloadText = await downloadRes.text()
  check(
    '下载端点可用且内容一致',
    downloadRes.ok && downloadText.startsWith('<!doctype html>') && downloadText.includes('RED-COLOR-MARKER'),
    `${downloadRes.status} ${downloadText.slice(0, 50)}`,
  )

  // 删除 HTML 快照（产生 log_delete 审计）
  check('删除快照文件', await page.evaluate(() => {
    const btn = document.querySelector('[data-testid^="logs-delete-"]')
    btn?.click()
    return Boolean(btn)
  }))
  await sleep(600)
  const afterDelete = await api('/logs/files')
  check('删除后文件列表为空', afterDelete.files.length === 0, `剩 ${afterDelete.files.length}`)

  /* ---------------- 6. HTML 日志在浏览器打开颜色正确（验收条件） ---------------- */
  console.log('\n[6] HTML 日志浏览器打开回放色彩')
  // 先关闭日志面板（遮罩会挡住侧栏的连接点击）
  check('关闭日志面板', await clickTestId('logs-close'))
  await sleep(300)

  // plain 会话走 UI 弹窗创建（REST 直建的节点侧栏不会自动出现）
  check('点击「+会话」新建 plain 会话', await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('+会话'))
    btn?.click()
    return Boolean(btn)
  }))
  await sleep(400)
  check(
    '填写 plain 会话（日志格式默认纯文本）',
    (await setInput('[data-testid="session-name"]', '浏览器纯文本会话')) &&
      (await setInput('[data-testid="session-host"]', '127.0.0.1')) &&
      (await setInput('[data-testid="session-port"]', String(MOCK_PORT))) &&
      (await setInput('[data-testid="session-username"]', 'demo')) &&
      (await setSelect('[data-testid="session-credential"]', cred.id)) &&
      (await clickChecked('[data-testid="session-log-enabled"]')),
  )
  check(
    'plain 会话日志格式默认纯文本',
    (await page.$eval('[data-testid="session-log-format"]', (el) => el.value)) === 'plain',
  )
  check('保存 plain 会话', await clickTestId('session-save'))
  await sleep(600)

  // 连接 plain 会话（单击节点名），产生 .log 文件
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('[data-testid="library-node"]')].find(
      (el) => el.dataset.name === '浏览器纯文本会话',
    )
    node?.querySelector('span[role="button"]')?.click()
  })
  const readyPlain = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="terminal-pane"][data-status="ready"]')].length >= 2,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('plain 会话终端就绪', readyPlain)
  check('plain 终端键入 echo', await typeLine('echo plain-browser-ok'))
  check('plain 终端输出到达', await waitTermText('plain-browser-ok', 10_000))
  await sleep(500)

  // html 会话继续跑命令触发新一轮快照（先切回 html 标签，否则命令落进 plain 终端）
  check('切回 html 会话标签', await selectTab('浏览器日志会话'))
  await sleep(400)
  check('html 终端键入 utf8 命令', await typeLine('utf8'))
  check('输出到达', await waitTermText('你好，世界', 10_000))

  // 快照每 15 秒一拍，给足两个周期
  const htmlFile2 = await (async () => {
    const deadline = Date.now() + 45_000
    for (;;) {
      const list = await api('/logs/files').catch(() => ({ files: [] }))
      const hit = list.files.find((f) => f.id.endsWith('.html'))
      if (hit) return hit
      if (Date.now() > deadline) return null
      await sleep(1000)
    }
  })()
  check('新一轮快照落盘', Boolean(htmlFile2), htmlFile2?.id ?? '未出现')

  // plain 会话的日志文件也应在列表里
  check(
    'plain 会话的 .log 文件出现在列表',
    (await api('/logs/files')).files.some((f) => f.id.endsWith('.log') && f.sessionDir.startsWith('浏览器纯文本会话')),
  )

  // 验收：把快照文件用 file:// 直接在浏览器打开，检查颜色样式
  if (!htmlFile2) {
    check('回放色彩验收（快照缺失，跳过）', false, '未生成 HTML 快照，无法验证')
  } else {
    const absoluteHtml = path.join(WORK, 'data/logs', ...htmlFile2.id.split('/'))
    const replayPage = await browser.newPage()
    await replayPage.goto(`file:///${absoluteHtml.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 10_000 })
    const replay = await replayPage.evaluate(() => {
      // 找到包含目标文本的元素，取计算样式（serializeAsHTML 用 span 内联样式着色）
      const findColor = (marker) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if ((n.textContent || '').includes(marker)) {
            const el = n.parentElement
            const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(el ? getComputedStyle(el).color : '')
            return rgb ? { r: +rgb[1], g: +rgb[2], b: +rgb[3], inline: el?.getAttribute('style') ?? '' } : null
          }
        }
        return null
      }
      return {
        text: document.body.innerText,
        background: getComputedStyle(document.body).backgroundColor,
        red: findColor('RED-COLOR-MARKER'),
        green: findColor('GREEN-COLOR-MARKER'),
      }
    })
    // 这张截图必须拍 replayPage —— 回放页在另一个标签里，拍主页面只会得到应用界面
    await replayPage
      .screenshot({ path: `${SHOT_DIR}/logging-05-html-replay.png` })
      .catch(() => {})
    await replayPage.close()
    check('回放页面包含彩色输出文本', replay.text.includes('RED-COLOR-MARKER') && replay.text.includes('GREEN-COLOR-MARKER'))
    // 底色必须跟随终端主题：浅色主题下终端就是白底，回放页写死深色会「白块浮在深色页面上」
    check(
      '回放页底色与终端主题一致（浅色主题 → 浅底 #fbfbfa）',
      replay.background === 'rgb(251, 251, 250)',
      replay.background,
    )
    check(
      'RED-COLOR-MARKER 呈红色系（验收：颜色正确）',
      Boolean(replay.red) && replay.red.r > replay.red.g + 100 && replay.red.r > replay.red.b + 100,
      replay.red ? `${replay.red.inline.slice(0, 60)}` : '未找到',
    )
    check(
      'GREEN-COLOR-MARKER 呈绿色系',
      Boolean(replay.green) && replay.green.g > replay.green.r + 30 && replay.green.g > replay.green.b + 30,
      replay.green ? `${replay.green.inline.slice(0, 60)}` : '未找到',
    )
    check('着色由内联 span 样式承载', Boolean(replay.red?.inline.includes('color')), replay.red?.inline.slice(0, 60))
  }

  /* ---------------- 7. 审计页 ---------------- */
  console.log('\n[7] 审计页')
  // [6] 里关闭过面板，重新打开
  check('重新打开日志面板', await clickTestId('open-logs'))
  check('日志面板再次打开', await hasText('会话日志', 6000))
  check('切到审计标签', await clickTestId('logs-tab-audit'))
  check('审计行出现', await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="audit-row"]').length > 0,
    { timeout: 8000 },
  ).then(() => true).catch(() => false))
  const auditText = await page.evaluate(() => document.body.innerText)
  check('审计页显示连接事件与来源 IP', auditText.includes('建立了到') && auditText.includes('127.0.0.1'))
  check('审计页显示删除事件', auditText.includes('删除了 1 个日志文件'))
  await shot('06-audit')

  // 事件筛选
  check(
    '事件筛选选「连接」',
    await setSelect('[data-testid="audit-event-filter"]', 'connect'),
  )
  check('点击刷新', await clickTestId('audit-refresh'))
  await sleep(800)
  const filteredAudit = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="audit-row"]')].map((r) => r.textContent),
  )
  check(
    '筛选后只剩连接事件',
    filteredAudit.length > 0 && filteredAudit.every((t) => t.includes('建立了到')),
    `${filteredAudit.length} 行`,
  )

  /* ---------------- 8. 设置页 ---------------- */
  console.log('\n[8] 日志设置页')
  check('切到设置标签', await clickTestId('logs-tab-settings'))
  check('保留天数输入框出现', await page.waitForFunction(
    () => document.querySelector('[data-testid="logs-retention"]') !== null,
    { timeout: 6000 },
  ).then(() => true).catch(() => false))
  check(
    '保留天数改为 45',
    await setInput('[data-testid="logs-retention"]', '45'),
  )
  check('点击新增脱敏规则', await clickTestId('logs-rule-add'))
  check(
    '填写自定义规则（名称 + 正则）',
    await setInput('[data-testid="logs-rule-row-1"] input[placeholder="规则名"]', '密钥脱敏') &&
      await setInput('[data-testid="logs-rule-pattern-1"]', 'secret-\\S+') &&
      await setInput('[data-testid="logs-rule-row-1"] input[placeholder^="替换为"]', 'secret=***'),
  )
  await shot('07-settings')
  check('保存设置', await clickTestId('logs-settings-save'))
  check('保存成功提示出现', await hasText('已保存', 6000))

  const settingsAfter = await api('/logs/settings')
  check(
    '设置已落库（保留 45 天 + 2 条规则）',
    settingsAfter.retentionDays === 45 && settingsAfter.redactionRules.length === 2,
    `${settingsAfter.retentionDays} 天 / ${settingsAfter.redactionRules.length} 条`,
  )

  // 非法正则就地报错
  check('点击新增第二条规则', await clickTestId('logs-rule-add'))
  check(
    '填入非法正则',
    await setInput('[data-testid="logs-rule-pattern-2"]', '([unclosed'),
  )
  await sleep(300)
  check('非法正则就地标红报错', await page.evaluate(() => {
    const input = document.querySelector('[data-testid="logs-rule-pattern-2"]')
    if (!input) return false
    return input.className.includes('red') || input.getAttribute('aria-invalid') === 'true'
  }))

  /* ---------------- 9. 收尾 ---------------- */
  console.log('\n[9] 无前端异常')
  check('整个过程无前端异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
} catch (err) {
  check('E2E 流程未抛出未捕获异常', false, String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

console.log(`\n===== 结果：${pass} 通过，${failures.length} 失败 =====`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
