/**
 * 终端连接管理 Hook：负责「创建服务端终端 → 附加 WebSocket → 收发 → 断线重连」的完整生命周期。
 *
 * 抽成独立 Hook 的原因：首连与重连走的是同一套逻辑（附加、消息分发、背压确认），
 * 若把重连写成一坨复制粘贴的代码，两处行为迟早会漂移。
 * 这里统一为 `openSocket(conn)` 一个入口，首连与重连都调它。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { type ClientControlMessage, type ServerControlMessage } from '@webterm/shared'
import {
  ApiRequestError,
  buildTerminalWsUrl,
  createTerminal,
  closeTerminal,
  type CreateTerminalResponse,
} from '../api/client'
import type { TerminalTab } from '../store/useTerminalStore'

/** 断线重连的最大次数与退避间隔（毫秒） */
const RECONNECT_DELAYS = [600, 1500, 3000]

/** WebSocket 应用自定义关闭码：令牌无效 / 终端不存在 */
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_NOT_FOUND = 4404

type TriggerMessage = Extract<ServerControlMessage, { t: 'trigger' }>
type ScriptMessage = Extract<ServerControlMessage, { t: 'script' }>
type MacroMessage = Extract<ServerControlMessage, { t: 'macro' }>

interface UseTerminalConnectionOptions {
  tab: TerminalTab
  /** 惰性获取 xterm 实例（实例在另一个 effect 中创建，故用 getter 而非直接传引用） */
  getTerm: () => Terminal | null
  setStatus: (patch: Partial<TerminalTab>) => void
  setBanner: (message: string | null) => void
  /**
   * 阶段 6：自动化运行态的三类推送。
   * 做成回调而不是让本 Hook 直接写 store，是为了让「连接层」保持只负责传输 ——
   * 它不知道也不需要知道什么叫规则命中。
   */
  onTrigger?: (msg: TriggerMessage) => void
  onScript?: (msg: ScriptMessage) => void
  onMacro?: (msg: MacroMessage) => void
}

export interface TerminalConnection {
  /** 发送 JSON 控制消息（尺寸变更、心跳、背压确认） */
  sendControl: (msg: ClientControlMessage) => void
  /** 发送二进制帧（键盘输入等终端字节流） */
  sendBinary: (payload: Uint8Array) => void
  /** 用户手动触发的重连（自动重连耗尽后可用） */
  reconnect: () => void
  /** 当前连接是否可写（同步输入广播用它筛选接收方） */
  isWritable: () => boolean
}

