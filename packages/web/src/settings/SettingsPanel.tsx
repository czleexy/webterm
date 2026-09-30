/**
 * 设置面板（阶段 8）：外观 / 高亮 / 快捷键 / 通知 / 语言。
 *
 * 一个刻意的设计：**改任何一项都立即生效，没有「保存」按钮**。
 * 外观类设置（字号、配色）必须所见即所得才调得准；而快捷键、通知这类
 * 「改完要立刻能试」的项目，多一步保存只会让人怀疑到底生效没有。
 * 唯一需要显式动作的是浏览器通知授权 —— 那是用户资产，必须由他主动点。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useThemeStore, type ThemeMode } from '../theme/useTheme'
import {
  FONT_FAMILY_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MAX_HIGHLIGHT_RULES,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  HIGHLIGHT_TONES,
  HIGHLIGHT_TONE_LABEL,
  highlightColor,
  useSettingsStore,
  validateHighlightPattern,
  type CursorStyle,
  type HighlightTone,
  type Locale,
} from '../settings/useSettingsStore'
import {
  TERMINAL_THEME_PRESETS,
  resolveTerminalTheme,
  type TerminalThemeId,
} from '../settings/terminalThemes'
import {
  SHORTCUT_ACTIONS,
  analyzeBindings,
  browserReservedReason,
  formatKeys,
  normalizeKeys,
  type ShortcutActionId,
} from '../settings/shortcuts'
import { useT } from '../i18n'
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '../ui/desktopNotify'
import { cn } from '../utils/cn'

type Tab = 'appearance' | 'highlight' | 'shortcuts' | 'notifications' | 'language'

export function SettingsPanel() {
  const t = useT()
  const open = useSettingsStore((state) => state.panelOpen)
  const setOpen = useSettingsStore((state) => state.setPanelOpen)
  const [tab, setTab] = useState<Tab>('appearance')

  // Esc 关闭；关闭时把面板状态留在当前标签，下次打开回到原处
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const tabs: { id: Tab; label: string }[] = [
    { id: 'appearance', label: t('settings.tab.appearance') },
    { id: 'highlight', label: t('settings.tab.highlight') },
    { id: 'shortcuts', label: t('settings.tab.shortcuts') },
    { id: 'notifications', label: t('settings.tab.notifications') },
    { id: 'language', label: t('settings.tab.language') },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog">
      <div
        data-testid="settings-panel"
        className="flex h-[min(44rem,88vh)] w-[min(56rem,96vw)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {t('settings.title')}
          </h2>
          <button
            type="button"
            data-testid="settings-close"
            onClick={() => setOpen(false)}
            className="rounded px-2 py-0.5 text-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            {t('common.close')}
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`settings-tab-${item.id}`}
                data-active={tab === item.id ? 'true' : 'false'}
                onClick={() => setTab(item.id)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
                  tab === item.id
                    ? 'bg-neutral-900 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {tab === 'appearance' ? <AppearanceTab /> : null}
            {tab === 'highlight' ? <HighlightTab /> : null}
            {tab === 'shortcuts' ? <ShortcutsTab /> : null}
            {tab === 'notifications' ? <NotificationsTab /> : null}
            {tab === 'language' ? <LanguageTab /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 外观                                                                 */
/* ------------------------------------------------------------------ */

