/**
 * 脚本编辑器（CodeMirror 6）。
 *
 * 三件事是「能写脚本」和「好写脚本」的分界线，这里都做了：
 *
 * 1. **语法高亮**：用 `@codemirror/lang-javascript`，与运行时同一个语言。
 * 2. **内置 API 补全**：补全项直接来自 shared 的 `SCRIPT_API_DOCS` ——
 *    也就是说**文档即补全**。沙箱里能用的东西只有那几个全局对象，
 *    要是让用户去翻文档猜名字，沙箱的安全性就白做了（他会想办法去 require）。
 *    补全项里带上签名与示例，光标停在方法上就能看到怎么用。
 * 3. **主题跟随**：编辑器是深色还是浅色必须跟着应用走，否则一个亮白方块
 *    嵌在深色界面里非常刺眼。用 Compartment 动态切换，不重建整个编辑器
 *    （重建会丢撤销历史与光标位置）。
 */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import { SCRIPT_API_DOCS, SCRIPT_GLOBAL_NAMES } from '@webterm/shared'
import { useThemeStore } from '../theme/useTheme'

/** 沙箱里可用的全局对象（不含 params —— 那是每次运行注入的上下文，不是常量） */
const GLOBAL_COMPLETIONS: Completion[] = SCRIPT_GLOBAL_NAMES.map((name) => ({
  label: name,
  type: 'variable',
  detail: '沙箱全局',
  info: '脚本沙箱提供的全局对象。沙箱内没有 require / process / fs。',
}))

const API_COMPLETIONS: Completion[] = SCRIPT_API_DOCS.map((doc) => ({
  label: doc.name,
  type: 'method',
  detail: doc.signature,
  info: `${doc.description}${doc.example ? `\n\n示例：\`${doc.example}\`` : ''}`,
}))

const ALL_COMPLETIONS = [...GLOBAL_COMPLETIONS, ...API_COMPLETIONS]

/**
 * 自定义补全源。
 *
 * 用 `[\w$.]*` 而不是默认的「单词」匹配，是为了让 `session.se` 这种
 * 「对象 + 点 + 半截方法名」能整段作为前缀去匹配 `session.send` ——
 * 否则用户敲完点之后补全列表会瞬间清空，反而比没有补全更烦人。
 */
function scriptCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w$.]*/)
  if (!word) return null
  if (word.from === word.to && !context.explicit) return null
  return { from: word.from, options: ALL_COMPLETIONS, validFor: /^[\w$.]*$/ }
}

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7c3aed' },
  { tag: [t.string, t.special(t.string)], color: '#047857' },
  { tag: t.comment, color: '#94a3b8', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: '#b45309' },
  { tag: [t.function(t.variableName), t.propertyName], color: '#1d4ed8' },
  { tag: t.variableName, color: '#0f172a' },
  { tag: t.operator, color: '#475569' },
])

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c4b5fd' },
  { tag: [t.string, t.special(t.string)], color: '#6ee7b7' },
  { tag: t.comment, color: '#64748b', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: '#fdba74' },
  { tag: [t.function(t.variableName), t.propertyName], color: '#93c5fd' },
  { tag: t.variableName, color: '#e2e8f0' },
  { tag: t.operator, color: '#94a3b8' },
])

const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', color: '#0f172a', fontSize: '12px' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', padding: '8px 0' },
    '.cm-gutters': { backgroundColor: '#fafafa', color: '#94a3b8', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#f1f5f9' },
    '.cm-activeLineGutter': { backgroundColor: '#e2e8f0' },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#bfdbfe' },
    '.cm-tooltip': {
      border: '1px solid #e2e8f0',
      backgroundColor: '#ffffff',
      color: '#0f172a',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#e0e7ff',
      color: '#1e1b4b',
    },
  },
  { dark: false },
)

const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#0a0a0a', color: '#e2e8f0', fontSize: '12px' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', padding: '8px 0' },
    '.cm-gutters': { backgroundColor: '#0a0a0a', color: '#525252', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#171717' },
    '.cm-activeLineGutter': { backgroundColor: '#262626' },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#1e40af' },
    '.cm-tooltip': {
      border: '1px solid #404040',
      backgroundColor: '#171717',
      color: '#e2e8f0',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#312e81',
      color: '#e0e7ff',
    },
    '.cm-cursor': { borderLeftColor: '#e2e8f0' },
  },
  { dark: true },
)

function themeExtension(mode: 'light' | 'dark'): Extension {
  return mode === 'dark'
    ? [darkTheme, syntaxHighlighting(darkHighlight)]
    : [lightTheme, syntaxHighlighting(lightHighlight)]
}

interface ScriptEditorProps {
  value: string
  onChange: (value: string) => void
  /** 出错行号（从 1 开始）；有值时在编辑器下方给出提示 */
  errorLine?: number
  errorMessage?: string
  height?: string
  /** 测试用：给编辑器容器一个可定位的钩子 */
  testId?: string
}

export function ScriptEditor({
  value,
  onChange,
  errorLine,
  errorMessage,
  height = '18rem',
  testId = 'script-editor',
}: ScriptEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const mode = useThemeStore((s) => s.mode)

  /* 创建编辑器（仅一次） */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          autocompletion({ override: [scriptCompletionSource] }),
          javascript(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          cmPlaceholder('// 顶层可用 await；沙箱内没有 require / process / fs'),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
          themeCompartment.current.of(
            themeExtension(useThemeStore.getState().mode === 'dark' ? 'dark' : 'light'),
          ),
        ],
      }),
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只跑一次：value 的后续变化由下面的 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 外部（如切换编辑对象）改 value 时同步进编辑器 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    // 用 dispatch 而不是重建 state：重建会把撤销历史一起清掉
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  /* 主题切换：只换 compartment，不动文档 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        themeExtension(mode === 'dark' ? 'dark' : 'light'),
      ),
    })
  }, [mode])

  return (
    <div data-testid={testId}>
      <div
        ref={hostRef}
        style={{ height }}
        className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-700"
      />
      {errorMessage ? (
        <p className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 font-mono text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {errorLine ? `第 ${errorLine} 行：` : ''}
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}
