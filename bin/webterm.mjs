#!/usr/bin/env node
/**
 * WebTerm 启动器（npm 包的 bin 入口 / 便携目录的启动脚本）。
 *
 * 这个文件只做三件事，然后原地把服务端加载起来：
 *
 * 1. **定位服务端入口与前端产物**。源码仓库里两者的位置是固定的
 *    （`packages/server/dist` + `packages/web/dist`），而 npm 包 / 便携目录 /
 *    Docker 镜像的布局由打包脚本决定。这里用「按候选路径探测」把两种布局都兼容掉，
 *    并把探测结果通过 `WEBTERM_WEB_DIR` 显式告诉服务端 —— 服务端不再需要
 *    猜测自己在什么形态里运行。
 *
 * 2. **给出可用的默认值**。默认进生产模式（这个入口就是给最终用户用的，
 *    开发请用 `npm run dev`），默认数据目录放到 `~/.webterm`：
 *    全局安装 / `npx` 场景下进程工作目录是随机的，把数据库落在 `./data`
 *    会让用户每次换目录就「丢」一次数据。
 *
 * 3. **跑起来之前把关键路径打出来**。数据目录在哪、配置从哪来，是这类自托管
 *    工具最高频的「我数据放哪了」问题，启动时一行讲清楚，比事后翻文档省事。
 *
 * 只用 `node:` 内置模块，不引入任何依赖。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 包根目录：仓库布局下是 <repo>/bin/.. ，发布布局下是 <pkg>/bin/.. */
const pkgRoot = path.resolve(here, '..')

/** 服务端入口的候选路径：发布布局优先，其次仓库布局 */
const ENTRY_CANDIDATES = ['dist/index.js', 'packages/server/dist/index.js']
/** 前端产物的候选路径：发布布局优先，其次仓库布局 */
const WEB_CANDIDATES = ['web', 'packages/web/dist']

const USAGE = `
WebTerm —— 浏览器里的 SSH / Telnet 终端

用法：
  webterm [选项]

选项：
  -p, --port <端口>      监听端口（默认 8080，等价于 WEBTERM_PORT）
  -H, --host <地址>      监听地址（默认 127.0.0.1；对外开放请填 0.0.0.0）
  -d, --data-dir <目录>  数据目录（默认 ~/.webterm，等价于 WEBTERM_DATA_DIR）
  -h, --help             显示本帮助
  -v, --version          显示版本号

环境变量：
  WEBTERM_HOST / WEBTERM_PORT / WEBTERM_DATA_DIR / WEBTERM_LOG_LEVEL
  WEBTERM_LOCAL_ROOT     文件面板「本地」侧的根目录（默认用户家目录）
  WEBTERM_SFTP_CONCURRENCY 文件传输并发数（默认 3）

示例：
  webterm                       # 本机访问 http://127.0.0.1:8080
  webterm -H 0.0.0.0 -p 9000    # 开给局域网
`.trim()

/** 极简参数解析：够用就好，不值得为三个选项引入 argv 库 */
function parseArgs(argv) {
  const out = { help: false, version: false, host: undefined, port: undefined, dataDir: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const takeValue = (name) => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${name} 后面需要一个值`)
      }
      i += 1
      return value
    }
    if (arg === '-h' || arg === '--help') out.help = true
    else if (arg === '-v' || arg === '--version') out.version = true
    else if (arg === '-p' || arg === '--port') out.port = takeValue(arg)
    else if (arg === '-H' || arg === '--host') out.host = takeValue(arg)
    else if (arg === '-d' || arg === '--data-dir') out.dataDir = takeValue(arg)
    else throw new Error(`无法识别的选项：${arg}`)
  }
  return out
}

/** 在候选路径里挑第一个真实存在的；都不存在时返回 null，由调用方决定怎么报错 */
function firstExisting(candidates) {
  for (const rel of candidates) {
    const abs = path.resolve(pkgRoot, rel)
    if (existsSync(abs)) return abs
  }
  return null
}

function readVersion() {
  const pkgFile = path.join(pkgRoot, 'package.json')
  if (!existsSync(pkgFile)) return 'unknown'
  try {
    return JSON.parse(readFileSync(pkgFile, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[webterm] ${err.message}\n`)
    console.error(USAGE)
    process.exit(2)
  }

  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.version) {
    console.log(readVersion())
    return
  }

  const entry = firstExisting(ENTRY_CANDIDATES)
  if (!entry) {
    console.error(
      '[webterm] 找不到服务端产物（已尝试：' +
        ENTRY_CANDIDATES.join('、') +
        '）\n' +
        `[webterm] 包根目录：${pkgRoot}\n` +
        '[webterm] 如果是源码仓库，请先执行：npm install && npm run build',
    )
    process.exit(1)
  }

  // 生产模式是这个入口的默认：用户装完就想直接跑起来。
  // 想开发调试请用 `npm run dev`（Vite + tsx watch），而不是这个文件。
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'

  const webDir = firstExisting(WEB_CANDIDATES)
  if (webDir && !process.env.WEBTERM_WEB_DIR) {
    process.env.WEBTERM_WEB_DIR = webDir
  }

  if (args.host !== undefined) process.env.WEBTERM_HOST = args.host
  if (args.port !== undefined) process.env.WEBTERM_PORT = args.port
  if (args.dataDir !== undefined) process.env.WEBTERM_DATA_DIR = args.dataDir

  if (!process.env.WEBTERM_DATA_DIR) {
    process.env.WEBTERM_DATA_DIR = path.join(homedir(), '.webterm')
  }

  const host = process.env.WEBTERM_HOST || '127.0.0.1'
  const port = process.env.WEBTERM_PORT || '8080'
  console.log(`[webterm] 数据目录：${path.resolve(process.env.WEBTERM_DATA_DIR)}`)
  console.log(`[webterm] 前端产物：${webDir ?? '未找到（仅提供 API）'}`)
  if (!webDir) {
    console.warn('[webterm] 未找到前端产物，浏览器访问会拿不到界面；请先执行 npm run build')
  }
  console.log(`[webterm] 启动后访问：http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)

  // 直接 import 而不是 spawn 子进程：信号处理、日志、退出码都留在单进程里，
  // Ctrl+C 的语义与 `node dist/index.js` 完全一致。
  // Windows 下拼 `file://` 前缀会得到非法 URL（盘符被当成主机名），必须走 pathToFileURL。
  await import(pathToFileURL(entry).href)
}

main().catch((err) => {
  console.error('[webterm] 启动失败：', err)
  process.exit(1)
})
