#!/usr/bin/env node
/**
 * 打包出 WebTerm 的可发布形态。
 *
 * 产出一个自包含目录（默认 `release/webterm/`），它同时是三样东西：
 *
 *   - **便携目录**：`node bin/webterm.mjs` 直接跑，或双击 start.cmd / ./start.sh；
 *   - **npm 包内容**：目录里就是 `npm pack` 该有的全部文件，`npm i -g` 后得到
 *     `webterm` 命令，`npx webterm` 同样可用；
 *   - **Docker 镜像的构建输入**：见仓库根的 Dockerfile。
 *
 * 为什么不用 `npm pack` 直接打仓库根包？因为仓库是 workspaces 布局，
 * 三个子包靠 npm 软链接互相引用，而发布包里必须是一份**扁平、自包含**的目录：
 * 服务端产物 + 前端产物 + 生产依赖 + 一个把 `@webterm/shared` 就地摊平的 node_modules。
 * 这套布局由本脚本显式构造，不依赖 npm 如何理解 workspaces。
 *
 * 用法：
 *   node scripts/package-portable.mjs                # 打包并安装生产依赖
 *   node scripts/package-portable.mjs --no-install   # 只铺文件，不装依赖（离线/快速验证）
 *   node scripts/package-portable.mjs --out build/x  # 自定义输出目录
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/* ------------------------------------------------------------------ */
/* 参数                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { out: 'release/webterm', install: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-install') out.install = false
    else if (arg === '--out') {
      const value = argv[i + 1]
      if (!value) throw new Error('--out 后面需要一个目录')
      out.out = value
      i += 1
    } else if (arg === '-h' || arg === '--help') {
      console.log('用法：node scripts/package-portable.mjs [--out <目录>] [--no-install]')
      process.exit(0)
    } else throw new Error(`无法识别的参数：${arg}`)
  }
  return out
}

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8'))
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(repoRoot, args.out)

const serverPkg = readJson('packages/server/package.json')
const sharedPkg = readJson('packages/shared/package.json')
const rootPkg = readJson('package.json')

/** 打包前必须存在的构建产物：缺了就是「忘了 build」，直接报错而不是产出半个包 */
const REQUIRED = [
  { rel: 'packages/shared/dist/index.js', hint: 'npm run build -w @webterm/shared' },
  { rel: 'packages/server/dist/index.js', hint: 'npm run build -w @webterm/server' },
  { rel: 'packages/web/dist/index.html', hint: 'npm run build -w @webterm/web' },
]
for (const item of REQUIRED) {
  if (!existsSync(path.join(repoRoot, item.rel))) {
    console.error(`[package] 缺少构建产物：${item.rel}\n[package] 请先执行：${item.hint}`)
    process.exit(1)
  }
}

console.log(`[package] 输出目录：${outDir}`)
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/**
 * 铺一个文件/目录进发布包。统一走这里是为了让日志里能看到「谁被放进去了」——
 * 发布包少了哪个子目录是那种「装完才在运行时炸」的问题，提前打印成本最低。
 */
function place(rel, to) {
  const from = path.join(repoRoot, rel)
  if (!existsSync(from)) {
    console.warn(`[package] 跳过（不存在）：${rel}`)
    return false
  }
  cpSync(from, path.join(outDir, to), { recursive: true })
  console.log(`[package]   ${rel} -> ${to}`)
  return true
}

// 服务端产物落在包根的 dist/，与 bin/webterm.mjs 的候选路径 `dist/index.js` 对齐
place('packages/server/dist', 'dist')
// 前端产物落在 web/，与候选路径 `web` 对齐
place('packages/web/dist', 'web')
place('bin', 'bin')

