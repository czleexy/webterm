/**
 * 全局快捷键注册表（阶段 8）。
 *
 * 两个关键设计决策：
 *
 * 1. **用 `event.code`（物理键）而不是 `event.key` 做匹配。**
 *    `key` 会随键盘布局与 Shift 变化（Shift+1 的 key 是 `!`，中文输入法下更是离谱），
 *    用它做绑定会出现「同一个快捷键在别人的机器上不生效」。`code` 是物理键位，跨布局稳定。
 *    代价是显示时要自己做一次映射（见 CODE_LABEL）。
 *
 * 2. **显式区分「浏览器保留键」。**
 *    计划里写的 `Ctrl+T` / `Ctrl+W` / `Ctrl+Tab` 恰好都是浏览器保留键 ——
 *    网页**无法**用 `preventDefault` 拦截它们（这是浏览器安全边界，不是实现缺陷）。
 *    因此默认绑定一律避开这些组合，同时在设置页给出明确标注，
 *    否则用户会以为是程序没生效而反复重装。
 */

export type ShortcutGroup = '标签' | '布局' | '面板' | '终端'

export interface ShortcutAction {
  id: ShortcutActionId
  label: string
  group: ShortcutGroup
  /** 默认绑定（标准化的 code 组合串） */
  defaultKeys: string
}

export const SHORTCUT_ACTION_IDS = [
  'new-connection',
  'close-tab',
  'next-tab',
  'prev-tab',
  'terminal-search',
  'copy-selection',
  'broadcast-toggle',
  'layout-single',
  'layout-split-2',
  'layout-grid-4',
  'focus-next-pane',
  'focus-prev-pane',
  'open-settings',
  'open-logs',
  'open-automation',
  'open-tunnels',
] as const

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number]

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'new-connection', label: '新建连接', group: '标签', defaultKeys: 'alt+keyt' },
  { id: 'close-tab', label: '关闭当前标签', group: '标签', defaultKeys: 'alt+keyw' },
  { id: 'next-tab', label: '下一个标签', group: '标签', defaultKeys: 'alt+arrowdown' },
  { id: 'prev-tab', label: '上一个标签', group: '标签', defaultKeys: 'alt+arrowup' },
  { id: 'terminal-search', label: '终端搜索', group: '终端', defaultKeys: 'ctrl+keyf' },
  { id: 'copy-selection', label: '复制选中内容', group: '终端', defaultKeys: 'ctrl+insert' },
  { id: 'broadcast-toggle', label: '同步输入开关', group: '终端', defaultKeys: 'alt+keyb' },
  { id: 'layout-single', label: '单格布局', group: '布局', defaultKeys: 'alt+digit1' },
  { id: 'layout-split-2', label: '左右分屏', group: '布局', defaultKeys: 'alt+digit2' },
  { id: 'layout-grid-4', label: '四宫格', group: '布局', defaultKeys: 'alt+digit4' },
  { id: 'focus-next-pane', label: '聚焦下一格', group: '布局', defaultKeys: 'alt+shift+arrowdown' },
  { id: 'focus-prev-pane', label: '聚焦上一格', group: '布局', defaultKeys: 'alt+shift+arrowup' },
  { id: 'open-settings', label: '打开设置', group: '面板', defaultKeys: 'alt+comma' },
  { id: 'open-logs', label: '打开日志与审计', group: '面板', defaultKeys: 'alt+keyl' },
  { id: 'open-automation', label: '打开自动化', group: '面板', defaultKeys: 'alt+keya' },
  { id: 'open-tunnels', label: '打开隧道', group: '面板', defaultKeys: 'alt+keyn' },
]

export const DEFAULT_SHORTCUTS: Record<ShortcutActionId, string> = SHORTCUT_ACTIONS.reduce(
  (acc, action) => {
    acc[action.id] = action.defaultKeys
    return acc
  },
  {} as Record<ShortcutActionId, string>,
)

/** `code` → 显示用的键名 */
const CODE_LABEL: Record<string, string> = {
  keya: 'A', keyb: 'B', keyc: 'C', keyd: 'D', keye: 'E', keyf: 'F', keyg: 'G', keyh: 'H',
  keyi: 'I', keyj: 'J', keyk: 'K', keyl: 'L', keym: 'M', keyn: 'N', keyo: 'O', keyp: 'P',
  keyq: 'Q', keyr: 'R', keys: 'S', keyt: 'T', keyu: 'U', keyv: 'V', keyw: 'W', keyx: 'X',
  keyy: 'Y', keyz: 'Z',
  digit0: '0', digit1: '1', digit2: '2', digit3: '3', digit4: '4',
  digit5: '5', digit6: '6', digit7: '7', digit8: '8', digit9: '9',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  comma: ',', period: '.', slash: '/', semicolon: ';', quote: "'",
  bracketleft: '[', bracketright: ']', backslash: '\\', backquote: '`', minus: '-', equal: '=',
  insert: 'Insert', delete: 'Delete', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', tab: 'Tab', space: 'Space', enter: 'Enter',
  escape: 'Esc', backspace: 'Backspace',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
}

