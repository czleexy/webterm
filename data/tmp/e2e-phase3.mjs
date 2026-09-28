/**
 * 阶段 3（SFTP 文件传输）端到端验证。
 *
 * 自管三个 mock SSH 与一个服务端实例：
 *   2231  常规后端（目录列举、文件操作、传输、并发、暂停/取消）
 *   2232  带一次性写故障注入的后端（验证断点续传）
 *   2233  禁用 sftp 子系统的后端（验证「远端不支持 SFTP」的提示）
 *   8096  服务端（独立数据目录与本地根目录，不影响开发用的 8080）
 *
 * 运行：node data/tmp/e2e-phase3.mjs
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
const WORK = path.join(ROOT, 'data/tmp/e2e-p3')
const API = 'http://127.0.0.1:8096'
const PORT = 8096

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

let pass = 0
const failures = []
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}${extra ? `  ${extra}` : ''}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`)
  }
}

const children = []
function startMock(port, env = {}) {
  const child = spawn(NODE_EXE, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      MOCK_SFTP_ROOT: path.join(WORK, `mock-${port}`),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.env.MOCK_DEBUG && process.stdout.write(`  [${port}] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  [${port}!] ${d}`))
  children.push(child)
  return child
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
  child.on('exit', (code) => (log += `\n[server exit] ${code}`))
  child.getLog = () => log
  children.push(child)
  return child
}

async function waitHealthy(timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${API}/api/health`)
      if (r.ok) return
    } catch {
      /* 未就绪 */
    }
    if (Date.now() - started > timeoutMs) throw new Error('服务端启动超时')
    await sleep(200)
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`)
    this.status = status
    this.code = body?.error
    this.body = body
  }
}

async function api(pathname, init = {}) {
  const response = await fetch(`${API}/api${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (response.status === 204) return undefined
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = { raw: text }
  }
  if (!response.ok) throw new ApiError(response.status, body)
  return body
}

const json = (method, body) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

/** 轮询某条任务直到进入终态 */
async function waitTask(sftpId, taskId, timeoutMs = 120_000) {
  const started = Date.now()
  let last
  for (;;) {
    const list = await api(`/sftp/sessions/${sftpId}/transfers`)
    last = list.tasks.find((t) => t.id === taskId)
    if (last && ['done', 'failed', 'canceled'].includes(last.state)) return last
    if (Date.now() - started > timeoutMs) {
      throw new Error(`任务未在超时内结束：${JSON.stringify(last)}`)
    }
    await sleep(60)
  }
}

async function waitState(sftpId, taskId, states, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    const list = await api(`/sftp/sessions/${sftpId}/transfers`)
    const task = list.tasks.find((t) => t.id === taskId)
    if (task && states.includes(task.state)) return task
    if (Date.now() - started > timeoutMs) throw new Error(`未等到状态 ${states}：${JSON.stringify(task)}`)
    await sleep(20)
  }
}

const readLocal = (rel) => fs.readFileSync(path.join(WORK, 'local', rel))

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

/* ================================================================== */
/* 准备数据                                                            */
/* ================================================================== */

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })
for (const port of [2231, 2232, 2233]) {
  fs.mkdirSync(path.join(WORK, `mock-${port}`), { recursive: true })
}

// mock 2231 的远端预置内容
const remoteRoot = path.join(WORK, 'mock-2231')
fs.writeFileSync(path.join(remoteRoot, 'readme.txt'), '远程说明文件\nwebterm sftp e2e\n')
fs.mkdirSync(path.join(remoteRoot, 'docs'), { recursive: true })
fs.writeFileSync(path.join(remoteRoot, 'docs/guide.md'), '# 指南\n\n阶段 3 文件传输。\n')
fs.writeFileSync(path.join(remoteRoot, 'blob.bin'), randomBytes(4096))

// 本地待上传内容
const SMALL = randomBytes(3 * 1024 * 1024)
fs.writeFileSync(path.join(WORK, 'local/small.bin'), SMALL)

const BIG = randomBytes(24 * 1024 * 1024)
fs.writeFileSync(path.join(WORK, 'local/big.bin'), BIG)
for (let i = 0; i < 4; i += 1) {
  fs.copyFileSync(path.join(WORK, 'local/big.bin'), path.join(WORK, `local/concurrent-${i}.bin`))
}

