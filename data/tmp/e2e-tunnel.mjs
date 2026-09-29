/**
 * 阶段 5（端口转发与隧道）端到端验证。
 *
 * 自管两个 mock 与一个服务端实例：
 *   2422  mock SSH（同时充当跳板与「远端」——它接受 tcpip-forward，与真实 sshd 行为一致）
 *   2431  mock Telnet（用于验证「Telnet 不支持隧道」）
 *   2451  回显服务（带问候语，验证转发链路真的到了业务端口）
 *   2452  裸回显服务（纯字节回环，用于大流量与字节计数）
 *   8100  服务端（独立数据目录，不影响开发用的 8080）
 *
 * 验证重点（手写端口转发最容易翻车的地方）：
 *   1. 三类转发是否真的连通业务端口，而不是「监听到了算成功」
 *   2. 字节计数与连接数是否准确（面板上给用户看的就是这两个数字）
 *   3. 背压：大流量经隧道不能丢字节、不能把进程内存吃满
 *   4. 生命周期：默认停掉就真的释放端口（能重新 bind 才算数）
 *   5. 端口占用 / 目标不可达 / Telnet 会话等边界是否给出可操作的错误
 *   6. 会话库配置的隧道是否随会话自动启动，且失败不阻断连接
 *
 * 运行：npm run build && node data/tmp/e2e-tunnel.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_EXE = process.execPath
const WORK = path.join(ROOT, 'data/tmp/tunnel-e2e')
const PORT = 8100
const API = `http://127.0.0.1:${PORT}`

const MOCK_SSH = 2422
const MOCK_TELNET = 2431
const SVC_ECHO = 2451
const SVC_RAW = 2452
const DEAD_PORT = 2459

/** 隧道监听端口（都取高位端口，避开常用服务） */
const L_LOCAL = 13601
const L_BUSY = 13602
const L_AUTO = 13603
const L_AUTO_FAIL = 13604
const SOCKS = 13610

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
/* 进程与端口工具                                                       */
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

function startServer() {
  return spawnChild([`${ROOT}/packages/server/dist/index.js`], {
    NODE_ENV: 'production',
    WEBTERM_PORT: String(PORT),
    WEBTERM_DATA_DIR: path.join(WORK, 'data'),
    WEBTERM_LOCAL_ROOT: path.join(WORK, 'local'),
    WEBTERM_LOG_LEVEL: 'warn',
  })
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

/** 在指定端口起一个业务服务，用于验证「流量真的到了目标端口」 */
const services = []
function startService(port, { greet } = {}) {
  const server = net.createServer((socket) => {
    if (greet) socket.write(`${greet}\n`)
    socket.on('data', (chunk) => {
      if (greet) socket.write(`echo:${chunk.toString().trim()}\n`)
      else socket.write(chunk) // 裸回环，用于精确的字节计数
    })
  })
  server.listen(port, '127.0.0.1')
  services.push(server)
  return server
}

/** 端口当前是否空闲（能 bind 才算真的释放） */
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** 建立一次 TCP 往返：连上后发一条，等回显里出现它 */
function roundTrip(port, payload, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok ? buffer : null)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('connect', () => socket.write(`${payload}\n`))
    socket.on('data', (d) => {
      buffer += d.toString()
      if (buffer.includes(`echo:${payload}`)) {
        clearTimeout(timer)
        finish(true)
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      finish(false)
    })
  })
}

/** 经隧道灌入 N 字节并统计收回的字节数（验证背压与计数） */
function bulkThrough(port, bytes, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunk = Buffer.alloc(16 * 1024, 0x61)
    let sent = 0
    let received = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(received)
    }
    const timer = setTimeout(finish, timeoutMs)
    socket.on('connect', () => {
      while (sent < bytes) {
        const size = Math.min(chunk.length, bytes - sent)
        socket.write(chunk.subarray(0, size))
        sent += size
      }
    })
    socket.on('data', (d) => {
      received += d.length
      if (received >= bytes) {
        clearTimeout(timer)
        finish()
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })
  })
}

