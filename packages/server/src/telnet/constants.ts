/**
 * Telnet 协议常量（RFC 854 / 855 / 857 / 858 / 1073 / 1091 / 1572）。
 *
 * 只列出本项目真正会用到或需要明确拒绝的部分：
 * 未列出的选项一律按「不支持」回复，这对端到端行为没有任何影响 ——
 * 协商的本质就是双方把各自支持的能力摆出来，不支持就明确拒绝，
 * 沉默反而会让对端一直等（这是自制 telnet 客户端最常见的卡死原因）。
 */

/** 命令起始字节。数据流里出现它意味着后面跟的是命令而不是数据 */
export const IAC = 255
/** 子协商结束 */
export const SE = 240
/** No Operation */
export const NOP = 241
/** Data Mark */
export const DM = 242
/** Break */
export const BRK = 243
/** Interrupt Process */
export const IP = 244
/** Abort Output */
export const AO = 245
/** Are You There */
export const AYT = 246
/** Erase Character */
export const EC = 247
/** Erase Line */
export const EL = 248
/** Go Ahead（半双工时代的「该你说了」） */
export const GA = 249
/** 子协商开始 */
export const SB = 250
/** 我愿意（开启） */
export const WILL = 251
/** 我不愿意（关闭） */
export const WONT = 252
/** 请你开启 */
export const DO = 253
/** 请你关闭 */
export const DONT = 254

/** 选项码 */
export const OPT = {
  /** 8 位二进制传输（关闭时才需要转义高位字节） */
  BINARY: 0,
  /** 由服务端回显用户输入 */
  ECHO: 1,
  /** 抑制 Go Ahead，实现全双工 */
  SGA: 3,
  /** 状态查询 */
  STATUS: 5,
  /** 计时标记 */
  TIMING_MARK: 6,
  /** 终端类型 */
  TERMINAL_TYPE: 24,
  /** 窗口尺寸 */
  NAWS: 31,
  /** 行模式（我们要的是逐字符模式，必须拒绝） */
  LINEMODE: 34,
  /** 环境变量 */
  NEW_ENVIRON: 39,
  /** 字符集 */
  CHARSET: 42,
} as const

/** TERMINAL_TYPE 子协商动作 */
export const TTYPE_IS = 0
export const TTYPE_SEND = 1

/** 选项码 → 可读名称（排障面板用） */
export const OPTION_NAME: Record<number, string> = {
  [OPT.BINARY]: '二进制传输',
  [OPT.ECHO]: '回显',
  [OPT.SGA]: '抑制继续',
  [OPT.STATUS]: '状态查询',
  [OPT.TIMING_MARK]: '计时标记',
  [OPT.TERMINAL_TYPE]: '终端类型',
  [OPT.NAWS]: '窗口尺寸',
  [OPT.LINEMODE]: '行模式',
  [OPT.NEW_ENVIRON]: '环境变量',
  [OPT.CHARSET]: '字符集',
}

export function optionName(code: number): string {
  return OPTION_NAME[code] ?? `选项${code}`
}

/**
 * 本端（客户端）愿意开启的选项。
 *
 * - BINARY：声明能处理 8 位数据，避免高位置 1 的字节被当作控制字符
 * - SGA：全双工，否则老设备会等 GA 才让我们输入
 * - TERMINAL_TYPE：把 TERM 报给设备（对路由器/交换机的分页与颜色有影响）
 * - NAWS：上报窗口尺寸，让设备知道该按多少列折行
 *
 * 明确**不含** ECHO 与 LINEMODE：
 * ECHO 是「谁来负责回显」的协商，本端不该主动抢；只有服务端明确表示不回显时
 * 才退回本地回显（见 transport）。
 */
export const LOCAL_SUPPORTED: ReadonlySet<number> = new Set([
  OPT.BINARY,
  OPT.SGA,
  OPT.TERMINAL_TYPE,
  OPT.NAWS,
])

/**
 * 希望服务端开启的选项：回显与全双工。
 * BINARY 也一并接受 —— 设备主动提出时没有理由拒绝。
 */
export const REMOTE_WANTED: ReadonlySet<number> = new Set([OPT.BINARY, OPT.ECHO, OPT.SGA])