function AppearanceTab() {
  const t = useT()
  const mode = useThemeStore((state) => state.mode)
  const setMode = useThemeStore((state) => state.setMode)
  const appearance = useSettingsStore((state) => state.appearance)
  const setAppearance = useSettingsStore((state) => state.setAppearance)
  const resetAppearance = useSettingsStore((state) => state.resetAppearance)

  // 预览用的是「解析后的实际配色」：跟随界面时立刻能看到明暗变化
  const resolvedMode = mode === 'auto' ? (document.documentElement.classList.contains('dark') ? 'dark' : 'light') : mode
  const previewTheme = resolveTerminalTheme(appearance.themeId, resolvedMode)

  const uiModes: { id: ThemeMode; label: string }[] = [
    { id: 'light', label: t('app.theme.light') },
    { id: 'dark', label: t('app.theme.dark') },
    { id: 'auto', label: t('app.theme.auto') },
  ]

  return (
    <div className="space-y-5">
      <Section title={t('settings.uiTheme')}>
        <div className="flex gap-2">
          {uiModes.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`settings-ui-theme-${item.id}`}
              data-active={mode === item.id ? 'true' : 'false'}
              onClick={() => setMode(item.id)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-[12px] transition-colors',
                mode === item.id
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                  : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('settings.terminalTheme')} hint={t('settings.terminalTheme.hint')}>
        <div className="grid grid-cols-3 gap-2">
          {TERMINAL_THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`settings-term-theme-${preset.id}`}
              data-active={appearance.themeId === preset.id ? 'true' : 'false'}
              onClick={() => setAppearance({ themeId: preset.id as TerminalThemeId })}
              className={cn(
                'flex flex-col gap-1.5 rounded-md border p-2 text-left transition-colors',
                appearance.themeId === preset.id
                  ? 'border-neutral-900 ring-1 ring-neutral-900 dark:border-neutral-100 dark:ring-neutral-100'
                  : 'border-neutral-200 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800',
              )}
            >
              <span
                className="flex h-6 items-center gap-1 rounded px-1.5 font-mono text-[10px]"
                style={{ background: preset.preview.background, color: preset.preview.foreground }}
              >
                <span style={{ color: preset.preview.red }}>●</span>
                <span style={{ color: preset.preview.green }}>●</span>
                <span style={{ color: preset.preview.blue }}>●</span>
                <span className="ml-auto truncate">$ ls</span>
              </span>
              <span className="truncate text-[11px] text-neutral-700 dark:text-neutral-300">
                {preset.name}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('settings.preview')}>
        <TerminalPreview />
      </Section>

      <div className="grid grid-cols-2 gap-4">
        <Field label={t('settings.fontFamily')}>
          <select
            data-testid="settings-font-family"
            value={appearance.fontFamily}
            onChange={(e) => setAppearance({ fontFamily: e.target.value })}
            className={SELECT_CLASS}
          >
            {FONT_FAMILY_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.value}>
                {preset.name}
              </option>
            ))}
            {/* 用户可能持久化了一份不在预设里的字族，保留它避免下拉显示成空白 */}
            {FONT_FAMILY_PRESETS.some((p) => p.value === appearance.fontFamily) ? null : (
              <option value={appearance.fontFamily}>自定义</option>
            )}
          </select>
        </Field>

        <Field label={`${t('settings.cursorStyle')}`}>
          <select
            data-testid="settings-cursor-style"
            value={appearance.cursorStyle}
            onChange={(e) => setAppearance({ cursorStyle: e.target.value as CursorStyle })}
            className={SELECT_CLASS}
          >
            <option value="bar">▏bar</option>
            <option value="block">█ block</option>
            <option value="underline">_ underline</option>
          </select>
        </Field>

        <Field label={`${t('settings.fontSize')} · ${appearance.fontSize}px`}>
          <input
            data-testid="settings-font-size"
            type="range"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={appearance.fontSize}
            onChange={(e) => setAppearance({ fontSize: Number(e.target.value) })}
            className={RANGE_CLASS}
          />
        </Field>

        <Field label={`${t('settings.lineHeight')} · ${appearance.lineHeight.toFixed(2)}`}>
          <input
            data-testid="settings-line-height"
            type="range"
            min={LINE_HEIGHT_MIN}
            max={LINE_HEIGHT_MAX}
            step={0.05}
            value={appearance.lineHeight}
            onChange={(e) => setAppearance({ lineHeight: Number(e.target.value) })}
            className={RANGE_CLASS}
          />
        </Field>

        <Field
          label={`${t('settings.scrollback')} · ${appearance.scrollback.toLocaleString()}`}
          hint={t('settings.scrollback.hint')}
        >
          <input
            data-testid="settings-scrollback"
            type="range"
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            step={1000}
            value={appearance.scrollback}
            onChange={(e) => setAppearance({ scrollback: Number(e.target.value) })}
            className={RANGE_CLASS}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Toggle
            testId="settings-ligatures"
            label={t('settings.ligatures')}
            hint={t('settings.ligatures.hint')}
            checked={appearance.ligatures}
            onChange={(value) => setAppearance({ ligatures: value })}
          />
          <Toggle
            testId="settings-cursor-blink"
            label={t('settings.cursor.blink')}
            checked={appearance.cursorBlink}
            onChange={(value) => setAppearance({ cursorBlink: value })}
          />
        </div>
      </div>

      <button
        type="button"
        data-testid="settings-reset-appearance"
        onClick={resetAppearance}
        className="rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {t('settings.resetAppearance')}
      </button>

      {/* 预览块的底色随主题走，方便肉眼确认「UI 与终端是否同步」 */}
      <span className="hidden" data-testid="settings-preview-bg" data-bg={previewTheme.background ?? ''} />
    </div>
  )
}

