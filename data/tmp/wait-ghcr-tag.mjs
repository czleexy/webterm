/**
 * 等指定 tag 出现在 GHCR，并报告它的平台列表。
 *
 * 用途：验证「打 v* 标签会构建 amd64 + arm64」这条分支。
 * 只看 GHCR —— 不消耗 GitHub REST 配额，而且镜像里的平台列表就是最终事实。
 */
const REPO = 'czleexy/webterm'
const TAG = process.argv[2] ?? '0.2.0'
const TIMEOUT_MS = Number(process.argv[3] ?? 30 * 60 * 1000)
const UA = { 'User-Agent': 'wait-ghcr-tag' }
const ANY = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const deadline = Date.now() + TIMEOUT_MS
let lastLine = ''
for (;;) {
  try {
    const tok = await (await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${REPO}:pull`, { headers: UA })).json()
    const auth = { ...UA, Authorization: `Bearer ${tok.token}` }
    const tags = (await (await fetch(`https://ghcr.io/v2/${REPO}/tags/list`, { headers: auth })).json()).tags ?? []
    const has = tags.includes(TAG)

    let line = `[${new Date().toISOString().slice(11, 19)}] tags=${tags.join(',')}`
    if (has) {
      const mRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/${TAG}`, { headers: { ...auth, Accept: ANY } })
      if (mRes.ok) {
        const m = await mRes.json()
        const isIndex = Array.isArray(m.manifests)
        const plats = isIndex
          ? m.manifests.filter((x) => x.platform?.os !== 'unknown').map((x) => `${x.platform?.os}/${x.platform?.architecture}`)
          : ['<单架构>']
        line += `  ${TAG} 已发布，平台=[${plats.join(', ')}]`
        if (line !== lastLine) console.log(line)
        console.log(`\ndigest: ${mRes.headers.get('docker-content-digest')}`)
        console.log(`媒体类型: ${m.mediaType}`)
        const unknowns = isIndex ? m.manifests.filter((x) => x.platform?.os === 'unknown').length : 0
        console.log(`unknown/unknown 条目: ${unknowns}`)
        const hasAmd = plats.includes('linux/amd64')
        const hasArm = plats.includes('linux/arm64')
        console.log(`\n${hasAmd ? 'PASS' : 'FAIL'}  含 linux/amd64`)
        console.log(`${hasArm ? 'PASS' : 'FAIL'}  含 linux/arm64`)
        console.log(`${unknowns === 0 ? 'PASS' : 'FAIL'}  没有 provenance 造成的 unknown 平台`)
        process.exit(hasAmd && hasArm && unknowns === 0 ? 0 : 1)
      }
      line += `  ${TAG} 的 manifest 暂时读不到（HTTP ${mRes.status}）`
    }
    if (line !== lastLine) {
      console.log(line)
      lastLine = line
    }
  } catch (e) {
    console.log(`探测出错（继续重试）：${e.message}`)
  }
  if (Date.now() > deadline) {
    console.log(`\n超时：${TAG} 未在时限内出现（arm64 走 QEMU 模拟，可能还在构建）`)
    process.exit(1)
  }
  await sleep(30000)
}
