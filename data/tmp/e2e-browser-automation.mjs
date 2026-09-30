/**
 * 阶段 6 浏览器端到端：在真实 UI 里把自动化与批量运维走通。
 *
 * 与服务端 E2E 的分工：
 *   服务端 E2E（data/tmp/e2e-automation.mjs）证明「引擎是对的」——
 *   行缓冲、CRLF、沙箱、并发、截断、容量上限；
 *   本脚本证明「用户能用」—— 从界面点出来的规则真的让设备自己答了 yes，
 *   按钮栏的宏真的把命令敲进了终端，脚本编辑器真的能把代码送进沙箱跑起来，
 *   广播模式下一次按键真的落到了多个终端上。
 *
 * 自管三个 mock SSH + 一个生产模式服务端：
 *   2441~2443  mock SSH（MOCK_NAME=h1/h2/h3，供触发器、批量、广播使用）
 *   8121       服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 运行（需要先 npm run build）：
 *   NODE_PATH=".../node/workspace/node_modules" node data/tmp/e2e-browser-automation.mjs
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
const RUN_ID = process.env.E2E_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(ROOT, `data/tmp/automation-browser/${RUN_ID}`)

const PORT = 8121
const BASE = `http://127.0.0.1:${PORT}`
const HOSTS = [
  { name: 'h1', port: 2441 },
  { name: 'h2', port: 2442 },
  { name: 'h3', port: 2443 },
]
const SHOT_DIR = path.join(ROOT, 'data/browser-e2e-shots')
const DOWNLOAD_DIR = path.join(WORK, 'downloads')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MASTER = 'master-pass-2026'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ */
/* 起环境                                                              */
/* ------------------------------------------------------------------ */

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true })
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const children = []

function startMockSsh(host) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: { ...process.env, MOCK_PORT: String(host.port), MOCK_NAME: host.name },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`  [${host.name}] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [${host.name}!] ${d}`))
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

for (const host of HOSTS) startMockSsh(host)
startServer()
await waitHealthy()

