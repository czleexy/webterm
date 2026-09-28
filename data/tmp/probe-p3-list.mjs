/**
 * 探针：检查 mock SFTP 后端在嵌套目录上的 REALPATH / READDIR 行为。
 * 目的是判断浏览器 E2E 里「进入子目录后列表为空、上一级跳到 /home」是
 * mock 的路径映射问题，还是服务端/前端的问题。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ssh2 = require('ssh2')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = path.join(ROOT, 'data/tmp/probe-p3')
const PORT = 2252
const SRV_ROOT = path.join(WORK, 'srv')

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(SRV_ROOT, 'docs'), { recursive: true })
fs.writeFileSync(path.join(SRV_ROOT, 'docs', 'note.md'), '# note\n')
fs.writeFileSync(path.join(SRV_ROOT, 'readme.txt'), 'hi\n')

const mock = spawn(process.execPath, [`${ROOT}/packages/server/dev/mock-ssh-server.mjs`], {
  env: { ...process.env, MOCK_PORT: String(PORT), MOCK_SFTP_ROOT: SRV_ROOT },
  stdio: ['pipe', 'pipe', 'pipe'],
})
mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`))
mock.stderr.on('data', (d) => process.stdout.write(`[mock!] ${d}`))
await new Promise((r) => setTimeout(r, 1200))

const conn = new ssh2.Client()
const call = (fn) => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v))))

conn.on('ready', () =>
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.log('sftp error', err.message)
      process.exit(1)
    }
    const show = async (label, fn) => {
      try {
        console.log(label, JSON.stringify(await call(fn)))
      } catch (e) {
        console.log(label, 'ERROR', e.message)
      }
    }
    await show('realpath(".")      ->', (cb) => sftp.realpath('.', cb))
    await show('realpath("/home/demo")    ->', (cb) => sftp.realpath('/home/demo', cb))
    await show('realpath("/home/demo/docs") ->', (cb) => sftp.realpath('/home/demo/docs', cb))
    await show('realpath("/home/docs")    ->', (cb) => sftp.realpath('/home/docs', cb))
    await show('realpath("/home")         ->', (cb) => sftp.realpath('/home', cb))

    const list = (p) =>
      call((cb) =>
        sftp.readdir(p, (e, items) => {
          if (e) return cb(e)
          cb(null, items.map((i) => `${i.filename}(dir=${i.attrs?.isDirectory()})`))
        }),
      )
    await show('readdir("/home/demo")     ->', (cb) => list('/home/demo').then((v) => cb(null, v), cb))
    await show('readdir("/home/demo/docs")->', (cb) => list('/home/demo/docs').then((v) => cb(null, v), cb))
    await show('readdir("/home")          ->', (cb) => list('/home').then((v) => cb(null, v), cb))

    conn.end()
    mock.kill()
    process.exit(0)
  }),
)
conn.on('error', (e) => {
  console.log('conn error', e.message)
  mock.kill()
  process.exit(1)
})
conn.connect({
  host: '127.0.0.1',
  port: PORT,
  username: 'demo',
  password: 'demo',
  algorithms: undefined,
  readyTimeout: 8000,
})
