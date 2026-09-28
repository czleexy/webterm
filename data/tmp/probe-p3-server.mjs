/**
 * 服务端级探针：直接打 REST，确认嵌套目录列举返回的 path / parent / entries。
 * 用于把「进入子目录列表为空、上一级跳到 /home」定位到服务端还是前端。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = path.join(ROOT, 'data/tmp/probe-p3b')
const MOCK_PORT = 2253
const PORT = 8099
const API = `http://127.0.0.1:${PORT}/api`
const SRV_ROOT = path.join(WORK, 'mock')
const LOCAL_ROOT = path.join(WORK, 'local')

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(SRV_ROOT, 'docs', 'deep'), { recursive: true })
fs.mkdirSync(LOCAL_ROOT, { recursive: true })
fs.writeFileSync(path.join(SRV_ROOT, 'docs', 'note.md'), '# note\n')
fs.writeFileSync(path.join(SRV_ROOT, 'docs', 'deep', 'x.txt'), 'x\n')
fs.writeFileSync(path.join(SRV_ROOT, 'readme.txt'), 'hi\n')

const children = []
const mock = spawn(process.execPath, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SFTP_ROOT: SRV_ROOT },
  stdio: ['pipe', 'pipe', 'pipe'],
})
mock.stderr.on('data', (d) => process.stdout.write(`[mock!] ${d}`))
children.push(mock)

const server = spawn(process.execPath, [`${ROOT}/packages/server/dist/index.js`], {
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
server.stderr.on('data', (d) => process.stdout.write(`[srv!] ${d}`))
children.push(server)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${API}/health`)).ok) break
  } catch {
    /* 未就绪 */
  }
  await sleep(200)
}

const post = (p, body) =>
  fetch(`${API}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

const get = (p) => fetch(`${API}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

const bench = async (label, fn) => {
  const r = await fn()
  console.log(`\n${label}  [${r.status}]`)
  console.log(JSON.stringify(r.body, null, 2))
}

try {
  const sess = await post('/sftp/sessions', {
    config: { target: { host: '127.0.0.1', port: MOCK_PORT, username: 'demo', password: 'demo', authMethod: 'password' } },
  })
  const sftpId = sess.body?.sftpId
  console.log('sftpId =', sftpId, 'remoteHome =', sess.body?.remoteHome, 'localHome =', sess.body?.localHome)

  await bench('list remote（无 path）', () => get(`/sftp/sessions/${sftpId}/list?side=remote`))
  await bench('list remote path=/home/demo/docs', () =>
    get(`/sftp/sessions/${sftpId}/list?side=remote&path=${encodeURIComponent('/home/demo/docs')}`),
  )
  await bench('list remote path=/home/demo/docs/deep', () =>
    get(`/sftp/sessions/${sftpId}/list?side=remote&path=${encodeURIComponent('/home/demo/docs/deep')}`),
  )
  await bench('list local（无 path）', () => get(`/sftp/sessions/${sftpId}/list?side=local`))

  await post(`/sftp/sessions/${sftpId}`, undefined).catch(() => {})
} finally {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* 忽略 */
    }
  }
  process.exit(0)
}