/** 组装标准化的组合串；修饰符顺序固定为 ctrl / alt / shift / meta，便于比较与去重 */
export function normalizeKeys(e: KeyboardEvent): string | null {
  const code = e.code.toLowerCase()
  const modifiers: string[] = []
  if (e.ctrlKey) modifiers.push('ctrl')
  if (e.altKey) modifiers.push('alt')
  if (e.shiftKey) modifiers.push('shift')
  if (e.metaKey) modifiers.push('meta')

  // 只按下修饰键本身：不构成完整绑定
  if (isModifierCode(code)) return null
  // 没有修饰键的裸键会抢走正常打字，不注册（F1~F12 例外，它们本来就是功能键）
  if (modifiers.length === 0 && !code.startsWith('f')) return null

  return [...modifiers, code].join('+')
}

function isModifierCode(code: string): boolean {
  return (
    code === 'controlleft' ||
    code === 'controlright' ||
    code === 'altleft' ||
    code === 'altright' ||
    code === 'shiftleft' ||
    code === 'shiftright' ||
    code === 'metaleft' ||
    code === 'metaright' ||
    code === 'capslock'
  )
}

/** 事件是否命中该绑定 */
export function matchesBinding(keys: string, e: KeyboardEvent): boolean {
  return normalizeKeys(e) === keys
}

/** 绑定串 → 可读文本，例如 `alt+keyt` → `Alt + T` */
export function formatKeys(keys: string): string {
  if (!keys) return '（未绑定）'
  return keys
    .split('+')
    .map((part) => {
      if (part === 'ctrl') return 'Ctrl'
      if (part === 'alt') return 'Alt'
      if (part === 'shift') return 'Shift'
      if (part === 'meta') return 'Meta'
      return CODE_LABEL[part] ?? part
    })
    .join(' + ')
}

/* ------------------------------------------------------------------ */
/* 浏览器保留键检测                                                       */
/* ------------------------------------------------------------------ */

export interface ReservedNotes {
  /** 命中保留键时的原因说明，未命中返回 null */
  reason: string | null
  /** 同一组合是否被两个及以上动作占用 */
  conflict: boolean
}

const CHROME_RESERVED_REASON: Record<string, string> = {
  'ctrl+keyt': '新建标签页',
  'ctrl+keyw': '关闭标签页',
  'ctrl+keyn': '新建窗口',
  'ctrl+shift+keyt': '恢复关闭的标签页',
  'ctrl+shift+keyw': '关闭窗口',
  'ctrl+shift+keyn': '新建无痕窗口',
  'ctrl+tab': '切换标签页',
  'ctrl+shift+tab': '切换标签页（反向）',
  'ctrl+pagedown': '切换标签页',
  'ctrl+pageup': '切换标签页',
  'ctrl+keyl': '聚焦地址栏',
  'ctrl+keyr': '刷新页面',
  'ctrl+shift+keyr': '强制刷新',
  'ctrl+keyp': '打印',
  'ctrl+keys': '保存页面',
  'ctrl+keyd': '加入书签',
  'ctrl+keyh': '历史记录',
  'ctrl+keyj': '下载内容',
  'ctrl+keyo': '打开文件',
  'ctrl+keyu': '查看源代码',
  'ctrl+minus': '缩小页面',
  'ctrl+equal': '放大页面',
  'ctrl+digit0': '重置缩放',
  'ctrl+shift+keyi': '开发者工具',
  'ctrl+shift+keyj': '开发者工具（控制台）',
  'ctrl+shift+keyc': '开发者工具（元素选择）',
  'ctrl+shift+keym': '设备模拟',
  'ctrl+shift+delete': '清除浏览数据',
  'alt+arrowleft': '后退',
  'alt+arrowright': '前进',
  'alt+keyd': '聚焦地址栏',
  'alt+home': '主页',
  'alt+space': '窗口系统菜单',
  f5: '刷新页面',
  f6: '聚焦地址栏',
  f11: '全屏',
  f12: '开发者工具',
}

// Ctrl+1 ~ Ctrl+9：切换第 n 个标签页
for (let i = 1; i <= 9; i += 1) {
  CHROME_RESERVED_REASON[`ctrl+digit${i}`] = `切换到第 ${i} 个标签页`
}

/** 该组合是否会被浏览器抢先处理（网页收不到事件，`preventDefault` 无效） */
export function browserReservedReason(keys: string): string | null {
  return CHROME_RESERVED_REASON[keys] ?? null
}

/** 计算冲突与保留键提示 */
export function analyzeBindings(bindings: Record<ShortcutActionId, string>): {
  reserved: Partial<Record<ShortcutActionId, string>>
  conflicts: Set<ShortcutActionId>
} {
  const reserved: Partial<Record<ShortcutActionId, string>> = {}
  const used = new Map<string, ShortcutActionId[]>()
  for (const id of SHORTCUT_ACTION_IDS) {
    const keys = bindings[id]
    if (!keys) continue
    const reason = browserReservedReason(keys)
    if (reason) reserved[id] = reason
    const list = used.get(keys) ?? []
    list.push(id)
    used.set(keys, list)
  }
  const conflicts = new Set<ShortcutActionId>()
  for (const list of used.values()) {
    if (list.length > 1) for (const id of list) conflicts.add(id)
  }
  return { reserved, conflicts }
}
