/**
 * 盯一次 GitHub Actions 运行直到结束（本环境没有 gh CLI，直接打 REST API）。
 *
 * 用法：node data/tmp/watch-run.mjs <head_sha 前缀>
 *
 * 输出每次轮询的 job 状态变化；结束时打印每个 job 的步骤级结论，
 * 失败时把失败步骤的日志尾部抓出来 —— 省掉在浏览器里翻页看日志。
 */
const H = { 'User-Agent': 'watch-run', Accept: 'application/vnd.github+json' }
const REPO = 'czleexy/webterm'
const SHA_PREFIX = process.argv[2]
if (!SHA_PREFIX) {
  console.error('用法：node data/tmp/watch-run.mjs <head_sha 前缀>')
  process.exit(2)
}

const api = async (path) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: H })
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 找对应的 run
let run
for (let i = 0; i < 20; i += 1) {
  const list = await api('/actions/runs?per_page=15')
  run = (list.workflow_runs ?? []).find((r) => r.head_sha.startsWith(SHA_PREFIX))
  if (run) break
  await sleep(6000)
}
if (!run) {
  console.error(`没有找到 head_sha 以 ${SHA_PREFIX} 开头的运行（可能被 paths-ignore 过滤掉了）`)
  process.exit(3)
}

console.log(`run #${run.run_number}  ${run.html_url}`)
console.log(`title=${run.display_title}  event=${run.event}  branch=${run.head_branch}`)

const seen = new Map()
for (let tick = 0; tick < 120; tick += 1) {
  const jobs = (await api(`/actions/runs/${run.id}/jobs`)).jobs ?? []
  for (const j of jobs) {
    const key = j.name
    const cur = `${j.status}/${j.conclusion ?? '-'}`
    if (seen.get(key) !== cur) {
      seen.set(key, cur)
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${j.name}: ${cur}`)
      if (j.status === 'in_progress' || j.status === 'completed') {
        for (const s of j.steps ?? []) {
          if (s.status === 'completed' && s.conclusion !== 'success' && s.conclusion !== 'skipped') {
            console.log(`    !! ${s.number}. ${s.name} -> ${s.conclusion}`)
          }
        }
      }
    }
  }
  const r = await api(`/actions/runs/${run.id}`)
  if (r.status === 'completed') {
    console.log(`\n运行结束：${r.conclusion}  (${r.run_started_at} -> ${r.updated_at})`)

    const jobs2 = (await api(`/actions/runs/${run.id}/jobs`)).jobs ?? []
    for (const j of jobs2) {
      console.log(`\n=== ${j.name} | ${j.conclusion} ===`)
      for (const s of j.steps ?? []) {
        const mark = s.conclusion === 'success' ? 'ok  ' : s.conclusion === 'skipped' ? 'skip' : 'FAIL'
        console.log(`  ${mark} ${String(s.number).padStart(2)}. ${s.name}  (${s.conclusion ?? '-'})`)
      }
      if (j.conclusion !== 'success') {
        const log = await fetch(
          `https://api.github.com/repos/${REPO}/actions/jobs/${j.id}/logs`,
          { headers: H, redirect: 'follow' },
        )
        const text = log.ok ? await log.text() : `<无法取日志：HTTP ${log.status}>`
        const lines = text.split('\n')
        const bad = lines.filter((l) => /##\[error\]|Error:|error |FAIL|not found/i.test(l))
        console.log(`  ---- 失败线索（${bad.length} 行）----`)
        console.log(bad.slice(-25).map((l) => '  ' + l.trim().slice(0, 200)).join('\n') || '  <无匹配行>')
        console.log('  ---- 日志尾部 30 行 ----')
        console.log(lines.slice(-30).map((l) => '  ' + l.slice(0, 200)).join('\n'))
      }
    }
    process.exit(r.conclusion === 'success' ? 0 : 1)
  }
  await sleep(20000)
}
console.error('轮询超时（40 分钟）')
process.exit(4)
