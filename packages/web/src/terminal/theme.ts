/**
 * xterm.js 配色。
 *
 * 说明：xterm 需要的是具体色值，无法直接用 Tailwind 的 CSS 变量类名，
 * 因此这里维护两套主题对象，与页面的明暗模式联动。
 * 配色取自常见终端方案（浅色用 Solarized Light 系，深色用 One Dark 系），
 * 保证 16 色在两种底色下都有足够对比度。
 */
import type { ITheme } from '@xterm/xterm'

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

export function terminalTheme(mode: 'light' | 'dark'): ITheme {
  return mode === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}
