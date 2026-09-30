/**
 * 插件状态（阶段 9）。
 *
 * 与其它 store 的差别：这里的**唯一真相在服务端**（插件是文件系统上的东西），
 * 前端只保存一份展示用的快照，任何写操作（启停 / 改配置 / 重载）都走接口，
 * 再用响应覆盖本地快照 —— 不做乐观更新。理由：插件状态随时可能被
 * 「服务端加载失败」推翻，乐观更新会让界面短暂显示一个并不存在的「已启用」，
 * 而用户会据此做判断。
 */
import { create } from 'zustand'
import type { PluginConfigMap, PluginInfo, PluginPanelData } from '@webterm/shared'
import {
  fetchPluginPanel,
  listPlugins,
  reloadPlugin,
  rescanPlugins,
  runPluginCommand,
  updatePlugin,
} from '../api/client'

interface PluginState {
  plugins: PluginInfo[]
  /** 插件根目录（服务端返回）：界面上要明确告诉用户「插件放哪儿」 */
  dir: string
  apiVersion: number
  loading: boolean
  error: string | null

  refresh: () => Promise<void>
  rescan: () => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  saveConfig: (id: string, config: PluginConfigMap) => Promise<void>
  reload: (id: string) => Promise<void>
  runCommand: (id: string, commandId: string) => Promise<{ ok: boolean; message?: string }>
  loadPanel: (id: string, panelId: string) => Promise<PluginPanelData>
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const usePluginStore = create<PluginState>((set, get) => {
  /** 用服务端返回的权威快照替换对应的一条 */
  const replace = (plugin: PluginInfo) =>
    set((state) => ({
      plugins: state.plugins.map((p) => (p.id === plugin.id ? plugin : p)),
    }))

  return {
    plugins: [],
    dir: '',
    apiVersion: 1,
    loading: false,
    error: null,

    refresh: async () => {
      // 只在首次加载时亮 loading：plugins-changed 触发的刷新不该让列表闪一下
      if (get().plugins.length === 0) set({ loading: true })
      try {
        const data = await listPlugins()
        set({
          plugins: data.plugins,
          dir: data.dir,
          apiVersion: data.apiVersion,
          error: null,
          loading: false,
        })
      } catch (err) {
        set({ error: messageOf(err), loading: false })
      }
    },

    rescan: async () => {
      const data = await rescanPlugins()
      set({ plugins: data.plugins, dir: data.dir, apiVersion: data.apiVersion, error: null })
    },

    setEnabled: async (id, enabled) => {
      const data = await updatePlugin(id, { enabled })
      replace(data.plugin)
    },

    saveConfig: async (id, config) => {
      const data = await updatePlugin(id, { config })
      replace(data.plugin)
    },

    reload: async (id) => {
      const data = await reloadPlugin(id)
      replace(data.plugin)
    },

    runCommand: (id, commandId) => runPluginCommand(id, commandId),

    loadPanel: async (id, panelId) => (await fetchPluginPanel(id, panelId)).panel,
  }
})
