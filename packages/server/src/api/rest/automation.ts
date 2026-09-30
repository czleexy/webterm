/**
 * 自动化接口：触发器 / 按钮栏宏 / 脚本 / 批量执行。
 *
 * 两类接口的超时策略不同，这是有意的：
 * - **配置类**（CRUD、试匹配、语法校验）同步返回，用户点了就要立刻看到结果
 * - **运行类**（跑脚本、跑宏）返回 **202 + runId** 立即放行，进度与结果走
 *   终端 WebSocket 推送。脚本可能跑几分钟，把它挂在 HTTP 请求上既会撞网关超时，
 *   也让「运行中」这个状态无处安放。
 * - **批量执行**是例外：它必须同步返回完整结果表（前端要立刻导出 CSV），
 *   但每个目标都有独立的超时兜底，不会无限期挂着。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type {
  ListMacrosResponse,
  ListScriptsResponse,
  ListTriggersResponse,
  RunBatchResponse,
  RunMacroResponse,
  RunScriptResponse,
  ScriptRunRecord,
  TestTriggerResponse,
} from '@webterm/shared'
import { AutomationError } from '../../db/automation.js'
import {
  AutomationFailure,
  type AutomationFailureCode,
} from '../../automation/errors.js'
import { testTriggerPattern } from '../../automation/triggers.js'
import { validateScriptSyntax } from '../../automation/script-validate.js'
import { LibraryError } from '../../db/library.js'
import { VaultError } from '../../security/vault.js'
import {
  CreateMacroRequestSchema,
  CreateScriptRequestSchema,
  CreateTriggerRequestSchema,
  RunBatchRequestSchema,
  RunMacroRequestSchema,
  RunScriptRequestSchema,
  TestTriggerRequestSchema,
  UpdateMacroRequestSchema,
  UpdateScriptRequestSchema,
  UpdateTriggerRequestSchema,
  ValidateScriptRequestSchema,
} from '../schemas.js'
import { sendError, sendValidationError } from '../errors.js'

/** 自动化类错误 → HTTP 状态码 */
const STATUS_BY_AUTOMATION_CODE: Record<AutomationFailureCode, number> = {
  TIMEOUT: 504,
  SANDBOX: 400,
  RUNTIME: 422,
  SESSION_CLOSED: 409,
  SESSION_NOT_SSH: 400,
  UNSUPPORTED: 400,
  SFTP: 502,
  NOT_FOUND: 404,
  INVALID: 400,
  BUSY: 409,
}

/** 四种错误类型（自动化 / 存储 / 保险库 / 会话库）统一出口 */
function sendAutomationError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AutomationFailure) {
    const message = err.hint ? `${err.message}\n\n${err.hint}` : err.message
    return sendError(reply, STATUS_BY_AUTOMATION_CODE[err.code] ?? 500, err.code, message)
  }
  if (err instanceof AutomationError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'IN_USE' ? 409 : 400
    return sendError(reply, status, err.code, err.message)
  }
  if (err instanceof VaultError) {
    return sendError(reply, 423, err.code, err.message)
  }
  if (err instanceof LibraryError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400
    return sendError(reply, status, err.code, err.message)
  }
  return sendError(reply, 500, 'INTERNAL', err instanceof Error ? err.message : String(err))
}

