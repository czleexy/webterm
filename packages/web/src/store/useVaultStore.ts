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
  /** 首次状态查询是否完成 */
  ready: boolean
  refresh: () => Promise<void>
  setup: (masterPassword: string) => Promise<void>
  unlock: (masterPassword: string) => Promise<void>
  lock: () => Promise<void>
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  status: null,
  ready: false,

  refresh: async () => {
    const status = await fetchVaultStatus()
    set({ status, ready: true })
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
