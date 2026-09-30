/**
 * 关键词高亮（阶段 8）。
 *
 * 实现路径：`registerMarker` + `registerDecoration`（两者都需要
 * `allowProposedApi: true`，见 TerminalPane 里创建 xterm 的说明）。
 *
 * 为什么不用 `registerDecorationProvider`：xterm 6 并没有对外暴露这个 API
 * （仅有 `registerDecoration`）。因此位置由我们自己算：把「行」变成 marker
 * （marker 会跟着内容滚动，行被滚动淘汰时自动失效），再在 marker 上挂一层
 * `layer: 'bottom'` 的装饰当底色 —— 放在底层是有意的：文字压在上面，
 * ANSI 颜色与加粗都保持原样，高亮只负责「让人一眼看到这一行」。
 *
 * 三处必须节制的点：
 * 1. **不全量扫描历史。** 首次挂载从可视区开始，之后只扫新产生的行。
 *    否则一个跑了半小时的日志会话在开启高亮的瞬间会生成几十万个装饰，直接卡死。
 * 2. **装饰有上限。** 命中的行会持续累积，超出上限就不再新增（只提示一次）。
 * 3. **alternate buffer 跳过。** vim / top 用的是备用缓冲区，
 *    在那里铺行底装饰既没意义（屏幕每秒重画）又干扰阅读。
 */
import { useEffect } from 'react'
import type { IDecoration, Terminal } from '@xterm/xterm'
import { highlightColor, type HighlightRule } from '../settings/useSettingsStore'

/** 单个终端最多同时保留的高亮装饰数 */
const MAX_DECORATIONS = 2_000

interface CompiledRule {
  regex: RegExp
  tone: HighlightRule['tone']
}

interface HighlighterOptions {
  term: Terminal | null
  ready: boolean
  rules: HighlightRule[]
  mode: 'light' | 'dark'
  /** 达到上限时的回调（只调一次，避免刷屏） */
  onLimitReached?: () => void
}

export function useTerminalHighlighter({
  term,
  ready,
  rules,
  mode,
  onLimitReached,
}: HighlighterOptions): void {
  useEffect(() => {
    if (!term || !ready) return

    const compiled: CompiledRule[] = []
    for (const rule of rules) {
      if (!rule.enabled || !rule.pattern.trim()) continue
      try {
        compiled.push({ regex: new RegExp(rule.pattern), tone: rule.tone })
      } catch {
        // 用户可能正在编辑一个还没写完的正则，跳过它而不是让整个高亮失效
      }
    }
    if (compiled.length === 0) return

    /** 光标上方的行已定型（内容不会再变）的最大行号；0 是「还没开始」的哨兵 */
    let scannedThrough = -1
    let limitNotified = false
    /** 已定型的装饰，用于卸载时统一释放与计数 */
    const decorations: IDecoration[] = []
    /**
     * 光标所在行的装饰。
     *
     * 单独拿一个变量是因为它**不稳定**：本地回显、`confirm` 那种不换行的提示、
     * 进度条都会持续改写当前行。早先的写法把光标行也算作「已扫描」，
     * 结果这些行永远轮不到被检查 —— `echo ERROR` 这种再普通不过的用例都高亮不出来。
     * 现在每轮都重扫光标行，命中就替换掉上一轮的装饰。
     */
    let pendingDecoration: IDecoration | null = null
    let pendingLine = -1
    let pendingTone: HighlightRule['tone'] | null = null

    const createDecoration = (absoluteLine: number, tone: HighlightRule['tone']): IDecoration | null => {
      const buffer = term.buffer.active
      const cursorAbsolute = buffer.baseY + buffer.cursorY
      // 负数 = 光标上方的行；marker 会随内容滚动自动跟着走
      const marker = term.registerMarker(absoluteLine - cursorAbsolute)
      if (!marker) return null
      const decoration = term.registerDecoration({
        marker,
        layer: 'bottom',
        x: 0,
        width: term.cols,
        backgroundColor: highlightColor(tone, mode),
      })
      if (!decoration) {
        marker.dispose()
        return null
      }
      return decoration
    }

    const atLimit = (): boolean => decorations.length + (pendingDecoration ? 1 : 0) >= MAX_DECORATIONS

    const pushDecoration = (absoluteLine: number, tone: HighlightRule['tone']): void => {
      if (atLimit()) {
        if (!limitNotified) {
          limitNotified = true
          onLimitReached?.()
        }
        return
      }
      const decoration = createDecoration(absoluteLine, tone)
      if (!decoration) return
      decorations.push(decoration)
      decoration.onDispose(() => {
        const index = decorations.indexOf(decoration)
        if (index >= 0) decorations.splice(index, 1)
      })
    }

    /** 该行命中的规则（取第一条命中的） */
    const toneAt = (lineIndex: number): HighlightRule['tone'] | null => {
      const line = term.buffer.active.getLine(lineIndex)
      if (!line) return null
      const text = line.translateToString(true)
      if (!text.trim()) return null
      for (const rule of compiled) {
        if (rule.regex.test(text)) return rule.tone
      }
      return null
    }

    const scan = (): void => {
      const buffer = term.buffer.active
      // 备用缓冲区（vim / top）不做高亮
      if (buffer.type === 'alternate') return

      const cursorAbsolute = buffer.baseY + buffer.cursorY
      if (scannedThrough < 0) {
        // 首次只回看可视区：历史内容如果也要高亮，用户重新搜索比等它卡死更实际
        scannedThrough = Math.max(-1, cursorAbsolute - term.rows - 1)
      }

      // (a) 光标已越过的行：内容不会再变，每行只查一次
      for (let y = scannedThrough + 1; y < cursorAbsolute; y += 1) {
        if (y === pendingLine && pendingDecoration) {
          // 这一行上一轮还是「光标行」，已经铺过底了：收编，不重复铺
          decorations.push(pendingDecoration)
          pendingDecoration = null
          pendingLine = -1
          pendingTone = null
          continue
        }
        const tone = toneAt(y)
        if (tone) pushDecoration(y, tone)
      }
      scannedThrough = Math.max(scannedThrough, cursorAbsolute - 1)

      // (b) 光标所在行：随时可能被改写，每轮重扫
      const tone = toneAt(cursorAbsolute)
      pendingLine = cursorAbsolute
      if (tone === pendingTone && pendingDecoration) return // 情况和上一轮一样，不动它
      if (pendingDecoration) {
        pendingDecoration.dispose()
        pendingDecoration = null
      }
      pendingTone = tone
      if (tone) {
        const decoration = createDecoration(cursorAbsolute, tone)
        if (decoration) pendingDecoration = decoration
      }
    }

    // 每批输出解析完扫一次增量（onWriteParsed 的触发粒度就是「一批」）
    const sub = term.onWriteParsed(scan)

    return () => {
      sub.dispose()
      for (const decoration of decorations) decoration.dispose()
      decorations.length = 0
      pendingDecoration?.dispose()
      pendingDecoration = null
    }
    // rules / mode 变化时整体重建：已铺的装饰按旧配色渲染，重建才能让改色立即生效
  }, [term, ready, rules, mode, onLimitReached])
}