/** 用当前设置画的假终端：不依赖 xterm，改参数即时可见 */
function TerminalPreview() {
  const mode = useThemeStore((state) => state.mode)
  const appearance = useSettingsStore((state) => state.appearance)
  const resolvedMode =
    mode === 'auto' ? (document.documentElement.classList.contains('dark') ? 'dark' : 'light') : mode
  const theme = resolveTerminalTheme(appearance.themeId, resolvedMode)

  const lines: { segments: { text: string; color?: string; bold?: boolean }[] }[] = [
    { segments: [{ text: 'user@webterm', color: theme.green }, { text: ':' }, { text: '~', color: theme.blue }, { text: '$ ls -al' }] },
    { segments: [{ text: 'total 24', color: theme.brightBlack ?? theme.foreground }] },
    { segments: [{ text: 'drwxr-xr-x  ', color: theme.blue }, { text: '5 user staff  160 Sep 30 10:23 ' }, { text: 'src', color: theme.magenta }] },
    { segments: [{ text: 'ERROR ', color: theme.red, bold: true }, { text: '连接被拒绝：端口 22 未监听', color: theme.yellow }] },
  ]

  return (
    <div
      data-testid="settings-preview"
      data-theme={appearance.themeId}
      className="overflow-hidden rounded-md border border-neutral-200 p-2 dark:border-neutral-700"
      style={{ background: theme.background, color: theme.foreground, lineHeight: appearance.lineHeight }}
    >
      <pre
        className="m-0 whitespace-pre-wrap break-all"
        style={{
          fontFamily: appearance.fontFamily,
          fontSize: `${appearance.fontSize}px`,
          // 连字开关：预览里用 CSS 的 font-variant-ligatures，与 xterm 的字符连接器语义一致
          fontVariantLigatures: appearance.ligatures ? 'contextual' : 'none',
        }}
      >
        {lines.map((line, index) => (
          <div key={index}>
            {line.segments.map((segment, segIndex) => (
              <span
                key={segIndex}
                style={{ color: segment.color, fontWeight: segment.bold ? 700 : undefined }}
              >
                {segment.text}
              </span>
            ))}
          </div>
        ))}
        <span style={{ background: theme.foreground, color: theme.background }}> </span>
      </pre>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 高亮                                                                 */
/* ------------------------------------------------------------------ */

function HighlightTab() {
  const t = useT()
  const rules = useSettingsStore((state) => state.highlightRules)
  const addRule = useSettingsStore((state) => state.addHighlightRule)
  const updateRule = useSettingsStore((state) => state.updateHighlightRule)
  const removeRule = useSettingsStore((state) => state.removeHighlightRule)
  const resetRules = useSettingsStore((state) => state.resetHighlightRules)
  const mode = useThemeStore((state) => state.mode)
  const resolvedMode =
    mode === 'auto' ? (document.documentElement.classList.contains('dark') ? 'dark' : 'light') : mode

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t('settings.highlight.hint')}
      </p>

      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 px-3 py-6 text-center text-[11px] text-neutral-400 dark:border-neutral-700">
          {t('settings.highlight.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, index) => {
            const error = validateHighlightPattern(rule.pattern)
            return (
              <div
                key={rule.id}
                data-testid={`highlight-rule-row-${index}`}
                className="grid grid-cols-[1fr_2fr_auto_auto_auto] items-center gap-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700"
              >
                <input
                  data-testid={`highlight-rule-name-${index}`}
                  value={rule.name}
                  onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                  placeholder={t('settings.highlight.name')}
                  className={INPUT_CLASS}
                />
                <div className="min-w-0">
                  <input
                    data-testid={`highlight-rule-pattern-${index}`}
                    value={rule.pattern}
                    onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
                    placeholder={t('settings.highlight.pattern')}
                    spellCheck={false}
                    aria-invalid={error ? 'true' : 'false'}
                    className={cn(
                      INPUT_CLASS,
                      'font-mono',
                      error ? 'border-red-400 text-red-600 dark:border-red-700 dark:text-red-400' : '',
                    )}
                  />
                  {error ? (
                    <div
                      data-testid={`highlight-rule-error-${index}`}
                      className="mt-0.5 text-[10px] text-red-600 dark:text-red-400"
                    >
                      {t('settings.highlight.invalid')}
                    </div>
                  ) : null}
                </div>
                <select
                  data-testid={`highlight-rule-tone-${index}`}
                  value={rule.tone}
                  onChange={(e) => updateRule(rule.id, { tone: e.target.value as HighlightTone })}
                  className={cn(SELECT_CLASS, 'w-24')}
                  style={{ background: highlightColor(rule.tone, resolvedMode) }}
                >
                  {HIGHLIGHT_TONES.map((tone) => (
                    <option key={tone} value={tone}>
                      {HIGHLIGHT_TONE_LABEL[tone]}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                  <input
                    data-testid={`highlight-rule-enabled-${index}`}
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                  />
                  {t('common.enabled')}
                </label>
                <button
                  type="button"
                  data-testid={`highlight-rule-remove-${index}`}
                  onClick={() => removeRule(rule.id)}
                  className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {t('common.remove')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="highlight-add"
          disabled={rules.length >= MAX_HIGHLIGHT_RULES}
          onClick={() => addRule({ name: '新规则', pattern: '\\b(TODO)\\b', tone: 'blue', enabled: true })}
          className="rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('settings.highlight.add')}
        </button>
        <button
          type="button"
          data-testid="highlight-reset"
          onClick={resetRules}
          className="rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('settings.highlight.reset')}
        </button>
        <span className="ml-auto text-[11px] text-neutral-400">
          {rules.filter((r) => r.enabled).length} / {rules.length}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 快捷键                                                               */
/* ------------------------------------------------------------------ */

function ShortcutsTab() {
  const t = useT()
  const shortcuts = useSettingsStore((state) => state.shortcuts)
  const setShortcut = useSettingsStore((state) => state.setShortcut)
  const resetShortcuts = useSettingsStore((state) => state.resetShortcuts)
  const [recording, setRecording] = useState<ShortcutActionId | null>(null)
  const recordingRef = useRef<ShortcutActionId | null>(null)
  recordingRef.current = recording

  const analysis = useMemo(() => analyzeBindings(shortcuts), [shortcuts])
  const groups = useMemo(() => {
    const map = new Map<string, typeof SHORTCUT_ACTIONS>()
    for (const action of SHORTCUT_ACTIONS) {
      const list = map.get(action.group) ?? []
      list.push(action)
      map.set(action.group, list)
    }
    return [...map.entries()]
  }, [])

  // 录制态：捕获阶段拦下按键，避免真的触发那个动作、也避免浏览器执行默认行为
  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const keys = normalizeKeys(e)
      if (!keys) return // 只按了修饰键，继续等
      const action = recordingRef.current
      if (action) setShortcut(action, keys)
      setRecording(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, setShortcut])

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t('settings.shortcuts.hint')}
      </p>

      {groups.map(([group, actions]) => (
        <div key={group}>
          <div className="mb-1.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
            {group}
          </div>
          <div className="space-y-1">
            {actions.map((action) => {
              const keys = shortcuts[action.id]
              const reserved = analysis.reserved[action.id]
              const conflict = analysis.conflicts.has(action.id)
              return (
                <div
                  key={action.id}
                  data-testid={`shortcut-row-${action.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <span className="w-32 shrink-0 text-[12px] text-neutral-700 dark:text-neutral-300">
                    {action.label}
                  </span>
                  <button
                    type="button"
                    data-testid={`shortcut-bind-${action.id}`}
                    data-recording={recording === action.id ? 'true' : 'false'}
                    onClick={() => setRecording(recording === action.id ? null : action.id)}
                    className={cn(
                      'min-w-28 rounded border px-2 py-0.5 font-mono text-[11px] transition-colors',
                      recording === action.id
                        ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300'
                        : 'border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800',
                    )}
                  >
                    {recording === action.id ? t('settings.shortcuts.press') : formatKeys(keys)}
                  </button>
                  <span
                    data-testid={`shortcut-note-${action.id}`}
                    className="min-w-0 flex-1 truncate text-[10px]"
                  >
                    {reserved ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('settings.shortcuts.reserved', { reason: reserved })}
                      </span>
                    ) : conflict ? (
                      <span className="text-red-600 dark:text-red-400">
                        {t('settings.shortcuts.conflict')}
                      </span>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <button
        type="button"
        data-testid="shortcut-reset"
        onClick={resetShortcuts}
        className="rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {t('settings.shortcuts.reset')}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 通知                                                                 */
/* ------------------------------------------------------------------ */

function NotificationsTab() {
  const t = useT()
  const notifications = useSettingsStore((state) => state.notifications)
  const setNotifications = useSettingsStore((state) => state.setNotifications)
  const [permission, setPermission] = useState<NotificationPermissionState>(() => notificationPermission())

  const permissionLabel =
    permission === 'granted'
      ? t('settings.notify.granted')
      : permission === 'denied'
        ? t('settings.notify.denied')
        : permission === 'unsupported'
          ? t('common.unknown')
          : t('settings.notify.default')

  return (
    <div className="space-y-4">
      <Toggle
        testId="notify-desktop"
        label={t('settings.notify.desktop')}
        hint={t('settings.notify.desktop.hint')}
        checked={notifications.desktop}
        onChange={(value) => setNotifications({ desktop: value })}
      />

      <div className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700">
        <span className="text-[12px] text-neutral-600 dark:text-neutral-300">
          {t('settings.notify.permission')}
        </span>
        <span
          data-testid="notify-permission"
          data-permission={permission}
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px]',
            permission === 'granted'
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
          )}
        >
          {permissionLabel}
        </span>
        {permission === 'default' ? (
          <button
            type="button"
            data-testid="notify-request"
            onClick={() => {
              void requestNotificationPermission().then(setPermission)
            }}
            className="ml-auto rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('settings.notify.request')}
          </button>
        ) : null}
      </div>

      <div className="space-y-2">
        <Toggle
          testId="notify-toast"
          label={t('settings.notify.toast')}
          checked={notifications.toast}
          onChange={(value) => setNotifications({ toast: value })}
        />
        <Toggle
          testId="notify-disconnect"
          label={t('settings.notify.onDisconnect')}
          checked={notifications.onDisconnect}
          onChange={(value) => setNotifications({ onDisconnect: value })}
        />
        <Toggle
          testId="notify-batch"
          label={t('settings.notify.onBatch')}
          checked={notifications.onBatchComplete}
          onChange={(value) => setNotifications({ onBatchComplete: value })}
        />
        <Toggle
          testId="notify-trigger"
          label={t('settings.notify.onTrigger')}
          checked={notifications.onTriggerHit}
          onChange={(value) => setNotifications({ onTriggerHit: value })}
        />
        <Toggle
          testId="notify-plugin"
          label={t('settings.notify.onPlugin')}
          checked={notifications.onPluginNotify}
          onChange={(value) => setNotifications({ onPluginNotify: value })}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 语言                                                                 */
/* ------------------------------------------------------------------ */

function LanguageTab() {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const setLocale = useSettingsStore((state) => state.setLocale)
  const options: { id: Locale; label: string }[] = [
    { id: 'zh-CN', label: t('settings.locale.zh') },
    { id: 'en-US', label: t('settings.locale.en') },
  ]

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t('settings.language.hint')}
      </p>
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            data-testid={`locale-${option.id}`}
            data-active={locale === option.id ? 'true' : 'false'}
            onClick={() => setLocale(option.id)}
            className={cn(
              'flex items-center justify-between rounded-md border px-3 py-2 text-[12px] transition-colors',
              locale === option.id
                ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                : 'border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800',
            )}
          >
            {option.label}
            {locale === option.id ? <span>✓</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 小组件                                                               */
/* ------------------------------------------------------------------ */

const INPUT_CLASS =
  'w-full rounded border border-neutral-200 bg-white px-2 py-1 text-[11px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100'

const SELECT_CLASS =
  'w-full rounded border border-neutral-200 bg-white px-2 py-1 text-[11px] text-neutral-900 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100'

const RANGE_CLASS = 'w-full accent-neutral-700 dark:accent-neutral-300'

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-neutral-800 dark:text-neutral-200">{title}</div>
      {hint ? (
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{hint}</p>
      ) : null}
      {children}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-neutral-600 dark:text-neutral-300">{label}</span>
      {children}
      {hint ? <span className="text-[10px] text-neutral-400">{hint}</span> : null}
    </label>
  )
}

function Toggle({
  testId,
  label,
  hint,
  checked,
  onChange,
}: {
  testId: string
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        data-testid={testId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-neutral-700 dark:accent-neutral-300"
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-neutral-700 dark:text-neutral-300">{label}</span>
        {hint ? <span className="block text-[10px] text-neutral-400">{hint}</span> : null}
      </span>
    </label>
  )
}

/** 供 AppHeader 决定是否显示「浏览器保留」提示用 */
export { browserReservedReason }
