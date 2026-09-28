/**
 * 阶段 3 浏览器端到端：真实 UI 走完「开 SFTP → 双栏浏览 → 上传/下载 → 远程编辑 → 关闭」。
 *
 * 自管一个 mock SSH（含 SFTP 子系统）+ 一个生产模式服务端实例（独立端口与数据目录），
 * 不触碰开发用的 8080。
 *
 *   2241  mock SSH（SFTP 家目录 = data/tmp/e2e-p3b/mock-2241）
 *   8098  服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 运行：node data/tmp/e2e-browser-p3.mjs
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
const WORK = path.join(ROOT, 'data/tmp/e2e-p3b')
const MOCK_PORT = 2241
const PORT = 8098
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_ROOT = path.join(WORK, `mock-${MOCK_PORT}`)
const LOCAL_ROOT = path.join(WORK, 'local')
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

const README_REMOTE = '这是远端 readme 的原始内容\n第二行\n'
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(MOCK_ROOT, 'docs'), { recursive: true })
fs.mkdirSync(LOCAL_ROOT, { recursive: true })
fs.writeFileSync(path.join(MOCK_ROOT, 'readme.txt'), README_REMOTE)
fs.writeFileSync(path.join(MOCK_ROOT, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 254]))
fs.writeFileSync(path.join(MOCK_ROOT, 'docs', 'note.md'), '# 远端文档\n')
fs.writeFileSync(path.join(LOCAL_ROOT, 'upload-source.txt'), '来自本地面板的上传内容\n')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const children = []
function startMock() {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SFTP_ROOT: MOCK_ROOT },
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
      WEBTERM_LOCAL_ROOT: LOCAL_ROOT,
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

/* ------------------------------------------------------------------ */
/* 浏览器                                                             */
/* ------------------------------------------------------------------ */

