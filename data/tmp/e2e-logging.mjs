/**
 * 阶段 7（日志与审计）端到端验证。
 *
 * 自管一个 mock SSH 与一个服务端实例：
 *   2442  mock SSH（会话输出 / SFTP 传输的业务端）
 *   8102  服务端（独立数据目录，不影响开发用的 8080）
 *
 * 验证重点（日志系统最容易翻车的地方）：
 *   1. 三种格式的日志文件真的生成，plain 里没有 ANSI 转义字节
 *   2. 脱敏规则在写入前生效（默认 password 规则 + 自定义规则）
 *   3. HTML 快照分片装配：乱序丢弃、final 原子落盘、扩展名 .html
 *   4. 20 MB 轮转真的切分出 part 文件；大文件按行窗口随机访问不卡
 *   5. 保留天数收紧后立即清理（含手工伪造的过期文件）
 *   6. 审计事件齐全且带来源 IP：connect / disconnect / upload / download /
 *      macro_run / log_delete / settings_change
 *   7. 路径安全：文件 id 越出日志根目录一律拒绝
 *
 * 运行：npm run build && node data/tmp/e2e-logging.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
const WORK = path.join(ROOT, 'data/tmp/logging-e2e')
const PORT = 8102
const API = `http://127.0.0.1:${PORT}`
const WS_BASE = `ws://127.0.0.1:${PORT}`

const MOCK_SSH = 2442
const LOGS_ROOT = path.join(WORK, 'data/logs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/* ------------------------------------------------------------------ */
/* 进程管理                                                            */
/* ------------------------------------------------------------------ */

const children = []
function spawnChild(args, env) {
  const child = spawn(NODE_EXE, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.env.MOCK_DEBUG && process.stdout.write(`  ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`  ! ${d}`))
  children.push(child)
  return child
}

function startMock(port) {
  return spawnChild([`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    MOCK_PORT: String(port),
    MOCK_SFTP_ROOT: path.join(WORK, `mock-${port}`),
  })
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

/* ------------------------------------------------------------------ */
/* REST 工具                                                            */
/* ------------------------------------------------------------------ */

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

const json = (method, body) => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

async function expectError(pathname, init) {
  try {
    await api(pathname, init)
    return null
  } catch (err) {
    return err instanceof ApiError ? err : null
  }
}

/** 轮询直到条件满足 */
async function waitFor(fn, timeoutMs = 5000, intervalMs = 80) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) return undefined
    await sleep(intervalMs)
  }
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ */
/* 终端收集器（同 e2e-telnet 模式）                                      */
/* ------------------------------------------------------------------ */

async function openTerminalBySession(sessionId) {
  const created = await api('/terminals', json('POST', { sessionId }))
  const ws = new WebSocket(
    `${WS_BASE}${created.wsPath}?token=${encodeURIComponent(created.attachToken)}`,
  )
  const collector = {
    created,
    ws,
    chunks: [],
    control: [],
    errors: [],
    /** 未 ack 的输出字节数（服务端按此做背压，必须定期回报） */
    unacked: 0,
    get text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once('close', () => resolve())
        ws.close()
      }),
  }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      collector.chunks.push(Buffer.from(data))
      // 模拟前端行为：消费 32KB 回一次 ack，否则服务端在高水位暂停远端
      collector.unacked += data.length
      if (collector.unacked >= 32 * 1024) {
        ws.send(JSON.stringify({ t: 'ack', bytes: collector.unacked }))
        collector.unacked = 0
      }
    } else {
      try {
        collector.control.push(JSON.parse(data.toString()))
      } catch {
        /* 忽略非法控制帧 */
      }
    }
  })
  ws.on('error', (err) => collector.errors.push(err))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 附加超时')), 10_000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  return collector
}

const sendInput = (collector, text) => collector.ws.send(Buffer.from(text))
const sendControl = (collector, msg) => collector.ws.send(JSON.stringify(msg))

/** 只建终端不附加 WS（大流量场景：避免未消费的 WS 背压拖慢输出） */
async function openTerminalRaw(sessionId) {
  const created = await api('/terminals', json('POST', { sessionId }))
  return {
    created,
    close: async () => {
      await api(`/terminals/${created.terminalId}`, { method: 'DELETE' }).catch(() => {})
    },
  }
}

/** 等待终端输出里出现指定文本 */
async function waitText(collector, needle, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    if (collector.text.includes(needle)) return true
    if (Date.now() - started > timeoutMs) return false
    await sleep(50)
  }
}

