/**
 * 能力查询接口。
 *
 * 把服务端实际生效的算法档案、编码支持、背压水位暴露给前端，
 * 这样用户排障时不必去翻源码或日志 —— 界面上的「连接信息」直接展示真实值。
 */
import type { FastifyPluginAsync } from 'fastify'
import type { CapabilitiesResponse } from '@webterm/shared'
import {
  BACKPRESSURE_HIGH_WATER_MARK,
  BACKPRESSURE_LOW_WATER_MARK,
  CONNECTION_PROTOCOLS,
  MAX_TUNNELS_PER_SESSION,
  SUPPORTED_ENCODINGS,
  TUNNEL_TYPES,
} from '@webterm/shared'
import { describeProfiles, getSsh2Version } from '../../ssh/algorithms.js'

export const capabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get('/capabilities', async (): Promise<CapabilitiesResponse> => {
    return {
      ssh2Version: getSsh2Version(),
      nodeVersion: process.version,
      profiles: describeProfiles(),
      supportedEncodings: [...SUPPORTED_ENCODINGS],
      supportedProtocols: [...CONNECTION_PROTOCOLS],
      supportedTunnelTypes: [...TUNNEL_TYPES],
      maxTunnelsPerSession: MAX_TUNNELS_PER_SESSION,
      automation: app.automation.capabilities(),
      logging: app.logging.capabilities(),
      backpressureHighWaterMark: BACKPRESSURE_HIGH_WATER_MARK,
      backpressureLowWaterMark: BACKPRESSURE_LOW_WATER_MARK,
    }
  })
}
