import { useEffect, useState } from 'react'
import type { HealthResponse } from '@webterm/shared'
import { fetchHealth } from '../api/client'

export type HealthStatus = 'loading' | 'online' | 'offline'

export interface UseHealthResult {
  status: HealthStatus
  data: HealthResponse | null
  error: string | null
}

/**
 * 轮询后端健康检查。阶段 1 接入 WebSocket 后可改为事件驱动。
 */
export function useHealth(intervalMs = 10_000): UseHealthResult {
  const [status, setStatus] = useState<HealthStatus>('loading')
  const [data, setData] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const probe = async (): Promise<void> => {
      try {
        const result = await fetchHealth()
        if (cancelled) return
        setData(result)
        setError(null)
        setStatus('online')
      } catch (err) {
        if (cancelled) return
        setData(null)
        setError(err instanceof Error ? err.message : String(err))
        setStatus('offline')
      }
    }

    void probe()
    const timer = window.setInterval(() => void probe(), intervalMs)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [intervalMs])

  return { status, data, error }
}
