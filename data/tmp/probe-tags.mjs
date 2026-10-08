/** 只用 GHCR：列出所有标签、每个标签的平台集合与 revision 标签。 */
const REPO = 'czleexy/webterm'
const UA = { 'User-Agent': 'probe-tags' }
const ANY = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const tok = await (await fetch(`https://ghcr.io/token?service=ghcr.io&scope:repository:${REPO}:pull&scope=repository:${REPO}:pull`, { headers: UA })).json()
const auth = { ...UA, Authorization: `Bearer ${tok.token}` }
const tags = (await (await fetch(`https://ghcr.io/v2/${REPO}/tags/list`, { headers: auth })).json()).tags ?? []
console.log(`标签（${tags.length}）：${tags.join(', ')}\n`)

for (const tag of tags.sort()) {
  const mRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/${tag}`, { headers: { ...auth, Accept: ANY } })
  if (!mRes.ok) {
    console.log(`${tag.padEnd(12)} HTTP ${mRes.status}`)
    continue
  }
  const digest = mRes.headers.get('docker-content-digest') ?? ''
  const m = await mRes.json()
  const isIndex = Array.isArray(m.manifests)
  const plats = isIndex
    ? m.manifests.map((x) => `${x.platform?.os}/${x.platform?.architecture}`).sort().join('+')
    : '<单架构>'
  const child = isIndex ? m.manifests.find((x) => x.platform?.architecture === 'amd64') ?? m.manifests[0] : { digest }
  const cm = await (await fetch(`https://ghcr.io/v2/${REPO}/manifests/${child.digest}`, { headers: { ...auth, Accept: ANY } })).json()
  const cfg = await (await fetch(`https://ghcr.io/v2/${REPO}/blobs/${cm.config.digest}`, { headers: auth })).json()
  const L = cfg.config?.Labels ?? {}
  const size = ((cm.layers ?? []).reduce((a, l) => a + (l.size ?? 0), 0) / 1024 / 1024).toFixed(1)
  console.log(`${tag.padEnd(20)} ${isIndex ? 'index' : 'image'}  ${plats}`)
  console.log(`${''.padEnd(20)} rev=${(L['org.opencontainers.image.revision'] ?? '').slice(0, 7)} ver=${L['org.opencontainers.image.version']} lic=${L['org.opencontainers.image.licenses']} amd64层=${size}MB digest=${digest.slice(7, 19)}…`)
}
