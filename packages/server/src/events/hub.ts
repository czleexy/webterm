/**
 * 全局事件通道（/ws/events）。
 *
 * 存在的理由：有些消息**不属于任何单个终端** —— 插件通知、插件列表变更、
 * 全局任务进度。把它们塞进终端 WS 会有一个尴尬后果：用户没开终端就收不到，
 * 而「插件发现会话失联了」恰恰是那种「越没盯着终端越需要收到」的消息。
 *
 * 实现上刻意保持极小：一个订阅者集合 + 一次 JSON 序列化后扇出。
 * 消息频率低（人类可读的通知，不是终端字节流），不需要背压与批量合并 ——
 * 真需要的时候再谈，现在加一层缓冲只会让「为什么通知晚了一秒」更难查。
 */
import type { ServerEventMessage } from '@webterm/shared'

/** 只依赖 send 与 readyState，便于测试时用假对象替换 */
export interface EventClient {
  send: (data: string) => void
  readyState: number
}

/** WebSocket.OPEN 的值；这里写死常量避免为一个数字引入 ws 的类型依赖 */
const OPEN = 1

export class EventHub {
  private readonly clients = new Set<EventClient>()

  get size(): number {
    return this.clients.size
  }

  /** 加入一个订阅者，返回退订函数 */
  add(client: EventClient): () => void {
    this.clients.add(client)
    return () => {
      this.clients.delete(client)
    }
  }

  /**
   * 广播一条事件。
   * 单个客户端发送失败不能影响其它客户端 —— 一个坏掉的页面不该让
   * 所有人的通知都断掉，所以逐条 try/catch 并在失败时踢出该客户端。
   */
  broadcast(message: ServerEventMessage): void {
    if (this.clients.size === 0) return
    const payload = JSON.stringify(message)
    for (const client of [...this.clients]) {
      if (client.readyState !== OPEN) {
        this.clients.delete(client)
        continue
      }
      try {
        client.send(payload)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  dispose(): void {
    this.clients.clear()
  }
}
