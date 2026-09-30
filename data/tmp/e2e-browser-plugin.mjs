/**
 * 阶段 9 浏览器端到端：插件机制在真实界面上的完整走查。
 *
 * 覆盖：
 *   - 顶栏插件入口与「加载失败」角标
 *   - 插件面板：状态徽标 / 出错原因可读 / 能力 Chips / 排序（出错的排最前）
 *   - 配置表单热更新（改完保存即生效，不需要重载插件）
 *   - 重新扫描目录（往目录里丢一个插件就能被发现）
 *   - 插件命令与插件面板（表格）
 *   - 触发器编辑器里的「插件动作」下拉：可选、保存、引用失效时当场提示
 *   - 全局事件通道 `/ws/events`：插件通知 → 站内 Toast，以及通知开关能真的关掉它
 *   - 停用插件后，它的触发器动作从下拉里消失（不做「假可选」）
 *   - 无未预期的前端报错
 *
 * 自管 mock SSH + 一个生产模式服务端实例（独立端口与数据目录）：
 *   2347  mock SSH
 *   8100  服务端（NODE_ENV=production，直接托管 web/dist）
 *
 * 运行（需要先 npm run build 与 npm run build -w @webterm/web）：
 *   NODE_PATH=".../node/workspace/node_modules" node data/tmp/e2e-browser-plugin.mjs
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
const WORK = path.join(ROOT, 'data/tmp/browser-plugin-e2e')
const PLUGIN_DIR = path.join(WORK, 'data/plugins')
const PORT = 8100
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_PORT = 2347
const SHOT_DIR = path.join(ROOT, 'data/browser-e2e-shots')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MASTER = 'master-pass-2026'
const SESSION_NAME = 'p9-session'

/** 被验证的两个插件 id */
const PLUGIN_ID = 'heartbeat-monitor'
const BOOM_ID = 'boom-plugin'
/** 测试中途写进目录的第三个插件：验证「重新扫描」 */
const LATE_ID = 'late-plugin'

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
/* 夹具：三个插件                                                       */
/*                                                                     */
/* 其中两个在服务端启动前就位，第三个等测试跑到一半再写盘 ——             */
/* 「目录即插件」这件事只有真的在运行期丢一个目录进去才算验证过。          */
/* ------------------------------------------------------------------ */

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
fs.mkdirSync(PLUGIN_DIR, { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

// 1) 示例插件（直接拷仓库里的那一份，验证随仓库分发的示例确实能用）
fs.cpSync(path.join(ROOT, 'data/plugins/heartbeat-monitor'), path.join(PLUGIN_DIR, PLUGIN_ID), {
  recursive: true,
})

// 2) 加载期抛错的插件：验证「一个坏插件不会连累好插件」且原因可读
const boomDir = path.join(PLUGIN_DIR, BOOM_ID)
fs.mkdirSync(boomDir, { recursive: true })
fs.writeFileSync(
  path.join(boomDir, 'plugin.json'),
  JSON.stringify(
    {
      id: BOOM_ID,
      name: '会炸的插件',
      version: '1.0.0',
      description: '入口在加载期抛错，用来验证隔离与错误展示',
      apiVersion: 1,
    },
    null,
    2,
  ),
)
fs.writeFileSync(
  path.join(boomDir, 'index.js'),
  `throw new Error('故意在加载期抛错：这是夹具插件的预期行为')\n`,
)

/** 运行期才写盘的那个插件 */
function writeLatePlugin() {
  const dir = path.join(PLUGIN_DIR, LATE_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: LATE_ID,
        name: '迟到的插件',
        version: '0.1.0',
        description: '测试运行期写盘 + 重新扫描',
        apiVersion: 1,
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    [
      `host.log('info', '迟到的插件已加载')`,
      `host.registerTriggerAction({ id: 'wave', label: '打个招呼' }, function () {`,
      `  host.notify('迟到的插件', '收到一次打招呼')`,
      `})`,
      '',
    ].join('\n'),
  )
}

/* ------------------------------------------------------------------ */
/* 进程                                                                */
/* ------------------------------------------------------------------ */

const children = []
function startMock() {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: {
      ...process.env,
      MOCK_PORT: String(MOCK_PORT),
      MOCK_SFTP_ROOT: path.join(WORK, 'mock'),
    },
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
  child.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [srv!] ${d}`))
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
    const text = m.text()
    // 业务上的 4xx（校验失败、插件停用等）是预期响应，不算前端异常
    if (/status of (400|401|403|404|409|423)/.test(text)) return
    jsErrors.push(text)
  })
  page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`))
  page.on('dialog', (d) => void d.accept())

  const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/phase9-${n}.png` }).catch(() => {})

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

  const clickTestId = (id) =>
    page.evaluate((x) => {
      const el = document.querySelector(`[data-testid="${x}"]`)
      if (!el) return false
      el.click()
      return true
    }, id)

  /** 点击第一个 data-testid 以某前缀开头的元素（列表项的 id 是动态的） */
  const clickPrefix = (prefix) =>
    page.evaluate((p) => {
      const el = document.querySelector(`[data-testid^="${p}"]`)
      if (!el) return false
      el.click()
      return true
    }, prefix)

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

  /** 受控 select 填值前必须等 option 出现，否则浏览器会静默置空 */
  const setSelect = async (sel, value) => {
    const deadline = Date.now() + 8000
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

  const selectOptions = (sel) =>
    page.evaluate(
      (s) => [...(document.querySelector(s)?.options ?? [])].map((o) => o.value),
      sel,
    )

  const toasts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="toast"]')].map((el) => ({
        tone: el.dataset.tone ?? '',
        text: el.textContent ?? '',
      })),
    )

  const dismissToasts = () =>
    page.evaluate(() => {
      for (const b of document.querySelectorAll('[data-testid^="toast-dismiss-"]')) b.click()
    })

  const pluginState = (id) => attrOf(`[data-testid="plugin-${id}"]`, 'data-state')

  /**
   * 数插件日志里提到某关键词的条数。
   *
   * 通知开关关掉之后界面上就不会有 Toast 了 —— 那一刻「插件还在不在工作」
   * 只能从插件自己的日志里看。这也是这个断言该用的证据：
   * 拿 Toast 当「插件确实告警了」的判据，正好会被被验证的那个开关抹掉。
   */
  const pluginLogCount = async (id, needle) => {
    const res = await api('/plugins')
    const found = (res.plugins ?? []).find((p) => p.id === id)
    return (found?.logs ?? []).filter((l) => (l.message ?? '').includes(needle)).length
  }

  /** 轮询等一个条件成立 */
  const waitFor = async (fn, timeoutMs = 12_000, intervalMs = 400) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await fn()) return true
      if (Date.now() > deadline) return false
      await sleep(intervalMs)
    }
  }

  /** 向指定会话的终端键入一行 */
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

  const openPlugins = async () => {
    await clickTestId('open-plugins')
    return page
      .waitForFunction(() => document.querySelector('[data-testid="plugins-panel"]') !== null, {
        timeout: 6000,
      })
      .then(() => true)
      .catch(() => false)
  }

  const closePlugins = async () => {
    await clickTestId('plugins-close')
    await sleep(250)
    return !(await exists('[data-testid="plugins-panel"]'))
  }

  const closeAutomation = async () => {
    await clickTestId('automation-close')
    await sleep(250)
  }

  const openTriggerDialog = async () => {
    await clickTestId('open-automation')
    await page
      .waitForFunction(() => document.querySelector('[data-testid="automation-panel"]') !== null, {
        timeout: 6000,
      })
      .catch(() => {})
    await clickTestId('automation-tab-triggers')
    await sleep(200)
    await clickTestId('trigger-new')
    await page
      .waitForFunction(() => document.querySelector('[data-testid="trigger-dialog"]') !== null, {
        timeout: 6000,
      })
      .catch(() => {})
    return exists('[data-testid="trigger-dialog"]')
  }

  /* ---------------- 1. 门禁与首页 ---------------- */
  console.log('\n[1] 门禁与首页')
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
  check(
    '首页阶段列表里「插件与打包」标为已完成',
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-testid^="welcome-phase-"]')].find((el) =>
        (el.textContent || '').includes('插件与打包'),
      )
      return Boolean(row) && (row.textContent || '').includes('已完成')
    }),
  )
  check('顶栏有插件入口', await exists('[data-testid="open-plugins"]'))
  check(
    '顶栏角标显示 1 个加载失败的插件',
    (await textOf('[data-testid="plugin-error-badge"]')) === '1',
    `角标=${await textOf('[data-testid="plugin-error-badge"]')}`,
  )
  await shot('01-welcome')

  /* ---------------- 2. 数据准备 ---------------- */
  console.log('\n[2] 凭据与一条会话')
  const cred = await api('/credentials', {
    method: 'POST',
    body: JSON.stringify({ name: 'p9 凭据', type: 'password', password: 'demo' }),
  })
  check('凭据创建成功', Boolean(cred.id))

  const created = await api('/library', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'session',
      name: SESSION_NAME,
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
  check('会话入库', Boolean(created.id))

  // store 快照在解锁时拉过一次，API 后补的数据要刷新页面才可见
  await page.reload({ waitUntil: 'networkidle2', timeout: 25_000 })
  await sleep(900)
  check('刷新后仍在主界面', await hasText('会话库', 15_000))

  check(
    '从会话库打开会话',
    await page.evaluate((n) => {
      const node = [...document.querySelectorAll('[data-testid="library-node"]')].find(
        (el) => el.dataset.name === n,
      )
      if (!node) return false
      const label = node.querySelector('span[role="button"]')
      ;(label ?? node).click()
      return true
    }, SESSION_NAME),
  )
  check(
    '终端进入 ready（插件应收到 session:opened）',
    await page
      .waitForFunction(
        (t) => {
          const pane = [...document.querySelectorAll('[data-testid="terminal-pane"]')].find(
            (el) => el.dataset.tabTitle === t,
          )
          return pane?.dataset.status === 'ready'
        },
        { timeout: 25_000 },
        SESSION_NAME,
      )
      .then(() => true)
      .catch(() => false),
  )
  await sleep(600)

  /* ---------------- 3. 插件面板 ---------------- */
  console.log('\n[3] 插件面板：状态 / 能力 / 错误隔离')
  check('打开插件面板', await openPlugins())
  check('面板挂载', await exists('[data-testid="plugins-panel"]'))
  check('加载 API 版本号', await hasText('API v1', 6000))
  check(
    '目录路径展示出来（插件该放哪，面板里能直接看到）',
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="plugins-panel"]')
      return Boolean(el) && (el.textContent || '').includes('plugins')
    }),
  )

  check('好插件是 ready', (await pluginState(PLUGIN_ID)) === 'ready', `state=${await pluginState(PLUGIN_ID)}`)
  check('坏插件是 error', (await pluginState(BOOM_ID)) === 'error', `state=${await pluginState(BOOM_ID)}`)
  check(
    '坏插件的出错原因整段可读',
    (await textOf(`[data-testid="plugin-error-${BOOM_ID}"]`))?.includes('故意在加载期抛错') === true,
    (await textOf(`[data-testid="plugin-error-${BOOM_ID}"]`))?.slice(0, 60) ?? '无',
  )
  check(
    '排序把出错的排在前面',
    await page.evaluate((boom) => {
      const cards = [...document.querySelectorAll('[data-testid^="plugin-"]')].filter((el) =>
        /^plugin-(heartbeat-monitor|boom-plugin|late-plugin)$/.test(el.dataset.testid ?? ''),
      )
      return cards[0]?.dataset.testid === `plugin-${boom}`
    }, BOOM_ID),
  )

  // 能力 Chips：三类注册项 + 事件订阅都要在界面上可见
  check(
    '能力 Chips 列出触发器动作',
    await hasText('触发器动作 · 心跳确认', 5000),
  )
  check('能力 Chips 列出命令', await hasText('命令 · 立即检查', 5000))
  check('能力 Chips 列出面板', await hasText('面板 · 会话心跳状态', 5000))
  check('能力 Chips 列出事件订阅', await hasText('订阅 ·', 5000))
  await shot('02-plugins-panel')

  /* ---------------- 4. 命令 / 面板 / 日志 ---------------- */
  console.log('\n[4] 插件命令、面板与日志')
  check('点击「立即检查」命令', await clickTestId(`plugin-command-${PLUGIN_ID}-check-now`))
  await sleep(900)
  check(
    '命令返回值显示在卡片上',
    (await textOf(`[data-testid="plugin-note-${PLUGIN_ID}"]`))?.includes('已检查') === true,
    (await textOf(`[data-testid="plugin-note-${PLUGIN_ID}"]`))?.slice(0, 60) ?? '无',
  )

  check('展开插件面板（会话心跳状态）', await clickTestId(`plugin-panel-${PLUGIN_ID}-sessions`))
  check('面板表格渲染出来', await hasText('距上次回应', 6000))
  check(
    '面板里能看到当前会话',
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="plugins-panel"]')
      return Boolean(el) && (el.textContent || '').includes('在线')
    }),
  )
  await shot('03-plugin-panel-table')

  check('展开日志折叠区', await clickTestId(`plugin-logs-toggle-${PLUGIN_ID}`))
  check('日志里有内容', await exists(`[data-testid="plugin-logs-${PLUGIN_ID}"]`))

  /* ---------------- 5. 配置热更新 ---------------- */
  console.log('\n[5] 配置热更新（保存即生效，不重载插件）')
  check('保存按钮初始为禁用（没有改动）', await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="plugin-save-${id}"]`)
    return el?.hasAttribute('disabled') === true
  }, PLUGIN_ID))

  check(
    '改 intervalMs',
    await setInput(`[data-testid="plugin-${PLUGIN_ID}-intervalMs"]`, '120000'),
  )
  await sleep(200)
  check(
    '有改动后保存按钮可用',
    await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="plugin-save-${id}"]`)
      return el?.hasAttribute('disabled') === false
    }, PLUGIN_ID),
  )
  check('点击保存配置', await clickTestId(`plugin-save-${PLUGIN_ID}`))
  await sleep(900)
  check(
    '提示「配置已保存并立即生效」',
    (await textOf(`[data-testid="plugin-note-${PLUGIN_ID}"]`))?.includes('立即生效') === true,
    (await textOf(`[data-testid="plugin-note-${PLUGIN_ID}"]`))?.slice(0, 40) ?? '无',
  )

  // 越界值要被钳制：min 5000
  check('把 intervalMs 改成越界的 1', await setInput(`[data-testid="plugin-${PLUGIN_ID}-intervalMs"]`, '1'))
  await sleep(200)
  check('保存越界值', await clickTestId(`plugin-save-${PLUGIN_ID}`))
  await sleep(900)
  check(
    '越界值被服务端钳制到下限 5000',
    (await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="plugin-${id}-intervalMs"]`)
      return el?.value ?? null
    }, PLUGIN_ID)) === '5000',
    `读回=${await page.evaluate((id) => document.querySelector(`[data-testid="plugin-${id}-intervalMs"]`)?.value, PLUGIN_ID)}`,
  )

  /* ---------------- 6. 重新扫描目录 ---------------- */
  console.log('\n[6] 运行期写入插件 + 重新扫描')
  check('扫描前列表里没有迟到插件', !(await exists(`[data-testid="plugin-${LATE_ID}"]`)))
  writeLatePlugin()
  check('点击「重新扫描目录」', await clickTestId('plugins-rescan'))
  check(
    '迟到插件被发现',
    await page
      .waitForFunction((id) => document.querySelector(`[data-testid="plugin-${id}"]`) !== null, {
        timeout: 8000,
      }, LATE_ID)
      .then(() => true)
      .catch(() => false),
  )
  check('迟到插件是 ready', (await pluginState(LATE_ID)) === 'ready', `state=${await pluginState(LATE_ID)}`)
  await shot('04-plugins-rescan')

  check('关闭插件面板', await closePlugins())

  /* ---------------- 7. 触发器编辑器里的插件动作 ---------------- */
  console.log('\n[7] 触发器动作下拉')
  check('打开新建触发器对话框', await openTriggerDialog())
  check('点击「+ 插件动作」', await clickTestId('trigger-add-action-plugin'))
  await sleep(300)
  check('插件动作编辑区出现', await exists('[data-testid="trigger-action-plugin-0"]'))

  const options = await selectOptions('[data-testid="trigger-action-plugin-0"]')
  check(
    '下拉里有示例插件注册的动作',
    options.includes(`${PLUGIN_ID}::mark-alive`),
    options.join(' | '),
  )
  check(
    '下拉里有迟到插件注册的动作（注册项是动态汇总的）',
    options.includes(`${LATE_ID}::wave`),
    options.join(' | '),
  )
  check(
    '选中示例插件的动作',
    await setSelect('[data-testid="trigger-action-plugin-0"]', `${PLUGIN_ID}::mark-alive`),
  )
  check(
    '填插件动作参数',
    await setInput('[data-testid="trigger-action-plugin-params-0"]', 'from-e2e'),
  )
  // 匹配串是必填的：心跳类规则的自然写法就是盯住回显标记
  check(
    '填匹配串',
    await setInput('[data-testid="trigger-pattern"]', 'HEARTBEAT-OK'),
  )
  check('填规则名', await setInput('[data-testid="trigger-name"]', 'p9 插件动作规则'))
  await sleep(200)
  check('保存规则', await clickTestId('trigger-save'))
  check(
    '规则出现在列表里',
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('[data-testid^="trigger-row-"]')].length > 0,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false),
  )
  await shot('05-trigger-plugin-action')

  // 规则命中 → 服务端真的把插件动作调起来了吗？打一行回显让规则触发，
  // 然后去插件日志里找那句「被规则…标记为存活」。
  // 这一段是「插件动作不是只在下拉里好看」的唯一证据。
  await closeAutomation()
  await sleep(400)
  const aliveBefore = await pluginLogCount(PLUGIN_ID, '标记为存活')
  check('在终端里打出心跳回显触发规则', await typeIn(SESSION_NAME, 'echo HEARTBEAT-OK'))
  check(
    '规则命中后插件动作真的被执行了（插件日志留痕）',
    await waitFor(async () => (await pluginLogCount(PLUGIN_ID, '标记为存活')) > aliveBefore, 15_000),
    `日志条数 ${aliveBefore} → ${await pluginLogCount(PLUGIN_ID, '标记为存活')}`,
  )
  await sleep(300)

  /* ---------------- 8. 事件通道：插件通知 → Toast ---------------- */
  console.log('\n[8] 全局事件通道（插件通知 → 站内 Toast）')
  // 把静默阈值压到下限 10 秒、阈值设 1，让下一次检查必定告警
  check('重开插件面板', await openPlugins())
  await setInput(`[data-testid="plugin-${PLUGIN_ID}-timeoutMs"]`, '10000')
  await setInput(`[data-testid="plugin-${PLUGIN_ID}-failureThreshold"]`, '1')
  await setInput(`[data-testid="plugin-${PLUGIN_ID}-intervalMs"]`, '3600000')
  await sleep(200)
  check('保存告警相关配置', await clickTestId(`plugin-save-${PLUGIN_ID}`))
  await sleep(800)

  await dismissToasts()
  let alerted = false
  for (let attempt = 1; attempt <= 6 && !alerted; attempt += 1) {
    await clickTestId(`plugin-command-${PLUGIN_ID}-check-now`)
    for (let i = 0; i < 12; i += 1) {
      await sleep(500)
      const list = await toasts()
      if (list.some((t) => t.text.includes('疑似失联'))) {
        alerted = true
        break
      }
    }
  }
  check('插件通知通过事件通道推到了界面', alerted)

  const alertToast = (await toasts()).find((t) => t.text.includes('疑似失联'))
  check('通知标题是插件给的标题', alertToast?.text.includes('会话疑似失联') === true, alertToast?.text.slice(0, 80) ?? '无')
  check(
    'warn 级别渲染成 warning 样式',
    alertToast?.tone === 'warning',
    `tone=${alertToast?.tone ?? '无'}`,
  )
  check(
    'Toast 里带上了插件名与正文',
    alertToast?.text.includes('心跳监视器') === true,
    alertToast?.text.slice(0, 80) ?? '无',
  )
  await shot('06-plugin-notify-toast')

  // 关掉开关：同一个告警不该再弹
  await closePlugins()
  check('打开设置面板', await clickTestId('open-settings'))
  await page
    .waitForFunction(() => document.querySelector('[data-testid="settings-panel"]') !== null, {
      timeout: 6000,
    })
    .catch(() => {})
  check('切到通知标签页', await clickTestId('settings-tab-notifications'))
  await sleep(300)
  check('「插件通知时提醒」开关存在', await exists('[data-testid="notify-plugin"]'))
  check(
    '关掉插件通知开关',
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="notify-plugin"]')
      if (!el || !el.checked) return false
      el.click()
      return true
    }),
  )
  await sleep(300)
  check(
    '开关已关闭',
    (await page.evaluate(() => document.querySelector('[data-testid="notify-plugin"]')?.checked)) === false,
  )
  check('关闭设置面板', await clickTestId('settings-close'))
  await sleep(300)

  await openPlugins()
  await dismissToasts()
  // 重置统计 → 让下一次检查重新计数并再次告警
  const alertsBefore = await pluginLogCount(PLUGIN_ID, '疑似失联')
  await clickTestId(`plugin-command-${PLUGIN_ID}-reset`)
  await sleep(600)

  let secondAlertFired = false
  for (let attempt = 1; attempt <= 8 && !secondAlertFired; attempt += 1) {
    await clickTestId(`plugin-command-${PLUGIN_ID}-check-now`)
    secondAlertFired = await waitFor(
      async () => (await pluginLogCount(PLUGIN_ID, '疑似失联')) > alertsBefore,
      6000,
    )
  }

  const afterOff = await toasts()
  check(
    '关闭开关后不再弹插件通知',
    afterOff.length === 0,
    afterOff.map((t) => t.text.slice(0, 30)).join(' / ') || '无 Toast',
  )
  check(
    '插件确实又告警了（证明「不弹」是开关生效而不是没触发）',
    secondAlertFired,
    `插件告警日志 ${alertsBefore} → ${await pluginLogCount(PLUGIN_ID, '疑似失联')}`,
  )

  /* ---------------- 9. 停用插件 → 动作从下拉消失 ---------------- */
  console.log('\n[9] 停用插件后动作从下拉消失')
  await openPlugins()
  check(
    '取消勾选「启用」',
    await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="plugin-toggle-${id}"]`)
      if (!el || !el.checked) return false
      el.click()
      return true
    }, PLUGIN_ID),
  )
  await page
    .waitForFunction(
      (id) => document.querySelector(`[data-testid="plugin-${id}"]`)?.dataset.state === 'disabled',
      { timeout: 8000 },
      PLUGIN_ID,
    )
    .catch(() => {})
  check('卡片变成已停用', (await pluginState(PLUGIN_ID)) === 'disabled', `state=${await pluginState(PLUGIN_ID)}`)
  check(
    '停用后不再显示能力 Chips',
    !(await hasText('触发器动作 · 心跳确认', 1500)),
  )
  await shot('07-plugin-disabled')
  await closePlugins()

  check('重新打开新建触发器对话框', await openTriggerDialog())
  check('再次点击「+ 插件动作」', await clickTestId('trigger-add-action-plugin'))
  await sleep(300)
  const optionsAfter = await selectOptions('[data-testid="trigger-action-plugin-0"]')
  check(
    '停用插件的动作已从下拉里消失',
    !optionsAfter.includes(`${PLUGIN_ID}::mark-alive`),
    optionsAfter.join(' | ') || '（空）',
  )
  check(
    '迟到插件的动作仍然可选',
    optionsAfter.includes(`${LATE_ID}::wave`),
    optionsAfter.join(' | '),
  )
  await shot('08-plugin-action-gone')

  // 打开上一步保存的规则：引用失效必须当场说清楚，而不是等命中才发现
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="trigger-dialog"]')
    // 先关掉当前对话框
    const cancel = [...(btn?.querySelectorAll('button') ?? [])].find((b) =>
      /取消/.test(b.textContent ?? ''),
    )
    cancel?.click()
  })
  await sleep(400)
  check('打开已有规则', await clickPrefix('trigger-edit-'))
  await page
    .waitForFunction(() => document.querySelector('[data-testid="trigger-dialog"]') !== null, {
      timeout: 6000,
    })
    .catch(() => {})
  check(
    '编辑区提示引用的插件动作当前不可用',
    await hasText('当前不可用', 6000),
    (await page.evaluate(() =>
      document.querySelector('[data-testid="trigger-dialog"]')?.textContent?.includes('当前不可用'),
    )) === true
      ? '文案命中'
      : '未命中',
  )
  await shot('09-dangling-plugin-action')
  await closeAutomation()

  /* ---------------- 10. 前端异常 ---------------- */
  console.log('\n[10] 前端运行期异常')
  const realErrors = jsErrors.filter((e) => !/favicon|net::ERR_/.test(e))
  check('没有未预期的前端报错', realErrors.length === 0, realErrors.slice(0, 4).join(' | ') || '无')
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
}

console.log(`\n===== 阶段 9 浏览器端到端：${pass} 通过 / ${failures.length} 失败 =====`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
