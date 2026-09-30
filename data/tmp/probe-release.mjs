#!/usr/bin/env node
/**
 * 发布形态探针：把「启动一个 WebTerm 实例 → 探活 → 取首页 → 优雅退出」跑一遍。
 *
 * 为什么单独写一个而不是在 bash 里拼零散命令：
 *  - 本环境里 `curl` 走代理，探活会拿到假的 502，必须用 node 内置 fetch；
 *  - 后台起的进程会随那条 bash 调用结束而死，所以「起服务 → 测试 → 收尾」
 *    必须由**一个**进程从头管到尾；
 *  - 三种发布形态（源码仓库 `npm start`、CLI 启动器、便携包）要能共用同一套判据。
 *
 * 用法：
 *   node data/tmp/probe-release.mjs --label "npm start" --entry packages/server/dist/index.js --cwd packages/server --port 8111
 *   node data/tmp/probe-release.mjs --label "cli"       --entry bin/webterm.mjs                  --cwd .            --port 8112
 *   node data/tmp/probe-release.mjs --label "portable"  --entry release/webterm/bin/webterm.mjs  --cwd release/webterm --port 8113
 *
 * 判据（全部通过才算 OK）：
 *   1. 进程在超时内起来并 /api/health 返回 ok:true
 *   2. 健康响应里的 version 与仓库根 package.json 一致（防止「界面和包版号对不上」）
 *   3. GET / 返回的是前端页面而不是 JSON 错误或「未构建」提示
 *   4. 静态资源真的能取到（从 index.html 里抠一个 /assets/*.js 并请求它）
 *   5. SIGTERM 之后 5 秒内退出（插件定时器不许拖住进程）
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

function parseArgs(argv) {
  const out = {
    entry: '',
    cwd: '.',
    port: 8111,
    label: 'release',
    data: '',
    host: '127.0.0.1',
    // 可选：把一个插件目录装进本次实例的数据目录，并断言它加载成功。
    // 用来验证「随包分发的示例插件在一个全新环境里真的能用」。
    plugindir: '',
    expectplugin: '',
  }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith('--') || value === undefined) {
      console.error(`参数格式错误：${key}`)
      process.exit(2)
    }
    out[key.slice(2)] = value
  }
  out.port = Number(out.port)
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.entry) {
  console.error('缺少 --entry')
  process.exit(2)
}

const entryPath = path.resolve(repoRoot, args.entry)
const cwd = path.resolve(repoRoot, args.cwd)
// 数据目录用一个带 label+端口 的独立目录：既避免串到真实数据（里面有加密凭据库），
// 也避免两次运行之间互相污染。
const dataDir = path.resolve(
  repoRoot,
  args.data || `data/tmp/probe-release-${args.label.replace(/[^\w-]/g, '')}-${args.port}`,
)

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  [通过] ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  [失败] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ */

console.log(`===== 发布形态探针：${args.label} =====`)
console.log(`入口：${path.relative(repoRoot, entryPath)}`)
console.log(`工作目录：${path.relative(repoRoot, cwd) || '.'}`)

check('入口文件存在', existsSync(entryPath), path.relative(repoRoot, entryPath))
if (!existsSync(entryPath)) process.exit(1)

// 数据目录每个 label 固定，所以要先清掉上一次的残留。
// （不删 node_modules 之类的东西，只删这个探针自己的目录）
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

// 塞插件必须在进程起来**之前**——插件是在启动时扫目录加载的
if (args.plugindir) {
  const src = path.resolve(repoRoot, args.plugindir)
  const pluginRoot = path.join(dataDir, 'plugins')
  mkdirSync(pluginRoot, { recursive: true })
  cpSync(src, path.join(pluginRoot, path.basename(src)), { recursive: true })
  console.log(`预置插件：${path.relative(repoRoot, src)} -> <数据目录>/plugins/`)
}

