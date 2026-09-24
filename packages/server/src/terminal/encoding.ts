/**
 * 终端字符编码桥。
 *
 * 设计要点（这是一个容易踩坑的地方）：
 *
 * 1. **UTF-8 走零拷贝快速路径**
 *    远端输出是字节流，浏览器里的 xterm.js 自带 UTF-8 解码。
 *    因此编码为 utf8 时完全不需要在服务端解码再编码 —— 直接透传 Buffer，
 *    既省 CPU 又天然避免「多字节字符被 chunk 边界切断」的乱码问题。
 *
 * 2. **非 UTF-8 才做转码，且必须用增量解码器**
 *    GBK 的一个汉字占 2 字节，若远端分两次发送（如 0xB7 / 0xD9），
 *    对单个 chunk 独立解码会得到两个乱码字符。
 *    iconv-lite 的 `getDecoder()` 会缓存不完整序列，等下一 chunk 补齐再输出，
 *    这是必须使用它的原因（而不是 `iconv.decode(chunk, 'gbk')`）。
 *
 * 3. **输入方向同理**
 *    浏览器发来的是 UTF-8 字节，需先按 UTF-8 增量解码成字符串，
 *    再按目标编码编码后写入远端。
 */
import iconv from 'iconv-lite'
import type { SupportedEncoding } from '@webterm/shared'

/** iconv-lite 使用的编码名映射（内部名与本项目对外名不同） */
const ICONV_NAME: Record<SupportedEncoding, string> = {
  utf8: 'utf8',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  latin1: 'latin1',
}

export interface EncodingBridge {
  readonly encoding: SupportedEncoding
  /** 是否为直通模式（无需转码） */
  readonly passthrough: boolean
  /** 远端 → 浏览器：把远端字节转换为浏览器可直接渲染的 UTF-8 字节 */
  toClient(chunk: Buffer): Buffer
  /** 浏览器 → 远端：把浏览器的 UTF-8 字节转换为远端期望的编码 */
  toRemote(chunk: Buffer): Buffer
  /** 冲刷可能残留的不完整序列（连接结束时调用） */
  flush(): Buffer
}

/**
 * 直通桥：零拷贝，用于 utf8。
 */
const passthroughBridge: EncodingBridge = {
  encoding: 'utf8',
  passthrough: true,
  toClient: (chunk) => chunk,
  toRemote: (chunk) => chunk,
  flush: () => Buffer.alloc(0),
}

/**
 * 创建一个编码桥。utf8 返回共享的直通实现，其余编码返回带增量解码器的实现。
 */
export function createEncodingBridge(encoding: SupportedEncoding): EncodingBridge {
  if (encoding === 'utf8') return passthroughBridge

  const name = ICONV_NAME[encoding]
  if (!iconv.encodingExists(name)) {
    throw new Error(`不支持的字符编码：${encoding}`)
  }

  // 远端输出方向的增量解码器（处理被切断的多字节序列）
  const decoder = iconv.getDecoder(name)
  // 客户端输入方向的 UTF-8 增量解码器（浏览器发来的字节同样可能被切分）
  const inputDecoder = iconv.getDecoder('utf8')

  return {
    encoding,
    passthrough: false,
    toClient(chunk: Buffer): Buffer {
      if (chunk.length === 0) return chunk
      const text = decoder.write(chunk)
      if (text.length === 0) return Buffer.alloc(0)
      return Buffer.from(text, 'utf8')
    },
    toRemote(chunk: Buffer): Buffer {
      if (chunk.length === 0) return chunk
      const text = inputDecoder.write(chunk)
      if (text.length === 0) return Buffer.alloc(0)
      return iconv.encode(text, name)
    },
    flush(): Buffer {
      // end() 会吐出解码器内残留的字节（不完整序列会被丢弃，这是预期行为）
      const tail = decoder.end() ?? ''
      return tail.length > 0 ? Buffer.from(tail, 'utf8') : Buffer.alloc(0)
    },
  }
}
