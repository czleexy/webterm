import { useEffect, useState } from 'react'
import { API_PREFIX, PROTOCOL_LABEL, WS_PATH } from '@webterm/shared'
import type { CapabilitiesResponse } from '@webterm/shared'
import { fetchCapabilities } from '../api/client'
import type { UseHealthResult } from '../hooks/useHealth'
import { useT, type MessageKey } from '../i18n'
import { SkeletonBlock } from '../ui/Skeleton'
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
  { id: 1, name: '终端主干打通', scope: 'ssh2 + WebSocket + xterm.js + 背压', status: 'done' },
  { id: 2, name: '会话管理与持久化', scope: 'SQLite / 主密码 / 密钥认证 / 跳板机', status: 'done' },
  { id: 3, name: 'SFTP 文件传输', scope: '双栏浏览 / 队列 / 断点续传 / 远程编辑', status: 'done' },
  { id: 4, name: 'Telnet 明文终端', scope: '选项协商 / NAWS / 本地回显 / 端口 23', status: 'done' },
  { id: 5, name: '端口转发与隧道', scope: '-L / -R / -D SOCKS5 / 随会话自动启动', status: 'done' },
  { id: 6, name: '自动化与批量运维', scope: '触发器 / 宏按钮栏 / 沙箱脚本 / 批量执行 / 同步输入', status: 'done' },
  { id: 7, name: '日志与审计', scope: '三种日志格式 / 归档轮转 / 分页预览 / 审计表 / 脱敏规则', status: 'done' },
  {
    id: 8,
    name: '体验打磨',
    scope: '主题与字体 / 快捷键 / 终端搜索 / 关键词高亮 / 分屏 / 通知 / i18n',
    status: 'done',
  },
  { id: 9, name: '插件与打包', scope: '插件宿主 / 打包发布（npm · Docker）', status: 'planned' },
]

const STATUS_BADGE: Record<PhaseStatus, { textKey: MessageKey; className: string }> = {
  done: {
    textKey: 'welcome.phase.done',
    className:
      'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400',
  },
  current: {
    textKey: 'welcome.phase.active',
    className: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400',
  },
  planned: {
    textKey: 'welcome.phase.planned',
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
  onNew: () => void
}

export function WelcomePane({ health, onNew }: WelcomePaneProps) {
  const t = useT()
  const { status, data, error } = health
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchCapabilities()
      .then((result) => {
        if (!cancelled) setCaps(result)
      })
      .catch(() => {
        // 能力查询失败不影响主流程，静默降级
      })
    return () => {
      cancelled = true
    }
  }, [])

  const legacyProfile = caps?.profiles.find((p) => p.legacy)

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
        {t('welcome.headline')}
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t('welcome.intro.lead')}
        <b className="font-medium text-neutral-700 dark:text-neutral-300">
          {t('welcome.intro.done')}
        </b>
        {t('welcome.intro.body')}
        {t('welcome.intro.next')}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="new-session"
          onClick={onNew}
          className="rounded-md bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          {t('welcome.newConnection')}
        </button>
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
          {t('welcome.shortcuts')}
        </span>
      </div>

      {status === 'offline' ? (
        <div className="mt-5 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <b className="font-medium">{t('welcome.offline.title')}</b>
          <div className="mt-1 break-all font-mono">{error}</div>
          <div className="mt-1 text-red-600/80 dark:text-red-400/80">
            {t('welcome.offline.hint')}
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InfoCell label="服务版本" value={data ? `v${data.version}` : '—'} />
        <InfoCell label="Node" value={data?.nodeVersion ?? '—'} />
        <InfoCell label="运行时长" value={data ? formatUptime(data.uptimeSec) : '—'} />
        <InfoCell label="活跃终端" value={data ? String(data.activeTabs) : '—'} />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <InfoCell label="REST 前缀" value={API_PREFIX} />
        <InfoCell label="终端端点" value={`${WS_PATH}/terminal/:id`} />
        <InfoCell label="ssh2" value={caps ? `v${caps.ssh2Version}` : '—'} />
        <InfoCell
          label="支持协议"
          value={
            caps ? caps.supportedProtocols.map((p) => PROTOCOL_LABEL[p]).join(' / ') : '—'
          }
        />
      </div>

      {/* 算法档案：老设备排障时最常需要确认的信息 */}
      <h2 className="mt-8 text-sm font-medium text-neutral-900 dark:text-neutral-100">
        算法兼容档案
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        连接时按序尝试：现代算法协商失败会自动降级到 legacy 档案，
        因此老旧交换机 / 路由器无需手动配置算法。
      </p>
      <div className="mt-2 space-y-2">
        {(caps?.profiles ?? []).map((profile) => (
          <div
            key={profile.name}
            className={cn(
              'rounded-lg border px-3 py-2',
              profile.legacy
                ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20'
                : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-neutral-900 dark:text-neutral-100">
                {profile.name}
              </span>
              <span
                className={cn(
                  'rounded border px-1.5 py-px text-[10px]',
                  profile.legacy
                    ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400'
                    : 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400',
                )}
              >
                {profile.legacy ? '兼容模式' : '默认'}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {profile.description}
            </p>
            {profile.legacy ? (
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                kex: {profile.kex.join(', ') || '（由 ssh2 决定）'}
              </p>
            ) : null}
          </div>
        ))}
        {!caps ? (
          <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-2 dark:border-neutral-800">
            <p className="mb-2 text-[11px] text-neutral-400 dark:text-neutral-500">
              {t('welcome.capsLoading')}
            </p>
            <SkeletonBlock lines={2} delayMs={0} label={t('welcome.capsLoading')} />
          </div>
        ) : null}
      </div>

      {caps && legacyProfile ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCell
            label="背压水位（高 / 低）"
            value={`${Math.round(caps.backpressureHighWaterMark / 1024)} KB / ${Math.round(caps.backpressureLowWaterMark / 1024)} KB`}
          />
          <InfoCell label="支持编码" value={caps.supportedEncodings.join(', ')} />
        </div>
      ) : null}

      <h2 className="mt-8 text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {t('welcome.progress')}
      </h2>
      <ul className="mt-2 divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {PHASES.map((phase) => {
          const badge = STATUS_BADGE[phase.status]
          return (
            <li
              key={phase.id}
              data-testid={`welcome-phase-${phase.id}`}
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
                {t(badge.textKey)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
