import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark'

interface ThemeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'light',
      setMode: (mode) => set({ mode }),
      toggle: () => set({ mode: get().mode === 'light' ? 'dark' : 'light' }),
    }),
    { name: 'webterm.theme' },
  ),
)

/** 把主题同步到 <html>，供 Tailwind 的 dark: 变体与浏览器原生控件使用。 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.style.colorScheme = mode
}
