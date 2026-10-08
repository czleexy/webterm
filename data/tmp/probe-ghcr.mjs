/**
 * 以**匿名**身份探测 GHCR 上的镜像是否可拉取 —— 也就是站在「别人拿到 README
 * 想 docker pull」的位置上检查一遍，而不是站在自己的 token 后面自说自话。
 *
 * GHCR 的匿名流程：先换一个匿名 pull token，再拿它去取 tags / manifest。
 * 包是私有的话，换 token 那一步成功但取 manifest 会 401 —— 这个差别正好用来判可见性。
 */
const REPO = 'czleexy/webterm'
const IMAGE = `ghcr.io/${REPO}`
const UA = { 'User-Agent': 'probe-ghcr' }

const step = (n, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? `  ${extra}` : ''}`)

// 1. 匿名 token
const tokRes = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${REPO}:pull`, { headers: UA })
const tok = await tokRes.json().catch(() => ({}))
console.log(`匿名 token：HTTP ${tokRes.status}  ${tok.token ? '已获取' : '未获取'}\n`)
const auth = tok.token ? { ...UA, Authorization: `Bearer ${tok.token}` } : UA

// 2. 标签列表
const tagsRes = await fetch(`https://ghcr.io/v2/${REPO}/tags/list`, { headers: auth })
console.log(`tags/list：HTTP ${tagsRes.status}`)
let tags = []
if (tagsRes.ok) {
  const j = await tagsRes.json()
  tags = j.tags ?? []
  console.log(`标签（${tags.length}）：${tags.join(', ')}\n`)
} else {
  console.log(`${(await tagsRes.text()).slice(0, 200)}\n`)
}

step('镜像可被匿名拉取（包已设为 public）', tagsRes.status === 200)
step('存在 latest 标签', tags.includes('latest'))
step('存在 main 标签', tags.includes('main'))
step('存在 sha- 标签（可精确回滚）', tags.some((t) => t.startsWith('sha-')))

// 3. manifest + 平台列表
// 单架构镜像返回的是 image.manifest，多架构才是 image.index —— Accept 里两种都得写上，
// 只写 index 的话 GHCR 会回 404（不是「不存在」，而是「没有你能接受的表示」）。
const ANY_MANIFEST = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')
const mRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/latest`, {
  headers: { ...auth, Accept: ANY_MANIFEST },
})
console.log(`\nmanifest(latest)：HTTP ${mRes.status}`)
if (mRes.ok) {
  const digest = mRes.headers.get('docker-content-digest')
  const m = await mRes.json()
  const isIndex = Array.isArray(m.manifests)
  const platforms = isIndex
    ? m.manifests.map((x) => (x.platform ? `${x.platform.os}/${x.platform.architecture}` : '?'))
    : ['<单架构 image manifest，平台在 config 里>']
  console.log(`digest: ${digest}`)
  console.log(`类型: ${isIndex ? 'image index（多架构）' : 'image manifest（单架构）'}  mediaType=${m.mediaType}`)
  console.log(`平台: ${platforms.join(', ')}`)
  step('manifest 里没有 unknown/unknown（provenance 已关）', !platforms.includes('unknown/unknown'))

  // 单架构时 manifest 本身就是目标，digest 要从响应头取（body 里没有）
  const child = isIndex
    ? (m.manifests.find((x) => x.platform?.architecture === 'amd64') ?? m.manifests[0])
    : { digest, mediaType: m.mediaType }
  const cRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/${child.digest}`, {
    headers: { ...auth, Accept: ANY_MANIFEST },
  })
  if (!cRes.ok) {
    console.log(`读取 amd64 manifest 失败：HTTP ${cRes.status}`)
  } else {
    const cm = await cRes.json()
    const cfgRes = await fetch(`https://ghcr.io/v2/${REPO}/blobs/${cm.config.digest}`, { headers: auth })
    if (!cfgRes.ok) {
      console.log(`读取 config blob 失败：HTTP ${cfgRes.status}`)
    } else {
      const cfg = await cfgRes.json()
      console.log(`\n架构：${cfg.os}/${cfg.architecture}`)
      step('是 linux/amd64', cfg.os === 'linux' && cfg.architecture === 'amd64')
      const L = cfg.config?.Labels ?? {}
      console.log('\nlabels:')
      for (const [k, v] of Object.entries(L)) console.log(`  ${k} = ${v}`)
      step('有 org.opencontainers.image.source（包已关联到仓库）', 'org.opencontainers.image.source' in L)
      console.log('\n运行配置：')
      console.log('  Entrypoint:', JSON.stringify(cfg.config?.Entrypoint ?? null))
      console.log('  Cmd       :', JSON.stringify(cfg.config?.Cmd ?? null))
      console.log('  User      :', cfg.config?.User ?? '<root>')
      console.log('  Env       :', (cfg.config?.Env ?? []).filter((e) => e.startsWith('WEBTERM') || e.startsWith('NODE_ENV')).join(' '))
      console.log('  ExposedPorts:', Object.keys(cfg.config?.ExposedPorts ?? {}).join(', '))
      console.log('  Healthcheck:', cfg.config?.Healthcheck?.Test?.join(' ') ?? '<无>')
      step('镜像内已设 WEBTERM_ALLOW_INSECURE_LAN=1', (cfg.config?.Env ?? []).includes('WEBTERM_ALLOW_INSECURE_LAN=1'))
      step('以非 root 用户运行', (cfg.config?.User ?? '') !== '')
      step('暴露 8080', '8080/tcp' in (cfg.config?.ExposedPorts ?? {}))
      console.log(`\n镜像大小（amd64 层合计）：${((cm.layers ?? []).reduce((a, l) => a + (l.size ?? 0), 0) / 1024 / 1024).toFixed(1)} MB（压缩后）`)
    }
  }
}

console.log(`\n拉取命令： docker pull ${IMAGE}:latest`)