const base = `http://127.0.0.1:${args.port}`
const child = spawn(process.execPath, [entryPath], {
  cwd,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    WEBTERM_HOST: args.host,
    WEBTERM_PORT: String(args.port),
    WEBTERM_DATA_DIR: dataDir,
    WEBTERM_LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const logs = []
child.stdout.on('data', (b) => logs.push(b.toString()))
child.stderr.on('data', (b) => logs.push(b.toString()))

let exited = false
let exitInfo = null
child.on('exit', (code, signal) => {
  exited = true
  exitInfo = { code, signal }
})

/** 轮询探活：起进程到能服务请求之间的耗时不确定，固定等待不可靠 */
async function waitHealthy(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) return null
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

const health = await waitHealthy()
check('进程启动并通过 /api/health 探活', health !== null, health ? `uptime=${health.uptimeSec}s` : '20 秒内未就绪')

if (health) {
  const pkgVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  check(
    '健康响应的版本与 package.json 一致',
    health.version === pkgVersion,
    `health=${health.version} package.json=${pkgVersion}`,
  )
  check('健康响应里 node 版本可用', typeof health.nodeVersion === 'string', health.nodeVersion)

  // 首页必须是前端页面。这里刻意断言「不是 JSON」而不是断言具体文案：
  // 文案会随 i18n 改，但「返回 HTML」这个契约不该变。
  try {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })
    const type = res.headers.get('content-type') ?? ''
    const body = await res.text()
    check('GET / 返回 HTML', res.ok && type.includes('text/html'), `status=${res.status} type=${type}`)
    check('首页含前端挂载点', body.includes('id="root"'), `长度=${body.length}`)

    // 静态资源真能取到，才算「前端产物被正确托管」——只看首页会漏掉
    // 「index.html 换了但 assets 没带上」这种情况
    const asset = body.match(/\/assets\/[^"']+\.js/)
    if (asset) {
      const assetRes = await fetch(`${base}${asset[0]}`, { signal: AbortSignal.timeout(5000) })
      check('静态资源可下载', assetRes.ok, `${asset[0]} status=${assetRes.status}`)
    } else {
      check('静态资源可下载', false, 'index.html 里没找到 /assets/*.js 引用')
    }
  } catch (err) {
    check('GET / 返回 HTML', false, String(err))
    check('首页含前端挂载点', false, String(err))
    check('静态资源可下载', false, String(err))
  }
} else {
  check('健康响应的版本与 package.json 一致', false, '未探活')
  check('GET / 返回 HTML', false, '未探活')
  check('首页含前端挂载点', false, '未探活')
  check('静态资源可下载', false, '未探活')
}

// 插件加载：只在显式要求时检查。判据取「状态为 ready 且注册了触发器动作」——
// 光看「列表里有这个 id」不够，加载失败的插件同样会出现在列表里（状态是 error）
if (args.expectplugin && health) {
  try {
    const res = await fetch(`${base}/api/plugins`, { signal: AbortSignal.timeout(5000) })
    const body = await res.json()
    const found = (body.plugins ?? []).find((p) => p.id === args.expectplugin)
    check(
      `插件 ${args.expectplugin} 已加载且状态为 ready`,
      found?.state === 'ready',
      found ? `state=${found.state}${found.error ? ` error=${found.error}` : ''}` : '列表里没有这个插件',
    )
    check(
      `插件 ${args.expectplugin} 注册了触发器动作`,
      Array.isArray(found?.triggerActions) && found.triggerActions.length > 0,
      found ? `${found.triggerActions?.length ?? 0} 个：${(found.triggerActions ?? []).map((a) => a.id).join(',')}` : '—',
    )
  } catch (err) {
    check(`插件 ${args.expectplugin} 已加载且状态为 ready`, false, String(err))
    check(`插件 ${args.expectplugin} 注册了触发器动作`, false, String(err))
  }
}

// SIGTERM 必须在 5 秒内结束进程：插件注册的定时器都 unref 过，
// 通道/SSH 连接在 onClose 里关闭，任何一处漏了都会表现为「关不掉」
const killStart = Date.now()
child.kill('SIGTERM')
if (!exited) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
const killMs = Date.now() - killStart
check(
  'SIGTERM 后 5 秒内退出',
  exited,
  exited ? `${killMs}ms，code=${exitInfo?.code} signal=${exitInfo?.signal}` : '超时未退出',
)

if (!exited) child.kill('SIGKILL')

const tail = logs.join('').trim()
if (tail) {
  console.log('--- 进程输出（末尾 800 字） ---')
  console.log(tail.slice(-800))
}

console.log(`===== ${args.label}：${passed} 通过 / ${failed} 失败 =====`)
rmSync(dataDir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
