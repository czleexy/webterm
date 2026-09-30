/**
 * 心跳监视器 —— WebTerm 示例插件。
 *
 * 它在演示插件机制的**全部**能力，因此也是一个可以直接抄的骨架：
 *
 * | 能力 | 用在哪 |
 * | --- | --- |
 * | `on('session:opened' / 'closed')` | 维护「要监视哪些会话」的表 |
 * | `on('session:output')` | 在输出流里找心跳回显，刷新「最后回应时间」 |
 * | `setInterval` + `host.getConfig` | 低频定时检查（每 5 秒醒一次，按配置决定要不要真的检查） |
 * | `registerTriggerAction` | 「心跳确认」——把某条规则命中的会话标记为存活 |
 * | `registerCommand` | 立即检查 / 全部发送心跳 / 重置统计 |
 * | `registerPanel` | 一张每个会话的存活状态表 |
 * | `host.notify` | 疑似失联与恢复时通知 |
 *
 * 两条刻意示范的写法，插件作者最容易踩：
 *
 * 1. **配置按需读取，不要抄进常量**。定时器固定每 5 秒醒一次，每次醒来
 *    才去读 `intervalMs`。这样用户在界面上把间隔从 60 秒改成 10 秒，
 *    下一个 tick 就生效了，不需要重载插件、也不会丢掉已经积累的存活记录。
 * 2. **输出回调里只做一次子串查找**。`session:output` 是远端每一次写入都会
 *    触发的，在里面做正则全扫或者在 10 万行里搜关键字，会实打实地拖慢终端。
 */

// ---- 状态 ------------------------------------------------------------

/** terminalId → 该会话的心跳记录 */
const records = new Map()

/** 上一次真正执行检查的时间（心跳间隔可能远大于定时器周期） */
let lastCheckAt = 0

function touch(terminalId, title) {
  let record = records.get(terminalId)
  if (!record) {
    record = {
      terminalId,
      title: title || terminalId.slice(0, 8),
      lastSeen: Date.now(),
      lastSeenSource: '建立连接',
      misses: 0,
      beats: 0,
      alerted: false,
    }
    records.set(terminalId, record)
  } else if (title) {
    record.title = title
  }
  return record
}

function markAlive(terminalId, source) {
  const record = touch(terminalId)
  const wasAlerted = record.alerted
  record.lastSeen = Date.now()
  record.lastSeenSource = source
  record.misses = 0
  record.alerted = false
  if (wasAlerted && host.getConfig('notifyOnRecover', true)) {
    host.notify('会话已恢复', '「' + record.title + '」重新开始回应心跳')
  }
  return record
}

function seed() {
  for (const session of host.sessions.list()) touch(session.terminalId, session.title)
}

// ---- 检查 ------------------------------------------------------------

function checkOnce(manual) {
  seed()
  const timeoutMs = host.getConfig('timeoutMs', 180000)
  const threshold = host.getConfig('failureThreshold', 3)
  const command = host.getConfig('heartbeatCommand', 'echo HEARTBEAT-OK')
  let probed = 0
  let alerted = 0

  for (const session of host.sessions.list()) {
    const record = touch(session.terminalId, session.title)
    if (Date.now() - record.lastSeen < timeoutMs) continue

    record.misses += 1
    record.beats += 1
    probed += 1
    // send 写的是原始字节，回车要自己补 —— 这是宿主 API 的约定：
    // 终端协议自己决定行结束符，宿主不替插件猜
    host.sessions.send(session.terminalId, command + '\r')

    if (record.misses >= threshold && !record.alerted) {
      record.alerted = true
      alerted += 1
      // 传 'warn'：告警与提示在界面上要能区分开
      host.notify(
        '会话疑似失联',
        '「' + record.title + '」已连续 ' + record.misses + ' 次没有回应心跳（阈值 ' + threshold + ' 次）',
        'warn',
      )
    }
  }

  if (manual) {
    return { probed, alerted, total: records.size }
  }
  return { probed, alerted, total: records.size }
}

// ---- 事件订阅 --------------------------------------------------------

host.on('session:opened', (event) => {
  const session = event.session
  touch(session.terminalId, session.title)
  host.log('info', '开始监视「' + session.title + '」（' + session.protocol + ' ' + session.host + ':' + session.port + '）')
})

host.on('session:closed', (event) => {
  records.delete(event.terminalId)
  host.log('info', '停止监视「' + event.title + '」：' + event.reason)
})

