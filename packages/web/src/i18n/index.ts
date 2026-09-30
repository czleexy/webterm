/**
 * i18n 运行时（阶段 8）。
 *
 * 用法：
 * - 组件里 `const t = useT()`，然后 `t('terminal.search')`
 * - 非组件环境（store / 事件回调）用 `t()`（读当前 locale 快照）
 *
 * 插值用 `{name}` 占位。缺少的键**原样返回键名**而不是抛错或返回空串 ——
 * 开发时一眼能看出漏了哪条，线上也不会因为一个笔误白屏。
 */
import { useCallback } from 'react'
import { useSettingsStore, type Locale } from '../settings/useSettingsStore'
import { DICTIONARIES, type MessageKey } from './dict'

export type TranslateParams = Record<string, string | number>
export type Translate = (key: MessageKey, params?: TranslateParams) => string

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES['zh-CN']
  const raw: string | undefined = dict[key]
  if (raw === undefined) return key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** 组件内使用；locale 变化时重渲染 */
export function useT(): Translate {
  const locale = useSettingsStore((state) => state.locale)
  return useCallback<Translate>((key, params) => translate(locale, key, params), [locale])
}

/** 非组件环境使用（Toast、事件回调等） */
export function t(key: MessageKey, params?: TranslateParams): string {
  return translate(useSettingsStore.getState().locale, key, params)
}

export type { MessageKey }
