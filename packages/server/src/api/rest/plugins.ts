/**
 * 插件接口。
 *
 * 一句话说清这套接口的分工：**宿主只做读写，不做渲染**。
 * 插件把「我有哪些触发器动作 / 命令 / 面板」注册出来，界面把它们渲染成
 * 下拉项、按钮、数据表；插件不接触任何 UI 代码。这条边界让插件作者只需
 * 关心自己的逻辑，也让整个插件面板的主题、可访问性、暗色适配保持一致。
 *
 * 关于错误码：清单非法、插件不存在这类**调用方的错**给 4xx；
 * 插件自己抛错给 200 + `ok: false`（或空表 + 原因），因为那是「运行结果」
 * 而不是「接口失败」—— 前端能据此显示更有信息量的提示。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type {
  ListPluginsResponse,
  PluginMutationResponse,
  PluginPanelResponse,
  RunPluginCommandResponse,
  UpdatePluginRequest,
} from '@webterm/shared'
import { PLUGIN_API_VERSION } from '@webterm/shared'
import { PluginFailure, type PluginFailureCode } from '../../plugin/errors.js'
import { UpdatePluginRequestSchema } from '../schemas.js'
import { sendError, sendValidationError } from '../errors.js'

/** 插件类错误 → HTTP 状态码 */
const STATUS_BY_PLUGIN_CODE: Record<PluginFailureCode, number> = {
  NOT_FOUND: 404,
  MANIFEST: 400,
  RUNTIME: 500,
  // 409 而不是 400：请求本身没问题，是「当前状态不允许」——
  // 界面据此提示「插件已停用，请先启用」而不是「参数错误」
  UNAVAILABLE: 409,
  INVALID: 400,
  DUPLICATE: 400,
}

function sendPluginError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PluginFailure) {
    const message = err.hint ? `${err.message}\n\n${err.hint}` : err.message
    return sendError(reply, STATUS_BY_PLUGIN_CODE[err.code] ?? 500, err.code, message)
  }
  return sendError(reply, 500, 'INTERNAL', err instanceof Error ? err.message : String(err))
}

interface PluginParams {
  id: string
}

export const pluginRoutes: FastifyPluginAsync = async (app) => {
  const plugins = app.plugins

  /** 插件列表（含状态、注册项、生效配置与最近日志） */
  app.get('/plugins', async (): Promise<ListPluginsResponse> => {
    return { plugins: plugins.list(), dir: plugins.dir, apiVersion: PLUGIN_API_VERSION }
  })

  /** 重新扫描插件目录：用户往目录里放了新插件之后点这里 */
  app.post('/plugins/rescan', async (): Promise<ListPluginsResponse> => {
    return { plugins: plugins.rescan(), dir: plugins.dir, apiVersion: PLUGIN_API_VERSION }
  })

  /** 单个插件详情 */
  app.get<{ Params: PluginParams }>('/plugins/:id', async (request, reply) => {
    const plugin = plugins.get(request.params.id)
    if (!plugin) return sendError(reply, 404, 'NOT_FOUND', `插件不存在：${request.params.id}`)
    return reply.send({ plugin } satisfies PluginMutationResponse)
  })

  /**
   * 启停与配置。
   * 两者能放在同一个 PATCH 里，是因为它们的语义都是「改这个插件的运行状态」；
   * 分成两个接口会让「启用并按新配置生效」变成两次请求（中间那一刻状态是错的）。
   */
  app.patch<{ Params: PluginParams }>('/plugins/:id', async (request, reply) => {
    const parsed = UpdatePluginRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    const body = parsed.data as UpdatePluginRequest
    try {
      let plugin = plugins.get(request.params.id)
      if (!plugin) return sendError(reply, 404, 'NOT_FOUND', `插件不存在：${request.params.id}`)

      if (body.config !== undefined) {
        plugin = plugins.updateConfig(request.params.id, body.config)
      }
      if (body.enabled !== undefined && body.enabled !== plugin.enabled) {
        plugin = plugins.setEnabled(request.params.id, body.enabled)
      }
      return reply.send({ plugin } satisfies PluginMutationResponse)
    } catch (err) {
      return sendPluginError(reply, err)
    }
  })

  /** 重载插件（改了插件代码之后用） */
  app.post<{ Params: PluginParams }>('/plugins/:id/reload', async (request, reply) => {
    try {
      return reply.send({ plugin: plugins.reload(request.params.id) } satisfies PluginMutationResponse)
    } catch (err) {
      return sendPluginError(reply, err)
    }
  })

  /** 执行插件注册的命令 */
  app.post<{ Params: { id: string; commandId: string } }>(
    '/plugins/:id/commands/:commandId',
    async (request, reply) => {
      try {
        const result = await plugins.runCommand(request.params.id, request.params.commandId)
        return reply.send(result satisfies RunPluginCommandResponse)
      } catch (err) {
        return sendPluginError(reply, err)
      }
    },
  )

  /** 取插件面板数据 */
  app.get<{ Params: { id: string; panelId: string } }>(
    '/plugins/:id/panels/:panelId',
    async (request, reply) => {
      try {
        const panel = await plugins.getPanel(request.params.id, request.params.panelId)
        return reply.send({ panel } satisfies PluginPanelResponse)
      } catch (err) {
        return sendPluginError(reply, err)
      }
    },
  )
}
