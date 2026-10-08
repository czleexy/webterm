/**
 * 在 GitHub REST API 被匿名限流时，用两个不受影响的通道盯构建：
 *   1. Actions 徽标 SVG（github.com，非 api.github.com）→ 给出该分支上工作流的结论
 *   2. GHCR 自身 → 直接读出镜像的标签与 OCI labels
 *
 * 后者其实是更有说服力的证据：不管 CI 页面怎么写，镜像里的元数据是最终产物。
 */
const REPO = 'czleexy/webterm'
const WF = 'docker-image.yml'
const TAG = process.argv[2] ?? 'latest'
const UA = { 'User-Agent': 'probe-status' }

// ---- 1. 限流余额（这个端点不计入配额）----
const rl = await (await fetch('https://api.github.com/rate_limit', { headers: UA })).json()
const core = rl.resources?.core
if (core) {
  const resetIn = Math.max(0, Math.round((core.reset * 1000 - Date.now()) / 1000))
  console.log(`REST 配额：${core.remaining}/${core.limit}，${resetIn}s 后重置`)
}

// ---- 2. 徽标 ----
const badgeUrl = `https://github.com/${REPO}/actions/workflows/${WF}/badge.svg?branch=main`
const bRes = await fetch(badgeUrl, { headers: { ...UA, Accept: 'image/svg+xml' } })
const svg = await bRes.text()
const title = /<title>([^<]*)<\/title>/.exec(svg)?.[1] ?? ''
console.log(`徽标：HTTP ${bRes.status}  title="${title}"`)
const conclusion = /passing/i.test(title) ? 'success'
  : /failing/i.test(title) ? 'failure'
  : /running|pending|queued/i.test(title) ? 'in_progress'
  : 'unknown'
console.log(`判定：${conclusion}`)

// ---- 3. GHCR 里的实际镜像 ----
const tok = await (await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${REPO}:pull`, { headers: UA })).json()
const auth = { ...UA, Authorization: `Bearer ${tok.token}` }
const ANY = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const tags = await (await fetch(`https://ghcr.io/v2/${REPO}/tags/list`, { headers: auth })).json()
console.log(`\nGHCR 标签（${(tags.tags ?? []).length}）：${(tags.tags ?? []).join(', ')}`)

const mRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/${TAG}`, { headers: { ...auth, Accept: ANY } })
if (!mRes.ok) {
  console.log(`manifest(${TAG})：HTTP ${mRes.status}`)
  process.exit(0)
}
const digest = mRes.headers.get('docker-content-digest')
const m = await mRes.json()
const isIndex = Array.isArray(m.manifests)
const platforms = isIndex ? m.manifests.map((x) => `${x.platform?.os}/${x.platform?.architecture}`) : ['<单架构>']
console.log(`\n${TAG}:`)
console.log(`  digest: ${digest}`)
console.log(`  平台: ${platforms.join(', ')}`)

const child = isIndex ? m.manifests[0] : { digest }
const cm = await (await fetch(`https://ghcr.io/v2/${REPO}/manifests/${child.digest}`, {
  headers: { ...auth, Accept: ANY },
})).json()
const cfg = await (await fetch(`https://ghcr.io/v2/${REPO}/blobs/${cm.config.digest}`, { headers: auth })).json()
console.log(`  架构: ${cfg.os}/${cfg.architecture}`)
console.log(`  labels:`)
for (const [k, v] of Object.entries(cfg.config?.Labels ?? {})) console.log(`    ${k} = ${v}`)
