/**
 * 保险库（主密码）状态。
 *
 * 解锁状态只存在于服务端内存；前端仅持有「是否已解锁」的视图状态。
 */
import { create } from 'zustand'
import {
  fetchVaultStatus,
  lockVault,
  setupVault,
  unlockVault,
} from '../api/client'
import type { VaultStatusResponse } from '@webterm/shared'

interface VaultStore {
  status: VaultStatusResponse | null
  /** 状态查询是否已结束（无论成功失败），用于区分「加载中」与「加载失败」 */
  ready: boolean
  /** 状态查询失败时的提示；查询成功后清空 */
  error: string | null
  refresh: () => Promise<void>
  setup: (masterPassword: string) => Promise<void>
  unlock: (masterPassword: string) => Promise<void>
  lock: () => Promise<void>
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  status: null,
  ready: false,
  error: null,

  refresh: async () => {
    try {
      const status = await fetchVaultStatus()
      set({ status, ready: true, error: null })
    } catch (err) {
      // 失败不能当作「未初始化」：那会让用户以为要设置一个其实已存在的主密码，
      // 覆盖掉原有保险库。这里只标记 ready 并给出错误，由界面引导重试。
      set({
        ready: true,
        error: err instanceof Error ? err.message : '无法连接到服务端',
      })
    }
  },

  setup: async (masterPassword) => {
    await setupVault(masterPassword)
    await get().refresh()
  },

  unlock: async (masterPassword) => {
    await unlockVault(masterPassword)
    await get().refresh()
  },

  lock: async () => {
    await lockVault()
    await get().refresh()
  },
}))
