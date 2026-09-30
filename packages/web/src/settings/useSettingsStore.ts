/**
 * 应用设置（阶段 8）：终端外观 / 通知 / 语言 / 快捷键 / 关键词高亮。
 *
 * 与 `useThemeStore` 的分工：那个只管 UI 明暗（阶段 1 就存在、被顶栏与全站 Tailwind 依赖），
 * 这里管「用户偏好」的其他部分。两者都在「设置」面板里改，但状态各自独立 ——
 * UI 明暗是由 CSS 类驱动的全局开关，混进来会让持久化结构变复杂。
 *
 * 不做服务端持久化：这些是**每台设备各自合适**的偏好（屏幕小就把字号调小、
 * 外接键盘就有自己的快捷键习惯），同步到服务端反而会让多设备体验互相打架。
 * 用 zustand persist 存 localStorage。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TerminalThemeId } from './terminalThemes'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTION_IDS,
  type ShortcutActionId,
} from './shortcuts'

/* ------------------------------------------------------------------ */
/* 常量与默认值                                                          */
/* ------------------------------------------------------------------ */

export const FONT_SIZE_MIN = 11
export const FONT_SIZE_MAX = 20
export const LINE_HEIGHT_MIN = 1
export const LINE_HEIGHT_MAX = 1.6
export const SCROLLBACK_MIN = 1_000
export const SCROLLBACK_MAX = 200_000
export const MAX_HIGHLIGHT_RULES = 32

/** 与 index.css 的 --font-mono 保持一致 */
export const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'

/** 可选字族（都要求等宽；终端用比例字体会直接错位） */
export const FONT_FAMILY_PRESETS: { id: string; name: string; value: string }[] = [
  { id: 'jetbrains', name: 'JetBrains Mono（优先）', value: DEFAULT_FONT_FAMILY },
  {
    id: 'cascadia',
    name: 'Cascadia Mono',
    value: '"Cascadia Mono", Consolas, "Courier New", monospace',
  },
  { id: 'sfmono', name: 'SF Mono', value: '"SFMono-Regular", Menlo, Monaco, monospace' },
  { id: 'consolas', name: 'Consolas', value: 'Consolas, "Liberation Mono", monospace' },
  { id: 'courier', name: 'Courier New', value: '"Courier New", Courier, monospace' },
  { id: 'system-mono', name: '系统等宽', value: 'ui-monospace, monospace' },
]

export type CursorStyle = 'block' | 'bar' | 'underline'

export interface HighlightRule {
  id: string
  name: string
  /** 正则源码（不含首尾斜杠） */
  pattern: string
  tone: HighlightTone
  enabled: boolean
}

export const HIGHLIGHT_TONES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'cyan'] as const
export type HighlightTone = (typeof HIGHLIGHT_TONES)[number]

export const HIGHLIGHT_TONE_LABEL: Record<HighlightTone, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  cyan: '青',
}

/**
 * 高亮底色按主题折算。
 *
 * 为什么不直接让用户填 `#RRGGBB`：装饰是**行底胶带**，文字压在其上，
 * 深色文字配深底、浅色文字配浅底都会糊成一片 ——
 * 用户很难在设置页里同时照顾到自己没在看的另一套主题。
 * 因此这里只给「语义色」，由程序按当前明暗折算成合适的深浅。
 */
const TONE_COLORS: Record<HighlightTone, { light: string; dark: string }> = {
  red: { light: '#ffd8d3', dark: '#5a1d18' },
  orange: { light: '#ffe4c7', dark: '#5c3512' },
  yellow: { light: '#fdf0c0', dark: '#4d3f10' },
  green: { light: '#d5f2d8', dark: '#143d1c' },
  blue: { light: '#d6e6fb', dark: '#153055' },
  purple: { light: '#e8dcfb', dark: '#3a1f5c' },
  cyan: { light: '#cfeef2', dark: '#0f3b42' },
}

export function highlightColor(tone: HighlightTone, mode: 'light' | 'dark'): string {
  return TONE_COLORS[tone][mode]
}

/**
 * 默认高亮规则。
 *
 * `\b` 的坑（踩过一次）：JS 的 `\w` 只含 `[A-Za-z0-9_]`，中文属「非单词字符」，
 * 所以 `\b错误\b` 在「…校验 failed，错误码…」里**永远不匹配** ——
 * 两侧都是非单词字符，压根没有边界。因此中英文必须分开写：
 * 英文靠 `\b` 保证不被 "errors" 这类词误伤，中文直接裸匹配。
 */
export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  {
    id: 'builtin-error',
    name: '错误',
    pattern: '(?:\\b(?:ERROR|FATAL|Exception|Traceback)\\b|错误|异常)',
    tone: 'red',
    enabled: true,
  },
  {
    id: 'builtin-warn',
    name: '警告',
    pattern: '(?:\\b(?:WARN|WARNING)\\b|警告)',
    tone: 'yellow',
    enabled: true,
  },
  {
    id: 'builtin-fail',
    name: '失败',
    pattern: '(?:\\b(?:FAILED|FAIL)\\b|失败|无法|拒绝)',
    tone: 'orange',
    enabled: false,
  },
  {
    id: 'builtin-ok',
    name: '成功',
    pattern: '(?:\\b(?:OK|SUCCESS|Passed)\\b|成功|完成)',
    tone: 'green',
    enabled: false,
  },
]

export interface TerminalAppearance {
  themeId: TerminalThemeId
  fontFamily: string
  fontSize: number
  lineHeight: number
  /** 连字：xterm 仅在支持字符连接器的渲染器下生效 */
  ligatures: boolean
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
}