/** 端口能否建立连接 */
function connectable(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const done = (ok) => {
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.on('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
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

/** 期望请求失败，返回 ApiError（便于断言状态码与错误码） */
async function expectError(pathname, init) {
  try {
    await api(pathname, init)
    return null
  } catch (err) {
    return err instanceof ApiError ? err : null
  }
}

const sshConfig = {
  protocol: 'ssh',
  target: {
    host: '127.0.0.1',
    port: MOCK_SSH,
    username: 'demo',
    authMethod: 'password',
    password: 'demo',
  },
  terminal: { cols: 100, rows: 30, encoding: 'utf8', term: 'xterm-256color' },
  legacyCompat: 'auto',
}

const telnetConfig = {
  protocol: 'telnet',
  target: { host: '127.0.0.1', port: MOCK_TELNET },
  terminal: { cols: 100, rows: 30, encoding: 'utf8', term: 'xterm-256color' },
}

const listTunnels = async () => (await api('/tunnels')).tunnels
const getTunnel = async (id) => (await listTunnels()).find((t) => t.id === id)

/** 轮询直到条件满足（统计数字的变化不是同步的） */
async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) return undefined
    await sleep(50)
  }
}

/* ------------------------------------------------------------------ */
/* SOCKS5 客户端（手工实现，验证服务端实现是否符合 RFC 1928）            */
/* ------------------------------------------------------------------ */

/**
 * 走一次 SOCKS5 握手 + CONNECT。
 *
 * 注意这里自带一个「按字节消费」的缓冲：方法应答与请求应答都是定长前缀 + 变长地址，
 * 用「累计字符串的第 2 个字节」去读应答码会读到上一条应答的字节 —— 这个坑
 * 在写第一版探针时踩过一次，因此显式保留 offset。
 *
 * @returns {Promise<{method:number, rep:number|null, text:string}>}
 */