/* ------------------------------------------------------------------ */
/* 就地摊平 @webterm/shared                                             */
/*                                                                     */
/* 仓库里它是 workspace 软链接，发布包里必须变成实体文件。               */
/* 服务端产物里有 `import ... from '@webterm/shared'`，Node 会从 dist/   */
/* 逐级向上找 node_modules，落在包根的 node_modules 上正好命中。          */
/*                                                                     */
/* 放进 vendor/ 而不是直接写 node_modules/ 是关键：npm install 会把       */
/* 依赖表里没有的 node_modules 内容当「多余包」清掉（第一版就是这么挂的）。 */
/* 声明成 `file:vendor/shared` 之后，它才是一个正规依赖，能被保留、       */
/* 也能被 npm pack 一起打进 tarball。                                   */
/* ------------------------------------------------------------------ */

const sharedRel = 'vendor/shared'
const sharedDest = path.join(outDir, sharedRel)
mkdirSync(sharedDest, { recursive: true })
cpSync(path.join(repoRoot, 'packages/shared/dist'), path.join(sharedDest, 'dist'), {
  recursive: true,
})
writeFileSync(
  path.join(sharedDest, 'package.json'),
  JSON.stringify(
    {
      name: sharedPkg.name,
      version: sharedPkg.version,
      type: sharedPkg.type,
      description: sharedPkg.description,
      main: sharedPkg.main,
      types: sharedPkg.types,
      exports: sharedPkg.exports,
    },
    null,
    2,
  ) + '\n',
)
console.log(`[package]   packages/shared/dist -> ${sharedRel}/dist`)

/* ------------------------------------------------------------------ */
/* 发布包的 package.json                                                */
/* ------------------------------------------------------------------ */

// 依赖表：沿用服务端的生产依赖，再把摊平的共享包按本地路径声明进来。
// 不列 root 的 devDependencies：pino-pretty 只在开发模式用，且服务端已做了
// 「解析不到就退化为普通日志」的兜底（见 app.ts），slim 部署不需要它。
const runtimeDeps = { ...serverPkg.dependencies, '@webterm/shared': `file:${sharedRel}` }

const releasePkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  description: rootPkg.description,
  type: 'module',
  license: 'MIT',
  bin: { webterm: 'bin/webterm.mjs' },
  main: 'dist/index.js',
  // files 只影响 `npm pack` 的内容：把运行时真正需要的东西列全，其余（文档、
  // 示例）也一并带上，因为本目录同时要当便携目录用，不能只有 dist。
  files: ['bin', 'dist', 'web', 'vendor', 'examples', 'README.md', 'CHANGELOG.md', '.env.example'],
  engines: rootPkg.engines,
  // 把本地路径依赖真正嵌进 tarball。否则 `npm pack` 出的包里只有一句
  // `file:vendor/shared`，别人装的时候这个相对路径在他的环境里不存在。
  // 有了它，`npm i -g webterm` / `npx webterm` 才是完整可用的形态。
  bundledDependencies: ['@webterm/shared'],
  scripts: {
    // 与 `webterm` 命令等价：都走 bin/webterm.mjs，
    // 这样 `npm start` 也不会因为漏设 NODE_ENV 而退化成开发态
    start: 'node bin/webterm.mjs',
  },
  dependencies: runtimeDeps,
}

writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(releasePkg, null, 2) + '\n')
console.log('[package]   package.json（bin: webterm，files，dependencies）')

/* ------------------------------------------------------------------ */
/* 便携启动脚本 + 示例插件                                              */
/* ------------------------------------------------------------------ */

// 便携目录的承诺是「拷走就能用、数据跟着目录走」，所以这两个脚本把
// WEBTERM_DATA_DIR 钉在自身目录下的 data/。全局安装请直接用 webterm 命令，
// 那条路径的数据目录默认是 ~/.webterm。
const portableNote = [
  '@echo off',
  'rem WebTerm 便携启动：数据留在本目录下的 data\\，整个目录可以直接拷走',
  'setlocal',
  'cd /d "%~dp0"',
  'if not defined WEBTERM_DATA_DIR set WEBTERM_DATA_DIR=%~dp0data',
  'if not defined NODE_ENV set NODE_ENV=production',
  'node "%~dp0bin\\webterm.mjs" %*',
].join('\r\n')
writeFileSync(path.join(outDir, 'start.cmd'), portableNote + '\r\n')