host.on('session:output', (event) => {
  // 这一行是整个插件里唯一的热路径：只做一次 indexOf，不做正则、不建对象
  const marker = host.config.responseMarker
  if (!marker || event.text.indexOf(marker) === -1) return
  const record = markAlive(event.terminalId, '收到心跳回应')
  host.log('debug', '「' + record.title + '」回应了心跳')
})

// ---- 定时检查 --------------------------------------------------------
//
// 固定 5 秒一个 tick，是否真的检查由 intervalMs 决定。
// 这样用户改配置立即生效，而不用重载插件（重载会把 records 全丢掉）。

setInterval(() => {
  const intervalMs = host.getConfig('intervalMs', 60000)
  if (Date.now() - lastCheckAt < intervalMs) return
  lastCheckAt = Date.now()
  const result = checkOnce(false)
  if (result.probed > 0) {
    host.log('info', '已补发 ' + result.probed + ' 次心跳，新增告警 ' + result.alerted + ' 条')
  }
}, 5000)

// ---- 触发器动作 ------------------------------------------------------

host.registerTriggerAction(
  {
    id: 'mark-alive',
    label: '心跳确认（重置该会话的失联计数）',
    description:
      '配套用法：给一条匹配心跳回显的正则规则挂上本动作。插件定时发心跳，规则在输出里看到回显就调用本动作，' +
      '把该会话标记为存活；连续收不到回显时会告警。',
  },
  (ctx) => {
    const terminalId = ctx.session ? ctx.session.terminalId : undefined
    if (!terminalId) {
      ctx.log('warn', '本动作需要绑定在一个仍然存活的会话上（触发规则的会话已关闭）')
      return
    }
    const record = markAlive(terminalId, '触发器确认：' + ctx.matched)
    ctx.log('info', '「' + record.title + '」被规则「' + ctx.ruleName + '」标记为存活')
  },
)

// ---- 命令 ------------------------------------------------------------

host.registerCommand({ id: 'check-now', label: '立即检查', description: '不等下一个间隔，马上跑一轮检查' }, () => {
  lastCheckAt = Date.now()
  const result = checkOnce(true)
  return '已检查 ' + result.total + ' 个会话，补发心跳 ' + result.probed + ' 次，新增告警 ' + result.alerted + ' 条'
})

host.registerCommand({ id: 'send-all', label: '全部发送心跳' }, () => {
  const command = host.getConfig('heartbeatCommand', 'echo HEARTBEAT-OK')
  let sent = 0
  for (const session of host.sessions.list()) {
    if (host.sessions.send(session.terminalId, command + '\r')) {
      sent += 1
      touch(session.terminalId, session.title).beats += 1
    }
  }
  return '已向 ' + sent + ' 个会话发送心跳命令'
})

host.registerCommand({ id: 'reset', label: '重置统计' }, () => {
  const count = records.size
  for (const record of records.values()) {
    record.lastSeen = Date.now()
    record.lastSeenSource = '手动重置'
    record.misses = 0
    record.alerted = false
  }
  return '已重置 ' + count + ' 个会话的心跳记录'
})

// ---- 面板 ------------------------------------------------------------

host.registerPanel({ id: 'sessions', title: '会话心跳状态' }, () => {
  const timeoutMs = host.getConfig('timeoutMs', 180000)
  const threshold = host.getConfig('failureThreshold', 3)
  const rows = []

  for (const record of records.values()) {
    const silentMs = Date.now() - record.lastSeen
    const alive = host.sessions.get(record.terminalId)
    rows.push([
      record.title,
      alive ? '在线' : '已关闭',
      Math.round(silentMs / 1000) + ' 秒',
      record.lastSeenSource,
      String(record.misses),
      String(record.beats),
      record.alerted ? '已告警' : silentMs >= timeoutMs ? '静默中' : '正常',
    ])
  }

  const elapsed = Date.now() - lastCheckAt
  const remaining = Math.max(0, Math.round((host.getConfig('intervalMs', 60000) - elapsed) / 1000))
  return {
    columns: ['会话', '连接', '距上次回应', '最后一次回应来源', '未回应次数', '已发心跳', '状态'],
    rows,
    note:
      rows.length === 0
        ? '还没有监视中的会话：建立一条终端连接后这里会出现它。'
        : '静默阈值 ' + Math.round(timeoutMs / 1000) + ' 秒 · 连续 ' + threshold + ' 次未回应即告警 · 下次检查还有约 ' + remaining + ' 秒',
  }
})

host.log('info', '心跳监视器已就绪：当前有 ' + host.sessions.list().length + ' 个会话')