export const automationRoutes: FastifyPluginAsync = async (app) => {
  const store = app.automationStore
  const automation = app.automation

  /* ------------------------------------------------------------------ */
  /* 触发器                                                              */
  /* ------------------------------------------------------------------ */

  app.get('/automation/triggers', async (): Promise<ListTriggersResponse> => {
    return { rules: store.listTriggers(), stats: automation.triggerStats() }
  })

  app.post('/automation/triggers', async (request, reply) => {
    const parsed = CreateTriggerRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const rule = store.createTrigger(parsed.data)
      // 规则是低频写、高频读的：改完立刻重建各会话的引擎，用户不必重连才能生效
      automation.refreshAll()
      return reply.code(201).send({ rule })
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  app.patch<{ Params: { id: string } }>('/automation/triggers/:id', async (request, reply) => {
    const parsed = UpdateTriggerRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const rule = store.updateTrigger(request.params.id, parsed.data)
      if (!rule) return sendError(reply, 404, 'NOT_FOUND', '规则不存在或已被删除')
      automation.refreshAll()
      return reply.send({ rule })
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/automation/triggers/:id', async (request, reply) => {
    if (!store.removeTrigger(request.params.id)) {
      return sendError(reply, 404, 'NOT_FOUND', '规则不存在或已被删除')
    }
    automation.refreshAll()
    return reply.code(204).send()
  })

  app.post('/automation/triggers/test', async (request, reply) => {
    const parsed = TestTriggerRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    const result: TestTriggerResponse = testTriggerPattern(parsed.data)
    return reply.send(result)
  })

  /* ------------------------------------------------------------------ */
  /* 按钮栏 / 宏                                                         */
  /* ------------------------------------------------------------------ */

  app.get('/automation/macros', async (): Promise<ListMacrosResponse> => {
    return { macros: store.listMacros() }
  })

  app.post('/automation/macros', async (request, reply) => {
    const parsed = CreateMacroRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const macro = store.createMacro(parsed.data)
      return reply.code(201).send({ macro })
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  app.patch<{ Params: { id: string } }>('/automation/macros/:id', async (request, reply) => {
    const parsed = UpdateMacroRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const macro = store.updateMacro(request.params.id, parsed.data)
      if (!macro) return sendError(reply, 404, 'NOT_FOUND', '按钮不存在或已被删除')
      return reply.send({ macro })
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/automation/macros/:id', async (request, reply) => {
    if (!store.removeMacro(request.params.id)) {
      return sendError(reply, 404, 'NOT_FOUND', '按钮不存在或已被删除')
    }
    return reply.code(204).send()
  })

  app.post('/automation/macros/run', async (request, reply) => {
    const parsed = RunMacroRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const result: RunMacroResponse = automation.runMacro(parsed.data)
      // 阶段 7：宏执行审计
      const macroName = parsed.data.macroId
        ? (store.getMacro(parsed.data.macroId)?.name ?? parsed.data.macroId)
        : (parsed.data.macroName ?? '内联宏')
      app.logging.recordAudit('macro_run', macroName, request.ip || '—', { name: macroName })
      return reply.code(202).send(result)
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  /* ------------------------------------------------------------------ */
  /* 脚本                                                                */
  /* ------------------------------------------------------------------ */

  app.get('/automation/scripts', async (): Promise<ListScriptsResponse> => {
    return { scripts: store.listScripts() }
  })

  app.post('/automation/scripts', async (request, reply) => {
    const parsed = CreateScriptRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    // 语法不合法就挡在入库之前：存一个跑不起来的脚本对谁都没好处
    const validation = validateScriptSyntax(parsed.data.code)
    if (!validation.ok) {
      return sendError(
        reply,
        400,
        'SANDBOX',
        validation.line
          ? `脚本第 ${validation.line} 行存在语法错误：${validation.error}`
          : `脚本存在语法错误：${validation.error}`,
      )
    }

    try {
      const script = store.createScript(parsed.data)
      return reply.code(201).send({ script })
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  app.patch<{ Params: { id: string } }>('/automation/scripts/:id', async (request, reply) => {
    const parsed = UpdateScriptRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)

    if (parsed.data.code !== undefined) {
      const validation = validateScriptSyntax(parsed.data.code)
      if (!validation.ok) {
        return sendError(
          reply,
          400,
          'SANDBOX',
          validation.line
            ? `脚本第 ${validation.line} 行存在语法错误：${validation.error}`
            : `脚本存在语法错误：${validation.error}`,
        )
      }
    }

    try {
      const script = store.updateScript(request.params.id, parsed.data)
      if (!script) return sendError(reply, 404, 'NOT_FOUND', '脚本不存在或已被删除')
      return reply.send({ script })
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  /**
   * 删除脚本。
   * 返回被引用的次数（会话启动脚本 + 触发器动作）—— 静默删掉会让那些会话
   * 下次连接时莫名其妙少跑一段逻辑，用户根本不会想到是这里。
   */
  app.delete<{ Params: { id: string } }>('/automation/scripts/:id', async (request, reply) => {
    const id = request.params.id
    if (!store.getScript(id)) {
      return sendError(reply, 404, 'NOT_FOUND', '脚本不存在或已被删除')
    }
    const references = store.countScriptReferences(id)
    store.removeScript(id)
    return reply.send({ removed: true, references })
  })

  app.post('/automation/scripts/run', async (request, reply) => {
    const parsed = RunScriptRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const result: RunScriptResponse = automation.startScript(parsed.data)
      // 阶段 7：脚本执行审计（名字取保存的定义；内联试运行用「内联脚本」）
      const name = parsed.data.scriptId
        ? (store.getScript(parsed.data.scriptId)?.name ?? parsed.data.scriptId)
        : '内联脚本'
      app.logging.recordAudit('script_run', name, request.ip || '—', { name })
      return reply.code(202).send(result)
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })

  app.post('/automation/scripts/validate', async (request, reply) => {
    const parsed = ValidateScriptRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    return reply.send(validateScriptSyntax(parsed.data.code))
  })

  app.get('/automation/script-runs', async (): Promise<{ runs: ScriptRunRecord[] }> => {
    return { runs: automation.scriptRuns() }
  })

  /* ------------------------------------------------------------------ */
  /* 批量执行                                                            */
  /* ------------------------------------------------------------------ */

  app.post('/automation/batch', async (request, reply) => {
    const parsed = RunBatchRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendValidationError(reply, parsed.error)
    try {
      const result: RunBatchResponse = await automation.runBatch(parsed.data)
      // 阶段 7：批量执行审计
      app.logging.recordAudit('batch_run', '批量执行', request.ip || '—', {
        count: parsed.data.targets.length,
      })
      return reply.send(result)
    } catch (err) {
      return sendAutomationError(reply, err)
    }
  })
}
