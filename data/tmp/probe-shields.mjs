/** 只用 shields.io 查各 ref 的结论（github.com 直连超时时仍可用）。 */
const WF = 'docker-image.yml'
const bust = Date.now()
for (const ref of process.argv.slice(2)) {
  const r = await fetch(`https://img.shields.io/github/actions/workflow/status/czleexy/webterm/${WF}?branch=${encodeURIComponent(ref)}&_=${bust}`,
    { headers: { 'User-Agent': 'p' }, signal: AbortSignal.timeout(30000) })
  const t = await r.text()
  const title = /<title>([^<]*)<\/title>/.exec(t)?.[1] ?? '(无)'
  console.log(`${ref.padEnd(10)} shields="${title}"  cache=${r.headers.get('cache-control')}`)
}
