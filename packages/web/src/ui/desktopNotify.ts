/**
 * 桌面通知（阶段 8）。
 *
 * 三个必须处理的现实：
 * 1. **权限是用户资产，不能想弹就弹。** 只有用户在设置页点了「请求授权」才调
 *    `requestPermission()`；自动弹权限框会被浏览器降级为「已忽略」，之后再也申请不到。
 * 2. **页面在前台时不该弹系统通知。** 用户正看着屏幕，右下角已经有 Toast 了，
 *    再弹一个系统通知纯属噪音（macOS 上还会盖住终端）。因此只在文档不可见时发。
 * 3. **HTTPS / localhost 才可用。** 局域网 IP 直连时 `Notification` 不存在，
 *    这里静默降级为「不通知」，绝不抛错影响连接流程。
 */
import { useSettingsStore } from '../settings/useSettingsStore'

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

export function notificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notificationPermission(): NotificationPermissionState {
  if (!notificationSupported()) return 'unsupported'
  return Notification.permission as NotificationPermissionState
}

/** 由用户显式触发；返回值即授权后的状态 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!notificationSupported()) return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    return result as NotificationPermissionState
  } catch {
    return 'denied'
  }
}

export interface DesktopNotifyOptions {
  /** 点通知时把窗口拉回前台 */
  onClick?: () => void
  tag?: string
}

/**
 * 发送桌面通知。
 * 调用方只需按业务语义决定「要不要发」，权限 / 开关 / 前台判断都在这里统一处理。
 */
export function notifyDesktop(title: string, body: string, options: DesktopNotifyOptions = {}): boolean {
  const settings = useSettingsStore.getState().notifications
  if (!settings.desktop) return false
  if (!notificationSupported() || Notification.permission !== 'granted') return false
  // 前台时不打扰：Toast 已经说明了同一件事
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return false

  try {
    const notification = new Notification(title, { body, tag: options.tag })
    notification.onclick = () => {
      window.focus()
      options.onClick?.()
      notification.close()
    }
    return true
  } catch {
    return false
  }
}

/** 组合入口：按事件类型查开关，再发系统通知 */
export function notifyEvent(
  event: 'disconnect' | 'batchComplete' | 'triggerHit' | 'pluginNotify',
  title: string,
  body: string,
): void {
  const settings = useSettingsStore.getState().notifications
  const allowed =
    event === 'disconnect'
      ? settings.onDisconnect
      : event === 'batchComplete'
        ? settings.onBatchComplete
        : event === 'triggerHit'
          ? settings.onTriggerHit
          : settings.onPluginNotify
  if (!allowed) return
  notifyDesktop(title, body)
}