function socksProbe(port, target, options = {}) {
  const { atyp = 'ipv4', methods = [0x00], split = false, payload = 'socks-ok', cmd = 0x01 } = options
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    let stage = 'method'
    let method = -1
    let rep = null
    let buffer = Buffer.alloc(0)
    let data = ''
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve({ method, rep, text: data })
    }
    const timer = setTimeout(finish, 5000)

    const buildRequest = () => {
      const addr =
        atyp === 'domain'
          ? (() => {
              const name = Buffer.from(target.host, 'utf8')
              return Buffer.concat([Buffer.from([0x03, name.length]), name])
            })()
          : Buffer.concat([
              Buffer.from([0x01]),
              Buffer.from(target.host.split('.').map((n) => Number(n))),
            ])
      const tail = Buffer.alloc(2)
      tail.writeUInt16BE(target.port, 0)
      return Buffer.concat([Buffer.from([0x05, cmd, 0x00]), addr, tail])
    }

    const pump = () => {
      if (stage === 'method') {
        if (buffer.length < 2) return
        method = buffer[1]
        buffer = buffer.subarray(2)
        if (method !== 0x00) {
          clearTimeout(timer)
          finish()
          return
        }
        stage = 'reply'
        const request = buildRequest()
        if (split) {
          socket.write(request.subarray(0, 3))
          setTimeout(() => socket.write(request.subarray(3)), 30)
        } else {
          socket.write(request)
        }
        return
      }

      if (stage === 'reply') {
        if (buffer.length < 2) return
        rep = buffer[1]
        // 应答长度取决于 ATYP，但后续数据我们不关心，直接整块丢弃
        buffer = Buffer.alloc(0)
        if (rep !== 0x00 || cmd !== 0x01) {
          clearTimeout(timer)
          finish()
          return
        }
        stage = 'data'
        socket.write(`${payload}\n`)
        return
      }

      data += buffer.toString()
      buffer = Buffer.alloc(0)
      if (data.includes(`echo:${payload}`)) {
        clearTimeout(timer)
        finish()
      }
    }

    socket.on('connect', () => {
      const greeting = Buffer.from([0x05, methods.length, ...methods])
      if (split) {
        // 故意拆包：握手状态机必须能累积不完整的报文
        socket.write(greeting.subarray(0, 1))
        setTimeout(() => socket.write(greeting.subarray(1)), 30)
      } else {
        socket.write(greeting)
      }
    })

    socket.on('data', (d) => {
      buffer = Buffer.concat([buffer, d])
      pump()
    })

    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })
    socket.on('close', () => {
      clearTimeout(timer)
      finish()
    })
  })
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORK, 'local'), { recursive: true })

  startService(SVC_ECHO, { greet: 'HELLO-ECHO' })
  startService(SVC_RAW, {})
  spawnChild([`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
    MOCK_PORT: String(MOCK_SSH),
    MOCK_SFTP_ROOT: path.join(WORK, 'mock-sftp'),
  })
  spawnChild([`${ROOT}/packages/server/dev/mock-telnet-server.mjs`], {
    MOCK_PORT: String(MOCK_TELNET),
  })
  startServer()
  await waitHealthy()

  /* ---------------------------------------------------------------- */
  console.log('\n[A] 本地转发（-L）：本机监听 → 经 SSH → 远端网络里的服务')

  const term = await api('/terminals', json('POST', { config: sshConfig, title: '隧道宿主' }))
  check('SSH 会话已建立', typeof term.terminalId === 'string')

  const localSpec = {
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: L_LOCAL,
    targetHost: '127.0.0.1',
    targetPort: SVC_ECHO,
  }
  let localTunnel
  try {
    const created = await api('/tunnels', json('POST', { terminalId: term.terminalId, spec: localSpec }))
    localTunnel = created.tunnel
    check('创建本地转发 → active', localTunnel.status === 'active', localTunnel.status)
    check('实际监听端口等于请求端口', localTunnel.boundPort === L_LOCAL, String(localTunnel.boundPort))
    check('隧道带宿主会话信息', localTunnel.terminalId === term.terminalId && !!localTunnel.terminalTitle)
  } catch (err) {
    check('创建本地转发 → active', false, err.message)
  }

  const localTunnelId = localTunnel?.id
  check('业务服务可直连（对照组）', (await roundTrip(SVC_ECHO, 'direct')) !== null)

  if (localTunnelId) {
    const trip = await roundTrip(L_LOCAL, 'via-local')
    check('经本地转发端口访问到目标服务', trip !== null, trip ? '' : '未能回环')
    check('目标服务的问候语原样透传', (trip ?? '').includes('HELLO-ECHO'))

    const stats = await waitFor(async () => {
      const t = await getTunnel(localTunnelId)
      return t && t.bytesUp > 0 && t.bytesDown > 0 ? t : undefined
    })
    check('上下行字节计数均已累加', Boolean(stats), stats ? `up=${stats.bytesUp} down=${stats.bytesDown}` : '')
    check('累计连接数已增加', (stats?.totalConnections ?? 0) >= 1, String(stats?.totalConnections))
    check('连接结束后活跃数回落到 0', (stats?.activeConnections ?? -1) === 0, String(stats?.activeConnections))

    // 并发三条连接，验证计数与多路复用
    await Promise.all([roundTrip(L_LOCAL, 'c1'), roundTrip(L_LOCAL, 'c2'), roundTrip(L_LOCAL, 'c3')])
    const after = await waitFor(async () => {
      const t = await getTunnel(localTunnelId)
      return t && t.totalConnections >= 4 ? t : undefined
    })
    check('并发连接被逐一计数', Boolean(after), `total=${after?.totalConnections}`)

    // 大流量：验证背压路径不丢字节
    const bulkBytes = 512 * 1024
    const bulkSpec = {
      type: 'local',
      bindHost: '127.0.0.1',
      bindPort: L_LOCAL + 50,
      targetHost: '127.0.0.1',
      targetPort: SVC_RAW,
    }
    const bulk = await api('/tunnels', json('POST', { terminalId: term.terminalId, spec: bulkSpec }))
    const received = await bulkThrough(L_LOCAL + 50, bulkBytes)
    check('512KB 经隧道往返无字节丢失', received === bulkBytes, `${received}/${bulkBytes}`)
    const bulkStats = await getTunnel(bulk.tunnel.id)
    check(
      '大流量后字节计数与发送量一致',
      (bulkStats?.bytesUp ?? 0) >= bulkBytes && (bulkStats?.bytesDown ?? 0) >= bulkBytes,
      `up=${bulkStats?.bytesUp} down=${bulkStats?.bytesDown}`,
    )
    await api(`/tunnels/${bulk.tunnel.id}`, { method: 'DELETE' })

    // 目标不可达：隧道本身仍是 active，但连过去的连接会被立刻断开
    const deadSpec = {
      type: 'local',
      bindHost: '127.0.0.1',
      bindPort: L_LOCAL + 51,
      targetHost: '127.0.0.1',
      targetPort: DEAD_PORT,
    }
    const dead = await api('/tunnels', json('POST', { terminalId: term.terminalId, spec: deadSpec }))
    const deadTrip = await roundTrip(L_LOCAL + 51, 'nobody')
    check('目标端口不可达时不返回数据（连接被断开）', deadTrip === null)
    check('目标不可达不会让隧道本身进入错误态', (await getTunnel(dead.tunnel.id))?.status === 'active')
    await api(`/tunnels/${dead.tunnel.id}`, { method: 'DELETE' })
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[B] 远程转发（-R）：远端监听 → 经 SSH → 回本机的服务')

  const busy = net.createServer()
  await new Promise((resolve) => busy.listen(L_BUSY, '127.0.0.1', resolve))
  const conflict = await expectError(
    '/tunnels',
    json('POST', {
      terminalId: term.terminalId,
      spec: { ...localSpec, bindPort: L_BUSY },
    }),
  )
  check('监听端口被占用 → 409', conflict?.status === 409, String(conflict?.status))
  check('错误码为 PORT_IN_USE', conflict?.code === 'PORT_IN_USE', String(conflict?.code))
  check('错误信息给出换端口的建议', /端口|占用/.test(conflict?.message ?? ''))
  busy.close()

  const remoteSpec = {
    type: 'remote',
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: SVC_ECHO,
  }
  const remote = await api('/tunnels', json('POST', { terminalId: term.terminalId, spec: remoteSpec }))
  const remotePort = remote.tunnel.boundPort
  check('远程转发由远端分配端口', typeof remotePort === 'number' && remotePort > 0, String(remotePort))
  check('远程转发状态为 active', remote.tunnel.status === 'active')

  if (remotePort > 0) {
    const trip = await roundTrip(remotePort, 'via-remote')
    check('从远端监听端口能访问到本机服务', trip !== null, trip ? '' : '未能回环')
    const stats = await waitFor(async () => {
      const t = await getTunnel(remote.tunnel.id)
      return t && t.bytesUp > 0 ? t : undefined
    })
    check('远程转发两侧字节计数已累加', Boolean(stats), stats ? `up=${stats.bytesUp}` : '')

    await api(`/tunnels/${remote.tunnel.id}/stop`, json('POST', {}))
    await sleep(300)
    check('停止远程转发后远端端口立即关闭', (await connectable(remotePort)) === false)
    check('停止后状态为 stopped', (await getTunnel(remote.tunnel.id))?.status === 'stopped')
    await api(`/tunnels/${remote.tunnel.id}/start`, json('POST', {}))
    const restart = await waitFor(async () => {
      const t = await getTunnel(remote.tunnel.id)
      return t?.status === 'active' ? t : undefined
    })
    check('可以重新启动已停止的隧道', Boolean(restart), String(restart?.boundPort))
    check('重启后再次连通', (await roundTrip(restart?.boundPort ?? 0, 'remote-again')) !== null)
    await api(`/tunnels/${remote.tunnel.id}`, { method: 'DELETE' })
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[C] 动态转发（-D）：本机 SOCKS5 代理')

  const dyn = await api(
    '/tunnels',
    json('POST', {
      terminalId: term.terminalId,
      spec: { type: 'dynamic', bindHost: '127.0.0.1', bindPort: SOCKS },
    }),
  )
  check('创建动态转发 → active', dyn.tunnel.status === 'active')

  const ipv4 = await socksProbe(SOCKS, { host: '127.0.0.1', port: SVC_ECHO })
  check('SOCKS5 无认证协商成功（05 00）', ipv4.method === 0x00, String(ipv4.method))
  check('SOCKS5 CONNECT 成功（REP=00）', ipv4.rep === 0x00, String(ipv4.rep))
  check('经 SOCKS5 代理访问到目标服务', ipv4.text.includes('echo:socks-ok'))

  const domain = await socksProbe(SOCKS, { host: 'localhost', port: SVC_ECHO }, { atyp: 'domain', payload: 'domain-ok' })
  check('域名（ATYP=03）目标可解析并连通', domain.rep === 0x00 && domain.text.includes('echo:domain-ok'))

  const bind = await socksProbe(SOCKS, { host: '127.0.0.1', port: SVC_ECHO }, { cmd: 0x02 })
  check('BIND 命令返回「不支持」（REP=07）', bind.rep === 0x07, String(bind.rep))

  const udp = await socksProbe(SOCKS, { host: '127.0.0.1', port: SVC_ECHO }, { cmd: 0x03 })
  check('UDP ASSOCIATE 返回「不支持」（REP=07）', udp.rep === 0x07, String(udp.rep))

  const noAuth = await socksProbe(SOCKS, { host: '127.0.0.1', port: SVC_ECHO }, { methods: [0x02] })
  check('客户端只提供不支持的方式时回 05 FF', noAuth.method === 0xff, String(noAuth.method))

  const split = await socksProbe(
    SOCKS,
    { host: '127.0.0.1', port: SVC_ECHO },
    { split: true, payload: 'split-ok' },
  )
  check('握手报文被拆包时仍能正确解析', split.rep === 0x00 && split.text.includes('echo:split-ok'))

  const deadProxy = await socksProbe(SOCKS, { host: '127.0.0.1', port: DEAD_PORT }, { payload: 'nope' })
  check('SOCKS5 目标不可达时返回非 0 应答', deadProxy.rep !== 0x00 && deadProxy.rep !== null, String(deadProxy.rep))

  const dynStats = await getTunnel(dyn.tunnel.id)
  // 只有成功的 CONNECT 才会建立桥接，因此统计口径是「3 次成功」，
  // 被拒的 BIND / UDP / 无可用认证方式都不该计入
  check('动态转发只统计成功建立的连接', (dynStats?.totalConnections ?? 0) === 3, `total=${dynStats?.totalConnections}`)
  await api(`/tunnels/${dyn.tunnel.id}`, { method: 'DELETE' })

  /* ---------------------------------------------------------------- */
  console.log('\n[D] 生命周期：停止即释放端口，关闭会话即清空隧道')

  if (localTunnelId) {
    await api(`/tunnels/${localTunnelId}/stop`, json('POST', {}))
    await sleep(250)
    check('停止本地转发后端口可被重新 bind', await canBind(L_LOCAL))
    check('停止后端口不再接受连接', (await connectable(L_LOCAL)) === false)

    await api(`/tunnels/${localTunnelId}/start`, json('POST', {}))
    await sleep(150)
    check('重新启动后端口被重新占用', (await canBind(L_LOCAL)) === false)
    check('重新启动后链路恢复', (await roundTrip(L_LOCAL, 'restart')) !== null)

    await api(`/tunnels/${localTunnelId}`, { method: 'DELETE' })
    check('删除后隧道不在列表中', (await getTunnel(localTunnelId)) === undefined)
    await sleep(200)
    check('删除后端口已释放', await canBind(L_LOCAL))
  }

  const autoSpec = {
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: L_AUTO,
    targetHost: '127.0.0.1',
    targetPort: SVC_ECHO,
  }
  const auto = await api('/tunnels', json('POST', { terminalId: term.terminalId, spec: autoSpec }))
  check('会话关闭前端口被占用', (await canBind(L_AUTO)) === false)
  await api(`/terminals/${term.terminalId}`, { method: 'DELETE' })
  await sleep(300)
  check('关闭会话后隧道被一并清理', (await getTunnel(auto.tunnel.id)) === undefined)
  check('关闭会话后本地端口已释放', await canBind(L_AUTO))
  check('会话关闭后隧道列表为空', (await listTunnels()).length === 0)

  /* ---------------------------------------------------------------- */
  console.log('\n[E] 校验与协议边界')

  const fresh = await api('/terminals', json('POST', { config: sshConfig, title: '校验用会话' }))

  const badPortZero = await expectError(
    '/tunnels',
    json('POST', {
      terminalId: fresh.terminalId,
      spec: { type: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: SVC_ECHO },
    }),
  )
  check('本地转发端口填 0 被拒（仅远程转发允许）', badPortZero?.status === 400, String(badPortZero?.status))

  const badPortRange = await expectError(
    '/tunnels',
    json('POST', {
      terminalId: fresh.terminalId,
      spec: { type: 'local', bindHost: '127.0.0.1', bindPort: 70000, targetHost: '127.0.0.1', targetPort: SVC_ECHO },
    }),
  )
  check('端口超出 65535 被拒', badPortRange?.status === 400, String(badPortRange?.status))

  const unknownTerm = await expectError(
    '/tunnels',
    json('POST', {
      terminalId: 'no-such-terminal',
      spec: { type: 'dynamic', bindHost: '127.0.0.1', bindPort: SOCKS + 1 },
    }),
  )
  check('宿主终端不存在 → 404', unknownTerm?.status === 404, String(unknownTerm?.status))

  const telnetTerm = await api('/terminals', json('POST', { config: telnetConfig, title: 'Telnet 会话' }))
  const telnetTunnel = await expectError(
    '/tunnels',
    json('POST', {
      terminalId: telnetTerm.terminalId,
      spec: { type: 'local', bindHost: '127.0.0.1', bindPort: L_AUTO + 20, targetHost: '127.0.0.1', targetPort: SVC_ECHO },
    }),
  )
  check('Telnet 会话创建隧道被拒 → 400', telnetTunnel?.status === 400, String(telnetTunnel?.status))
  check('拒绝原因说明协议层缺失', /Telnet|协议层/.test(telnetTunnel?.message ?? ''))
  await api(`/terminals/${telnetTerm.terminalId}`, { method: 'DELETE' })

  const caps = await api('/capabilities')
  check(
    '能力接口声明三种转发类型与上限',
    caps.supportedTunnelTypes?.length === 3 && caps.maxTunnelsPerSession > 0,
    JSON.stringify(caps.supportedTunnelTypes),
  )

  await api(`/terminals/${fresh.terminalId}`, { method: 'DELETE' })

  /* ---------------------------------------------------------------- */
  console.log('\n[F] 会话库：隧道随会话自动启动')

  await api('/vault/setup', json('POST', { masterPassword: 'webterm-e2e-master' }))
  const cred = await api('/credentials', json('POST', { name: 'e2e-凭据', type: 'password', password: 'demo' }))

  const sessionPayload = {
    protocol: 'ssh',
    host: '127.0.0.1',
    port: MOCK_SSH,
    username: 'demo',
    credentialId: cred.id,
    encoding: 'utf8',
    term: 'xterm-256color',
    legacyCompat: 'auto',
    jumpChain: [],
    tunnels: [autoSpec],
  }
  const node = await api(
    '/library',
    json('POST', { kind: 'session', name: '带隧道的会话', session: sessionPayload }),
  )
  check('会话库接受隧道定义', node.session?.tunnels?.length === 1)

  const tree = await api('/library')
  const saved = tree.nodes.find((n) => n.id === node.id)
  check('隧道定义已持久化', saved?.session?.tunnels?.[0]?.bindPort === L_AUTO)

  const autoTerm = await api('/terminals', json('POST', { sessionId: node.id, title: '自动隧道' }))
  check('带隧道的会话可以正常连接', typeof autoTerm.terminalId === 'string')
  check('自动启动无告警', !autoTerm.tunnelWarnings, JSON.stringify(autoTerm.tunnelWarnings))

  const autoTunnels = (await listTunnels()).filter((t) => t.terminalId === autoTerm.terminalId)
  check('隧道已随会话自动启动', autoTunnels.length === 1, `count=${autoTunnels.length}`)
  check('自动启动的隧道被标记', autoTunnels[0]?.autoStarted === true)
  check('自动启动的隧道真的可用', (await roundTrip(L_AUTO, 'auto')) !== null)

  await api(`/terminals/${autoTerm.terminalId}`, { method: 'DELETE' })
  await sleep(250)
  check('关闭会话后自动启动的隧道也被清理', await canBind(L_AUTO))

  // 端口被占用时的自动启动：会话要能连上，只是隧道失败并给出告警
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(L_AUTO_FAIL, '127.0.0.1', resolve))
  const failNode = await api(
    '/library',
    json('POST', {
      kind: 'session',
      name: '隧道端口被占',
      session: {
        ...sessionPayload,
        tunnels: [{ ...autoSpec, bindPort: L_AUTO_FAIL }],
      },
    }),
  )
  const failTerm = await api('/terminals', json('POST', { sessionId: failNode.id }))
  check('隧道端口被占用时会话仍能建立', typeof failTerm.terminalId === 'string')
  check(
    '回传隧道启动失败告警',
    Array.isArray(failTerm.tunnelWarnings) && failTerm.tunnelWarnings.length === 1,
    JSON.stringify(failTerm.tunnelWarnings),
  )
  check(
    '告警内容说明端口占用',
    /端口|占用/.test(failTerm.tunnelWarnings?.[0] ?? ''),
    String(failTerm.tunnelWarnings?.[0]).slice(0, 60),
  )
  await api(`/terminals/${failTerm.terminalId}`, { method: 'DELETE' })
  blocker.close()

  // Telnet 会话不允许携带隧道（与跳板链同样在写入时挡住）
  const telnetLib = await expectError(
    '/library',
    json('POST', {
      kind: 'session',
      name: 'Telnet 带隧道',
      session: {
        protocol: 'telnet',
        host: '127.0.0.1',
        port: MOCK_TELNET,
        encoding: 'utf8',
        term: 'xterm-256color',
        jumpChain: [],
        tunnels: [autoSpec],
      },
    }),
  )
  check('Telnet 会话库记录带隧道被拒', telnetLib?.status === 400, String(telnetLib?.status))

  /* ---------------------------------------------------------------- */
  report()
}

/** 无论中途是否抛错，都要打出汇总 —— 否则失败项会随异常一起被吞掉 */
let fatal = false
function report() {
  console.log(`\n==> 隧道 E2E：${pass} 通过 / ${failures.length} 失败`)
  if (failures.length > 0) {
    console.log(`    失败项：${failures.join('、')}`)
  }
}

main()
  .catch((err) => {
    console.error('\nE2E 运行失败：', err)
    fatal = true
    report()
  })
  .finally(async () => {
    await sleep(200)
    cleanup()
    // 本进程自己起的业务监听必须显式关掉，否则事件循环永远不空、脚本不退出
    for (const server of services) {
      try {
        server.close()
      } catch {
        /* 忽略 */
      }
    }
    await sleep(200)
    try {
      fs.rmSync(WORK, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    process.exit(failures.length > 0 || fatal ? 1 : 0)
  })
