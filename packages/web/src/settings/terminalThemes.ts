/**
 * 终端配色方案（阶段 8）。
 *
 * 与 UI 明暗主题**分离配置**：UI 只有明/暗两套（Tailwind 变量驱动），
 * 而终端配色是用户审美偏好，两者不是一一对应的 ——
 * 有人喜欢浅色界面配 Nord 深色终端，所以这里做成独立可选项。
 *
 * `auto` 是默认值：跟随界面明暗（浅色界面用内置浅色终端，深色界面用内置深色终端），
 * 这样「切主题后 UI 与终端同步生效」对默认用户是自动成立的。
 */
import type { ITheme } from '@xterm/xterm'

/* ------------------------------------------------------------------ */
/* 内置两套（与原阶段 1~7 的配色完全一致，避免既有观感与断言漂移）            */
/* ------------------------------------------------------------------ */

/** 内置浅色终端配色 */
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#fbfbfa',
  foreground: '#2f3337',
  cursor: '#2f3337',
  cursorAccent: '#fbfbfa',
  selectionBackground: '#d5dbe0',
  black: '#2f3337',
  red: '#c0392b',
  green: '#2e7d32',
  yellow: '#a1740b',
  blue: '#1f6feb',
  magenta: '#8b3fa8',
  cyan: '#0e7490',
  white: '#d6d6d3',
  brightBlack: '#6b7280',
  brightRed: '#e04b3a',
  brightGreen: '#3d9140',
  brightYellow: '#c08a11',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855c9',
  brightCyan: '#1592ad',
  brightWhite: '#ffffff',
}

/** 内置深色终端配色（One Dark 系） */
export const DARK_TERMINAL_THEME: ITheme = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0d1117',
  selectionBackground: '#2d3a4a',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
}

/* ------------------------------------------------------------------ */
/* 八套具名配色（取自各方案的官方/社区标准调色板）                          */
/* ------------------------------------------------------------------ */

const DRACULA: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
}

const NORD: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: '#434c5e',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4',
}

const GRUVBOX_DARK: ITheme = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: '#504945',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
}

const MONOKAI: ITheme = {
  background: '#272822',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#272822',
  selectionBackground: '#49483e',
  black: '#272822',
  red: '#f92672',
  green: '#a6e22e',
  yellow: '#f4bf75',
  blue: '#66d9ef',
  magenta: '#ae81ff',
  cyan: '#a1efe4',
  white: '#f8f8f2',
  brightBlack: '#75715e',
  brightRed: '#f92672',
  brightGreen: '#a6e22e',
  brightYellow: '#f4bf75',
  brightBlue: '#66d9ef',
  brightMagenta: '#ae81ff',
  brightCyan: '#a1efe4',
  brightWhite: '#f9f8f5',
}

const TOKYO_NIGHT: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
}

const SOLARIZED_DARK: ITheme = {
  background: '#002b36',
  foreground: '#839496',
  cursor: '#839496',
  cursorAccent: '#002b36',
  selectionBackground: '#073642',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
}

const SOLARIZED_LIGHT: ITheme = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#657b83',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
}

const GITHUB_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#24292f',
  cursorAccent: '#ffffff',
  selectionBackground: '#dbe9f6',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
}

/* ------------------------------------------------------------------ */
/* 元数据与解析                                                          */
/* ------------------------------------------------------------------ */

/** 内置配色 id；`auto` 跟随界面明暗 */
export const TERMINAL_THEME_IDS = [
  'auto',
  'dracula',
  'nord',
  'gruvbox-dark',
  'monokai',
  'tokyo-night',
  'solarized-dark',
  'solarized-light',
  'github-light',
] as const

export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number]

export interface TerminalThemePreset {
  id: TerminalThemeId
  name: string
  /** 卡片预览用的几个代表色 */
  preview: { background: string; foreground: string; red: string; green: string; blue: string }
  /** `auto` 没有固定配色，运行时按界面明暗解析 */
  theme?: ITheme
}

function previewOf(theme: ITheme): TerminalThemePreset['preview'] {
  return {
    background: theme.background ?? '#000000',
    foreground: theme.foreground ?? '#ffffff',
    red: theme.red ?? '#ff0000',
    green: theme.green ?? '#00ff00',
    blue: theme.blue ?? '#0000ff',
  }
}

export const TERMINAL_THEME_PRESETS: TerminalThemePreset[] = [
  { id: 'auto', name: '跟随界面', preview: previewOf(LIGHT_TERMINAL_THEME) },
  { id: 'dracula', name: 'Dracula', preview: previewOf(DRACULA), theme: DRACULA },
  { id: 'nord', name: 'Nord', preview: previewOf(NORD), theme: NORD },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', preview: previewOf(GRUVBOX_DARK), theme: GRUVBOX_DARK },
  { id: 'monokai', name: 'Monokai', preview: previewOf(MONOKAI), theme: MONOKAI },
  { id: 'tokyo-night', name: 'Tokyo Night', preview: previewOf(TOKYO_NIGHT), theme: TOKYO_NIGHT },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    preview: previewOf(SOLARIZED_DARK),
    theme: SOLARIZED_DARK,
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    preview: previewOf(SOLARIZED_LIGHT),
    theme: SOLARIZED_LIGHT,
  },
  { id: 'github-light', name: 'GitHub Light', preview: previewOf(GITHUB_LIGHT), theme: GITHUB_LIGHT },
]

/**
 * 解析出实际要用的 xterm 配色。
 * `auto` / 未知 id 都退化为按界面明暗取内置两套，保证任何情况下都有配色可用。
 */
export function resolveTerminalTheme(id: TerminalThemeId, mode: 'light' | 'dark'): ITheme {
  if (id === 'auto') return mode === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
  const preset = TERMINAL_THEME_PRESETS.find((p) => p.id === id)
  return preset?.theme ?? (mode === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME)
}

/** 兼容阶段 1~7 的调用点 */
export function terminalTheme(mode: 'light' | 'dark'): ITheme {
  return mode === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}
