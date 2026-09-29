/**
 * 脚本分区：编辑器 + 运行面板 + API 速查。
 *
 * 关于「脚本绑定」的一件事必须在界面上说清楚：脚本有三种被调用的方式 ——
 * 手动运行、随会话自动运行（`runOnConnect`）、被触发器动作调用。
 * 后两种都不是从这个面板发起的，所以列表上要明确标出「随会话运行」这条绑定，
 * 否则用户会奇怪「我设置的那段检查逻辑怎么从来没跑过」。
 *
 * 运行采用「提交 + 推送」而不是「请求-响应」：脚本可能跑几十秒，
 * 期间要逐条看到 log 输出，用一个挂着不返回的 HTTP 请求来承载体验很差。
 * 因此这里只做提交，日志从 useAutomationStore 的实时状态里读。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  SCRIPT_API_DOCS,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_MAX_TIMEOUT_MS,
  type ScriptDefinition,
} from '@webterm/shared'
import { runScript, validateScript } from '../api/client'
import { useAutomationStore } from '../store/useAutomationStore'
import { useTerminalStore } from '../store/useTerminalStore'
import { ScriptEditor } from './ScriptEditor'
import {
  Chip,
  EmptyState,
  SectionHeader,
  dangerButtonClass,
  hintClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui'

const STARTER_CODE = `// 沙箱内可用的全局对象：session / sftp / log / console / sleep / target / params
// 顶层可以直接用 await。没有 require、process、fs。
log('开始执行，目标：' + target.host)

const out = await session.run('df -h')
log(out)

return { host: target.host, lines: out.split('\\n').length }`

export function ScriptSection() {
  const scripts = useAutomationStore((s) => s.scripts)
  const liveRuns = useAutomationStore((s) => s.liveRuns)
  const runs = useAutomationStore((s) => s.runs)
  const setError = useAutomationStore((s) => s.setError)
  const tabs = useTerminalStore((s) => s.tabs)

  const [editing, setEditing] = useState<ScriptDefinition | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(String(SCRIPT_DEFAULT_TIMEOUT_MS))
  const [runOnConnect, setRunOnConnect] = useState(false)
  const [code, setCode] = useState(STARTER_CODE)
  const [saving, setSaving] = useState(false)
  const [syntaxIssue, setSyntaxIssue] = useState<{ line?: number; message: string } | null>(null)
  const [targetTabId, setTargetTabId] = useState('')
  const [showDocs, setShowDocs] = useState(false)

  useEffect(() => {
    if (scripts.length === 0) void useAutomationStore.getState().refreshScripts()
    void useAutomationStore.getState().refreshRuns()
  }, [scripts.length])

  const runnable = useMemo(() => tabs.filter((t) => Boolean(t.terminalId)), [tabs])

  useEffect(() => {
    if (targetTabId && !runnable.some((t) => t.id === targetTabId)) setTargetTabId('')
    if (!targetTabId && runnable.length > 0) setTargetTabId(runnable[0]?.id ?? '')
  }, [runnable, targetTabId])

  const resetForm = () => {
    setEditing(null)
    setName('')
    setDescription('')
    setTimeoutMs(String(SCRIPT_DEFAULT_TIMEOUT_MS))
    setRunOnConnect(false)
    setCode(STARTER_CODE)
    setSyntaxIssue(null)
  }

  const startEdit = (script: ScriptDefinition) => {
    setEditing(script)
    setName(script.name)
    setDescription(script.description)
    setTimeoutMs(String(script.timeoutMs))
    setRunOnConnect(script.runOnConnect)
    setCode(script.code)
    setSyntaxIssue(null)
  }

  const save = async () => {
    if (name.trim() === '') {
      setError('脚本名称不能为空')
      return
    }
    const timeout = Number(timeoutMs)
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > SCRIPT_MAX_TIMEOUT_MS) {
      setError(`超时需要在 1000~${SCRIPT_MAX_TIMEOUT_MS} 毫秒之间`)
      return
    }
    setSaving(true)
    setError(null)
    setSyntaxIssue(null)
    try {
      // 先本地问一次服务端的语法校验接口：服务端会用与运行**完全相同**的包装去编译，
      // 所以这一步过了，运行前的编译就一定不会再报语法错
      const result = await validateScript(code)
      if (!result.ok) {
        setSyntaxIssue({ line: result.line, message: result.error ?? '语法错误' })
        setSaving(false)
        return
      }
      const body = {
        name: name.trim(),
        description: description.trim(),
        code,
        timeoutMs: timeout,
        runOnConnect,
      }
      if (editing) await useAutomationStore.getState().saveScript(editing.id, body)
      else await useAutomationStore.getState().createScript(body)
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /** 在选中终端上提交一次运行（可以跑已保存的脚本，也可以跑编辑器里这份未保存的草稿） */
  const submit = async (script: ScriptDefinition | null) => {
    const tab = runnable.find((t) => t.id === targetTabId)
    if (!tab?.terminalId) {
      setError('请先选择一个已连接的终端作为运行目标')
      return
    }
    setError(null)
    try {
      if (script) {
        await runScript({ terminalId: tab.terminalId, scriptId: script.id })
      } else {
        await runScript({ terminalId: tab.terminalId, code, timeoutMs: Number(timeoutMs) })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 只显示当前选中终端上的运行记录 —— 混着显示会让人分不清输出来自哪台机器 */
  const visibleRuns = useMemo(() => {
    const tab = runnable.find((t) => t.id === targetTabId)
    if (!tab?.terminalId) return []
    return liveRuns.filter((r) => r.tabId === tab.id)
  }, [liveRuns, runnable, targetTabId])

  const selectedRun = visibleRuns[0]

  return (
    <div className="space-y-4">
      <SectionHeader
        title="脚本"
        description="在受控沙箱里运行 JavaScript，通过注入的 session / sftp API 操作会话。没有 require、process、fs；超时会被强制中断。"
      >
        {runnable.length > 0 ? (
          <select
            data-testid="script-target"
            className={`${inputClass} w-48`}
            value={targetTabId}
            onChange={(e) => setTargetTabId(e.target.value)}
          >
            {runnable.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          data-testid="script-docs-toggle"
          onClick={() => setShowDocs((v) => !v)}
          className={secondaryButtonClass}
        >
          {showDocs ? '收起 API 速查' : 'API 速查'}
        </button>
        <button type="button" onClick={resetForm} className={secondaryButtonClass}>
          新建脚本
        </button>
      </SectionHeader>

      {showDocs ? (
        <div
          data-testid="script-docs"
          className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950/40"
        >
          <p className="mb-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            沙箱内没有 <code className="font-mono">require</code> /{' '}
            <code className="font-mono">process</code> / <code className="font-mono">fs</code>，
            也没有 <code className="font-mono">eval</code> 与{' '}
            <code className="font-mono">new Function</code>。可用的全局对象只有下面这些。
          </p>
          <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto">
            {SCRIPT_API_DOCS.map((doc) => (
              <div key={doc.name} className="text-[11px]">
                <code className="font-mono font-medium text-neutral-900 dark:text-neutral-100">
                  {doc.name}
                </code>
                <p className="font-mono text-[10px] text-sky-700 dark:text-sky-400">
                  {doc.signature}
                </p>
                <p className="text-neutral-600 dark:text-neutral-400">{doc.description}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ---------- 编辑器 ---------- */}
      <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            {editing ? `编辑脚本：${editing.name}` : '新建脚本'}
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                data-testid="script-run-on-connect"
                checked={runOnConnect}
                onChange={(e) => setRunOnConnect(e.target.checked)}
              />
              会话建立后自动运行（同一会话最多一个）
            </label>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>名称</label>
            <input
              data-testid="script-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：采集磁盘快照"
            />
          </div>
          <div>
            <label className={labelClass}>说明</label>
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这个脚本做什么"
            />
          </div>
          <div>
            <label className={labelClass}>超时（毫秒）</label>
            <input
              data-testid="script-timeout"
              type="number"
              min={1000}
              max={SCRIPT_MAX_TIMEOUT_MS}
              className={inputClass}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-3">
          <ScriptEditor
            value={code}
            onChange={setCode}
            errorLine={syntaxIssue?.line}
            errorMessage={syntaxIssue?.message}
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className={hintClass}>
            沙箱内的循环不会拖垮服务：超时后由 worker 强制终止，其他会话完全不受影响。
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="script-try-run"
              onClick={() => void submit(null)}
              disabled={runnable.length === 0}
              title={runnable.length === 0 ? '需要一个已连接的终端' : '用编辑器里这份代码试运行'}
              className={secondaryButtonClass}
            >
              试运行（不保存）
            </button>
            <button
              type="button"
              data-testid="script-save"
              onClick={() => void save()}
              disabled={saving}
              className={primaryButtonClass}
            >
              {saving ? '保存中…' : editing ? '保存修改' : '创建脚本'}
            </button>
          </div>
        </div>
      </div>

      {/* ---------- 运行输出 ---------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            运行输出
            {selectedRun ? (
              <span className="ml-1.5 text-neutral-500 dark:text-neutral-400">
                （{selectedRun.scriptName}）
              </span>
            ) : null}
          </span>
          <div className="flex items-center gap-2">
            {selectedRun ? (
              <Chip
                tone={
                  selectedRun.phase === 'done'
                    ? 'green'
                    : selectedRun.phase === 'error' || selectedRun.phase === 'timeout'
                      ? 'red'
                      : 'amber'
                }
              >
                {selectedRun.phase === 'running'
                  ? '运行中'
                  : selectedRun.phase === 'done'
                    ? `完成 ${selectedRun.elapsedMs ?? 0}ms`
                    : selectedRun.phase === 'timeout'
                      ? '超时被中断'
                      : '出错'}
              </Chip>
            ) : null}
            {liveRuns.length > 0 ? (
              <button
                type="button"
                onClick={() => useAutomationStore.getState().clearLiveRuns()}
                className={secondaryButtonClass}
              >
                清空
              </button>
            ) : null}
          </div>
        </div>

        <div
          data-testid="script-output"
          className="max-h-52 min-h-16 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-950 p-2 font-mono text-[11px] leading-relaxed text-neutral-200 dark:border-neutral-800"
        >
          {!selectedRun ? (
            <span className="text-neutral-500">
              还没有运行记录。选中一个终端后点「试运行」或列表里的「运行」。
            </span>
          ) : (
            <>
              {selectedRun.logs.map((entry, index) => (
                <div
                  key={index}
                  className={
                    entry.level === 'error'
                      ? 'text-red-400'
                      : entry.level === 'warn'
                        ? 'text-amber-300'
                        : entry.level === 'debug'
                          ? 'text-neutral-500'
                          : 'text-neutral-200'
                  }
                >
                  <span className="text-neutral-600">
                    [{entry.level}
                    {entry.line ? ` L${entry.line}` : ''}]
                  </span>{' '}
                  {entry.message}
                </div>
              ))}
              {selectedRun.droppedLogs > 0 ? (
                <div className="text-neutral-500">
                  … 另有 {selectedRun.droppedLogs} 条日志因超出上限未保留
                </div>
              ) : null}
              {selectedRun.result !== undefined ? (
                <div className="mt-1 text-emerald-300">
                  ↳ 返回值 {JSON.stringify(selectedRun.result)}
                </div>
              ) : null}
              {selectedRun.error ? (
                <div className="mt-1 text-red-400">↳ {selectedRun.error}</div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* ---------- 脚本列表 ---------- */}
      {scripts.length === 0 ? (
        <EmptyState>还没有脚本。编辑器里默认给了一段示例，可以直接改成自己要的。</EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="script-list">
          {scripts.map((script) => (
            <li
              key={script.id}
              data-testid={`script-row-${script.id}`}
              className="rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-neutral-900 dark:text-neutral-100">
                      {script.name}
                    </span>
                    <Chip tone="blue">{`超时 ${script.timeoutMs}ms`}</Chip>
                    {script.runOnConnect ? (
                      <Chip tone="amber" title="新会话建立后由服务端自动运行">
                        随会话运行
                      </Chip>
                    ) : null}
                  </div>
                  {script.description ? (
                    <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                      {script.description}
                    </p>
                  ) : null}
                  <p className="mt-1 truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                    {script.code.split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ??
                      '（空脚本）'}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <button
                    type="button"
                    data-testid={`script-run-${script.id}`}
                    onClick={() => void submit(script)}
                    disabled={runnable.length === 0}
                    className={primaryButtonClass}
                  >
                    运行
                  </button>
                  <button
                    type="button"
                    data-testid={`script-edit-${script.id}`}
                    onClick={() => startEdit(script)}
                    className={secondaryButtonClass}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    data-testid={`script-delete-${script.id}`}
                    onClick={() => {
                      const message = `删除脚本「${script.name}」？`
                      if (!window.confirm(message)) return
                      void useAutomationStore
                        .getState()
                        .removeScript(script.id)
                        .then((references) => {
                          if (references > 0) {
                            setError(
                              `脚本已删除，但它还被 ${references} 处引用（会话启动脚本或触发器动作），那些地方会提示脚本不存在。`,
                            )
                          }
                        })
                        .catch(() => {})
                    }}
                    className={dangerButtonClass}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ---------- 历史记录 ---------- */}
      {runs.length > 0 ? (
        <details className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <summary className="cursor-pointer text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            服务端保留的最近运行记录（{runs.length} 条）
          </summary>
          <ul className="mt-2 space-y-1" data-testid="script-run-history">
            {runs.slice(0, 20).map((run) => (
              <li
                key={run.runId}
                className="flex items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-[11px] dark:border-neutral-800"
              >
                <Chip tone={run.phase === 'done' ? 'green' : run.phase === 'running' ? 'amber' : 'red'}>
                  {run.phase}
                </Chip>
                <span className="text-neutral-700 dark:text-neutral-300">{run.scriptName}</span>
                <span className="text-neutral-500 dark:text-neutral-400">{run.terminalTitle}</span>
                {run.elapsedMs !== undefined ? (
                  <span className="text-neutral-400 dark:text-neutral-500">{run.elapsedMs}ms</span>
                ) : null}
                <span className="ml-auto truncate font-mono text-neutral-500 dark:text-neutral-400">
                  {run.error ??
                    (run.result !== undefined ? JSON.stringify(run.result) : '')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
