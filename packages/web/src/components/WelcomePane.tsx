import { API_PREFIX, WS_PATH } from '@webterm/shared'
import type { UseHealthResult } from '../hooks/useHealth'
import { cn } from '../utils/cn'

type PhaseStatus = 'done' | 'current' | 'planned'

interface PhaseItem {
  id: number
  name: string
  scope: string
  status: PhaseStatus
}

const PHASES: PhaseItem[] = [
  { id: 0, name: '工程骨架', scope: 'workspaces / Fastify / Vite / 一键启动', status: 'done' },
  { id: 1, name: '终端主干打通', scope: 'ssh2 + WebSocket + xterm.js', status: 'current' },
  { id: 2, name: '会话管理与持久化', scope: 'SQLite / 主密码 / 密钥认证 / 跳板机', status: 'planned' },
  { id: 3, name: 'SFTP 文件传输', scope: '双栏浏览 / 队列 / 断点续传', status: 'planned' },
  { id: 4, name: '端口转发与隧道', scope: '-L / -R / -D SOCKS5', status: 'planned' },
  { id: 5, name: '自动化与批量运维', scope: '触发器 / 脚本沙箱 / 批量执行', status: 'planned' },
  { id: 6, name: '日志与审计', scope: '会话日志 / 归档 / 审计表', status: 'planned' },
  { id: 7, name: '体验打磨', scope: '主题 / 快捷键 / 搜索 / 分屏', status: 'planned' },
  { id: 8, name: '插件与打包', scope: '插件宿主 / 生产构建', status: 'planned' },
]

const STATUS_BADGE: Record<PhaseStatus, { text: string; className: string }> = {
  done: {
    text: '已完成',
    className:
      'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400',
  },
  current: {
    text: '进行中',
    className: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400',
  },
  planned: {
    text: '待开发',
    className:
      'border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500',
  },
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-neutral-900 dark:text-neutral-100">
        {value}
      </div>
    </div>
  )
}

interface WelcomePaneProps {
  health: UseHealthResult
}

export function WelcomePane({ health }: WelcomePaneProps) {
  const { status, data, error } = health

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
        浏览器里的 SSH 工作台
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
        后端跑在本机，负责建立 SSH 连接与协议处理；浏览器只做渲染与交互。
        当前处于<b className="font-medium text-neutral-700 dark:text-neutral-300">阶段 0（工程骨架）</b>
        ，前后端链路已打通，下一步接入 SSH 终端。
      </p>

      {status === 'offline' ? (
        <div className="mt-5 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <b className="font-medium">无法连接后端服务</b>
          <div className="mt-1 break-all font-mono">{error}</div>
          <div className="mt-1 text-red-600/80 dark:text-red-400/80">
            请确认后端已启动（npm run dev），或访问的服务地址与后端端口一致。
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InfoCell label="服务版本" value={data ? `v${data.version}` : '—'} />
        <InfoCell label="Node" value={data?.nodeVersion ?? '—'} />
        <InfoCell label="运行时长" value={data ? formatUptime(data.uptimeSec) : '—'} />
        <InfoCell label="活跃标签" value={data ? String(data.activeTabs) : '—'} />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <InfoCell label="REST 前缀" value={API_PREFIX} />
        <InfoCell label="终端端点" value={WS_PATH} />
      </div>

      <h2 className="mt-8 text-sm font-medium text-neutral-900 dark:text-neutral-100">
        实施进度
      </h2>
      <ul className="mt-2 divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {PHASES.map((phase) => {
          const badge = STATUS_BADGE[phase.status]
          return (
            <li
              key={phase.id}
              className={cn(
                'flex items-center gap-3 bg-white px-3 py-2 dark:bg-neutral-900',
                phase.status === 'current' && 'bg-amber-50 dark:bg-amber-950/20',
              )}
            >
              <span className="w-4 shrink-0 font-mono text-[11px] text-neutral-400 dark:text-neutral-600">
                {phase.id}
              </span>
              <span className="w-36 shrink-0 text-xs text-neutral-900 dark:text-neutral-100">
                {phase.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                {phase.scope}
              </span>
              <span
                className={cn(
                  'shrink-0 rounded border px-1.5 py-px text-[10px]',
                  badge.className,
                )}
              >
                {badge.text}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