startMock()
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
    // 业务上的 4xx（未解锁、冲突、校验失败）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(t)) return
    jsErrors.push(t)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))

  // DEBUG_NET=1 时打印所有 SFTP 接口的往返，便于定位「界面状态与请求不一致」这类问题
  if (process.env.DEBUG_NET) {
    const t0 = Date.now()
    page.on('request', (req) => {
      const url = req.url()
      if (!url.includes('/api/sftp/')) return
      console.log(`  [req ${String(Date.now() - t0).padStart(6)}ms] ${url.replace(BASE, '')}`)
    })
    page.on('response', async (res) => {
      const url = res.url()
      if (!url.includes('/api/sftp/')) return
      let extra = ''
      try {
        const body = await res.json()
        if (body && typeof body === 'object') {
          if (Array.isArray(body.entries)) {
            extra = `path=${body.path} entries=${body.entries.map((e) => e.name).join(',')}`
          } else if (body.error) {
            extra = `error=${body.error}`
          }
        }
      } catch {
        /* 无 JSON 响应体 */
      }
      console.log(`  [res ${String(Date.now() - t0).padStart(6)}ms] ${res.status()} ${url.replace(BASE, '')} ${extra}`)
    })
  }

  /** 由测试逐次设定的对话框应答（prompt / confirm） */
  let nextDialogText = null
  let nextDialogAccept = true
  page.on('dialog', async (dialog) => {
    const type = dialog.type()
    if (type === 'prompt' && nextDialogText !== null) {
      const text = nextDialogText
      nextDialogText = null
      await dialog.accept(text)
      return
    }
    const accept = nextDialogAccept
    nextDialogAccept = true
    if (accept) await dialog.accept()
    else await dialog.dismiss()
  })

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/p3-${n}.png` }).catch(() => {})

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

  /** 图标按钮没有文本，只能按 title / aria-label 定位 */
  const clickByTitle = (title, scope = 'body') =>
    page.evaluate(
      (t, s) => {
        const root = document.querySelector(s) ?? document.body
        const el = [...root.querySelectorAll('button')].find(
          (e) => (e.getAttribute('title') || e.getAttribute('aria-label') || '') === t,
        )
        if (!el) return false
        el.click()
        return true
      },
      title,
      scope,
    )

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

  /** 列出某一栏当前渲染出的条目名 */
  const paneEntries = (side) =>
    page.evaluate(
      (s) => [...document.querySelectorAll(`[data-testid="entry-${s}"]`)].map((e) => e.dataset.name),
      side,
    )

  const entryAction = (side, name, event) =>
    page.evaluate(
      (s, n, ev) => {
        const el = [...document.querySelectorAll(`[data-testid="entry-${s}"]`)].find(
          (e) => e.dataset.name === n,
        )
        if (!el) return false
        el.dispatchEvent(new MouseEvent(ev, { bubbles: true, button: 0 }))
        return true
      },
      side,
      name,
      event,
    )

  const panePath = (side) =>
    page.evaluate(
      (s) => document.querySelector(`[data-testid="sftp-pane-${s}"]`)?.dataset.path ?? '',
      side,
    )

  const drawerText = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="transfer-drawer-toggle"]')?.parentElement
      return el ? el.innerText : ''
    })

  /** 等待某一栏渲染出至少 n 个条目 */
  async function waitEntries(side, n = 1, timeoutMs = 12_000) {
    try {
      await page.waitForFunction(
        (s, count) => document.querySelectorAll(`[data-testid="entry-${s}"]`).length >= count,
        { timeout: timeoutMs },
        side,
        n,
      )
      return true
    } catch {
      return false
    }
  }

  /** 等待某一栏出现指定名字的条目（切换目录后必须等目标条目，不能只等「有东西」） */
  async function waitEntry(side, name, timeoutMs = 12_000) {
    try {
      await page.waitForFunction(
        (s, n) =>
          [...document.querySelectorAll(`[data-testid="entry-${s}"]`)].some(
            (e) => e.dataset.name === n,
          ),
        { timeout: timeoutMs },
        side,
        name,
      )
      return true
    } catch {
      return false
    }
  }

  /** 等待某个文件在指定位置出现（真实落盘断言，比看进度条可靠） */
  async function waitFile(filePath, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (fs.existsSync(filePath)) return true
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
    await clickText('设置并解锁')
  }
  check('设置主密码后进入主界面', await hasText('会话库', 12_000))
  await shot('01-main')

  /* ---------------- 2. 快速连接开 SFTP ---------------- */
  console.log('\n[2] 打开 SFTP 会话')
  check('点击「快速连接」', await clickText('快速连接'))
  await sleep(500)
  check('切换到「SFTP 文件」用途', await page.evaluate(() => {
    const el = document.querySelector('[data-testid="mode-sftp"]')
    if (!el) return false
    el.click()
    return true
  }))
  await sleep(200)
  check('对话框标题变为 SFTP', await hasText('新建 SFTP 文件传输'))
  check(
    '填写连接参数',
    (await setInput('input[name="host"]', '127.0.0.1')) &&
      (await setInput('input[name="port"]', String(MOCK_PORT))) &&
      (await setInput('input[name="username"]', 'demo')) &&
      (await setInput('input[name="password"]', 'demo')),
  )
  await shot('02-dialog')
  check('点击「打开文件传输」', await clickText('打开文件传输'))
  check('SFTP 工作区出现', await page.waitForSelector('[data-testid="sftp-workspace"]', { timeout: 20_000 }).then(() => true).catch(() => false))
  const ready = await page
    .waitForFunction(
      () => document.querySelector('[data-testid="sftp-workspace"]')?.dataset.status === 'ready',
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('会话状态变为 ready', ready)
  check('双栏都已渲染', (await page.$('[data-testid="sftp-pane-local"]')) !== null && (await page.$('[data-testid="sftp-pane-remote"]')) !== null)
  check('远端栏加载出条目', await waitEntries('remote', 3))
  check('本地栏加载出条目', await waitEntries('local', 1))

  const remoteNames = await paneEntries('remote')
  check(
    '远端栏列出家目录内容',
    remoteNames.includes('readme.txt') && remoteNames.includes('docs') && remoteNames.includes('blob.bin'),
    remoteNames.join(','),
  )
  check('标签栏出现 SFTP 标签', await hasText('SFTP'))
  await shot('03-workspace')

  /* ---------------- 3. 目录导航 ---------------- */
  console.log('\n[3] 目录导航')
  const homePath = await panePath('remote')
  check('远端初始目录是家目录', homePath === '/home/demo', homePath)
  check('双击进入子目录', await entryAction('remote', 'docs', 'dblclick'))
  await page
    .waitForFunction(
      () => document.querySelector('[data-testid="sftp-pane-remote"]')?.dataset.path?.endsWith('/docs'),
      { timeout: 8000 },
    )
    .catch(() => {})
  check('路径已进入 /home/demo/docs', (await panePath('remote')).endsWith('/docs'), await panePath('remote'))
  await waitEntry('remote', 'note.md', 8000)
  check('子目录内容渲染', (await paneEntries('remote')).includes('note.md'))

  check('点击「上一级」返回', await clickByTitle('上一级', '[data-testid="sftp-pane-remote"]'))
  await waitEntry('remote', 'readme.txt', 8000)
  await sleep(300)
  check('回到家目录', (await panePath('remote')) === homePath, await panePath('remote'))

  /* ---------------- 4. 远端新建目录 / 重命名 / 删除 ---------------- */
  console.log('\n[4] 远端文件操作')
  nextDialogText = 'browser-made'
  check('新建目录', await clickText('新建目录', '[data-testid="sftp-pane-remote"]'))
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="entry-remote"]')].some((e) => e.dataset.name === 'browser-made'),
    { timeout: 8000 },
  ).catch(() => {})
  check('新目录出现在列表中', (await paneEntries('remote')).includes('browser-made'))
  check('宿主磁盘上也确实创建了', fs.existsSync(path.join(MOCK_ROOT, 'browser-made')))

  // 删除刚建的目录（右键 → 删除 → confirm）
  await entryAction('remote', 'browser-made', 'click')
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="entry-remote"]')].find(
      (e) => e.dataset.name === 'browser-made',
    )
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
  })
  await sleep(300)
  nextDialogAccept = true
  check('右键菜单可见', await hasText('修改权限'))
  check('执行删除', await clickText('删除', '[role="menu"]'))
  await sleep(1200)
  check('目录已从远端删除', !fs.existsSync(path.join(MOCK_ROOT, 'browser-made')))
  check('列表已刷新', !(await paneEntries('remote')).includes('browser-made'))

  /* ---------------- 5. 下载：远端 → 本地栏 ---------------- */
  console.log('\n[5] 下载（远端 → 本地栏）')
  check('本地栏初始在家目录', (await panePath('local')) === LOCAL_ROOT, await panePath('local'))
  check('选中远端 readme.txt', await entryAction('remote', 'readme.txt', 'click'))
  check('点击「← 下载」', await clickText('← 下载', '[data-testid="sftp-pane-remote"]'))
  const downloaded = await waitFile(path.join(LOCAL_ROOT, 'readme.txt'))
  check('文件已下载到本地面板', downloaded)
  if (downloaded) {
    check(
      '下载内容与远端一致',
      fs.readFileSync(path.join(LOCAL_ROOT, 'readme.txt'), 'utf8') === README_REMOTE,
    )
  }
  await sleep(600)
  check('传输面板显示已完成', /已完成/.test(await drawerText()), (await drawerText()).slice(0, 80))
  // 本地栏需要刷新（传输终态会自动刷新两栏）
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="entry-local"]')].some((e) => e.dataset.name === 'readme.txt'),
    { timeout: 8000 },
  ).catch(() => {})
  check('本地栏列表出现该文件', (await paneEntries('local')).includes('readme.txt'))
  await shot('04-download')

  /* ---------------- 6. 上传：本地栏 → 远端 ---------------- */
  console.log('\n[6] 上传（本地栏 → 远端）')
  check('双击远端 docs 进入子目录', await entryAction('remote', 'docs', 'dblclick'))
  await page
    .waitForFunction(
      () => document.querySelector('[data-testid="sftp-pane-remote"]')?.dataset.path?.endsWith('/docs'),
      { timeout: 8000 },
    )
    .catch(() => {})
  check('选中本地 upload-source.txt', await entryAction('local', 'upload-source.txt', 'click'))
  check('点击「上传 →」', await clickText('上传 →', '[data-testid="sftp-pane-local"]'))
  const uploaded = await waitFile(path.join(MOCK_ROOT, 'docs', 'upload-source.txt'))
  check('文件已上传到远端 docs 目录', uploaded)
  if (uploaded) {
    check('上传内容一致', fs.readFileSync(path.join(MOCK_ROOT, 'docs', 'upload-source.txt'), 'utf8').includes('上传内容'))
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="entry-remote"]')].some((e) => e.dataset.name === 'upload-source.txt'),
    { timeout: 8000 },
  ).catch(() => {})
  check('远端栏列表出现上传的文件', (await paneEntries('remote')).includes('upload-source.txt'))
  await shot('05-upload')

  /* ---------------- 7. 文本预览与远程编辑 ---------------- */
  console.log('\n[7] 文本预览与远程编辑')
  // 上一步把远端栏留在了 docs 子目录，先回到上层再打开 readme.txt
  check('远端回到上层', await clickByTitle('上一级', '[data-testid="sftp-pane-remote"]'))
  await waitEntry('remote', 'readme.txt', 8000)
  check('双击 readme.txt 打开预览', await entryAction('remote', 'readme.txt', 'dblclick'))
  await sleep(1200)
  const viewerOpen = await hasText('保存')
  check('预览弹窗打开', viewerOpen)
  const originalText = await page.evaluate(() => document.querySelector('textarea')?.value ?? '')
  check('预览内容是文本', originalText.includes('这是远端 readme'), originalText.slice(0, 20))
  check('把内容改为新文本', await setInput('textarea', '被浏览器改写过\n'))
  check('点击「保存」', await clickText('保存'))
  const savedDeadline = Date.now() + 8000
  let savedOk = false
  while (Date.now() < savedDeadline && !savedOk) {
    savedOk = fs.readFileSync(path.join(MOCK_ROOT, 'readme.txt'), 'utf8') === '被浏览器改写过\n'
    if (!savedOk) await sleep(150)
  }
  check('远端文件内容已被改写', savedOk, fs.readFileSync(path.join(MOCK_ROOT, 'readme.txt'), 'utf8').slice(0, 20))
  await sleep(600)
  check('保存后弹窗自动关闭', !(await page.$('[data-testid="sftp-save"]')))
  await shot('06-edit')

  /* ---------------- 8. 二进制文件不提供编辑 ---------------- */
  console.log('\n[8] 二进制保护')
  check('定位到 blob.bin', await waitEntry('remote', 'blob.bin', 8000))
  check('双击 blob.bin', await entryAction('remote', 'blob.bin', 'dblclick'))
  await sleep(1200)
  check('二进制文件给出不可编辑提示', await hasText('二进制文件'))
  nextDialogAccept = true
  await clickText('关闭')
  await sleep(300)

  /* ---------------- 9. 关闭标签回收会话 ---------------- */
  console.log('\n[9] 关闭与回收')
  const before = await fetch(`${BASE}/api/sftp/sessions`).then((r) => r.json()).catch(() => null)
  check('服务端存在 1 个 SFTP 会话', Array.isArray(before?.sessions) && before.sessions.length === 1, JSON.stringify(before?.sessions?.length))
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[aria-label^="关闭"]')].find((b) =>
      (b.getAttribute('aria-label') || '').includes('SFTP'),
    )
    btn?.click()
  })
  await sleep(1200)
  check('工作区已移除', (await page.$('[data-testid="sftp-workspace"]')) === null)
  const after = await fetch(`${BASE}/api/sftp/sessions`).then((r) => r.json()).catch(() => null)
  check('服务端会话已回收', Array.isArray(after?.sessions) && after.sessions.length === 0, JSON.stringify(after?.sessions?.length))
  await shot('07-closed')

  check('全程无未捕获的前端错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' / '))
} catch (err) {
  check(`执行异常：${err.message}`, false)
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n阶段 3 浏览器端到端：${passed}/${results.length} 通过`)
if (passed !== results.length) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`)
}
process.exit(passed === results.length ? 0 : 1)
