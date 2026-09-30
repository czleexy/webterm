/**
 * 触发器规则编辑弹窗。
 *
 * 这个弹窗承载了整个阶段 6 里最容易出错的一次输入 —— 一条正则。
 * 因此它做了两件别的地方没做的事：
 *
 * 1. **本地即时语法校验**：正则语法在浏览器和服务端是同一套（都是 JS 引擎），
 *    所以本地 `new RegExp` 的结论与服务端一致，但反馈是零延迟的。
 *    服务端那份 `testTriggerPattern` 依然保留 —— 它多做了「逐行匹配」这一层，
 *    是权威结论；本地校验只负责「别让你按了保存才发现括号没闭合」。
 * 2. **试匹配面板**：贴一段真实设备输出，直接看哪些行会命中、捕获组是什么。
 *    捕获组编号与动作里的 `$1` 一一对应，避免了「数括号数错」这类经典事故。
 *
 * 作用域选择单独占一行并给出解释：会话级规则只影响一个会话，
 * 这在生产环境里是「安全得多」的选项，但用户往往不知道该选哪个。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  TRIGGER_DEFAULT_COOLDOWN_MS,
  TRIGGER_HIGHLIGHT_COLORS,
  TRIGGER_HIGHLIGHT_LABEL,
  TRIGGER_MAX_ACTIONS,
  TRIGGER_MAX_COOLDOWN_MS,
  TRIGGER_MIN_COOLDOWN_MS,
  describeTriggerAction,
  expandCaptureGroups,
  normalizeTriggerFlags,
  type CreateTriggerRequest,
  type TestTriggerResponse,
  type TriggerAction,
  type TriggerHighlightColor,
  type TriggerMatchMode,
  type TriggerRule,
  type TriggerScope,
} from '@webterm/shared'
import { testTrigger } from '../api/client'
import { useLibraryStore } from '../store/useLibraryStore'
import { useAutomationStore } from '../store/useAutomationStore'
import { usePluginStore } from '../store/usePluginStore'
import {
  Chip,
  hintClass,
  inputClass,
  labelClass,
  monoInputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui'

interface TriggerDialogProps {
  /** undefined = 新建 */
  editing?: TriggerRule
  onClose: () => void
  onSaved: () => void
}

interface FormState {
  name: string
  scope: TriggerScope
  sessionId: string
  matchMode: TriggerMatchMode
  pattern: string
  flags: string
  cooldownMs: string
  actions: TriggerAction[]
}

function formOf(rule?: TriggerRule): FormState {
  if (!rule) {
    return {
      name: '',
      scope: 'global',
      sessionId: '',
      matchMode: 'regex',
      pattern: '',
      flags: '',
      cooldownMs: String(TRIGGER_DEFAULT_COOLDOWN_MS),
      actions: [],
    }
  }
  return {
    name: rule.name,
    scope: rule.scope,
    sessionId: rule.sessionId ?? '',
    matchMode: rule.matchMode,
    pattern: rule.pattern,
    flags: rule.flags,
    cooldownMs: String(rule.cooldownMs),
    actions: rule.actions.map((a) => ({ ...a })),
  }
}