export function useTerminalConnection({
  tab,
  getTerm,
  setStatus,
  setBanner,
  onTrigger,
  onScript,
  onMacro,
}: UseTerminalConnectionOptions): TerminalConnection {
  const wsRef = useRef<WebSocket | null>(null)
  const connRef = useRef<CreateTerminalResponse | null>(null)
  const attemptRef = useRef(0)
  const disposedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 回调存进 ref，避免把它们写进 effect 依赖导致连接被反复重建
  const getTermRef = useRef(getTerm)
  const setStatusRef = useRef(setStatus)
  const setBannerRef = useRef(setBanner)
  const onTriggerRef = useRef(onTrigger)
  const onScriptRef = useRef(onScript)
  const onMacroRef = useRef(onMacro)
  getTermRef.current = getTerm
  setStatusRef.current = setStatus
  setBannerRef.current = setBanner
  onTriggerRef.current = onTrigger
  onScriptRef.current = onScript
  onMacroRef.current = onMacro

  const sendControl = useCallback((msg: ClientControlMessage) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }, [])

  const sendBinary = useCallback((payload: Uint8Array) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(payload)
  }, [])

  /**
   * 连接是否可写。
   * 读 wsRef 而不是读 tab.status：status 是渲染用的状态快照，会有一次渲染的延迟，
   * 广播正在往一批终端投字节时，用陈旧状态判断会把刚断开的目标也算进去。
   */
  const isWritable = useCallback(
    () => wsRef.current !== null && wsRef.current.readyState === WebSocket.OPEN,
    [],
  )

  /** 向终端写入一条带颜色的提示行 */
  const writeNotice = useCallback((text: string, tone: 'error' | 'info' = 'info') => {
    const term = getTermRef.current()
    if (!term) return
    const color = tone === 'error' ? '\x1b[31m' : '\x1b[90m'
    term.write(`\r\n${color}${text}\x1b[0m\r\n`)
  }, [])

  /** 统一的控制消息分发 */
  const handleControl = useCallback(
    (msg: ServerControlMessage) => {
      const term = getTermRef.current()
      switch (msg.t) {
        case 'ready':
          attemptRef.current = 0
          setBannerRef.current(null)
          setStatusRef.current({
            status: 'ready',
            terminalId: msg.terminalId,
            negotiation: {
              serverIdent: msg.info.serverIdent,
              kex: msg.info.kex,
              hostKeyAlgorithm: msg.info.hostKeyAlgorithm,
              cipher: msg.info.cipherS2c,
              mac: msg.info.mac,
              profile: msg.info.profile,
              legacy: msg.info.legacy,
            },
            // Telnet 才有；SSH 时是 undefined，正好把陈旧值一并覆盖掉
            telnetOptions: msg.info.telnetOptions,
          })
          // 就绪后立即同步一次尺寸，确保远端 PTY 与本地渲染一致
          if (term) sendControl({ t: 'resize', cols: term.cols, rows: term.rows })
          break

        case 'flow':
          setStatusRef.current({ status: msg.action === 'pause' ? 'flow-paused' : 'ready' })
          setBannerRef.current(msg.action === 'pause' ? '输出过快，已自动限速（背压保护中）' : null)
          break

        case 'exit':
          term?.write(`\r\n\x1b[90m[${msg.reason}]\x1b[0m\r\n`)
          setStatusRef.current({ status: 'exited', notice: msg.reason })
          break

        case 'error':
          writeNotice(msg.message, 'error')
          setBannerRef.current(msg.message)
          setStatusRef.current({
            status: msg.fatal ? 'error' : tab.status,
            notice: msg.message,
          })
          break

        case 'pong':
          break

        // 阶段 6：三类自动化运行态。连接层只做转发，具体反应由上层决定
        // （命中要标色、脚本要进日志面板、宏要进进度条，三者关注的东西完全不同）
        case 'trigger':
          onTriggerRef.current?.(msg)
          break

        case 'script':
          onScriptRef.current?.(msg)
          break

        case 'macro':
          onMacroRef.current?.(msg)
          break
      }
    },
    [sendControl, tab.status, writeNotice],
  )

  /** 打开（或重新打开）WebSocket 连接 */
  const openSocket = useCallback(
    (conn: CreateTerminalResponse) => {
      const ws = new WebSocket(buildTerminalWsUrl(conn.wsPath, conn.attachToken))
      // 终端输出是二进制，用 arraybuffer 避免 Blob 转换的额外开销
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        attemptRef.current = 0
        const term = getTermRef.current()
        if (term) sendControl({ t: 'resize', cols: term.cols, rows: term.rows })
      }

      ws.onmessage = (event: MessageEvent) => {
        const term = getTermRef.current()
        if (!term) return

        // 二进制帧 = 终端输出字节，直接交给 xterm
        if (event.data instanceof ArrayBuffer) {
          const bytes = event.data.byteLength
          // write 的回调在数据被解析后触发，用它作为「已消费」信号回报服务端
          term.write(new Uint8Array(event.data), () => {
            sendControl({ t: 'ack', bytes })
          })
          return
        }

        if (typeof event.data === 'string') {
          try {
            handleControl(JSON.parse(event.data) as ServerControlMessage)
          } catch {
            /* 无法解析的消息直接忽略 */
          }
        }
      }

      ws.onclose = (event: CloseEvent) => {
        if (disposedRef.current) return
        wsRef.current = null

        // 确定性失败：重试也不会成功，直接给出结论
        if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_NOT_FOUND) {
          const message = '终端已在服务端关闭，无法重新附加，请重新发起连接。'
          setStatusRef.current({ status: 'error', notice: message })
          setBannerRef.current(message)
          return
        }

        const attempt = attemptRef.current
        if (attempt < RECONNECT_DELAYS.length) {
          attemptRef.current = attempt + 1
          const delay = RECONNECT_DELAYS[attempt] ?? 3000
          setBannerRef.current(
            `连接已断开，${(delay / 1000).toFixed(1)} 秒后自动重试（第 ${attempt + 1}/${RECONNECT_DELAYS.length} 次）…`,
          )
          timerRef.current = setTimeout(() => {
            if (disposedRef.current) return
            const current = connRef.current
            if (current) openSocket(current)
          }, delay)
          return
        }

        setStatusRef.current({ status: 'exited', notice: '连接已断开' })
        setBannerRef.current('连接已断开，自动重连未成功。可点击「重新连接」再试。')
      }

      ws.onerror = () => {
        // 错误必然伴随 close，统一在那里处理，避免重复提示
      }
    },
    [handleControl, sendControl],
  )

  /* ---------------- 首次建立：创建服务端终端后再附加 ---------------- */
  useEffect(() => {
    disposedRef.current = false

    const bootstrap = async () => {
      try {
        // 会话库引用与快速连接两条路径；前者连接参数由服务端解析
        const conn = tab.sessionId
          ? await createTerminal({ sessionId: tab.sessionId, title: tab.title })
          : await createTerminal({ config: tab.config, title: tab.title })
        if (disposedRef.current) {
          // 组件已卸载：回收刚创建的服务端终端，避免留下无人使用的 SSH 连接
          void closeTerminal(conn.terminalId).catch(() => {})
          return
        }
        connRef.current = conn
        setStatusRef.current({
          terminalId: conn.terminalId,
          attachToken: conn.attachToken,
          wsPath: conn.wsPath,
          negotiation: conn.negotiation,
        })
        // 随会话自动启动的隧道可以失败（端口被占用等），但这不影响连接本身。
        // 必须明确告诉用户，否则他会以为「隧道配好了」却在别处找不到原因。
        if (conn.tunnelWarnings?.length) {
          for (const warning of conn.tunnelWarnings) writeNotice(warning, 'error')
          setBannerRef.current(conn.tunnelWarnings.join('\n'))
        }
        openSocket(conn)
      } catch (err) {
        if (disposedRef.current) return
        const message =
          err instanceof ApiRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err)
        writeNotice(message, 'error')
        setBannerRef.current(message)
        setStatusRef.current({ status: 'error', notice: message })
      }
    }

    void bootstrap()

    return () => {
      disposedRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        try {
          ws.close()
        } catch {
          /* 忽略 */
        }
      }
    }
    // tab.id 是面板身份；配置创建后不再变更，故不列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  /** 手动重连：复用已创建的终端直接重新附加 */
  const reconnect = useCallback(() => {
    const conn = connRef.current
    if (!conn) {
      // 首连就失败（例如认证失败），此时没有可复用的终端，只能让用户重建
      setBannerRef.current('没有可复用的连接，请关闭此标签后重新发起连接。')
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    attemptRef.current = 0
    setBannerRef.current(null)
    setStatusRef.current({ status: 'connecting' })
    openSocket(conn)
  }, [openSocket])

  return { sendControl, sendBinary, reconnect, isWritable }
}