/** 关闭终端：WS 与 REST 会话都收掉（触发 writer 收尾与 disconnect 审计） */
async function closeTerminal(collector) {
  await collector.close().catch(() => {})
  await api(`/terminals/${collector.created.terminalId}`, { method: 'DELETE' }).catch(() => {})
}

const sshTarget = {
  host: '127.0.0.1',
  port: MOCK_SSH,
  username: 'demo',
  authMethod: 'password',
  password: 'demo',
}

const sshSession = {
  protocol: 'ssh',
  host: sshTarget.host,
  port: sshTarget.port,
  username: sshTarget.username,
  authMethod: 'password',
  password: sshTarget.password,
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })

const mock = startMock(MOCK_SSH)
const server = startServer()
await waitHealthy()
console.log('服务端与 mock SSH 已就绪\n')

try {
  /* ---------------- 0. 保险库与凭据（会话库 SSH 记录必需） ---------------- */

  await api('/vault/setup', json('POST', { masterPassword: 'e2e-master-pass' }))
  const cred = await api(
    '/credentials',
    json('POST', { name: 'e2e 凭据', type: 'password', password: 'demo' }),
  )
  check('保险库就绪且凭据已创建', Boolean(cred.id))

  /* ---------------- A. 设置与能力 ---------------- */
  console.log('[A] 设置与能力')

  const caps = await api('/capabilities')
  check('capabilities 声明三种日志格式', caps.logging?.formats?.length === 3, caps.logging?.formats?.join(','))
  check('capabilities 声明轮转阈值为 20 MB', caps.logging?.rotateBytes === 20 * 1024 * 1024)

  const defaults = await api('/logs/settings')
  check(
    '默认设置：保留 30 天且含默认 password 脱敏规则',
    defaults.retentionDays === 30 &&
      defaults.redactionRules.some((r) => r.pattern.includes('password') && r.enabled),
    `${defaults.retentionDays} 天 / ${defaults.redactionRules.length} 条规则`,
  )

  // 追加一条自定义规则（保留默认规则一起提交）
  const rulesPayload = [
    ...defaults.redactionRules,
    { name: '令牌脱敏', pattern: 'token=\\S+', replacement: 'token=***', enabled: true },
  ]
  const updated = await api('/logs/settings', json('PUT', { redactionRules: rulesPayload }))
  check(
    '自定义脱敏规则已保存',
    updated.settings?.redactionRules?.some((r) => r.pattern === 'token=\\S+'),
  )

  const badRetention = await expectError('/logs/settings', json('PUT', { retentionDays: 0 }))
  check('保留天数 0 被拒绝（400 校验）', badRetention?.status === 400, `${badRetention?.status}`)

  /* ---------------- B. 会话库节点 ---------------- */
  console.log('\n[B] 会话库节点')

  const librarySession = (logging) => ({
    protocol: 'ssh',
    host: sshSession.host,
    port: sshSession.port,
    username: sshSession.username,
    credentialId: cred.id,
    logging,
  })

  const nodePlain = await api(
    '/library',
    json('POST', {
      kind: 'session',
      name: 'PlainLog',
      session: librarySession({ enabled: true, format: 'plain' }),
    }),
  )
  const nodeTs = await api(
    '/library',
    json('POST', {
      kind: 'session',
      name: 'TsLog',
      session: librarySession({ enabled: true, format: 'timestamped' }),
    }),
  )
  const nodeHtml = await api(
    '/library',
    json('POST', {
      kind: 'session',
      name: 'HtmlLog',
      session: librarySession({ enabled: true, format: 'html' }),
    }),
  )
  const nodeRotate = await api(
    '/library',
    json('POST', {
      kind: 'session',
      name: 'RotateLog',
      session: librarySession({ enabled: true, format: 'plain' }),
    }),
  )
  check(
    '三个格式的会话节点已入库',
    Boolean(nodePlain.id && nodeTs.id && nodeHtml.id && nodeRotate.id),
  )

  /* ---------------- C. plain 会话日志 + 脱敏 + ANSI 剥离 ---------------- */
  console.log('\n[C] plain 日志：ANSI 剥离与脱敏')

  const plain = await openTerminalBySession(nodePlain.id)
  check('创建响应回传日志配置', plain.created.logging?.enabled === true && plain.created.logging?.format === 'plain')
  const nologCreated = await api(
    '/terminals',
    json('POST', { config: { protocol: 'ssh', target: sshTarget }, title: 'nolog' }),
  )
  check(
    '未启用日志的连接不回传日志配置',
    nologCreated.logging === undefined,
    JSON.stringify(nologCreated.logging ?? null),
  )
  await api(`/terminals/${nologCreated.terminalId}`, { method: 'DELETE' }).catch(() => {})

  await waitText(plain, 'WebTerm 测试 SSH 服务端')

  // 宏执行（审计 script 家族事件，此时终端还活着）
  const macroRun = await api(
    '/automation/macros/run',
    json('POST', {
      terminalId: plain.created.terminalId,
      macroName: '审计宏',
      steps: [{ send: 'echo macro-audit-ok', expect: 'macro-audit-ok', expectTimeoutMs: 5000 }],
    }),
  )
  check('宏执行被受理（202）', macroRun.accepted === true)

  sendInput(plain, 'color\n')
  check('color 命令输出到达终端（含 ANSI）', await waitText(plain, 'GREEN-COLOR-MARKER'))
  check('宏执行完成（终端可见宏回显）', await waitText(plain, 'macro-audit-ok'))

  // 脚本执行审计：同一会话上自动化任务互斥，必须等宏跑完再提交
  sendInput(plain, 'echo password=secret123 token=abc123\n')
  check('敏感内容到达终端（原文）', await waitText(plain, 'secret123'))
  await sleep(300)

  const scriptRun = await api(
    '/automation/scripts/run',
    json('POST', {
      terminalId: plain.created.terminalId,
      code: "log('script-audit-ok')\n",
    }),
  )
  check('脚本执行被受理（202）', scriptRun.accepted === true)
  await sleep(600)

  await closeTerminal(plain)
  const plainFiles = await waitFor(async () => {
    const list = await api(`/logs/files?sessionId=${nodePlain.id}`)
    return list.files.length > 0 ? list.files : undefined
  })
  check('plain 会话按天生成日志文件', Boolean(plainFiles), plainFiles ? plainFiles[0].id : '无文件')

  const plainFile = plainFiles[0]
  check('文件日期为今天', plainFile.date === today(), plainFile.date)
  check('目录名 = 会话名-短哈希', plainFile.sessionDir.startsWith('PlainLog-'), plainFile.sessionDir)
  check('列表回传会话名', plainFile.sessionName === 'PlainLog')
  check('格式嗅探为 plain', plainFile.format === 'plain')

  const plainPreview = await api(
    `/logs/files/${encodeURIComponent(plainFile.id)}/preview?start=0&count=500`,
  )
  const plainText = plainPreview.lines.join('\n')
  check('预览包含 RED-COLOR-MARKER', plainText.includes('RED-COLOR-MARKER'))
  check('预览包含 GREEN-COLOR-MARKER', plainText.includes('GREEN-COLOR-MARKER'))
  check('日志中无 ANSI 转义字节', !plainText.includes('\x1b'))
  check('默认规则脱敏 password', plainText.includes('password=***') && !plainText.includes('secret123'))
  check('自定义规则脱敏 token', plainText.includes('token=***') && !plainText.includes('abc123'))
  check('宏输出也在日志里', plainText.includes('macro-audit-ok'))

  // 下载端点
  const download = await fetch(`${API}/api/logs/files/${encodeURIComponent(plainFile.id)}/download`)
  const downloadText = await download.text()
  check(
    '下载端点返回附件流且内容一致',
    download.ok && download.headers.get('content-disposition')?.includes('attachment') && downloadText.includes('RED-COLOR-MARKER'),
  )

  /* ---------------- D. timestamped 会话 ---------------- */
  console.log('\n[D] timestamped 日志')

  const ts = await openTerminalBySession(nodeTs.id)
  check('timestamped 配置回传', ts.created.logging?.format === 'timestamped')
  await waitText(ts, 'WebTerm 测试 SSH 服务端')
  sendInput(ts, 'echo ts-line-ok\n')
  check('输出到达', await waitText(ts, 'ts-line-ok'))
  await sleep(300)
  await closeTerminal(ts)

  const tsFiles = await waitFor(async () => {
    const list = await api(`/logs/files?sessionId=${nodeTs.id}`)
    return list.files.length > 0 ? list.files : undefined
  })
  check('timestamped 文件生成', Boolean(tsFiles), tsFiles ? tsFiles[0].id : '无文件')
  const tsPreview = await api(`/logs/files/${encodeURIComponent(tsFiles[0].id)}/preview?start=0&count=500`)
  const stampRe = /^\[\d{2}:\d{2}:\d{2}\] /
  const nonEmpty = tsPreview.lines.filter((l) => l.trim() !== '')
  const stamped = nonEmpty.filter((l) => stampRe.test(l))
  check(
    '除收尾残行外所有行都带时间戳',
    nonEmpty.length > 1 && stamped.length >= nonEmpty.length - 1,
    `${stamped.length}/${nonEmpty.length} 行`,
  )
  check('目标行带时间戳', tsPreview.lines.some((l) => stampRe.test(l) && l.includes('ts-line-ok')))

  /* ---------------- E. html 快照 ---------------- */
  console.log('\n[E] HTML 快照')

  const html = await openTerminalBySession(nodeHtml.id)
  check('html 配置回传', html.created.logging?.format === 'html')

  // 乱序分片必须被丢弃（从 seq=7 直接开始，前面没有 seq=0）
  sendControl(html, { t: 'log-html', seq: 7, final: false, data: 'OUT-OF-ORDER-GARBAGE' })
  await sleep(200)

  // 正式快照：两片，final 落盘
  sendControl(html, {
    t: 'log-html',
    seq: 0,
    final: false,
    data: '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#111;color:#0f0;font-family:monospace}</style></head><body><pre>',
  })
  sendControl(html, {
    t: 'log-html',
    seq: 1,
    final: true,
    data: 'HTML-SNAPSHOT-MARKER <span style="color:red">红字</span></pre></body></html>',
  })

  const htmlFiles = await waitFor(async () => {
    const list = await api(`/logs/files?sessionId=${nodeHtml.id}`)
    const hit = list.files.find((f) => f.id.endsWith('.html'))
    return hit ? [hit] : undefined
  }, 8000)
  check('HTML 快照落盘为 .html 文件', Boolean(htmlFiles), htmlFiles ? htmlFiles[0].id : '无文件')
  const htmlPreview = await api(
    `/logs/files/${encodeURIComponent(htmlFiles[0].id)}/preview?start=0&count=500`,
  )
  check('快照以 <!DOCTYPE html> 开头', htmlPreview.lines[0]?.startsWith('<!DOCTYPE html>'))
  check('快照内容完整', htmlPreview.lines.join('').includes('HTML-SNAPSHOT-MARKER'))
  check('乱序分片未混入', !htmlPreview.lines.join('').includes('OUT-OF-ORDER-GARBAGE'))
  check('格式嗅探为 html', htmlFiles[0].format === 'html')

  // 删除该文件（产生 log_delete 审计）
  await api(`/logs/files/${encodeURIComponent(htmlFiles[0].id)}`, { method: 'DELETE' })
  await sleep(200)
  const afterDelete = await api(`/logs/files?sessionId=${nodeHtml.id}`)
  check('删除后文件从列表消失', afterDelete.files.length === 0, `剩 ${afterDelete.files.length}`)
  await html.close().catch(() => {})
  await api(`/terminals/${html.created.terminalId}`, { method: 'DELETE' }).catch(() => {})

  /* ---------------- F. 20 MB 轮转与大文件分页预览 ---------------- */
  console.log('\n[F] 轮转与大文件预览')

  const rotate = await openTerminalBySession(nodeRotate.id)
  await waitText(rotate, 'WebTerm 测试 SSH 服务端')
  sendInput(rotate, 'big 21000\n') // ≈21 MB > 20 MB 阈值

  const rotateFiles = await waitFor(async () => {
    const list = await api(`/logs/files?sessionId=${nodeRotate.id}`)
    const part = list.files.find((f) => f.id.includes('.part1.log'))
    return part ? list.files : undefined
  }, 180_000, 1000)
  const growDebug = rotateFiles
    ? rotateFiles.map((f) => `${f.id.split('/').pop()}(${Math.round(f.sizeBytes / 1024)}KB)`).join(' ')
    : (await api(`/logs/files?sessionId=${nodeRotate.id}`)).files
        .map((f) => `${f.id.split('/').pop()}(${Math.round(f.sizeBytes / 1024)}KB)`).join(' ')
  check(
    '超过 20 MB 后切分出 part 文件',
    Boolean(rotateFiles?.find((f) => f.id.includes('.part1.log'))),
    growDebug,
  )

  const mainPart = (rotateFiles ?? []).find((f) => f.id.endsWith(`/${today()}.log`))
  if (!mainPart) {
    check('大文件行数统计正确（> 200k 行）', false, '主文件不存在')
    check('随机跳转到 100000 行成功', false, '主文件不存在')
    check('大文件预览不卡（< 2000 ms）', false, '主文件不存在')
    check('分页行号衔接', false, '主文件不存在')
  } else {
  const bigPreview = await api(`/logs/files/${encodeURIComponent(mainPart.id)}/preview?start=0&count=500`)
  check('大文件行数统计正确（> 200k 行）', bigPreview.totalLines > 200_000, `${bigPreview.totalLines} 行`)

  const t0 = Date.now()
  const jumped = await api(`/logs/files/${encodeURIComponent(mainPart.id)}/preview?start=100000&count=500`)
  const jumpMs = Date.now() - t0
  check('随机跳转到 100000 行成功', jumped.start === 100000 && jumped.lines.length === 500, `${jumpMs} ms`)
  check('大文件预览不卡（< 2000 ms）', jumpMs < 2000, `${jumpMs} ms`)

  // 页间连续性：第 1 页结束行的下一行是第 2 页第一行
  const page1 = bigPreview
  const page2 = await api(`/logs/files/${encodeURIComponent(mainPart.id)}/preview?start=${page1.lines.length}&count=500`)
  check('分页行号衔接', page2.start === page1.lines.length)
  }

  await closeTerminal(rotate)

  /* ---------------- G. SFTP 传输审计 ---------------- */
  console.log('\n[G] SFTP 上传/下载审计')

  const sample = Buffer.alloc(64 * 1024)
  for (let i = 0; i < sample.length; i++) sample[i] = i % 251
  fs.writeFileSync(path.join(WORK, 'local/audit-sample.bin'), sample)

  const sftpCreated = await api(
    '/sftp/sessions',
    json('POST', { config: { target: sshTarget, legacyCompat: 'auto' }, title: 'audit-sftp' }),
  )
  const sftpId = sftpCreated.sftpId
  check('SFTP 会话建立', Boolean(sftpId))

  const up = await api(
    `/sftp/sessions/${sftpId}/transfers`,
    json('POST', { direction: 'upload', sources: [path.join(WORK, 'local/audit-sample.bin')], targetDir: '/home/demo', overwrite: true }),
  )
  const upTask = await waitFor(async () => {
    const { tasks } = await api(`/sftp/sessions/${sftpId}/transfers`)
    return tasks.find((t) => t.id === up.tasks[0].id && t.state === 'done')
  }, 20_000)
  check('上传任务完成', Boolean(upTask))

  const down = await api(
    `/sftp/sessions/${sftpId}/transfers`,
    json('POST', { direction: 'download', sources: ['/home/demo/audit-sample.bin'], targetDir: path.join(WORK, 'local/downloads'), overwrite: true }),
  )
  const downTask = await waitFor(async () => {
    const { tasks } = await api(`/sftp/sessions/${sftpId}/transfers`)
    return tasks.find((t) => t.id === down.tasks[0].id && t.state === 'done')
  }, 20_000)
  check('下载任务完成', Boolean(downTask))

  const uploadAudit = await api('/audit?event=upload')
  const uploadEntry = uploadAudit.entries.find((e) => e.detail.includes('audit-sample.bin'))
  check(
    '上传审计：句式与来源 IP',
    Boolean(uploadEntry) &&
      uploadEntry.detail.includes('用户从 127.0.0.1 上传了 audit-sample.bin') &&
      uploadEntry.clientIp === '127.0.0.1',
    uploadEntry?.detail,
  )
  const downloadAudit = await api('/audit?event=download')
  check(
    '下载审计：句式与来源 IP',
    downloadAudit.entries.some((e) => e.detail.includes('用户从 127.0.0.1 下载了 audit-sample.bin')),
  )
  await api(`/sftp/sessions/${sftpId}`, { method: 'DELETE' }).catch(() => {})

  /* ---------------- H. 审计查询 ---------------- */
  console.log('\n[H] 审计事件与查询')

  // 等宏审计与 connect/disconnect 都入库
  await waitFor(async () => {
    const { entries } = await api('/audit?pageSize=200')
    const events = new Set(entries.map((e) => e.event))
    return ['connect', 'disconnect', 'macro_run', 'script_run', 'settings_change', 'log_delete', 'upload', 'download'].every((e) => events.has(e))
  }, 8000)

  const allAudit = await api('/audit?pageSize=200')
  const byEvent = Object.groupBy(allAudit.entries, (e) => e.event)
  check('connect 审计存在', (byEvent.connect ?? []).length >= 1)
  check(
    'connect 详情带协议与主机',
    (byEvent.connect ?? []).some((e) => e.detail.includes('127.0.0.1') && e.detail.toUpperCase().includes('SSH')),
    byEvent.connect?.[0]?.detail,
  )
  check('disconnect 审计存在', (byEvent.disconnect ?? []).length >= 1)
  check('macro_run 审计存在', (byEvent.macro_run ?? []).some((e) => e.detail.includes('审计宏')), byEvent.macro_run?.[0]?.detail)
  check(
    'script_run 审计存在（内联试运行记「内联脚本」）',
    (byEvent.script_run ?? []).some((e) => e.detail.includes('内联脚本')),
    byEvent.script_run?.[0]?.detail,
  )
  check(
    'settings_change 审计存在',
    (byEvent.settings_change ?? []).some((e) => e.detail.includes('脱敏规则')),
    byEvent.settings_change?.[0]?.detail,
  )
  check(
    'log_delete 审计存在（删除 HTML 快照）',
    (byEvent.log_delete ?? []).length >= 1,
    byEvent.log_delete?.[0]?.detail,
  )
  check('所有审计条目都带来源 IP', allAudit.entries.every((e) => e.clientIp === '127.0.0.1'))

  const onlyConnect = await api('/audit?event=connect')
  check('事件过滤生效', onlyConnect.entries.length > 0 && onlyConnect.entries.every((e) => e.event === 'connect'))

  const page1a = await api('/audit?page=1&pageSize=2')
  const page2a = await api('/audit?page=2&pageSize=2')
  check(
    '审计分页正确',
    page1a.entries.length === 2 && page2a.entries.length >= 1 && page1a.entries[0].id !== page2a.entries[0].id,
    `total=${page1a.total}`,
  )
  check('分页 total 一致', page1a.total === allAudit.total)

  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10)
  const futureAudit = await api(`/audit?from=${tomorrow}`)
  check('时间范围过滤（未来为空）', futureAudit.entries.length === 0)

  /* ---------------- I. 保留清理 ---------------- */
  console.log('\n[I] 保留清理')

  // 手工伪造一个 3 天前的过期文件
  const retiredDir = path.join(LOGS_ROOT, 'Retired-999')
  fs.mkdirSync(retiredDir, { recursive: true })
  const retiredFile = path.join(retiredDir, `${today()}.log`)
  fs.writeFileSync(retiredFile, 'expired content\n')
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  fs.utimesSync(retiredFile, old, old)
  check('伪造过期文件就绪', fs.existsSync(retiredFile))

  await api('/logs/settings', json('PUT', { retentionDays: 1 }))
  const swept = await waitFor(async () => !fs.existsSync(retiredDir), 8000)
  check('保留天数收紧为 1 天后过期文件立即被清理（目录一并移除）', swept === true)

  const retiredList = await api('/logs/files')
  check('清理后列表中不再出现该会话', !retiredList.files.some((f) => f.sessionDir === 'Retired-999'))

  await api('/logs/settings', json('PUT', { retentionDays: 30 }))

  /* ---------------- J. 安全与边界 ---------------- */
  console.log('\n[J] 安全与边界')

  const traversalPreview = await expectError(
    `/logs/files/${encodeURIComponent('../escape.log')}/preview`,
  )
  check('预览路径穿越被拒', traversalPreview !== null && traversalPreview.status >= 400, `${traversalPreview?.status}`)
  const traversalDownload = await expectError(
    `/logs/files/${encodeURIComponent('../../etc/passwd')}/download`,
  )
  check('下载路径穿越被拒', traversalDownload !== null && traversalDownload.status >= 400, `${traversalDownload?.status}`)
  const missing = await expectError(`/logs/files/${encodeURIComponent('nope/2020-01-01.log')}/preview`)
  check('不存在的文件返回 404', missing?.status === 404, `${missing?.status}`)

  const emptyDate = await api('/logs/files?date=2001-01-01')
  check('日期过滤（无结果日期）为空', emptyDate.files.length === 0)
  const dateFiltered = await api(`/logs/files?date=${today()}`)
  check('日期过滤（今天）有结果', dateFiltered.files.length > 0)
  const sessionFiltered = await api(`/logs/files?sessionId=${nodeRotate.id}`)
  check(
    '会话过滤只返回该会话文件',
    sessionFiltered.files.length > 0 && sessionFiltered.files.every((f) => f.sessionDir.startsWith('RotateLog-')),
  )
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n===== 结果：${pass} 通过，${failures.length} 失败 =====`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
