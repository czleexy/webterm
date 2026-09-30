/**
 * 终端输入总线：把「往某个终端写字节」这件事从组件树里解耦出来。
 *
 * 为什么需要它：
 * 键盘输入天然是「自己组件 → 自己的 WebSocket」这种点对点关系，
 * 但阶段 6 的**同步输入（广播）**要求一次按键落到多个终端上。若把这个逻辑塞进
 * TerminalPane，就要让每个面板都能拿到其他面板的 sendBinary —— 那意味着要么层层透传
 * 回调，要么把 WebSocket 提到全局 store 里（后者会让 React 的渲染与连接生命周期纠缠在一起）。
 *
 * 这里取第三条路：面板在挂载时把「发送能力」登记进一个模块级注册表，
 * 广播模块按 tabId 查出目标端点直接投递。注册表里只存函数，不存 React 状态，
 * 因此不会引起任何额外渲染。
 *
 * 边界说明：本模块**不感知广播是否开启**（那是 useBroadcastStore 的事），
 * 它只提供「往这些 tab 投字节」的机械能力。这样触发器的「发送到指定会话」等
 * 后续需求也能直接复用，而不必再写一遍注册表。
 */
import type { ClientControlMessage } from '@webterm/shared'

export interface TerminalEndpoint {
  tabId: string
  /** 展示名，用于广播面板列出「谁会收到」 */
  title: string
  /** 发送二进制帧（键盘字节流）。未连接时静默丢弃 */
  sendBinary: (payload: Uint8Array) => void
  /** 发送 JSON 控制消息 */
  sendControl: (msg: ClientControlMessage) => void
  /** 当前是否可写（连接处于 OPEN 状态） */
  isWritable: () => boolean
  /**
   * 面板级动作（阶段 8）。
   * 全局快捷键只能拿到「当前活动的 tabId」，真正要操作的是那个面板内部的
   * xterm 实例与局部 UI 状态（搜索条开关、选区、焦点），
   * 因此由面板把这些能力登记出来，而不是把 xterm 实例暴露到全局。
   */
  openSearch?: () => void
  focus?: () => void
  copySelection?: () => void
}

const endpoints = new Map<string, TerminalEndpoint>()

/** 注册一个终端端点，返回注销函数（应在组件卸载时调用） */
export function registerTerminalEndpoint(endpoint: TerminalEndpoint): () => void {
  endpoints.set(endpoint.tabId, endpoint)
  return () => {
    // 只有当当前登记的仍是自己时才删除：避免「旧实例的清理函数」把新实例的登记抹掉
    // （React 严格模式下 effect 会成对执行，这种覆盖很常见）
    if (endpoints.get(endpoint.tabId) === endpoint) endpoints.delete(endpoint.tabId)
  }
}

export function getTerminalEndpoint(tabId: string): TerminalEndpoint | undefined {
  return endpoints.get(tabId)
}

/** 当前登记在册的全部端点，供广播面板展示与选择 */
export function listTerminalEndpoints(): TerminalEndpoint[] {
  return [...endpoints.values()]
}

/**
 * 是否可以向该终端投递输入。
 * Telnet 会话同样支持 —— 它本来就是一条裸字节通道，广播很好用
 * （例如同时给几台设备下发同样的配置命令）。
 */
export function isEndpointWritable(tabId: string): boolean {
  return endpoints.get(tabId)?.isWritable() ?? false
}

export interface BroadcastOutcome {
  /** 实际投递成功的 tabId */
  delivered: string[]
  /** 因为没连接上而跳过的 tabId */
  skipped: string[]
}

/**
 * 把一段按键输入投递给多个终端。
 *
 * `sourceTabId` 会被排除 —— 源面板自己的 onData 已经把这一下按键发过一遍了，
 * 这里再发一次就是双份输入（表现为「按一个 a 出来两个 a」）。
 *
 * 不做任何去抖或合并：终端输入必须保持原始时序，把两次按键合成一次会让
 * 方向键、Tab 补全这类依赖顺序的操作彻底错乱。
 */
export function broadcastInput(
  text: string,
  targetTabIds: readonly string[],
  sourceTabId?: string,
): BroadcastOutcome {
  const delivered: string[] = []
  const skipped: string[] = []
  if (text === '') return { delivered, skipped }

  const payload = new TextEncoder().encode(text)
  for (const tabId of targetTabIds) {
    if (tabId === sourceTabId) continue
    const endpoint = endpoints.get(tabId)
    if (!endpoint || !endpoint.isWritable()) {
      skipped.push(tabId)
      continue
    }
    endpoint.sendBinary(payload)
    delivered.push(tabId)
  }
  return { delivered, skipped }
}

/** 单独向一个终端发送一段按键输入（宏「临时执行」等场景用） */
export function sendInputTo(tabId: string, text: string): boolean {
  const endpoint = endpoints.get(tabId)
  if (!endpoint || !endpoint.isWritable()) return false
  endpoint.sendBinary(new TextEncoder().encode(text))
  return true
}

/** 仅供测试使用：清空注册表，避免用例之间互相串扰 */
export function __resetTerminalBusForTest(): void {
  endpoints.clear()
}