const portableSh = [
  '#!/usr/bin/env sh',
  '# WebTerm 便携启动：数据留在本目录下的 data/，整个目录可以直接拷走',
  'set -e',
  'cd "$(dirname "$0")"',
  'WEBTERM_DATA_DIR="${WEBTERM_DATA_DIR:-$(pwd)/data}"',
  'NODE_ENV="${NODE_ENV:-production}"',
  'export WEBTERM_DATA_DIR NODE_ENV',
  'exec node ./bin/webterm.mjs "$@"',
].join('\n')
writeFileSync(path.join(outDir, 'start.sh'), portableSh + '\n')
console.log('[package]   start.cmd / start.sh（便携启动，数据目录=./data）')

// 示例插件不放进 data/plugins 自动加载：一个会定时发通知的插件不该在
// 用户第一次打开界面时就开始打扰。放在 examples/ 里，README 教用户自己拷。
place('data/plugins/heartbeat-monitor', 'examples/plugins/heartbeat-monitor')

// 文档：README 在 #60 里重写，这里按「有就带上」处理，避免脚本里再抄一份
for (const doc of ['README.md', 'CHANGELOG.md', '.env.example']) {
  if (existsSync(path.join(repoRoot, doc))) {
    cpSync(path.join(repoRoot, doc), path.join(outDir, doc))
    console.log(`[package]   ${doc}`)
  }
}

/* ------------------------------------------------------------------ */
/* 安装生产依赖                                                         */
/* ------------------------------------------------------------------ */

if (args.install) {
  console.log('[package] 安装生产依赖（npm install --omit=dev）…')
  const npmCli = process.env.npm_execpath
  // npm 在 Windows 上是 .cmd 外壳，不能直接 spawn；有 npm_execpath 时
  // 它是 JS 入口，用当前 node 执行最稳。两者都没有就退回裸 npm。
  const cmd = npmCli ? process.execPath : 'npm'
  const cmdArgs = npmCli
    ? [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock']
    : ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock']
  const result = spawnSync(cmd, cmdArgs, { cwd: outDir, stdio: 'inherit', shell: !npmCli })
  if (result.status !== 0) {
    console.error('[package] 依赖安装失败。可加 --no-install 只铺文件，或在发布目录里手动执行 npm install。')
    process.exit(result.status ?? 1)
  }
} else {
  console.log('[package] 已跳过依赖安装（--no-install）')
}

/* ------------------------------------------------------------------ */
/* 收尾检查                                                             */
/* ------------------------------------------------------------------ */

const checks = [
  ['dist/index.js', '服务端入口'],
  ['web/index.html', '前端页面'],
  ['bin/webterm.mjs', 'CLI 启动器'],
  ['node_modules/@webterm/shared/dist/index.js', '摊平后的共享包'],
]
let ok = true
for (const [rel, label] of checks) {
  const exists = existsSync(path.join(outDir, rel))
  if (!exists) ok = false
  console.log(`[package] ${exists ? 'OK  ' : '缺失'} ${label}：${rel}`)
}
if (args.install) {
  const deps = existsSync(path.join(outDir, 'node_modules', 'fastify'))
  if (!deps) ok = false
  console.log(`[package] ${deps ? 'OK  ' : '缺失'} 生产依赖已安装（node_modules）`)
}

console.log(ok ? '\n[package] 打包完成。' : '\n[package] 打包完成，但存在缺失项（见上）。')
console.log(`[package] 试运行：cd ${path.relative(process.cwd(), outDir) || '.'} && node bin/webterm.mjs --port 8099`)
process.exit(ok ? 0 : 1)
