import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * UI 明暗主题（阶段 8 扩展为三态）。
 *
 * `auto` 跟随操作系统的 `prefers-color-scheme`：白天自动浅色、晚上自动深色。
 * 这是「界面」主题，终端配色另有独立开关（见 settings/terminalThemes.ts）。
 *
 * `resolved` 是「当前实际生效的明暗」，单独存在 store 里而不是让每个组件各自解析：
 * 系统主题变化时只有一处更新，所有消费方（终端配色、预览、日志回放）自动跟着变，
 * 不会出现「设置页说深色、终端还是浅色」这种不同步。
 */
export type ThemeMode = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /** 在浅色 / 深色之间切换；当前是 auto 时切到与「当前实际观感」相反的那个 */
  toggle: () => void
  /** 重新解析并应用到 <html>（系统主题变化、或 mode 改变后调用） */
  apply: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'light',
      resolved: 'light',
      setMode: (mode) => {
        applyTheme(mode)
        set({ mode, resolved: resolveTheme(mode) })
      },
      toggle: () => get().setMode(get().resolved === 'light' ? 'dark' : 'light'),
      apply: () => {
        const mode = get().mode
        applyTheme(mode)
        set({ resolved: resolveTheme(mode) })
      },
    }),
    {
      name: 'webterm.theme',
      // resolved 是派生态，持久化它只会掩盖「用户换了系统主题」这一事实
      partialize: (state) => ({ mode: state.mode }),
    },
  ),
)

/** 系统是否偏好深色（无 matchMedia 环境退化为浅色） */
export function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 把三态解析为实际生效的明暗 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') return prefersDark() ? 'dark' : 'light'
  return mode
}

/** 把主题同步到 <html>，供 Tailwind 的 dark: 变体与浏览器原生控件使用 */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

/**
 * 订阅系统主题变化。
 * 仅在 `mode === 'auto'` 时回调 —— 用户显式选了浅色 / 深色时，
 * 系统怎么变都不该动他的界面。
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = () => {
    if (useThemeStore.getState().mode === 'auto') onChange()
  }
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
