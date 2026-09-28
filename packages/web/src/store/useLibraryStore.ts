/**
 * 会话库与凭据的共享状态。
 *
 * 两个列表经常被同一批组件消费（会话编辑弹窗需要凭据下拉，
 * 侧边栏需要树），放一个 store 里，解锁/变更后统一刷新。
 */
import { create } from 'zustand'
import {
  deleteCredential,
  deleteLibraryNode,
  fetchLibrary,
  listCredentials,
} from '../api/client'
import type { CredentialSummary, LibraryNode } from '@webterm/shared'

interface LibraryStore {
  nodes: LibraryNode[]
  credentials: CredentialSummary[]
  loaded: boolean
  /** 保险库未解锁时凭据列表不可用，标记一下避免误判为空 */
  credentialsAvailable: boolean
  refresh: () => Promise<void>
  removeNode: (id: string) => Promise<void>
  removeCredential: (id: string) => Promise<void>
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  nodes: [],
  credentials: [],
  loaded: false,
  credentialsAvailable: false,

  refresh: async () => {
    const [library, credentials] = await Promise.allSettled([fetchLibrary(), listCredentials()])
    const nodes = library.status === 'fulfilled' ? library.value.nodes : get().nodes
    const credentialsAvailable = credentials.status === 'fulfilled'
    set({
      nodes,
      credentials: credentialsAvailable ? credentials.value.credentials : [],
      credentialsAvailable,
      loaded: true,
    })
  },

  removeNode: async (id) => {
    await deleteLibraryNode(id)
    await get().refresh()
  },

  removeCredential: async (id) => {
    await deleteCredential(id)
    await get().refresh()
  },
}))
