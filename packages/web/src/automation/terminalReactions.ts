/**
 * 触发器命中时的**渲染端**反应。
 *
 * 服务端在命中就地做完了「自动应答 / 执行脚本」这些不需要界面参与的动作，
 * 剩下三件事必须由浏览器完成：把命中行标色、弹系统通知、给终端打标签。
 * 本模块就是这三件事的唯一实现处 —— 之所以单独成文件，是因为它同时需要
 * xterm 实例、主题和 store，塞进 TerminalPane 会让那个组件迅速膨胀，
 * 而塞进 store 又会让 store 反向依赖渲染层。
 *
 * 一个必须坚持的原则：**凡是服务端已经做了的事，界面必须说出来**。
 * 自动应答最危险的失败模式不是「没答」，而是「答了但用户不知道」——
 * 他会以为设备自己按了键。所以只要规则真动了手，就一定要在终端里留一行提示。
 */
import type { Terminal } from '@xterm/xterm'
import type { TriggerHighlightColor, TriggerUiAction } from '@webterm/shared'
import { useThemeStore } from '../theme/useTheme'

/** 命中行的底色与字色（按主题分两套，浅色主题下深底会被暗色文字吃掉） */
interface HighlightPalette {
  background: string
  foreground: string
}

const HIGHLIGHT_PALETTE: Record<'light' | 'dark', Record<TriggerHighlightColor, HighlightPalette>> = {
  light: {
    red: { background: '#fee2e2', foreground: '#991b1b' },
    amber: { background: '#fef3c7', foreground: '#92400e' },
    green: { background: '#dcfce7', foreground: '#166534' },
    blue: { background: '#dbeafe', foreground: '#1e40af' },
  },
  dark: {
    red: { background: '#7f1d1d', foreground: '#fecaca' },
    amber: { background: '#78350f', foreground: '#fde68a' },
    green: { background: '#14532d', foreground: '#bbf7d0' },
    blue: { background: '#1e3a8a', foreground: '#bfdbfe' },
  },
}

/** 提示行用的 ANSI 前景色（用最基础的三色，避免依赖 24 位色支持） */
const NOTICE_ANSI: Record<TriggerHighlightColor, string> = {
  red: '\x1b[1;31m',
  amber: '\x1b[1;33m',
  green: '\x1b[1;32m',
  blue: '\x1b[1;34m',
}

export function highlightPalette(color: TriggerHighlightColor): HighlightPalette {
  const mode = useThemeStore.getState().mode === 'dark' ? 'dark' : 'light'
  return HIGHLIGHT_PALETTE[mode][color]
}

/**
 * 给「刚刚输出的那一行」加底色。
 *
 * 这里有一个无法回避的近似：触发器消息到达时，那一行已经写进 xterm 了，
 * 而 xterm 的 decoration 必须以 marker（锚定注册时刻的光标行）为基准。
 * 服务端是在整行输出完成后才判定命中的，因此此刻光标通常正好在命中行的下一行，
 * 于是用 `cursorYOffset = -1` 作为锚点。
 *
 * 这个近似在两种情况下会偏：一是命中行后面又跟了输出（例如尾行去抖期间），
 * 二是远端正处于备用缓冲区（全屏程序）。前者退化为「标错一行」，不影响使用；
 * 后者 `registerDecoration` 会直接返回 undefined，这里也照常放过 ——
 * 宁可少一个底色，也不能因此打断输出或抛错。
 */
function decorateMatchedLine(term: Terminal, color: TriggerHighlightColor, width: number): void {
  try {
    const marker = term.registerMarker(-1)
    if (!marker) return
    const palette = highlightPalette(color)
    const decoration = term.registerDecoration({
      marker,
      width: Math.max(1, Math.min(width, 500)),
      height: 1,
      backgroundColor: palette.background,
      foregroundColor: palette.foreground,
      layer: 'top',
    })
    if (!decoration) {
      // 备用缓冲区等场景：marker 已经注册上了，不 dispose 会一直挂在缓冲里
      marker.dispose()
    }
  } catch {
    /* decoration 是尽力而为的装饰，任何异常都不该影响终端本身 */
  }
}

/** 浏览器通知：权限没有就安静跳过（不能因为用户拒绝了通知就丢一条命中记录） */
function notify(title: string, body: string): boolean {
  try {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission !== 'granted') return false
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag: 'webterm-trigger' })
    return true
  } catch {
    return false
  }
}

export interface TriggerReactionInput {
  term: Terminal | null
  /** 已剥离 ANSI 的命中整行，用来估算高亮宽度 */
  line: string
  matched: string
  ruleName: string
  ui: TriggerUiAction[]
  /** 服务端已完成的动作摘要 */
  performed: string[]
  /** 是否在终端里追加一行命中提示（由面板上的开关控制） */
  announce: boolean
}

export interface TriggerReactionOutput {
  /** 本次命中实际用到的配色（取第一个 highlight 动作） */
  color: TriggerHighlightColor
  notified: boolean
  labels: string[]
  /** 提示行是否真的写进去了 */
  announced: boolean
}

export function reactToTrigger(input: TriggerReactionInput): TriggerReactionOutput {
  const highlightAction = input.ui.find((a) => a.type === 'highlight')
  const color: TriggerHighlightColor =
    highlightAction && highlightAction.type === 'highlight' ? highlightAction.color : 'amber'

  const labels: string[] = []
  let notified = false

  for (const action of input.ui) {
    if (action.type === 'notify') {
      // 通知正文为空时退化成规则名 —— 一条只有标题的通知毫无信息量
      notified = notify(action.title || 'WebTerm 触发器', action.body || input.ruleName) || notified
    } else if (action.type === 'label') {
      labels.push(action.label)
    }
  }

  const term = input.term
  if (!term) {
    return { color, notified, labels, announced: false }
  }

  if (highlightAction) {
    decorateMatchedLine(term, color, input.line.length)
  }

  let announced = false
  if (input.announce && input.performed.length > 0) {
    const ansi = NOTICE_ANSI[color]
    // 规则名与动作摘要是用户输入拼出来的，可能夹带转义序列 ——
    // 直接写进终端就能伪造颜色甚至清屏，必须先剥掉控制字符
    const detail = sanitizeForNotice(input.performed.join('；'))
    const name = sanitizeForNotice(input.ruleName)
    term.write(`\r\n${ansi}⚡ 触发器「${name}」命中 → ${detail}\x1b[0m\r\n`)
    announced = true
  }

  return { color, notified, labels, announced }
}

/** 提示行文案里出现的转义序列可能被注入（规则名是用户输入），统一剥掉控制字符 */
export function sanitizeForNotice(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, '')
}