export const DEFAULT_APPEARANCE: TerminalAppearance = {
  themeId: 'auto',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 13,
  lineHeight: 1.25,
  ligatures: false,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 1000,
}

export interface NotificationSettings {
  /** 桌面通知总开关（浏览器通知中心） */
  desktop: boolean
  /** 站内 Toast 总开关 */
  toast: boolean
  onDisconnect: boolean
  onBatchComplete: boolean
  onTriggerHit: boolean
  /**
   * 插件通知（阶段 9）。
   * 单列一项而不是并进 onTriggerHit：插件的通知既可能来自触发器动作，
   * 也可能来自插件自己的定时检查（心跳失联告警就是后者）。
   * 用户想「关掉插件唠叨但保留触发器提示」时得有办法表达。
   */
  onPluginNotify: boolean
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  desktop: false,
  toast: true,
  onDisconnect: true,
  onBatchComplete: true,
  onTriggerHit: false,
  onPluginNotify: true,
}

export type Locale = 'zh-CN' | 'en-US'

/* ------------------------------------------------------------------ */
/* Store                                                                */
/* ------------------------------------------------------------------ */

interface SettingsState {
  appearance: TerminalAppearance
  notifications: NotificationSettings
  locale: Locale
  highlightRules: HighlightRule[]
  shortcuts: Record<ShortcutActionId, string>
  /** 设置面板是否打开（放 store 里，快捷键与顶栏按钮都能开关它） */
  panelOpen: boolean

  setAppearance: (patch: Partial<TerminalAppearance>) => void
  resetAppearance: () => void
  setNotifications: (patch: Partial<NotificationSettings>) => void
  setLocale: (locale: Locale) => void
  addHighlightRule: (rule: Omit<HighlightRule, 'id'>) => void
  updateHighlightRule: (id: string, patch: Partial<HighlightRule>) => void
  removeHighlightRule: (id: string) => void
  resetHighlightRules: () => void
  setShortcut: (action: ShortcutActionId, keys: string) => void
  resetShortcuts: () => void
  setPanelOpen: (open: boolean) => void
}

function newRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 补齐缺失的动作绑定：老版本 localStorage 里没有新加的快捷键时不能变成 undefined */
function withAllShortcuts(saved: Partial<Record<ShortcutActionId, string>>): Record<ShortcutActionId, string> {
  const result = { ...DEFAULT_SHORTCUTS }
  for (const id of SHORTCUT_ACTION_IDS) {
    const value = saved[id]
    if (typeof value === 'string' && value.trim()) result[id] = value
  }
  return result
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      appearance: DEFAULT_APPEARANCE,
      notifications: DEFAULT_NOTIFICATIONS,
      locale: 'zh-CN',
      highlightRules: DEFAULT_HIGHLIGHT_RULES,
      shortcuts: DEFAULT_SHORTCUTS,
      panelOpen: false,

      setAppearance: (patch) =>
        set((state) => ({ appearance: { ...state.appearance, ...patch } })),
      resetAppearance: () => set({ appearance: DEFAULT_APPEARANCE }),

      setNotifications: (patch) =>
        set((state) => ({ notifications: { ...state.notifications, ...patch } })),

      setLocale: (locale) => set({ locale }),

      addHighlightRule: (rule) =>
        set((state) => {
          if (state.highlightRules.length >= MAX_HIGHLIGHT_RULES) return state
          return { highlightRules: [...state.highlightRules, { ...rule, id: newRuleId() }] }
        }),

      updateHighlightRule: (id, patch) =>
        set((state) => ({
          highlightRules: state.highlightRules.map((rule) =>
            rule.id === id ? { ...rule, ...patch } : rule,
          ),
        })),

      removeHighlightRule: (id) =>
        set((state) => ({ highlightRules: state.highlightRules.filter((rule) => rule.id !== id) })),

      resetHighlightRules: () => set({ highlightRules: DEFAULT_HIGHLIGHT_RULES }),

      setShortcut: (action, keys) =>
        set((state) => ({ shortcuts: { ...state.shortcuts, [action]: keys } })),

      resetShortcuts: () => set({ shortcuts: DEFAULT_SHORTCUTS }),

      setPanelOpen: (open) => set({ panelOpen: open }),
    }),
    {
      name: 'webterm.settings',
      version: 1,
      // panelOpen 是瞬时 UI 状态，不该被持久化
      partialize: (state) => ({
        appearance: state.appearance,
        notifications: state.notifications,
        locale: state.locale,
        highlightRules: state.highlightRules,
        shortcuts: state.shortcuts,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>
        return {
          ...current,
          ...saved,
          appearance: { ...DEFAULT_APPEARANCE, ...(saved.appearance ?? {}) },
          notifications: { ...DEFAULT_NOTIFICATIONS, ...(saved.notifications ?? {}) },
          highlightRules:
            Array.isArray(saved.highlightRules) && saved.highlightRules.length > 0
              ? saved.highlightRules
              : DEFAULT_HIGHLIGHT_RULES,
          shortcuts: withAllShortcuts(saved.shortcuts ?? {}),
        }
      },
    },
  ),
)

/* ------------------------------------------------------------------ */
/* 选择器（多处要读同一份快照，避免每个组件各写一遍）                        */
/* ------------------------------------------------------------------ */

export const useAppearance = (): TerminalAppearance =>
  useSettingsStore((state) => state.appearance)

export const useHighlightRules = (): HighlightRule[] =>
  useSettingsStore((state) => state.highlightRules)

/** 校验正则是否可用；返回错误信息或 null */
export function validateHighlightPattern(pattern: string): string | null {
  if (!pattern.trim()) return '正则不能为空'
  try {
    new RegExp(pattern)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : '正则不合法'
  }
}
