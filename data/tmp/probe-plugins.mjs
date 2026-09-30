/**
 * 阶段 9 插件接口的临时探针（不入库，用完即删）。
 * 用 node:fetch 而不是 curl：本环境的 curl 走代理，
 * 服务未就绪时看到的是代理的 502 文案，容易误判成接口报错。
 */
const base = process.env.PROBE_BASE ?? 'http://127.0.0.1:8125'

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  let text = await res.text()
  try {
    text = JSON.stringify(JSON.parse(text))
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, text }
}

const show = async (label, method, path, body) => {
  const r = await req(method, path, body)
  console.log(`[${label}] ${r.status} ${r.text.slice(0, 260)}`)
}

await show('list', 'GET', '/api/plugins')
await show('panel', 'GET', '/api/plugins/heartbeat-monitor/panels/sessions')
await show('command', 'POST', '/api/plugins/heartbeat-monitor/commands/check-now')
await show('unknown-plugin', 'GET', '/api/plugins/nope')
await show('empty-patch', 'PATCH', '/api/plugins/heartbeat-monitor', {})
await show('disable', 'PATCH', '/api/plugins/heartbeat-monitor', { enabled: false })
await show('cmd-when-disabled', 'POST', '/api/plugins/heartbeat-monitor/commands/check-now')
await show('panel-when-disabled', 'GET', '/api/plugins/heartbeat-monitor/panels/sessions')
await show('config', 'PATCH', '/api/plugins/heartbeat-monitor', { config: { intervalMs: '15000', notifyOnRecover: 'true' } })
await show('enable', 'PATCH', '/api/plugins/heartbeat-monitor', { enabled: true })
await show('bad-config-key', 'PATCH', '/api/plugins/heartbeat-monitor', { config: { nope: { a: 1 } } })