const apiJson = (p, method, body) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

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
    // 业务上的 4xx（未解锁、校验失败、BUSY 冲突）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(t)) return
    jsErrors.push(t)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))

  /* ---------------- 页面操作助手 ---------------- */

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/automation-${n}.png` }).catch(() => {})

  const hasText = async (t, timeout = 8000) => {
    try {
      await page.waitForFunction((x) => document.body?.innerText?.includes(x), { timeout }, t)
      return true
    } catch {
      return false
    }
  }

  const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel)

  const textOf = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel)

  const clickTestId = (id) =>
    page.evaluate((x) => {
      const el = document.querySelector(`[data-testid="${x}"]`)
      if (!el) return false
      el.click()
      return true
    }, id)

  /** 在指定容器内按可见文本点按钮（面板和弹窗里都有「关闭」这类同名按钮） */
  const clickTextIn = (scope, text) =>
    page.evaluate(
      (s, x) => {
        const root = document.querySelector(s)
        if (!root) return false
        const el = [...root.querySelectorAll('button, a')].find((b) =>
          (b.textContent || '').trim().includes(x),
        )
        if (!el) return false
        el.click()
        return true
      },
      scope,
      text,
    )

  /** 给受控组件填值：必须走原生 setter + 事件，直接改 value 不会被 React 感知 */
  const setInput = (sel, value) =>
    page.evaluate(
      (s, v) => {
        const el = document.querySelector(s)
        if (!el) return false
        const proto =
          el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : el.tagName === 'SELECT'
              ? window.HTMLSelectElement.prototype
              : window.HTMLInputElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (!desc?.set) return false
        desc.set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        // select 的受控绑定走 change 事件
        if (el.tagName === 'SELECT') el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      },
      sel,
      value,
    )

  const panelText = () => textOf('[data-testid="automation-panel"]')

  /** 读指定标题的终端面板的可见文本 */
  const termTextOf = (title) =>
    page.evaluate((t) => {
      const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
        (p) => p.dataset.tabTitle === t,
      )
      const rows = pane?.querySelector('.xterm-rows')
      if (!rows) return ''
      return [...rows.children].map((el) => el.textContent || '').join('\n')
    }, title)

  async function waitTermText(title, sub, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((await termTextOf(title)).includes(sub)) return true
      if (Date.now() > deadline) return false
      await sleep(200)
    }
  }

  /** 等到某个终端面板的文本不再变化（用于确认广播的输入已经落地） */
  async function settleTerm(title, ms = 700) {
    let prev = await termTextOf(title)
    const deadline = Date.now() + 6000
    for (;;) {
      await sleep(ms)
      const next = await termTextOf(title)
      if (next === prev) return next
      prev = next
      if (Date.now() > deadline) return next
    }
  }

  const selectTab = (title) =>
    page.evaluate((t) => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
        (el.textContent || '').includes(t),
      )
      if (!tab) return false
      tab.click()
      return true
    }, title)

  /** 往当前活动终端键入（xterm 的输入层是透明浮层，只能先 focus 再 type） */
  async function typeIntoActiveTerminal(text, { enter = true } = {}) {
    const focused = await page.evaluate(() => {
      const ta = document.querySelector(
        '[data-testid="terminal-pane"][data-active="true"] .xterm-helper-textarea',
      )
      if (!ta) return false
      ta.focus()
      return true
    })
    if (!focused) return false
    await page.keyboard.type(text)
    if (enter) await page.keyboard.press('Enter')
    return true
  }

  /** 用 UI 建立一条 SSH 会话（快速连接） */
  async function connectViaUi(host) {
    // 第一个会话从欢迎页的「新建连接」进；之后欢迎页就消失了（tabItems 不为空），
    // 入口变成标签栏右侧的「+」
    const opened =
      (await exists('[data-testid="new-session"]'))
        ? await clickTestId('new-session')
        : await clickTestId('new-tab')
    if (!opened) return false
    await sleep(500)
    const ok =
      (await setInput('input[name="host"]', '127.0.0.1')) &&
      (await setInput('input[name="port"]', String(host.port))) &&
      (await setInput('input[name="username"]', 'demo')) &&
      (await setInput('input[name="password"]', 'demo')) &&
      (await setInput('input[name="title"]', host.name))
    if (!ok) return false
    if (!(await clickTestId('connect-session'))) return false
    const deadline = Date.now() + 20_000
    for (;;) {
      const ready = await page.evaluate(
        (t) =>
          [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
            (p) => p.dataset.tabTitle === t,
          )?.dataset.status === 'ready',
        host.name,
      )
      if (ready) return true
      if (Date.now() > deadline) return false
      await sleep(250)
    }
  }

  /** 打开自动化面板的指定分区 */
  async function openAutomation(section) {
    if (!(await exists('[data-testid="automation-panel"]'))) {
      if (!(await clickTestId('open-automation'))) return false
      await sleep(400)
    }
    if (!(await exists(`[data-testid="automation-tab-${section}"]`))) return false
    await clickTestId(`automation-tab-${section}`)
    await sleep(300)
    return true
  }

  async function closeAutomation() {
    if (!(await exists('[data-testid="automation-panel"]'))) return true
    const ok = await clickTestId('automation-close')
    await sleep(300)
    return ok
  }

  const activeTabId = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="terminal-pane"][data-active="true"]')?.dataset.tabId ??
        '',
    )

  /** 清空 CodeMirror 内容并键入新代码（Ctrl+A 在编辑器内即全选） */
  async function typeEditorCode(code) {
    const focused = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="script-editor"] .cm-content')
      if (!el) return false
      el.focus()
      return true
    })
    if (!focused) return false
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await page.keyboard.type(code)
    await sleep(400)
    return true
  }

  const editorText = () => textOf('[data-testid="script-editor"] .cm-content')

  async function waitForText(sel, sub, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((await textOf(sel)).includes(sub)) return true
      if (Date.now() > deadline) return false
      await sleep(250)
    }
  }

  /* ================================================================ */
  console.log('\n[1] 保险库、主界面与入口')
  /* ================================================================ */
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 25_000 })
  await sleep(600)
  check('首屏渲染出保险库门禁', await hasText('设置主密码', 12_000))
  const pw = await page.$$('[data-testid="vault-gate"] input[type="password"]')
  if (pw.length === 2) {
    await pw[0].type(MASTER)
    await pw[1].type(MASTER)
    await clickTextIn('body', '设置并解锁')
  }
  check('设置主密码后进入主界面', await hasText('会话库', 15_000))
  check('欢迎页声明完成阶段 0 ~ 9', await hasText('已完成阶段 0 ~ 9'))
  check('欢迎页列出自动化与批量运维', await hasText('自动化与批量运维'))
  check('头部出现「自动化」入口', await exists('[data-testid="open-automation"]'))
  check('头部出现「同步输入」入口', await exists('[data-testid="open-broadcast"]'))
  check('未开启广播时没有警示条', !(await exists('[data-testid="broadcast-bar"]')))
  await shot('01-main')

  /* ================================================================ */
  console.log('\n[2] 触发器面板：空态、一键添加、试匹配与即时语法校验')
  /* ================================================================ */
  check('打开自动化面板的触发器分区', await openAutomation('triggers'))
  check('面板标题正确', (await panelText()).includes('自动化与批量运维'))
  check('触发器空态给出引导', (await panelText()).includes('还没有任何规则'))
  check('提供常备规则一键添加', await exists('[data-testid="trigger-preset-确认提示自动应答"]'))

  // 用「常备规则」建一条：这正是验收清单里的 (yes/no)? 自动应答
  await clickTestId('trigger-preset-确认提示自动应答')
  await sleep(1200)
  const triggerList = await panelText()
  check('一键添加后列表出现该规则', triggerList.includes('确认提示自动应答'), triggerList.slice(0, 200))
  check('列表展示实际匹配表达式', triggerList.includes('包含「(yes/no)?」'))
  check('列表展示动作摘要', triggerList.includes('自动应答 "yes"'))
  check('新规则默认全局作用域', triggerList.includes('全局'))
  check('未命中时明确标注', triggerList.includes('未命中'))
  await shot('02-trigger-list')

  check('打开新建规则弹窗', (await clickTestId('trigger-new')) && (await hasText('新建触发器规则', 6000)))
  await setInput('[data-testid="trigger-name"]', '错误码捕获')
  await setInput('[data-testid="trigger-match-mode"]', 'regex')
  await setInput('[data-testid="trigger-pattern"]', 'code=(\\d+)')
  await sleep(400)
  const modeText = await textOf('[data-testid="trigger-dialog"]')
  check('切到正则模式后提示修饰符白名单', modeText.includes('g / y 被刻意排除'))
  await setInput(
    '[data-testid="trigger-test-sample"]',
    '开始自检…\n[ fail ] disk0 校验 failed，错误码 code=5001\n[ warn ] nic1 重传偏高 code=1004',
  )
  await clickTestId('trigger-run-test')
  await waitForText('[data-testid="trigger-test-result"]', '命中', 8000)
  const dialogText = await textOf('[data-testid="trigger-dialog"]')
  check('试匹配返回命中结果', dialogText.includes('2 行命中'), dialogText.slice(0, 300))
  check('$0 是整个匹配', dialogText.includes('$0 = "code=5001"'))
  check('$1 是第一个捕获组', dialogText.includes('$1 = "5001"'))
  check('本地正则语法校验通过', !(await exists('[data-testid="trigger-pattern-error"]')))

  // 故意写坏正则，验证即时校验与保存闸门
  await setInput('[data-testid="trigger-pattern"]', 'code=(\\d+')
  await sleep(500)
  const badText = await textOf('[data-testid="trigger-dialog"]')
  check('正则写错时即时给出错误', badText.includes('正则语法错误'))
  const saveDisabled = await page.evaluate(
    () => document.querySelector('[data-testid="trigger-save"]')?.disabled === true,
  )
  check('语法错误时保存按钮被禁用', saveDisabled)
  check('试匹配结果在模式变更后作废', !(await exists('[data-testid="trigger-test-result"]')))
  await clickTextIn('[data-testid="trigger-dialog"]', '取消')
  await sleep(300)
  check('弹窗已关闭', !(await exists('[data-testid="trigger-dialog"]')))

  /* ================================================================ */
  console.log('\n[3] 验收 1：终端出现 (yes/no)? 自动回 yes 并回车')
  /* ================================================================ */
  check('关闭面板', await closeAutomation())
  check('建立 SSH 会话 h1', await connectViaUi(HOSTS[0]))
  check('终端就绪提示可见', await waitTermText('h1', 'WebTerm 测试 SSH 服务端'))

  // mock 的 confirm 会打印一行不带换行的 (yes/no)? 并等待输入
  await typeIntoActiveTerminal('confirm')
  const autoAnswered = await waitTermText('h1', 'OK, proceeding (answer=yes)', 15_000)
  check('规则自动回了 yes，设备继续执行', autoAnswered, (await termTextOf('h1')).slice(-160))
  const termAfter = await termTextOf('h1')
  check(
    '终端里回显了命中提示（用户知道是谁按的键）',
    termAfter.includes('⚡ 触发器「确认提示自动应答」命中'),
    termAfter.slice(-200),
  )
  check('命中提示写明了服务端完成的动作', termAfter.includes('自动应答 "yes"'))
  await shot('03-auto-answer')

  /* ================================================================ */
  console.log('\n[4] 命中记录与停用')
  /* ================================================================ */
  check('重新打开自动化面板', await openAutomation('triggers'))
  const hitPanel = await panelText()
  check('面板列出命中记录区', hitPanel.includes('命中记录'))
  check('命中记录带规则名', hitPanel.includes('确认提示自动应答'))
  check('命中记录带终端标题', hitPanel.includes('h1'))
  check('命中记录里能看到动作说明', hitPanel.includes('自动应答'))
  await shot('04-trigger-hits')

  const enabledRules = (await apiJson('/api/automation/triggers', 'GET')).body?.rules ?? []
  const answerRule = enabledRules.find((r) => r.name === '确认提示自动应答')
  check('服务端确认规则已入库且启用', Boolean(answerRule?.enabled), JSON.stringify(enabledRules.map((r) => `${r.name}:${r.enabled}`)))
  // 停用后再触发，应当不再自动应答
  await clickTestId(`trigger-toggle-${answerRule.id}`)
  await sleep(800)
  const afterToggle = await panelText()
  check('停用后列表标记为已停用', afterToggle.includes('已停用'))
  await closeAutomation()
  await selectTab('h1')
  await sleep(300)
  // 终端里已经有上一次自动应答留下的 "OK, proceeding"，所以不能直接搜字符串，
  // 要比较「出现次数」有没有增加
  const beforePause = await termTextOf('h1')
  const answersBefore = (beforePause.match(/OK, proceeding/g) ?? []).length
  const noticesBefore = (beforePause.match(/⚡ 触发器/g) ?? []).length
  await typeIntoActiveTerminal('confirm')
  await sleep(2500)
  const pausedText = await termTextOf('h1')
  const answersAfter = (pausedText.match(/OK, proceeding/g) ?? []).length
  check(
    '停用后不再自动应答（设备停在等待输入）',
    answersAfter === answersBefore,
    `${answersBefore} → ${answersAfter}`,
  )
  check(
    '停用期间不再产生新的命中提示',
    (pausedText.match(/⚡ 触发器/g) ?? []).length === noticesBefore,
    `${noticesBefore} → ${(pausedText.match(/⚡ 触发器/g) ?? []).length}`,
  )

  // 重新启用，后面还要用
  await openAutomation('triggers')
  await clickTestId(`trigger-toggle-${answerRule.id}`)
  await sleep(800)
  check('重新启用成功', (await panelText()).includes('启用'))
  // h1 还停在 confirm 等待态，敲个 y 让它收尾
  await closeAutomation()
  await selectTab('h1')
  await sleep(300)
  await typeIntoActiveTerminal('y')
  await sleep(800)
  await shot('05-trigger-toggled')

  /* ================================================================ */
  console.log('\n[5] 按钮栏：多步宏')
  /* ================================================================ */
  check('打开按钮栏分区', await openAutomation('macros'))
  await setInput('[data-testid="macro-name"]', '看磁盘')
  // 第一步：发 df -h 并等到提示符；第二步：发 whoami
  await setInput('[data-testid="macro-step-send-0"]', 'df -h')
  await setInput('[data-testid="macro-step-expect-0"]', '$ ')
  check('添加第二步', await clickTestId('macro-add-step'))
  await sleep(300)
  await setInput('[data-testid="macro-step-send-1"]', 'whoami')
  await setInput('[data-testid="macro-step-expect-1"]', '$ ')
  await clickTestId('macro-save')
  await sleep(1200)
  const macroPanel = await panelText()
  check('宏保存成功并进入列表', macroPanel.includes('看磁盘'), macroPanel.slice(0, 300))
  check('列表展示步骤摘要', macroPanel.includes('发送 "df -h"') && macroPanel.includes('发送 "whoami"'))
  check('步骤数量展示正确', macroPanel.includes('2 步'))
  await shot('06-macro')

  check('关闭面板回到终端', await closeAutomation())
  const tabId = await activeTabId()
  check('终端里出现按钮栏', await exists(`[data-testid="macro-bar-${tabId}"]`))
  const barText = await textOf(`[data-testid="macro-bar-${tabId}"]`)
  check('按钮栏列出宏按钮', barText.includes('看磁盘'), barText)

  // 点按钮栏上的按钮执行
  const beforeMacro = await termTextOf('h1')
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid^="macro-bar-run-"]')].find((b) =>
      (b.textContent || '').includes('看磁盘'),
    )
    btn?.click()
  })
  const macroRan = await waitTermText('h1', 'whoami', 15_000)
  check('点击按钮栏按钮后宏真的执行到了第二步', macroRan, (await termTextOf('h1')).slice(-200))
  const afterMacro = await termTextOf('h1')
  check('宏执行后终端内容有变化', afterMacro.length > beforeMacro.length)
  await shot('07-macro-ran')

  /* ================================================================ */
  console.log('\n[6] 脚本编辑器、沙箱（验收 3）与超时中断（验收 4）')
  /* ================================================================ */
  check('打开脚本分区', await openAutomation('scripts'))
  check('CodeMirror 编辑器已渲染', await exists('[data-testid="script-editor"] .cm-content'))
  const starterText = await editorText()
  check('编辑器里有默认示例代码', starterText.includes('session.run'), starterText.slice(0, 100))
  check('API 速查可展开', await clickTestId('script-docs-toggle'))
  await sleep(400)
  const docsText = await textOf('[data-testid="script-docs"]')
  check('速查列出 session.send', docsText.includes('session.send'))
  check('速查列出 sftp.list', docsText.includes('sftp.list'))
  check(
    '速查明确说明沙箱内没有 require',
    docsText.includes('没有 require') || docsText.includes('沙箱'),
    docsText.slice(0, 160),
  )
  await clickTestId('script-docs-toggle')
  await sleep(200)

  // 键盘输入 → onChange → state → 提交运行：验证编辑器双向绑定真的通
  check('键入一段脚本', await typeEditorCode('log("editor-bound-ok")\nreturn 42;'))
  const typedText = await editorText()
  check(
    '编辑器接受了键盘输入',
    typedText.includes('editor-bound-ok') && typedText.includes('return 42'),
    typedText.slice(0, 120),
  )
  await shot('08-editor')

  await clickTestId('script-try-run')
  const gotLog = await waitForText('[data-testid="script-output"]', 'editor-bound-ok', 12_000)
  check('试运行产出了脚本日志', gotLog, await textOf('[data-testid="script-output"]'))
  const gotResult = await waitForText('[data-testid="script-output"]', '返回值 42', 8000)
  check('试运行回传了返回值', gotResult)
  check('运行状态标记为完成', (await panelText()).includes('完成'))

  /* ---- 验收 3：沙箱内 require('fs') 抛错 ---- */
  check('键入越界的沙箱调用', await typeEditorCode("const fs = require('fs')\nreturn fs.readFileSync('/etc/passwd')"))
  await clickTestId('script-try-run')
  const sandboxBlocked = await waitForText('[data-testid="script-output"]', '沙箱', 15_000)
  const sandboxOut = await textOf('[data-testid="script-output"]')
  check('验收 3：沙箱拒绝 require（界面给出明确原因）', sandboxBlocked, sandboxOut.slice(0, 300))
  check('错误信息说明了可用全局', sandboxOut.includes('session'), sandboxOut.slice(0, 300))
  await shot('09-sandbox')

  /* ---- 验收 4：死循环脚本被强制终止 ---- */
  await setInput('[data-testid="script-timeout"]', '1500')
  await sleep(300)
  check('键入死循环', await typeEditorCode('while (true) {}'))
  await clickTestId('script-try-run')
  const killed = await waitForText('[data-testid="script-output"]', '超时', 20_000)
  check('验收 4：死循环在超时后被强制终止', killed, (await textOf('[data-testid="script-output"]')).slice(0, 300))
  check('界面标注为「超时被中断」', (await panelText()).includes('超时被中断'))
  // 服务与其它会话不受影响 —— 这是这条验收真正的重点
  const healthAfterKill = await fetch(`${BASE}/api/health`)
    .then((r) => r.ok)
    .catch(() => false)
  check('强制终止后服务端仍然健康', healthAfterKill)
  await clickTestId('automation-tab-batch')
  await sleep(400)
  check('终止后界面仍可正常切换分区', (await panelText()).includes('执行目标'))
  await shot('10-timeout')

  /* ---- 脚本保存与列表运行（验证「脚本绑定」的手动运行路径） ---- */
  await clickTestId('automation-tab-scripts')
  await sleep(400)
  check('切回脚本分区', (await panelText()).includes('脚本'))
  await setInput('[data-testid="script-name"]', '编辑器保存的脚本')
  await setInput('[data-testid="script-timeout"]', '10000')
  await typeEditorCode('log("saved-script-ran")\nreturn "saved-ok";')
  await clickTestId('script-save')
  await sleep(1500)
  const listPanel = await panelText()
  check('保存后脚本出现在列表里', listPanel.includes('编辑器保存的脚本'), listPanel.slice(0, 300))
  check('列表标注超时设置', listPanel.includes('超时 10000ms'))
  const savedRules = (await apiJson('/api/automation/scripts', 'GET')).body?.scripts ?? []
  const savedScript = savedRules.find((s) => s.name === '编辑器保存的脚本')
  check('服务端确认脚本已入库', Boolean(savedScript))
  check('默认不随会话自动运行', savedScript?.runOnConnect === false)
  await clickTestId(`script-run-${savedScript.id}`)
  const listRunOk = await waitForText('[data-testid="script-output"]', 'saved-ok', 15_000)
  check('从列表点「运行」能跑起来并回传结果', listRunOk, await textOf('[data-testid="script-output"]'))

  // 打开「随会话运行」开关，验证这条绑定被记录
  await clickTestId(`script-edit-${savedScript.id}`)
  await sleep(400)
  check('进入编辑态', (await panelText()).includes('编辑脚本：编辑器保存的脚本'))
  await clickTestId('script-run-on-connect')
  await sleep(200)
  await clickTestId('script-save')
  await sleep(1200)
  const afterOnConnect = (await apiJson('/api/automation/scripts', 'GET')).body?.scripts ?? []
  check(
    '「随会话运行」绑定已保存',
    afterOnConnect.find((s) => s.name === '编辑器保存的脚本')?.runOnConnect === true,
  )
  // 关掉，避免影响后面新建的会话
  await clickTestId(`script-edit-${savedScript.id}`)
  await sleep(300)
  await clickTestId('script-run-on-connect')
  await sleep(200)
  await clickTestId('script-save')
  await sleep(1000)
  check(
    '重新关闭「随会话运行」',
    ((await apiJson('/api/automation/scripts', 'GET')).body?.scripts ?? []).find(
      (s) => s.name === '编辑器保存的脚本',
    )?.runOnConnect === false,
  )
  await shot('11-script-saved')

  /* ================================================================ */
  console.log('\n[7] 批量执行：3 台主机并发 df -h，导出 CSV')
  /* ================================================================ */
  check('关闭面板', await closeAutomation())
  check('建立第 2 台会话 h2', await connectViaUi(HOSTS[1]))
  check('建立第 3 台会话 h3', await connectViaUi(HOSTS[2]))
  check('打开批量执行分区', await openAutomation('batch'))
  check('目标来源默认是「已打开的终端」', (await panelText()).includes('复用已登录的连接'))
  const targetCount = await page.evaluate(
    () => document.querySelectorAll('[data-testid^="batch-target-"]').length,
  )
  check('列出 3 个候选目标', targetCount === 3, String(targetCount))
  await clickTestId('batch-select-all')
  await sleep(400)
  const batchLabel = await textOf('[data-testid="batch-run"]')
  check('目标计数正确（3 台）', batchLabel.includes('3'), batchLabel)

  await setInput('[data-testid="batch-command"]', 'df -h')
  await clickTestId('batch-run')
  const tableReady = await waitForText('[data-testid="batch-result"]', '执行结果', 30_000)
  check('结果表出现', tableReady)
  await sleep(800)
  const table = await textOf('[data-testid="batch-result"]')
  check('汇总：成功 3 / 失败 0', table.includes('成功 3') && table.includes('失败 0'), table.slice(0, 200))
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="batch-row-"]')].map((r) => ({
      target: r.dataset.testid.replace('batch-row-', ''),
      ok: r.dataset.ok,
      text: r.innerText,
    })),
  )
  check('结果表有 3 行', rows.length === 3, JSON.stringify(rows.map((r) => r.target)))
  check('三行都标记为成功', rows.every((r) => r.ok === 'true'), JSON.stringify(rows.map((r) => r.ok)))
  check(
    '每行都带主机名',
    ['h1', 'h2', 'h3'].every((h) => rows.some((r) => r.target === h)),
    JSON.stringify(rows.map((r) => r.target)),
  )
  check('每行都带耗时', rows.every((r) => r.text.includes('ms')), JSON.stringify(rows[0]?.text))
  // 折叠状态只显示 stdout 的第一行（df 的表头），所以要展开才能看到挂载点
  check(
    '折叠行显示 stdout 首行（df 表头）',
    rows.every((r) => r.text.includes('Filesystem')),
    JSON.stringify(rows[0]?.text),
  )
  await shot('12-batch')

  // 展开一行看 stdout / stderr 分离与完整输出
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid^="batch-row-"] button')
    btn?.click()
  })
  await sleep(500)
  const expandedText = await textOf('[data-testid="batch-result"]')
  check('展开行能看到 stdout 与 stderr 分栏', expandedText.includes('stdout') && expandedText.includes('stderr'))
  check('展开后能看到真实的挂载点与使用率', expandedText.includes('/dev/sda1') && expandedText.includes('32%'))

  // 导出 CSV：真的落到磁盘，而不是只断言按钮存在
  const client = await page.createCDPSession()
  await client
    .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR })
    .catch(async () => {
      await client
        .send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR })
        .catch(() => {})
    })
  await clickTestId('batch-export')
  const csvFile = await waitForFile(DOWNLOAD_DIR, '.csv', 12_000)
  check('导出 CSV 文件真的生成', Boolean(csvFile), csvFile ?? '超时')
  if (csvFile) {
    const csv = fs.readFileSync(csvFile, 'utf8')
    check('CSV 带 UTF-8 BOM（Excel 不乱码）', csv.charCodeAt(0) === 0xfeff)
    check('CSV 表头含中文列名', csv.includes('主机') && csv.includes('退出码'))
    check('CSV 记录了命令', csv.includes('df -h'))
    check('CSV 含三台主机', ['h1', 'h2', 'h3'].every((h) => csv.includes(h)))
  }

  /* ================================================================ */
  console.log('\n[8] 同步输入（广播模式）')
  /* ================================================================ */
  await closeAutomation()
  check('打开同步输入面板', await clickTestId('open-broadcast'))
  check('面板出现', await exists('[data-testid="broadcast-panel"]'))
  const bcText = await textOf('[data-testid="broadcast-panel"]')
  check('面板给出危险提示', bcText.includes('回车也会一起发出去'), bcText.slice(0, 200))
  check('列出候选终端', bcText.includes('h1') && bcText.includes('h2') && bcText.includes('h3'))
  check('标注当前标签无需勾选', bcText.includes('不必勾选'))
  await clickTestId('broadcast-select-writable')
  await sleep(400)
  await clickTestId('broadcast-start')
  await sleep(500)
  check('开启后自动关闭面板', !(await exists('[data-testid="broadcast-panel"]')))
  check('工作区顶部出现常驻警示条', await exists('[data-testid="broadcast-bar"]'))
  const barWarn = await textOf('[data-testid="broadcast-bar"]')
  check('警示条写明接收方数量', /同时发给\s*2\s*个终端/.test(barWarn), barWarn)
  check('警示条提供「立即停止」', barWarn.includes('立即停止'))
  check('头部入口变为开启态', (await textOf('[data-testid="open-broadcast"]')).includes('（开）'))
  await shot('13-broadcast')

  // 在活动标签（h3）里敲一条命令，另两个终端应当同时收到。
  // 注意：读隐藏面板的 `.xterm-rows` 是不可靠的（display:none 时渲染器不更新），
  // 因此要先把目标标签切到前台再读。
  await selectTab('h3')
  await sleep(500)
  await typeIntoActiveTerminal('echo BCAST-MARK')
  await sleep(2000)

  await selectTab('h3')
  await sleep(800)
  const onH3 = (await termTextOf('h3')).includes('BCAST-MARK')
  check('源终端收到自己的输入', onH3)
  await selectTab('h1')
  await sleep(900)
  const h1Text = await termTextOf('h1')
  check('接收方 h1 同步收到', h1Text.includes('BCAST-MARK'), h1Text.slice(-200))
  await selectTab('h2')
  await sleep(900)
  const h2Text = await termTextOf('h2')
  check('接收方 h2 同步收到', h2Text.includes('BCAST-MARK'), h2Text.slice(-200))
  check(
    '接收方真的执行了这条命令（有回显输出）',
    (h1Text.match(/BCAST-MARK/g) ?? []).length >= 2,
    h1Text.slice(-200),
  )
  const barWithReceipt = await textOf('[data-testid="broadcast-bar"]')
  check('警示条回显最近一次投递数量', barWithReceipt.includes('投递 2 个'), barWithReceipt)
  await shot('14-broadcast-delivered')

  // 停止广播后不应再投递
  await clickTestId('broadcast-bar-stop')
  await sleep(500)
  check('停止后警示条消失', !(await exists('[data-testid="broadcast-bar"]')))
  check('头部入口恢复常态', !(await textOf('[data-testid="open-broadcast"]')).includes('（开）'))
  await selectTab('h3')
  await sleep(400)
  await typeIntoActiveTerminal('echo AFTER-STOP')
  check('源终端仍然正常收到输入', await waitTermText('h3', 'AFTER-STOP', 8000))
  await selectTab('h2')
  await sleep(900)
  check('停止后接收方不再收到', !(await termTextOf('h2')).includes('AFTER-STOP'), (await termTextOf('h2')).slice(-160))
  await shot('15-broadcast-stopped')

  /* ================================================================ */
  console.log('\n[9] 标签、角标与资源回收')
  /* ================================================================ */
  // 「记录标签」动作 → 标签打到标签栏上（走真实 WS 推送，不依赖面板里的列表）
  const labelRule = await apiJson('/api/automation/triggers', 'POST', {
    name: '打标签',
    pattern: 'TAGME',
    matchMode: 'text',
    cooldownMs: 0,
    actions: [{ type: 'label', label: '就绪' }],
  })
  check('通过接口新增标签规则(201)', labelRule.status === 201, String(labelRule.status))
  await selectTab('h2')
  await sleep(400)
  await typeIntoActiveTerminal('echo TAGME')
  await sleep(2000)
  const tabBarText = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].map((e) => e.innerText).join(' | '),
  )
  check('规则打的标签出现在标签栏上', tabBarText.includes('就绪'), tabBarText)
  const badgeOnActive = await page.evaluate(
    () => document.querySelectorAll('[data-testid^="tab-hit-badge-"]').length,
  )
  check('活动标签不显示未读角标', badgeOnActive === 0, String(badgeOnActive))
  await shot('16-tab-label')

  // 未读角标：让后台标签也命中。用广播把同一条命令投给另外两台，
  // 这样命中发生在「不是当前标签」的终端上，角标才有意义。
  await selectTab('h3')
  await sleep(400)
  check('再次打开同步输入面板', await clickTestId('open-broadcast'))
  await clickTestId('broadcast-select-writable')
  await sleep(400)
  await clickTestId('broadcast-start')
  await sleep(500)
  check('广播重新开启', await exists('[data-testid="broadcast-bar"]'))
  await typeIntoActiveTerminal('echo TAGME')
  await sleep(2500)
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tab-hit-badge-"]')].map((e) => e.textContent),
  )
  check('后台标签出现未读命中角标', badges.length >= 2, JSON.stringify(badges))
  const badgeTabIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tab-hit-badge-"]')].map((e) => e.dataset.testid),
  )
  check('角标落在 h1 / h2 上（不是当前标签）', badgeTabIds.length >= 2, JSON.stringify(badgeTabIds))
  await shot('17-hit-badge')

  // 切到有角标的标签，角标应清零
  await selectTab('h1')
  await sleep(900)
  const badgeAfterSelect = await page.evaluate(
    () => document.querySelectorAll('[data-testid^="tab-hit-badge-"]').length,
  )
  check('切到该标签后角标清零', badgeAfterSelect < badges.length, `${badges.length} → ${badgeAfterSelect}`)

  // 关掉广播，后面不再需要
  await clickTestId('broadcast-bar-stop')
  await sleep(500)
  check('广播已停止', !(await exists('[data-testid="broadcast-bar"]')))

  // 关掉一个终端，它的命中记录应被清理。
  // 两个计数都必须在面板**开着**的时候取：面板一关就 display:none，
  // 那时 innerText 会一律返回空串
  await openAutomation('triggers')
  const hitCounts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="trigger-hits"] li')]
    return {
      total: rows.length,
      forH2: rows.filter((li) => (li.textContent || '').includes('h2')).length,
    }
  })
  await closeAutomation()
  check('命中记录非空（用于验证清理）', hitCounts.total > 0, String(hitCounts.total))
  check('h2 有独立命中记录', hitCounts.forH2 > 0, String(hitCounts.forH2))
  const closed = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
      (el.textContent || '').includes('h2'),
    )
    const btn = [...(tab?.querySelectorAll('button') ?? [])].find((b) =>
      (b.getAttribute('aria-label') || '').startsWith('关闭'),
    )
    if (!btn) return false
    btn.click()
    return true
  })
  check('关闭 h2 标签', closed)
  await sleep(1500)
  await openAutomation('triggers')
  const hitRowsAfter = await page.evaluate(
    () => document.querySelectorAll('[data-testid="trigger-hits"] li').length,
  )
  check(
    '关闭标签后它的命中记录被清理',
    hitRowsAfter === hitCounts.total - hitCounts.forH2,
    `${hitCounts.total} → ${hitRowsAfter}（预期 ${hitCounts.total - hitCounts.forH2}）`,
  )
  const remainingTabs = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].map((e) => e.innerText),
  )
  check('标签栏不再包含 h2', !remainingTabs.some((t) => t.includes('h2')), JSON.stringify(remainingTabs))
  const terminalsLeft = (await apiJson('/api/terminals', 'GET')).body?.terminals ?? []
  check('服务端终端数减 1', terminalsLeft.length === 2, String(terminalsLeft.length))
  await closeAutomation()

  check('全程无未捕获的前端错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' / '))
} catch (err) {
  check(`执行异常：${err.message}`, false)
  console.log(err.stack?.split('\n').slice(0, 6).join('\n'))
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n阶段 6 浏览器端到端：${passed} 通过 / ${results.length - passed} 失败（共 ${results.length}）`)
if (passed !== results.length) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`)
}
process.exit(passed === results.length ? 0 : 1)

/* ------------------------------------------------------------------ */
/* 小助手                                                              */
/* ------------------------------------------------------------------ */

async function waitForFile(dir, ext, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)) : []
    if (files.length > 0) return path.join(dir, files[0])
    if (Date.now() > deadline) return null
    await sleep(300)
  }
}
