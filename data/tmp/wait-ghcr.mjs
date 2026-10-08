/**
 * 等 `latest` 指向一个新的镜像（不看 API，只看 GHCR 的 digest 变化）。
 *
 * 用途：新推送触发构建后，想知道「新镜像到底发布了没有」。
 * 比读 Actions 页面可靠 —— 镜像里的 revision 标签直接说明它是哪份代码构建的。
 */
const REPO = 'czleexy/webterm'
const UA = { 'User-Agent': 'wait-ghcr' }
const OLD = process.argv[2] ?? null
const WANT_REV = process.argv[3] ?? null
const TIMEOUT_MS = 12 * 60 * 1000

const ANY = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function look() {
  const tok = await (await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${REPO}:pull`, { headers: UA })).json()
  const auth = { ...UA, Authorization: `Bearer ${tok.token}` }
  const mRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/latest`, { headers: { ...auth, Accept: ANY } })
  if (!mRes.ok) return { status: mRes.status }
  const digest = mRes.headers.get('docker-content-digest')
  const m = await mRes.json()
  const child = Array.isArray(m.manifests) ? m.manifests[0] : { digest }
  const cm = await (await fetch(`https://ghcr.io/v2/${REPO}/manifests/${child.digest}`, { headers: { ...auth, Accept: ANY } })).json()
  const cfg = await (await fetch(`https://ghcr.io/v2/${REPO}/blobs/${cm.config.digest}`, { headers: auth })).json()
  return {
    status: 200,
    digest,
    rev: cfg.config?.Labels?.['org.opencontainers.image.revision'] ?? '',
    labels: cfg.config?.Labels ?? {},
    created: cfg.config?.Labels?.['org.opencontainers.image.created'] ?? '',
    arch: `${cfg.os}/${cfg.architecture}`,
  }
}

const deadline = Date.now() + TIMEOUT_MS
let last = null
for (;;) {
  try {
    const r = await look()
    if (r.status === 200) {
      const key = `${r.digest}|${r.rev}`
      if (key !== last) {
        last = key
        console.log(`[${new Date().toISOString().slice(11, 19)}] digest=${r.digest.slice(7, 19)}… rev=${r.rev.slice(0, 7)} arch=${r.arch} created=${r.created}`)
      }
      const fresh = (!OLD || r.digest !== OLD) && (!WANT_REV || r.rev.startsWith(WANT_REV))
      if (fresh) {
        console.log('\n新镜像已发布。labels：')
        for (const [k, v] of Object.entries(r.labels)) console.log(`  ${k} = ${v}`)
        process.exit(0)
      }
    } else {
      console.log(`manifest 读取失败：HTTP ${r.status}`)
    }
  } catch (e) {
    console.log(`探测出错（继续重试）：${e.message}`)
  }
  if (Date.now() > deadline) {
    console.log('\n超时：12 分钟内 latest 没有变成期望的构建。')
    process.exit(1)
  }
  await sleep(20000)
}