// 目录树（验证递归传输与结构保持）
const treeFiles = {
  'tree/a.txt': randomBytes(2048),
  'tree/nested/b.bin': randomBytes(200_000),
  'tree/nested/deep/c.txt': Buffer.from('深层文件内容\n'),
  'tree/nested/deep/d.log': randomBytes(50_000),
}
for (const [rel, buf] of Object.entries(treeFiles)) {
  const target = path.join(WORK, 'local', rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buf)
}

const RESUME = randomBytes(12 * 1024 * 1024)
fs.writeFileSync(path.join(WORK, 'local/resume.bin'), RESUME)

console.log('=== 阶段 3 SFTP 端到端 ===')

startMock(2231)
startMock(2232, { MOCK_SFTP_FAIL_ONCE_AFTER: String(2 * 1024 * 1024) })
startMock(2233, { MOCK_NO_SFTP: '1' })
const server = startServer()

await waitHealthy()
await sleep(500)

try {
  /* ---------------- A. 会话 ---------------- */
  console.log('\n[A] 会话建立')
  const target = { host: '127.0.0.1', port: 2231, username: 'demo', password: 'demo', authMethod: 'password' }
  const created = await api(
    '/sftp/sessions',
    json('POST', { config: { target, legacyCompat: 'auto' }, title: 'e2e-2231' }),
  )
  const sftpId = created.sftpId
  check('建立 SFTP 会话', Boolean(sftpId), `remoteHome=${created.remoteHome}`)
  check('远端初始目录是家目录', created.remoteHome === '/home/demo', created.remoteHome)
  check('本地根目录与会话一致', created.localRoot.replace(/\\/g, '/').endsWith('e2e-p3/local'), created.localRoot)
  check('初始为独立连接', created.reusedConnection === false)

  // 终端连接复用
  const terminal = await api('/terminals', json('POST', { config: { target, terminal: { cols: 80, rows: 24, encoding: 'utf8', term: 'xterm-256color' } } }))
  const reused = await api(
    '/sftp/sessions',
    json('POST', { config: { target }, terminalId: terminal.terminalId, title: 'reuse' }),
  )
  check('复用终端连接', reused.reusedConnection === true)
  const reuseList = await api(`/sftp/sessions/${reused.sftpId}/list?side=remote`)
  check('复用连接可正常列目录', reuseList.entries.length >= 3, `${reuseList.entries.length} 项`)

  const bogus = await api('/sftp/sessions', json('POST', { config: { target }, terminalId: 'not-exist' }))
  check('无效 terminalId 退化为独立连接', bogus.reusedConnection === false)

  /* ---------------- B. 列举与文件操作 ---------------- */
  console.log('\n[B] 目录列举与文件操作')
  const remoteList = await api(`/sftp/sessions/${sftpId}/list?side=remote`)
  const names = remoteList.entries.map((e) => e.name).sort()
  check('远端列目录', names.includes('readme.txt') && names.includes('docs'), names.join(','))
  const readme = remoteList.entries.find((e) => e.name === 'readme.txt')
  check('条目含大小与权限', readme.size > 0 && readme.mode === 0o644, `mode=${readme.mode.toString(8)}`)
  check('目录条目类型正确', remoteList.entries.find((e) => e.name === 'docs')?.type === 'dir')
  check('远端父目录', remoteList.parent === '/home', remoteList.parent)

  const localList = await api(`/sftp/sessions/${sftpId}/list?side=local`)
  check('本地列目录', localList.entries.some((e) => e.name === 'small.bin'))
  check('本地根不可再向上', localList.parent === null, String(localList.parent))

  await api(`/sftp/sessions/${sftpId}/mkdir`, json('POST', { side: 'remote', path: '/home/demo', name: 'newdir' }))
  const afterMkdir = await api(`/sftp/sessions/${sftpId}/list?side=remote`)
  check('远端新建目录', afterMkdir.entries.some((e) => e.name === 'newdir' && e.type === 'dir'))

  await api(`/sftp/sessions/${sftpId}/rename`, json('POST', { side: 'remote', from: '/home/demo/newdir', to: '/home/demo/renamed' }))
  const afterRename = await api(`/sftp/sessions/${sftpId}/list?side=remote`)
  check('远端重命名', afterRename.entries.some((e) => e.name === 'renamed'))

  await api(`/sftp/sessions/${sftpId}/chmod`, json('POST', { side: 'remote', path: '/home/demo/readme.txt', mode: '600' }))
  const afterChmod = await api(`/sftp/sessions/${sftpId}/list?side=remote`)
  const chmodded = afterChmod.entries.find((e) => e.name === 'readme.txt')
  check('chmod 600 生效', chmodded.mode === 0o600, `mode=${chmodded.mode.toString(8)} (${chmodded.modeText})`)

  await api(`/sftp/sessions/${sftpId}/touch`, json('POST', { side: 'remote', path: '/home/demo/touched.txt' }))
  const afterTouch = await api(`/sftp/sessions/${sftpId}/list?side=remote`)
  check('touch 创建空文件', afterTouch.entries.some((e) => e.name === 'touched.txt' && e.size === 0))

  await api(`/sftp/sessions/${sftpId}/remove`, json('POST', { side: 'remote', paths: ['/home/demo/touched.txt', '/home/demo/renamed'] }))
  const afterRemove = await api(`/sftp/sessions/${sftpId}/list?side=remote`)
  check('删除文件与目录', !afterRemove.entries.some((e) => ['touched.txt', 'renamed'].includes(e.name)))

  /* ---------------- C. 传输 ---------------- */
  console.log('\n[C] 传输队列')
  const up1 = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/small.bin')], targetDir: '/home/demo' }))
  const up1Task = await waitTask(sftpId, up1.tasks[0].id)
  check('上传单文件完成', up1Task.state === 'done', `${up1Task.state} ${up1Task.error || ''}`)
  check(
    '上传内容一致',
    sha(fs.readFileSync(path.join(remoteRoot, 'small.bin'))) === sha(SMALL),
  )
  check('落地文件大小一致', up1Task.size === SMALL.length && up1Task.transferred === SMALL.length)

  const down1 = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'download', sources: ['/home/demo/small.bin'], targetDir: path.join(WORK, 'local/downloads'), overwrite: true }))
  const down1Task = await waitTask(sftpId, down1.tasks[0].id)
  check('下载单文件完成', down1Task.state === 'done', `${down1Task.state} ${down1Task.error || ''}`)
  check('下载内容一致', sha(fs.readFileSync(path.join(WORK, 'local/downloads/small.bin'))) === sha(SMALL))

  const upTree = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/tree')], targetDir: '/home/demo', recursive: true, overwrite: true }))
  const upTreeTask = await waitTask(sftpId, upTree.tasks[0].id)
  check('递归上传目录完成', upTreeTask.state === 'done', `${upTreeTask.state} ${upTreeTask.error || ''}`)
  check('目录聚合统计', upTreeTask.isDirectory === true && upTreeTask.filesTotal === 4, `files=${upTreeTask.filesDone}/${upTreeTask.filesTotal}`)
  const treeOk =
    Object.entries(treeFiles).every(([rel, buf]) => {
      const remoteRel = rel.replace(/^tree\//, 'tree/')
      const host = path.join(remoteRoot, remoteRel.split('/').join(path.sep))
      return fs.existsSync(host) && sha(fs.readFileSync(host)) === sha(buf)
    }) && fs.existsSync(path.join(remoteRoot, 'tree/nested/deep'))
  check('目录结构与内容保持', treeOk)

  const downTree = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'download', sources: ['/home/demo/tree'], targetDir: path.join(WORK, 'local/tree-back'), recursive: true, overwrite: true }))
  const downTreeTask = await waitTask(sftpId, downTree.tasks[0].id)
  check('递归下载目录完成', downTreeTask.state === 'done', `${downTreeTask.state} ${downTreeTask.error || ''}`)
  // 目录下载保留源目录名：local/tree-back/tree/...（与 cp -r、FileZilla 一致）
  const backOk =
    Object.entries(treeFiles).every(([rel, buf]) => {
      const host = path.join(WORK, 'local/tree-back', rel.split('/').join(path.sep))
      return fs.existsSync(host) && sha(fs.readFileSync(host)) === sha(buf)
    }) && fs.existsSync(path.join(WORK, 'local/tree-back/tree/nested/deep'))
  check('下载目录结构与内容保持', backOk)

  // 覆盖保护
  const conflict = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/small.bin')], targetDir: '/home/demo', overwrite: false }))
  const conflictTask = await waitTask(sftpId, conflict.tasks[0].id)
  check('目标已存在时拒绝覆盖', conflictTask.state === 'failed' && /已存在/.test(conflictTask.error || ''), conflictTask.error || '')

  // 并发与同目标串行
  const sources = [0, 1, 2, 3].map((i) => path.join(WORK, `local/concurrent-${i}.bin`))
  const conc = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources, targetDir: '/home/demo/conc', overwrite: true }))
  const concIds = conc.tasks.map((t) => t.id)
  let maxRunning = 0
  let sawPending = 0
  const sampler = setInterval(async () => {
    try {
      const list = await api(`/sftp/sessions/${sftpId}/transfers`)
      const mine = list.tasks.filter((t) => concIds.includes(t.id))
      maxRunning = Math.max(maxRunning, mine.filter((t) => t.state === 'running').length)
      sawPending = Math.max(sawPending, mine.filter((t) => t.state === 'pending').length)
    } catch {
      /* 忽略采样失败 */
    }
  }, 20)
  const concDone = []
  for (const id of concIds) concDone.push(await waitTask(sftpId, id))
  clearInterval(sampler)
  check('并发任务全部完成', concDone.every((t) => t.state === 'done'))
  check('并发不超过上限（3）', maxRunning <= 3, `观察到最大并发 ${maxRunning}`)
  check('并发确实生效', maxRunning >= 2, `观察到最大并发 ${maxRunning}`)

  const serial = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', {
    direction: 'download',
    sources: ['/home/demo/conc/concurrent-0.bin', '/home/demo/conc/concurrent-0.bin'],
    targetDir: path.join(WORK, 'local/serial'),
    overwrite: true,
  }))
  const serialIds = serial.tasks.map((t) => t.id)
  let bothRunning = false
  const serialSampler = setInterval(async () => {
    try {
      const list = await api(`/sftp/sessions/${sftpId}/transfers`)
      const mine = list.tasks.filter((t) => serialIds.includes(t.id))
      if (mine.filter((t) => t.state === 'running').length > 1) bothRunning = true
    } catch {
      /* 忽略 */
    }
  }, 10)
  for (const id of serialIds) await waitTask(sftpId, id)
  clearInterval(serialSampler)
  check('同目标任务串行执行', bothRunning === false)
  check('串行任务内容正确', sha(fs.readFileSync(path.join(WORK, 'local/serial/concurrent-0.bin'))) === sha(BIG))

  /* ---------------- 暂停 / 继续 / 取消 ---------------- */
  const pauseTarget = '/home/demo/pause-test'
  const pauseUp = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/big.bin')], targetDir: pauseTarget, overwrite: true }))
  const pauseId = pauseUp.tasks[0].id
  await waitState(sftpId, pauseId, ['running'])
  await sleep(60)
  const paused = await api(`/sftp/sessions/${sftpId}/transfers/${pauseId}/pause`, json('POST'))
  check('暂停任务', paused.task.state === 'paused', paused.task.state)
  const frozen = await api(`/sftp/sessions/${sftpId}/transfers`)
  const before = frozen.tasks.find((t) => t.id === pauseId)
  await sleep(300)
  const after = (await api(`/sftp/sessions/${sftpId}/transfers`)).tasks.find((t) => t.id === pauseId)
  check('暂停后进度冻结', after.transferred === before.transferred, `${before.transferred} -> ${after.transferred}`)
  await api(`/sftp/sessions/${sftpId}/transfers/${pauseId}/resume`, json('POST'))
  const resumed = await waitTask(sftpId, pauseId)
  check('继续后完成', resumed.state === 'done', `${resumed.state} ${resumed.error || ''}`)
  check('暂停继续后内容一致', sha(fs.readFileSync(path.join(remoteRoot, 'pause-test/big.bin'))) === sha(BIG))

  const cancelTarget = '/home/demo/cancel-test'
  const cancelUp = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/big.bin')], targetDir: cancelTarget, overwrite: true }))
  const cancelId = cancelUp.tasks[0].id
  await waitState(sftpId, cancelId, ['running'])
  await sleep(60)
  const canceled = await api(`/sftp/sessions/${sftpId}/transfers/${cancelId}/cancel`, json('POST'))
  check('取消任务', canceled.task.state === 'canceled', canceled.task.state)
  // 清理要等远端 CLOSE 往返完成（Windows 上句柄未关时删除会 EBUSY），因此轮询等待
  const cancelPartial = path.join(remoteRoot, 'cancel-test/big.bin')
  let cleaned = false
  for (let i = 0; i < 40 && !cleaned; i += 1) {
    if (!fs.existsSync(cancelPartial)) cleaned = true
    else await sleep(50)
  }
  check('取消后半成品被清理', cleaned)
  const removed = await api(`/sftp/sessions/${sftpId}/transfers/${cancelId}`, { method: 'DELETE' })
  check('移除已结束任务', removed === undefined)

  /* ---------------- 断点续传（注入一次性写故障） ---------------- */
  console.log('\n[D] 断点续传')
  const resumeTarget = { host: '127.0.0.1', port: 2232, username: 'demo', password: 'demo', authMethod: 'password' }
  const resumeSession = await api('/sftp/sessions', json('POST', { config: { target: resumeTarget }, title: 'resume' }))
  const resumeId = resumeSession.sftpId
  const resumeUp = await api(`/sftp/sessions/${resumeId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/resume.bin')], targetDir: '/home/demo', overwrite: true }))
  const resumeTaskId = resumeUp.tasks[0].id
  const failed = await waitTask(resumeId, resumeTaskId)
  check('注入故障导致首次失败', failed.state === 'failed', `${failed.state} ${failed.error || ''}`)

  const resumeHostPath = path.join(WORK, 'mock-2232/resume.bin')
  const partialSize = fs.existsSync(resumeHostPath) ? fs.statSync(resumeHostPath).size : 0
  check('失败时保留半成品', partialSize > 0 && partialSize < RESUME.length, `${partialSize}/${RESUME.length}`)

  /**
   * 行为级证明「真的续传而不是重传」：
   * 把半成品的前 partialSize 字节改写成 0xAB 标记，然后重试。
   * 若从断点续传，这些标记字节必须原样保留（说明没有重新发送）；
   * 若从头重传，整个文件都会等于源内容。
   */
  fs.writeFileSync(resumeHostPath, Buffer.concat([Buffer.alloc(partialSize, 0xab), fs.readFileSync(resumeHostPath).subarray(partialSize)]))

  const retried = await api(`/sftp/sessions/${resumeId}/transfers/${resumeTaskId}/retry`, json('POST'))
  check('重试起点不低于断点', retried.task.transferred >= partialSize, `起点 ${retried.task.transferred}，半成品 ${partialSize}`)
  const resumedTask = await waitTask(resumeId, resumeTaskId)
  check('断点续传完成', resumedTask.state === 'done', `${resumedTask.state} ${resumedTask.error || ''}`)

  const finalBuf = fs.readFileSync(resumeHostPath)
  const prefixIntact = finalBuf.subarray(0, partialSize).every((b) => b === 0xab)
  const suffixOk = sha(finalBuf.subarray(partialSize)) === sha(RESUME.subarray(partialSize))
  check('断点前的字节未被重传', prefixIntact, `前 ${partialSize} 字节保持标记`)
  check('断点后的字节正确写入', suffixOk && finalBuf.length === RESUME.length)

  /* ---------------- 源不存在 ---------------- */
  const missing = await api(`/sftp/sessions/${sftpId}/transfers`, json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/does-not-exist.bin')], targetDir: '/home/demo' }))
  const missingTask = await waitTask(sftpId, missing.tasks[0].id)
  check('源不存在时任务失败', missingTask.state === 'failed' && /不存在/.test(missingTask.error || ''), missingTask.error || '')

  /* ---------------- E. 浏览器上传 / 下载原始流 ---------------- */
  console.log('\n[E] 浏览器上传下载（octet-stream / Range）')
  const browserBuf = randomBytes(1024 * 512)
  const upStream = await fetch(`${API}/api/sftp/sessions/${sftpId}/upload?path=${encodeURIComponent('/home/demo/browser.bin')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: browserBuf,
  })
  const upStreamBody = await upStream.json()
  check('浏览器上传（octet-stream）', upStream.ok && upStreamBody.size === browserBuf.length, `size=${upStreamBody?.size}`)
  check('浏览器上传内容一致', sha(fs.readFileSync(path.join(remoteRoot, 'browser.bin'))) === sha(browserBuf))

  const tail = randomBytes(1024 * 128)
  const upOffset = await fetch(`${API}/api/sftp/sessions/${sftpId}/upload?path=${encodeURIComponent('/home/demo/browser.bin')}&offset=${browserBuf.length}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: tail,
  })
  const upOffsetBody = await upOffset.json()
  check('浏览器续写（offset）', upOffset.ok && upOffsetBody.size === browserBuf.length + tail.length, `size=${upOffsetBody?.size}`)
  check('续写内容正确', sha(fs.readFileSync(path.join(remoteRoot, 'browser.bin'))) === sha(Buffer.concat([browserBuf, tail])))

  const full = await fetch(`${API}/api/sftp/sessions/${sftpId}/download?path=${encodeURIComponent('/home/demo/browser.bin')}`)
  const fullBuf = Buffer.from(await full.arrayBuffer())
  check('浏览器下载全量', full.status === 200 && sha(fullBuf) === sha(Buffer.concat([browserBuf, tail])))
  check('响应声明支持 Range', full.headers.get('accept-ranges') === 'bytes')

  const ranged = await fetch(`${API}/api/sftp/sessions/${sftpId}/download?path=${encodeURIComponent('/home/demo/browser.bin')}`, {
    headers: { Range: 'bytes=100-199' },
  })
  const rangedBuf = Buffer.from(await ranged.arrayBuffer())
  const expectedSlice = Buffer.concat([browserBuf, tail]).subarray(100, 200)
  check('Range 请求返回 206', ranged.status === 206, String(ranged.status))
  check('Range 内容正确', rangedBuf.length === 100 && sha(rangedBuf) === sha(expectedSlice), `len=${rangedBuf.length}`)
  check('Content-Range 正确', ranged.headers.get('content-range') === `bytes 100-199/${browserBuf.length + tail.length}`, ranged.headers.get('content-range') || '')

  const localDl = await fetch(`${API}/api/sftp/sessions/${sftpId}/local/download?path=${encodeURIComponent(path.join(WORK, 'local/small.bin'))}`)
  const localBuf = Buffer.from(await localDl.arrayBuffer())
  check('本地文件下载', localDl.status === 200 && sha(localBuf) === sha(SMALL))

  /* ---------------- F. 安全 ---------------- */
  console.log('\n[F] 路径安全')
  for (const bad of ['../../..', path.join(WORK, 'local/../../..'), path.resolve(path.sep === '\\' ? 'C:\\Windows' : '/etc')]) {
    const res = await api(`/sftp/sessions/${sftpId}/list?side=local&path=${encodeURIComponent(bad)}`).then(
      () => ({ status: 200, code: 'OK' }),
      (err) => ({ status: err.status, code: err.code }),
    )
    check(`本地越界路径被拒：${bad.slice(0, 28)}`, res.status === 403 && res.code === 'PATH_ESCAPE', `HTTP ${res.status} ${res.code}`)
  }
  const relRemote = await api(`/sftp/sessions/${sftpId}/list?side=remote&path=${encodeURIComponent('relative/dir')}`).then(
    () => ({ status: 200, code: 'OK' }),
    (err) => ({ status: err.status, code: err.code }),
  )
  check('远端相对路径被拒', relRemote.status === 400 && relRemote.code === 'INVALID_PATH', `HTTP ${relRemote.status} ${relRemote.code}`)
  const escapeRemove = await api(`/sftp/sessions/${sftpId}/remove`, json('POST', { side: 'local', paths: ['../../etc'] })).then(
    () => ({ status: 200, code: 'OK' }),
    (err) => ({ status: err.status, code: err.code }),
  )
  check('本地越界删除被拒', escapeRemove.status === 403 && escapeRemove.code === 'PATH_ESCAPE', `HTTP ${escapeRemove.status} ${escapeRemove.code}`)

  /* ---------------- G. 预览与远程编辑 ---------------- */
  console.log('\n[G] 文本预览与远程编辑')
  const preview = await api(`/sftp/sessions/${sftpId}/preview`, json('POST', { path: '/home/demo/readme.txt' }))
  check('文本预览', preview.kind === 'text' && preview.editable === true && preview.content.includes('webterm'), `kind=${preview.kind}`)
  check('预览返回 mtime', typeof preview.mtime === 'number' && preview.mtime > 0)

  const conflictSave = await api(`/sftp/sessions/${sftpId}/save`, json('POST', { path: '/home/demo/readme.txt', content: 'x', expectedMtime: preview.mtime - 60_000 })).then(
    () => ({ status: 200, code: 'OK' }),
    (err) => ({ status: err.status, code: err.code }),
  )
  check('过期 mtime 保存被拒', conflictSave.status === 409 && conflictSave.code === 'CONFLICT', `HTTP ${conflictSave.status} ${conflictSave.code}`)

  const saved = await api(`/sftp/sessions/${sftpId}/save`, json('POST', { path: '/home/demo/readme.txt', content: '已远程编辑\n第二行\n', expectedMtime: preview.mtime, mode: preview.mode }))
  check('保存编辑结果', saved.ok === true)
  check('保存后内容生效', fs.readFileSync(path.join(remoteRoot, 'readme.txt'), 'utf8') === '已远程编辑\n第二行\n')
  check('保存沿用原权限', (await api(`/sftp/sessions/${sftpId}/list?side=remote`)).entries.find((e) => e.name === 'readme.txt').mode === 0o600)

  const binPreview = await api(`/sftp/sessions/${sftpId}/preview`, json('POST', { path: '/home/demo/blob.bin' }))
  check('二进制文件禁止编辑', binPreview.kind === 'binary' && binPreview.editable === false, binPreview.reason || '')

  const bigPreview = await api(`/sftp/sessions/${sftpId}/preview`, json('POST', { path: '/home/demo/small.bin', maxBytes: 1024 }))
  check('超限预览标记截断', bigPreview.truncated === true && bigPreview.editable === false)

  /* ---------------- H. 远端不支持 SFTP ---------------- */
  console.log('\n[H] 远端不支持 SFTP 的提示')
  const noSftpTarget = { host: '127.0.0.1', port: 2233, username: 'demo', password: 'demo', authMethod: 'password' }
  const noSftp = await api('/sftp/sessions', json('POST', { config: { target: noSftpTarget } })).then(
    () => ({ status: 200, code: 'OK', message: '' }),
    (err) => ({ status: err.status, code: err.code, message: err.message }),
  )
  check('禁用 sftp 时创建会话失败', noSftp.status >= 400, `HTTP ${noSftp.status} ${noSftp.code}`)
  check('错误信息指出 SFTP 子系统', /SFTP|子系统/.test(noSftp.message), noSftp.message.split('\n')[0])

  /* ---------------- 收尾 ---------------- */
  console.log('\n[I] 会话关闭')
  await api(`/sftp/sessions/${sftpId}`, { method: 'DELETE' })
  const gone = await api(`/sftp/sessions/${sftpId}/list?side=remote`).then(
    () => ({ status: 200, code: 'OK' }),
    (err) => ({ status: err.status, code: err.code }),
  )
  check('关闭后会话不可用', gone.status === 404 && gone.code === 'SESSION_NOT_FOUND', `HTTP ${gone.status} ${gone.code}`)

  // 现开一个终端再借它建会话，避免被「创建后长期未附加」的回收逻辑影响判定
  const freshTerminal = await api(
    '/terminals',
    json('POST', {
      config: {
        target,
        terminal: { cols: 80, rows: 24, encoding: 'utf8', term: 'xterm-256color' },
      },
    }),
  )
  const borrowedSession = await api(
    '/sftp/sessions',
    json('POST', { config: { target }, terminalId: freshTerminal.terminalId }),
  )
  await api(`/sftp/sessions/${borrowedSession.sftpId}`, { method: 'DELETE' })
  const terminalStill = await api(`/terminals/${freshTerminal.terminalId}`).then(
    () => true,
    () => false,
  )
  check('关闭借用的 SFTP 会话不影响终端连接', terminalStill === true)
} catch (err) {
  console.error('\n[异常]', err?.stack || err)
  failures.push(`异常：${err?.message || err}`)
} finally {
  console.log(`\n==> 阶段 3 E2E：${pass} 通过 / ${failures.length} 失败`)
  if (failures.length > 0) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
  cleanup()
  await sleep(200)
  process.exit(failures.length === 0 ? 0 : 1)
}
