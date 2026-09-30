#!/usr/bin/env node
/**
 * Dockerfile 静态自检。
 *
 * 存在的理由：CI / 开发机上不一定有 docker，但 Dockerfile 里最容易写错的两件事
 * 完全可以离线查出来 ——
 *
 *   1. `COPY --from=build /src/xxx` 指向了一个构建阶段根本不会产出的路径
 *      （改目录结构后忘了同步 Dockerfile，属于典型漏改）；
 *   2. 路径存在，但被 `.dockerignore` 挡在构建上下文之外，
 *      导致 `COPY . .` 时压根没进镜像。
 *
 * 这两类错误的表现都是「镜像能构建成功，但跑起来 404 / 找不到模块」，排查成本高。
 * 本脚本不做镜像构建，只做路径与忽略规则的核对 —— 它不能替代 `docker build`，
 * 但能把最常见的漏改拦在前面。
 *
 * 用法：node scripts/check-dockerfile.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
const dockerignore = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8')

let failed = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  [通过] ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failed += 1
    console.log(`  [失败] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ */
/* 1. COPY --from=build 的源路径必须真实存在                             */
/* ------------------------------------------------------------------ */

/** 构建阶段的工作目录是 /src，因此 /src/a/b 对应仓库里的 a/b */
const serverDirs = ['packages/shared', 'packages/server', 'packages/web']

// Dockerfile 里服务的源目录要按构建阶段的布局核对。
// dist/ 是构建产物（.dockerignore 里被排除、由 npm run build 现场生成），
// 所以只核对那些「来自仓库源码、构建阶段不会生成」的路径。
const fromBuild = [...dockerfile.matchAll(/COPY --from=build\s+(\/src\/\S+)\s+(\S+)/g)].map((m) => ({
  src: m[1],
  dest: m[2],
}))

console.log('===== Dockerfile 静态自检 =====')
console.log(`COPY --from=build 指令：${fromBuild.length} 条`)

for (const { src, dest } of fromBuild) {
  const rel = src.replace(/^\/src\//, '')
  // 构建产物（node_modules、各包的 dist）由 build 阶段现场生成，
  // 仓库里存不存在取决于本地是否构建过，所以不做存在性断言，只提示
  const isBuildOutput = rel === 'node_modules' || /(^|\/)dist(\/|$)/.test(rel)
  const exists = existsSync(path.join(repoRoot, rel))
  if (isBuildOutput) {
    check(`构建产物路径（由 build 阶段生成）${rel}`, true, exists ? '本地已构建' : '本地未构建，镜像内会生成')
  } else {
    check(`COPY 源路径存在：${rel}`, exists, `-> ${dest}`)
  }
}

/* ------------------------------------------------------------------ */
/* 2. 构建阶段声明的三个子包清单必须都在                                 */
/* ------------------------------------------------------------------ */

const manifestCopies = [...dockerfile.matchAll(/COPY packages\/(\w+)\/package\.json/g)].map((m) => m[1])
for (const name of new Set(manifestCopies)) {
  check(
    `依赖清单存在：packages/${name}/package.json`,
    existsSync(path.join(repoRoot, `packages/${name}/package.json`)),
  )
}
check('三个子包的清单都被拷进构建阶段', new Set(manifestCopies).size === serverDirs.length, [...new Set(manifestCopies)].join(','))

/* ------------------------------------------------------------------ */
/* 3. .dockerignore 不能把镜像需要的东西挡掉                             */
/* ------------------------------------------------------------------ */

/**
 * 判定「某路径是否被 .dockerignore 排除」。
 * 只实现需要的语义：按顺序取最后一条命中的规则；`*` 不跨 `/`；`**` 跨 `/`；
 * `!` 前缀表示重新放行。不追求与 Docker 完全等价的边界行为，
 * 够用来抓「整类文件被误挡」这种粗粒度错误。
 */
function toRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  // 无斜杠的模式在 Docker 里匹配任意层级
  const prefix = pattern.includes('/') ? '^' : '(^|/)'
  return new RegExp(`${prefix}${escaped}(/.*)?$`)
}

const rules = dockerignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => (line.startsWith('!') ? { negate: true, re: toRegExp(line.slice(1)) } : { negate: false, re: toRegExp(line) }))

function isIgnored(relPath) {
  let ignored = false
  for (const rule of rules) {
    if (rule.re.test(relPath)) ignored = !rule.negate
  }
  return ignored
}

const mustBeIncluded = [
  'package.json',
  'package-lock.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/web/package.json',
  'packages/server/src/app.ts',
  'packages/web/index.html',
  'bin/webterm.mjs',
  'tsconfig.base.json',
  'data/plugins/heartbeat-monitor/index.js',
]
for (const rel of mustBeIncluded) {
  check(`未被 .dockerignore 排除：${rel}`, !isIgnored(rel))
}

// 反面：运行期数据必须被挡掉，否则用户凭据会被打进镜像分发出去
const mustBeExcluded = ['data/webterm.db', 'data/keys/id_rsa', 'data/logs/x.log', 'node_modules/fastify/index.js', '.env']
for (const rel of mustBeExcluded) {
  check(`已被 .dockerignore 排除：${rel}`, isIgnored(rel))
}

/* ------------------------------------------------------------------ */

console.log(failed === 0 ? '\n===== Dockerfile 静态自检：全部通过 =====' : `\n===== Dockerfile 静态自检：${failed} 项失败 =====`)
console.log('注意：本脚本不构建镜像，无法替代 `docker build`。')
process.exit(failed === 0 ? 0 : 1)
