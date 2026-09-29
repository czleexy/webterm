/**
 * 批量执行分区。
 *
 * 一个反复出现的坑：批量执行的目标有两种来源，成本完全不同，界面上必须分开说。
 *
 * - **已打开的终端**（terminalId）：复用那条**已经登录好**的 SSH 连接另开一条 exec 通道，
 *   不占新的 VTY 线路。交换机、路由器这类设备常常只有 4~16 条 VTY，重复登录会把自己
 *   挡在门外 —— 因此这是默认选项。
 * - **会话库节点**（sessionId）：独立建连，跑完就断。适合「这几台我并没有开着会话」。
 *
 * 结果表里退出码与 stdout / stderr 是分开的：把 stderr 混进 stdout 会让
 * 「有没有出错」这件事只能靠猜，而批量运维最需要的就是一眼看出哪台不对。
 */
import { useMemo, useState } from 'react'
import {
  BATCH_DEFAULT_CONCURRENCY,
  BATCH_DEFAULT_TIMEOUT_MS,
  BATCH_MAX_CONCURRENCY,
  BATCH_MAX_TARGETS,
  BATCH_MAX_TIMEOUT_MS,
  type BatchResult,
  type RunBatchResponse,
} from '@webterm/shared'
import { runBatch } from '../api/client'
import { useLibraryStore } from '../store/useLibraryStore'
import { useTerminalStore } from '../store/useTerminalStore'
import {
  Chip,
  EmptyState,
  SectionHeader,
  hintClass,
  inputClass,
  labelClass,
  monoInputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui'

type Source = 'terminals' | 'library'

interface SelectedTarget {
  /** 稳定 key：terminals 用 tabId，library 用 sessionId */
  key: string
  label: string
  sessionId?: string
  terminalId?: string
  protocol: 'ssh' | 'telnet'
}

export function BatchSection() {
  const tabs = useTerminalStore((s) => s.tabs)
  const nodes = useLibraryStore((s) => s.nodes)

  const [source, setSource] = useState<Source>('terminals')
  const [picked, setPicked] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [concurrency, setConcurrency] = useState(String(BATCH_DEFAULT_CONCURRENCY))
  const [timeoutMs, setTimeoutMs] = useState(String(BATCH_DEFAULT_TIMEOUT_MS))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<RunBatchResponse | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  /** 候选目标：终端标签一律可选（Telnet 会被服务端拒绝，这里标出来而不是藏起来） */
  const candidates = useMemo<SelectedTarget[]>(() => {
    if (source === 'terminals') {
      return tabs
        .filter((t) => Boolean(t.terminalId))
        .map((t) => ({
          key: t.id,
          label: t.title,
          terminalId: t.terminalId,
          protocol: t.protocol,
        }))
    }
    return nodes
      .filter((n) => n.kind === 'session' && n.session)
      .map((n) => ({
        key: n.id,
        label: n.name,
        sessionId: n.id,
        // LibraryNode.session 的协议判别字段
        protocol: (n.session?.protocol ?? 'ssh') as 'ssh' | 'telnet',
      }))
  }, [nodes, source, tabs])

  const toggle = (key: string) => {
    setPicked((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key)
      if (prev.length >= BATCH_MAX_TARGETS) return prev
      return [...prev, key]
    })
  }

  const allPicked = candidates.length > 0 && picked.length === candidates.length

  const execute = async () => {
    const targets = candidates.filter((c) => picked.includes(c.key))
    if (targets.length === 0) {
      setError('请至少选择一个执行目标')
      return
    }
    if (command.trim() === '') {
      setError('命令不能为空')
      return
    }
    setRunning(true)
    setError(null)
    setOutcome(null)
    try {
      const result = await runBatch({
        targets: targets.map((t) => ({
          label: t.label,
          ...(t.terminalId ? { terminalId: t.terminalId } : {}),
          ...(t.sessionId ? { sessionId: t.sessionId } : {}),
        })),
        command: command.trim(),
        concurrency: Number(concurrency) || BATCH_DEFAULT_CONCURRENCY,
        timeoutMs: Number(timeoutMs) || BATCH_DEFAULT_TIMEOUT_MS,
      })
      setOutcome(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="批量执行"
        description="对多台主机并发执行同一条命令，结果汇总成一张表。只支持 SSH —— 要拿到退出码就必须用 exec 通道，Telnet 没有这一层。"
      />

      <div className="grid grid-cols-2 gap-3">
        {/* ---------- 目标选择 ---------- */}
        <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
              执行目标（{picked.length}/{BATCH_MAX_TARGETS}）
            </span>
            <div className="flex items-center gap-1">
              <select
                data-testid="batch-source"
                className={`${inputClass} w-36`}
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as Source)
                  setPicked([])
                }}
              >
                <option value="terminals">已打开的终端</option>
                <option value="library">会话库</option>
              </select>
              <button
                type="button"
                data-testid="batch-select-all"
                onClick={() => setPicked(allPicked ? [] : candidates.slice(0, BATCH_MAX_TARGETS).map((c) => c.key))}
                disabled={candidates.length === 0}
                className={secondaryButtonClass}
              >
                {allPicked ? '全不选' : '全选'}
              </button>
            </div>
          </div>

          <p className={hintClass}>
            {source === 'terminals'
              ? '复用已登录的连接另开 exec 通道，不会新增 SSH 登录，也不占设备的 VTY 线路。'
              : '从会话库取配置独立建连，执行完即断开。适合目标机器上并没有开着会话的情况。'}
          </p>

          {candidates.length === 0 ? (
            <div className="mt-2">
              <EmptyState>
                {source === 'terminals'
                  ? '还没有已连接的终端。先在左侧建立几个会话，或切换到「会话库」。'
                  : '会话库里还没有会话。'}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto" data-testid="batch-targets">
              {candidates.map((candidate) => (
                <li key={candidate.key}>
                  <label className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-neutral-50 dark:hover:bg-neutral-800/60">
                    <input
                      type="checkbox"
                      data-testid={`batch-target-${candidate.key}`}
                      checked={picked.includes(candidate.key)}
                      onChange={() => toggle(candidate.key)}
                    />
                    <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">
                      {candidate.label}
                    </span>
                    <Chip tone={candidate.protocol === 'ssh' ? 'blue' : 'amber'}>
                      {candidate.protocol === 'ssh' ? 'SSH' : 'Telnet 不支持'}
                    </Chip>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---------- 命令与参数 ---------- */}
        <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <label className={labelClass}>要执行的命令</label>
          <input
            data-testid="batch-command"
            className={monoInputClass}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) void execute()
            }}
            placeholder="df -h"
          />
          <p className={hintClass}>通过 exec 通道执行，不经过交互式 shell，因此不会加载登录时的别名与函数。</p>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>并发度</label>
              <input
                data-testid="batch-concurrency"
                type="number"
                min={1}
                max={BATCH_MAX_CONCURRENCY}
                className={inputClass}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
              <p className={hintClass}>上限 {BATCH_MAX_CONCURRENCY}</p>
            </div>
            <div>
              <label className={labelClass}>单目标超时（毫秒）</label>
              <input
                data-testid="batch-timeout"
                type="number"
                min={1000}
                max={BATCH_MAX_TIMEOUT_MS}
                className={inputClass}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <p className={hintClass}>单个目标输出超过 256 KB 会被截断。</p>
            <button
              type="button"
              data-testid="batch-run"
              onClick={() => void execute()}
              disabled={running || picked.length === 0}
              className={primaryButtonClass}
            >
              {running ? '执行中…' : `执行（${picked.length} 台）`}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* ---------- 结果表 ---------- */}
      {outcome ? (
        <div data-testid="batch-result">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
                执行结果
              </span>
              <Chip tone="green">{`成功 ${outcome.succeeded}`}</Chip>
              <Chip tone={outcome.failed > 0 ? 'red' : 'neutral'}>{`失败 ${outcome.failed}`}</Chip>
              <Chip>{`总耗时 ${outcome.elapsedMs}ms`}</Chip>
            </div>
            <button
              type="button"
              data-testid="batch-export"
              onClick={() => exportCsv(outcome.results, command)}
              className={secondaryButtonClass}
            >
              导出 CSV
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[44rem] border-collapse text-[11px]">
              <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                <tr className="text-neutral-600 dark:text-neutral-400">
                  <th className="px-2 py-1.5 font-medium">主机</th>
                  <th className="px-2 py-1.5 font-medium">协议</th>
                  <th className="px-2 py-1.5 font-medium">退出码</th>
                  <th className="px-2 py-1.5 font-medium">耗时</th>
                  <th className="px-2 py-1.5 font-medium">输出</th>
                </tr>
              </thead>
              <tbody data-testid="batch-result-body">
                {outcome.results.map((row, index) => (
                  <ResultRow
                    key={`${row.target}-${index}`}
                    row={row}
                    expanded={expanded === `${row.target}-${index}`}
                    onToggle={() =>
                      setExpanded(expanded === `${row.target}-${index}` ? null : `${row.target}-${index}`)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ResultRow({
  row,
  expanded,
  onToggle,
}: {
  row: BatchResult
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        data-testid={`batch-row-${row.target}`}
        data-ok={row.ok ? 'true' : 'false'}
        className="border-t border-neutral-200 dark:border-neutral-800"
      >
        <td className="px-2 py-1.5 text-neutral-800 dark:text-neutral-200">
          {row.target}
          {row.truncated ? (
            <Chip tone="amber" title="输出超过 256 KB，已截断">
              已截断
            </Chip>
          ) : null}
        </td>
        <td className="px-2 py-1.5">
          <Chip tone={row.protocol === 'ssh' ? 'blue' : 'amber'}>{row.protocol}</Chip>
        </td>
        <td className="px-2 py-1.5 font-mono">
          {row.ok ? (
            <span className="text-emerald-600 dark:text-emerald-400">{row.exitCode ?? 0}</span>
          ) : (
            <span className="text-red-600 dark:text-red-400">
              {row.exitCode ?? row.signal ?? '—'}
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 font-mono text-neutral-500 dark:text-neutral-400">
          {row.elapsedMs}ms
        </td>
        <td className="px-2 py-1.5">
          {row.error ? (
            <span className="text-red-600 dark:text-red-400">{row.error}</span>
          ) : (
            <button
              type="button"
              onClick={onToggle}
              className="max-w-[28rem] truncate text-left font-mono text-neutral-600 hover:underline dark:text-neutral-300"
            >
              {firstLine(row.stdout) || firstLine(row.stderr) || '（无输出）'}
            </button>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950/60">
          <td colSpan={5} className="px-2 py-2">
            <div className="space-y-2">
              <OutputBlock label="stdout" text={row.stdout} />
              <OutputBlock label="stderr" text={row.stderr} tone="red" />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: 'red' }) {
  return (
    <div>
      <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
        {label}
        {text === '' ? '（空）' : ''}
      </span>
      {text !== '' ? (
        <pre
          className={`mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-neutral-200 bg-white p-2 font-mono text-[11px] dark:border-neutral-800 dark:bg-neutral-900 ${
            tone === 'red' ? 'text-red-700 dark:text-red-300' : 'text-neutral-700 dark:text-neutral-300'
          }`}
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

/**
 * 导出 CSV。
 *
 * 带 UTF-8 BOM：不加的话 Excel（尤其是中文 Windows 版）会按本地代码页解读，
 * 中文全变成乱码 —— 而导出这份表的人下一步几乎一定是拿 Excel 打开。
 * 换行统一成 `\r\n`，同样是 Excel 的兼容要求。
 */
function exportCsv(results: BatchResult[], command: string): void {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`
  const header = ['主机', '协议', '退出码', '信息', '耗时(ms)', '命令', 'stdout', 'stderr']
  const lines = [header.map(escape).join(',')]
  for (const row of results) {
    lines.push(
      [
        escape(row.target),
        escape(row.protocol),
        escape(row.exitCode === null ? '' : String(row.exitCode)),
        escape(row.error ?? (row.truncated ? '输出已截断' : '')),
        escape(String(row.elapsedMs)),
        escape(command),
        escape(row.stdout),
        escape(row.stderr),
      ].join(','),
    )
  }

  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `webterm-batch-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻回收会让部分浏览器的下载中断，交给下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