/** 本地语法校验：只判正则合法性与修饰符，不碰匹配结果 */
function localPatternError(mode: TriggerMatchMode, pattern: string, flags: string): string | null {
  if (mode === 'text') return null
  if (pattern === '') return null
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function TriggerDialog({ editing, onClose, onSaved }: TriggerDialogProps) {
  const nodes = useLibraryStore((s) => s.nodes)
  const scripts = useAutomationStore((s) => s.scripts)
  const capabilities = useAutomationStore((s) => s.capabilities)
  const plugins = usePluginStore((s) => s.plugins)

  const [form, setForm] = useState<FormState>(() => formOf(editing))
  const [sample, setSample] = useState('')
  const [tested, setTested] = useState<TestTriggerResponse | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 只有真的会渲染会话列表时才需要它
  useEffect(() => {
    if (nodes.length === 0) void useLibraryStore.getState().refresh()
  }, [nodes.length])

  const sessionOptions = useMemo(
    () => nodes.filter((n) => n.kind === 'session' && n.session),
    [nodes],
  )

  const flagChars = capabilities?.supportedTriggerFlagChars ?? ['i', 'm', 's', 'u']

  /**
   * 插件注册的触发器动作（阶段 9）。
   *
   * 只取 `state === 'ready'` 的插件：加载失败或已停用的插件注册项在服务端
   * 就已经是空的了，这里再过滤一次是为了不把「上一秒的旧快照」渲染进下拉 ——
   * 让用户选到一个选了也执行不了的动作，是最坏的一种「假可选」。
   */
  const pluginActions = useMemo(
    () =>
      plugins
        .filter((p) => p.state === 'ready')
        .flatMap((p) =>
          p.triggerActions.map((action) => ({
            pluginId: p.id,
            pluginName: p.name,
            actionId: action.id,
            label: action.label,
            description: action.description,
          })),
        ),
    [plugins],
  )
  const pluginActionKey = (pluginId: string, actionId: string) => `${pluginId}::${actionId}`

  const patternError = localPatternError(form.matchMode, form.pattern, form.flags)

  // 换了模式/模式串/修饰符，之前的试匹配结论就作废了 ——
  // 留着它会让用户看着「0 处命中」却不知道那是旧结果
  useEffect(() => {
    setTested(null)
  }, [form.matchMode, form.pattern, form.flags])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const patchAction = (index: number, patch: Partial<TriggerAction>) => {
    setForm((prev) => ({
      ...prev,
      actions: prev.actions.map((a, i) => (i === index ? ({ ...a, ...patch } as TriggerAction) : a)),
    }))
  }

  const addAction = (type: TriggerAction['type']) => {
    if (form.actions.length >= TRIGGER_MAX_ACTIONS) return
    // 插件动作要带「是哪个插件的哪个动作」：默认取第一个可用的，
    // 让用户先看到一条完整的动作再改，比让他面对一个空的三个下拉好
    const firstPluginAction = pluginActions[0]
    const fresh: TriggerAction =
      type === 'send'
        ? { type: 'send', text: '' }
        : type === 'highlight'
          ? { type: 'highlight', color: 'amber' }
          : type === 'notify'
            ? { type: 'notify', title: '', body: '' }
            : type === 'label'
              ? { type: 'label', label: '' }
              : type === 'plugin'
                ? {
                    type: 'plugin',
                    pluginId: firstPluginAction?.pluginId ?? '',
                    actionId: firstPluginAction?.actionId ?? '',
                    ...(firstPluginAction ? { label: firstPluginAction.label } : {}),
                  }
                : { type: 'script', scriptId: scripts[0]?.id ?? '' }
    setForm((prev) => ({ ...prev, actions: [...prev.actions, fresh] }))
  }

  const runTest = async () => {
    if (sample.trim() === '') {
      setError('请先贴一段样例输出再试匹配')
      return
    }
    setTesting(true)
    setError(null)
    try {
      const result = await testTrigger({
        pattern: form.pattern,
        matchMode: form.matchMode,
        flags: form.flags,
        sample,
      })
      setTested(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (patternError) return
    if (form.scope === 'session' && !form.sessionId) {
      setError('会话级规则必须选择目标会话')
      return
    }
    const cooldown = Number(form.cooldownMs)
    if (!Number.isFinite(cooldown) || cooldown < TRIGGER_MIN_COOLDOWN_MS || cooldown > TRIGGER_MAX_COOLDOWN_MS) {
      setError(`冷却时间需要在 ${TRIGGER_MIN_COOLDOWN_MS}~${TRIGGER_MAX_COOLDOWN_MS} 毫秒之间`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body: CreateTriggerRequest = {
        name: form.name.trim() || '未命名规则',
        scope: form.scope,
        sessionId: form.scope === 'session' ? form.sessionId : null,
        matchMode: form.matchMode,
        pattern: form.pattern,
        flags: normalizeTriggerFlags(form.flags),
        cooldownMs: cooldown,
        actions: form.actions,
      }
      if (editing) {
        await useAutomationStore.getState().saveTrigger(editing.id, body)
      } else {
        await useAutomationStore.getState().createTrigger(body)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /** 第一个命中行的捕获组展开预览，用来验证 `$1` 写得对不对 */
  const previewExpansion = useMemo(() => {
    const first = tested?.matches[0]
    if (!first) return null
    const sendAction = form.actions.find((a) => a.type === 'send')
    if (!sendAction || sendAction.type !== 'send') return null
    // 复用 shared 的实现：与服务端 runAction 里用的是同一个函数，不会出现「预览对、实际错」
    const match = [first.matched, ...first.groups.slice(1)] as unknown as RegExpExecArray
    return expandCaptureGroups(sendAction.text, match)
  }, [form.actions, tested])

  return (
    <div
      data-testid="trigger-dialog"
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-3xl rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {editing ? `编辑规则：${editing.name}` : '新建触发器规则'}
          </h3>
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            取消
          </button>
        </div>

        <div className="max-h-[62vh] space-y-4 overflow-y-auto p-4">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : null}

          {/* ---------- 基本信息 ---------- */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>规则名称</label>
              <input
                data-testid="trigger-name"
                className={inputClass}
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="例如：确认提示自动应答"
              />
            </div>
            <div>
              <label className={labelClass}>冷却时间（毫秒）</label>
              <input
                data-testid="trigger-cooldown"
                type="number"
                min={TRIGGER_MIN_COOLDOWN_MS}
                max={TRIGGER_MAX_COOLDOWN_MS}
                className={inputClass}
                value={form.cooldownMs}
                onChange={(e) => setField('cooldownMs', e.target.value)}
              />
              <p className={hintClass}>
                同一规则在这个时间内最多触发一次。分页提示会在一屏里出现多次，冷却能避免连发。
              </p>
            </div>
          </div>

          {/* ---------- 作用域 ---------- */}
          <div>
            <label className={labelClass}>作用域</label>
            <div className="flex items-center gap-2">
              <select
                data-testid="trigger-scope"
                className={inputClass}
                value={form.scope}
                onChange={(e) => setField('scope', e.target.value as TriggerScope)}
              >
                <option value="global">全局（对所有会话生效）</option>
                <option value="session">仅指定会话</option>
              </select>
              {form.scope === 'session' ? (
                <select
                  data-testid="trigger-session"
                  className={inputClass}
                  value={form.sessionId}
                  onChange={(e) => setField('sessionId', e.target.value)}
                >
                  <option value="">请选择会话…</option>
                  {sessionOptions.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <p className={hintClass}>
              {form.scope === 'global'
                ? '全局规则对每一个新建立的会话都生效 —— 包括你只是随手连上去看一眼的那台设备。'
                : '会话级规则只对这一个会话库节点生效，是更安全的选择。'}
            </p>
          </div>

          {/* ---------- 匹配 ---------- */}
          <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex items-center gap-2">
              <select
                data-testid="trigger-match-mode"
                className={`${inputClass} w-32`}
                value={form.matchMode}
                onChange={(e) => setField('matchMode', e.target.value as TriggerMatchMode)}
              >
                <option value="regex">正则</option>
                <option value="text">纯文本包含</option>
              </select>
              <input
                data-testid="trigger-pattern"
                className={monoInputClass}
                value={form.pattern}
                onChange={(e) => setField('pattern', e.target.value)}
                placeholder={form.matchMode === 'regex' ? '(yes/no)?' : '(yes/no)? '}
              />
            </div>

            {form.matchMode === 'regex' ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">修饰符</span>
                {flagChars.map((char) => (
                  <label
                    key={char}
                    className="flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300"
                  >
                    <input
                      type="checkbox"
                      data-testid={`trigger-flag-${char}`}
                      checked={form.flags.includes(char)}
                      onChange={(e) => {
                        const next = new Set(form.flags.split(''))
                        if (e.target.checked) next.add(char)
                        else next.delete(char)
                        setField('flags', [...next].join(''))
                      }}
                    />
                    <span className="font-mono">{char}</span>
                  </label>
                ))}
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  （g / y 被刻意排除：它们会让正则带状态，出现「时灵时不灵」）
                </span>
              </div>
            ) : (
              <p className={hintClass}>
                设备提示串里满是需要转义的字符（<code className="font-mono">(yes/no)?</code> 是典型），
                纯文本模式帮你避开这件事。勾选 <span className="font-mono">i</span> 可忽略大小写。
              </p>
            )}

            {patternError ? (
              <div
                data-testid="trigger-pattern-error"
                className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 font-mono text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              >
                正则语法错误：{patternError}
              </div>
            ) : (
              <p className={hintClass}>
                实际匹配：<span className="font-mono">{form.matchMode === 'text'
                  ? `包含「${form.pattern}」`
                  : `/${form.pattern}/${normalizeTriggerFlags(form.flags)}`}</span>
              </p>
            )}
          </div>

          {/* ---------- 动作 ---------- */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className={labelClass}>命中后执行的动作</label>
              <div className="flex items-center gap-1">
                {(['send', 'highlight', 'notify', 'label', 'script', 'plugin'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    data-testid={`trigger-add-action-${type}`}
                    onClick={() => addAction(type)}
                    disabled={
                      form.actions.length >= TRIGGER_MAX_ACTIONS ||
                      // 没有任何插件注册动作时不给点：点了只会多出一个空动作
                      (type === 'plugin' && pluginActions.length === 0)
                    }
                    title={
                      type === 'plugin' && pluginActions.length === 0
                        ? '当前没有已加载的插件注册触发器动作（可在顶栏「插件」里查看）'
                        : undefined
                    }
                    className={secondaryButtonClass}
                  >
                    + {ACTION_LABEL[type]}
                  </button>
                ))}
              </div>
            </div>

            {form.actions.length === 0 ? (
              <p className={hintClass}>
                还没有动作。没有动作的规则只会消耗 CPU —— 命中之后什么都不会发生。
              </p>
            ) : (
              <ul className="space-y-2">
                {form.actions.map((action, index) => (
                  <li
                    key={index}
                    className="rounded-md border border-neutral-200 p-2.5 dark:border-neutral-800"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <Chip tone="blue">{ACTION_LABEL[action.type]}</Chip>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                          {describeTriggerAction(action)}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              actions: prev.actions.filter((_, i) => i !== index),
                            }))
                          }
                          className="text-[11px] text-red-600 hover:underline dark:text-red-400"
                        >
                          移除
                        </button>
                      </div>
                    </div>

                    {action.type === 'send' ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            data-testid={`trigger-action-send-text-${index}`}
                            className={monoInputClass}
                            value={action.text}
                            onChange={(e) => patchAction(index, { text: e.target.value })}
                            placeholder="yes"
                          />
                          <label className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                            <input
                              type="checkbox"
                              checked={action.enter !== false}
                              onChange={(e) => patchAction(index, { enter: e.target.checked })}
                            />
                            追加回车
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                            延迟
                          </span>
                          <input
                            type="number"
                            min={0}
                            className={`${inputClass} w-24`}
                            value={action.delayMs ?? 0}
                            onChange={(e) =>
                              patchAction(index, { delayMs: Number(e.target.value) || 0 })
                            }
                          />
                          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                            毫秒（等对端真正进入提示态再发）
                          </span>
                        </div>
                        <p className={hintClass}>
                          文本里可用 <span className="font-mono">$0</span>（整个匹配）与{' '}
                          <span className="font-mono">$1</span>…
                          <span className="font-mono">$9</span>（第 n 个捕获组）引用命中内容。
                        </p>
                      </div>
                    ) : null}

                    {action.type === 'highlight' ? (
                      <select
                        data-testid={`trigger-action-highlight-color-${index}`}
                        className={inputClass}
                        value={action.color ?? 'amber'}
                        onChange={(e) =>
                          patchAction(index, { color: e.target.value as TriggerHighlightColor })
                        }
                      >
                        {TRIGGER_HIGHLIGHT_COLORS.map((color) => (
                          <option key={color} value={color}>
                            {TRIGGER_HIGHLIGHT_LABEL[color]}
                          </option>
                        ))}
                      </select>
                    ) : null}

                    {action.type === 'notify' ? (
                      <div className="space-y-2">
                        <input
                          className={inputClass}
                          value={action.title ?? ''}
                          onChange={(e) => patchAction(index, { title: e.target.value })}
                          placeholder="通知标题"
                        />
                        <input
                          className={inputClass}
                          value={action.body ?? ''}
                          onChange={(e) => patchAction(index, { body: e.target.value })}
                          placeholder="通知内容（同样支持 $1 捕获组）"
                        />
                        <p className={hintClass}>
                          需要浏览器通知权限；未授权时命中记录照常保留，只是不会弹窗。
                        </p>
                      </div>
                    ) : null}

                    {action.type === 'label' ? (
                      <input
                        data-testid={`trigger-action-label-${index}`}
                        className={inputClass}
                        value={action.label}
                        onChange={(e) => patchAction(index, { label: e.target.value })}
                        placeholder="例如：已登录"
                      />
                    ) : null}

                    {action.type === 'script' ? (
                      <div>
                        <select
                          data-testid={`trigger-action-script-${index}`}
                          className={inputClass}
                          value={action.scriptId}
                          onChange={(e) => patchAction(index, { scriptId: e.target.value })}
                        >
                          <option value="">请选择脚本…</option>
                          {scripts.map((script) => (
                            <option key={script.id} value={script.id}>
                              {script.name}
                            </option>
                          ))}
                        </select>
                        {scripts.length === 0 ? (
                          <p className={hintClass}>还没有脚本，请先到「脚本」分区创建一个。</p>
                        ) : (
                          <p className={hintClass}>
                            脚本通过 <span className="font-mono">params.trigger</span>{' '}
                            拿到命中行、匹配片段与捕获组。
                          </p>
                        )}
                      </div>
                    ) : null}

                    {action.type === 'plugin' ? (
                      <div className="space-y-2">
                        <select
                          data-testid={`trigger-action-plugin-${index}`}
                          className={inputClass}
                          value={
                            pluginActions.some(
                              (o) =>
                                o.pluginId === action.pluginId && o.actionId === action.actionId,
                            )
                              ? pluginActionKey(action.pluginId, action.actionId)
                              : ''
                          }
                          onChange={(e) => {
                            const picked = pluginActions.find(
                              (o) => pluginActionKey(o.pluginId, o.actionId) === e.target.value,
                            )
                            if (!picked) return
                            patchAction(index, {
                              pluginId: picked.pluginId,
                              actionId: picked.actionId,
                              label: picked.label,
                            })
                          }}
                        >
                          <option value="">请选择插件动作…</option>
                          {pluginActions.map((option) => (
                            <option
                              key={pluginActionKey(option.pluginId, option.actionId)}
                              value={pluginActionKey(option.pluginId, option.actionId)}
                            >
                              {option.pluginName} · {option.label}
                            </option>
                          ))}
                        </select>

                        {/* 动作指向的插件被卸载 / 停用时，必须当场说清楚，而不是等命中才发现 */}
                        {action.pluginId !== '' &&
                        !pluginActions.some(
                          (o) => o.pluginId === action.pluginId && o.actionId === action.actionId,
                        ) ? (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            引用的插件动作当前不可用（插件「{action.pluginId}」可能已停用、卸载或更新）。
                            规则仍可保存，命中时会记录失败原因。
                          </p>
                        ) : null}

                        <input
                          data-testid={`trigger-action-plugin-params-${index}`}
                          className={monoInputClass}
                          value={action.params ?? ''}
                          onChange={(e) => patchAction(index, { params: e.target.value })}
                          placeholder="可选：传给插件的参数（原样字符串，语义由插件定义）"
                        />

                        <p className={hintClass}>
                          {pluginActions.find(
                            (o) => o.pluginId === action.pluginId && o.actionId === action.actionId,
                          )?.description ??
                            '插件动作在服务端执行；插件内部的失败会记进插件日志并发出通知，不会影响终端输出。'}
                        </p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---------- 试匹配 ---------- */}
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950/40">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
                试匹配（把一段真实设备输出贴进来）
              </span>
              <button
                type="button"
                data-testid="trigger-run-test"
                onClick={() => void runTest()}
                disabled={testing || Boolean(patternError)}
                className={secondaryButtonClass}
              >
                {testing ? '匹配中…' : '试匹配'}
              </button>
            </div>
            <textarea
              data-testid="trigger-test-sample"
              className={`${monoInputClass} h-20 resize-y`}
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder={'Are you sure? (yes/no)? \nWarning: code=5001 disk0 failed'}
            />

            {tested ? (
              <div className="mt-2 space-y-2" data-testid="trigger-test-result">
                {!tested.valid ? (
                  <p className="font-mono text-[11px] text-red-600 dark:text-red-400">
                    {tested.error}
                  </p>
                ) : tested.matches.length === 0 ? (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    没有一行命中。注意匹配是<b>按行</b>进行的 —— 跨行的内容不会被匹配到。
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                      {tested.matches.length} 行命中
                    </p>
                    <ul className="space-y-1">
                      {tested.matches.slice(0, 8).map((m) => (
                        <li
                          key={m.line}
                          className="rounded border border-neutral-200 bg-white px-2 py-1 text-[11px] dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          <div className="flex items-center gap-2">
                            <Chip>{`行 ${m.line}`}</Chip>
                            <code className="min-w-0 flex-1 truncate font-mono text-neutral-700 dark:text-neutral-300">
                              {m.text}
                            </code>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Chip tone="violet" title="整个匹配，动作里用 $0 引用">
                              $0 = {JSON.stringify(m.matched)}
                            </Chip>
                            {m.groups.slice(1).map((group, gi) => (
                              <Chip key={gi} tone="blue" title={`第 ${gi + 1} 个捕获组`}>
                                {`$${gi + 1} = ${JSON.stringify(group)}`}
                              </Chip>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {previewExpansion !== null ? (
                      <p className="text-[11px] text-neutral-600 dark:text-neutral-300">
                        第一条命中将发送：
                        <code className="ml-1 font-mono text-neutral-900 dark:text-neutral-100">
                          {JSON.stringify(previewExpansion)}
                        </code>
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              <p className={hintClass}>
                试匹配只看模式本身能不能命中，与冷却时间无关。样例输出可以贴多行，服务端会逐行尝试。
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            最多 {TRIGGER_MAX_ACTIONS} 个动作
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={secondaryButtonClass}>
              取消
            </button>
            <button
              type="button"
              data-testid="trigger-save"
              onClick={() => void save()}
              disabled={saving || Boolean(patternError)}
              className={primaryButtonClass}
            >
              {saving ? '保存中…' : editing ? '保存修改' : '创建规则'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const ACTION_LABEL: Record<TriggerAction['type'], string> = {
  send: '自动应答',
  highlight: '高亮',
  notify: '通知',
  label: '标签',
  script: '脚本',
  plugin: '插件动作',
}
