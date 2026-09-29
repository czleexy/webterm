/**
 * 脚本沙箱的 worker 源码（以字符串形式内联）。
 *
 * 为什么必须放在独立线程里跑，而不是直接在主进程里 `vm.runInContext`：
 *
 * 实测结论（`data/tmp/probe-worker-timeout.mjs`）——
 * `vm` 的 `timeout` 选项**只覆盖首次同步执行段**：
 *
 * | 脚本形态                                | vm timeout | 结果        |
 * | --------------------------------------- | ---------- | ----------- |
 * | `while(true){}`                         | 生效       | 抛出并恢复  |
 * | `await sleep(5); while(true){}`         | **无效**   | 主线程卡死  |
 * | `for(;;){ await Promise.resolve() }`    | **无效**   | 事件循环饿死 |
 * | `await new Promise(()=>{})`             | **无效**   | 永不返回    |
 *
 * 后三类会让**整个服务**失去响应 —— 一个用户随手写错的脚本就能放倒所有会话，
 * 这是不可接受的。而 `worker.terminate()` 对四类全部有效（前两类由 vm 先拦，
 * 其余由主线程硬终止），因此这里采用「worker + vm」双层：
 * - vm 负责沙箱（不给 require / process / fs，禁用 eval 与 WebAssembly）
 * - worker 负责可终止性（超时后 terminate，线程连同它的死循环一起消失）
 *
 * 为什么用内联字符串而不是一个真实的 .ts 文件：
 * worker 的模块解析走 Node 自己的加载器，开发态的 `tsx` 不会介入，
 * 指向 `./script-worker.js` 在 src 下必然找不到文件。内联源码用
 * `eval: true` 交给 CommonJS 执行，开发态与构建产物行为完全一致。
 *
 * RPC 约定：worker 只做「薄封装 + 组合」，真正的 IO 全部回主线程执行 ——
 * 终端输出缓冲、SFTP 通道、日志上报都握在主线程手里，worker 里不放任何状态。
 */
export const SCRIPT_FILENAME = 'webterm-script.js'

/**
 * 默认的 shell 提示符特征（`session.run` 未显式给 prompt 时使用）。
 * 行尾的 `$` `#` `>` 是最通用的三类提示符。
 */
export const DEFAULT_PROMPT_PATTERN = '[\\s\\S]*[#$>]\\s*$'

/**
 * 发送之后等待「回显刷出来」的短间隔。
 * 少了它，`await session.send('ls'); session.read()` 会读到空 ——
 * 字节刚写到远端，回显还没回来。
 */
export const DEFAULT_SETTLE_MS = 30

export const SCRIPT_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const util = require('node:util');

const SCRIPT_FILENAME = 'webterm-script.js';
const SETTLE_MS = typeof workerData.settleMs === 'number' ? workerData.settleMs : 30;
const DEFAULT_WAIT_MS = 10000;
const DEFAULT_PROMPT = '[\\s\\S]*[#$>]\\s*$';

/* ---------------- 与主线程的 RPC ---------------- */

var seq = 0;
var pending = new Map();

function callHost(method, args) {
  return new Promise(function (resolve, reject) {
    var id = ++seq;
    pending.set(id, { resolve: resolve, reject: reject });
    parentPort.postMessage({ t: 'call', id: id, method: method, args: args });
  });
}

parentPort.on('message', function (msg) {
  if (!msg || msg.t !== 'result') return;
  var entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.value);
  else entry.reject(reviveError(msg.error));
});

function reviveError(payload) {
  var err = new Error(payload && payload.message ? payload.message : '宿主调用失败');
  if (payload && payload.name) err.name = payload.name;
  if (payload && payload.code) err.code = payload.code;
  return err;
}

/* ---------------- 输出与错误 ---------------- */

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return util.inspect(value, { depth: 3, breakLength: 100, compact: true });
  } catch (e) {
    return String(value);
  }
}

function callerLine() {
  var match = /webterm-script\.js:(\d+):\d+/.exec(new Error().stack || '');
  return match ? Number(match[1]) : undefined;
}

function postLog(level, message) {
  parentPort.postMessage({ t: 'log', level: level, message: message, line: callerLine() });
}

function sleep(ms) {
  var wait = Math.min(Math.max(0, Number(ms) || 0), 60000);
  return new Promise(function (resolve) { setTimeout(resolve, wait); });
}

function clampDelay(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(n, 60000);
}

function numberOr(value, fallback) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? n : fallback;
}

/* ---------------- 注入的宿主 API ---------------- */

var sessionApi = Object.freeze({
  info: Object.freeze(Object.assign({}, workerData.session)),

  send: async function (text, opts) {
    var options = opts || {};
    var payload = typeof text === 'string' ? text : stringify(text);
    var enter = options.enter !== false;
    var delayMs = clampDelay(options.delayMs);
    if (delayMs > 0) await sleep(delayMs);
    await callHost('session.send', [enter ? payload + '\r' : payload]);
    if (SETTLE_MS > 0) await sleep(SETTLE_MS);
  },

  write: async function (text) {
    var payload = typeof text === 'string' ? text : stringify(text);
    await callHost('session.send', [payload]);
    if (SETTLE_MS > 0) await sleep(SETTLE_MS);
  },

  waitFor: function (pattern, opts) {
    return callHost('session.waitFor', [String(pattern), opts || {}]);
  },

  expect: function (patterns, opts) {
    var list = Array.isArray(patterns) ? patterns.map(String) : [String(patterns)];
    return callHost('session.expect', [list, opts || {}]);
  },

  readUntil: function (pattern, opts) {
    return callHost('session.readUntil', [String(pattern), opts || {}]);
  },

  read: function () {
    return callHost('session.read', []);
  },

  clear: function () {
    return callHost('session.clear', []);
  },

  run: async function (command, opts) {
    var options = opts || {};
    var timeoutMs = numberOr(options.timeoutMs, DEFAULT_WAIT_MS);
    await callHost('session.clear', []);
    await sessionApi.send(command);
    var pattern = options.prompt !== undefined ? String(options.prompt) : DEFAULT_PROMPT;
    var isRegex = options.prompt === undefined ? true : !!options.regex;
    try {
      return await callHost('session.readUntil', [pattern, { timeoutMs: timeoutMs, regex: isRegex }]);
    } catch (err) {
      // 设备没有可识别的提示符是常态：超时就把已读到的内容交出去，
      // 而不是让整段脚本因为「收尾没认出来」而失败
      if (err && err.code === 'TIMEOUT') return await callHost('session.read', []);
      throw err;
    }
  },
});

var sftpApi = Object.freeze({
  list: function (path) { return callHost('sftp.list', [String(path)]); },
  stat: function (path) { return callHost('sftp.stat', [String(path)]); },
  read: function (path, opts) {
    var encoding = opts && opts.encoding !== undefined ? opts.encoding : 'utf8';
    return callHost('sftp.read', [String(path), { encoding: encoding }]);
  },
  write: function (path, content) { return callHost('sftp.write', [String(path), content]); },
  exists: function (path) { return callHost('sftp.exists', [String(path)]); },
});

var consoleShim = {};
['debug', 'info', 'log', 'warn', 'error'].forEach(function (name) {
  consoleShim[name] = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i += 1) parts.push(stringify(arguments[i]));
    postLog(name === 'log' ? 'info' : name, parts.join(' '));
  };
});
Object.freeze(consoleShim);

/* ---------------- 沙箱 ---------------- */

var globals = {
  session: sessionApi,
  sftp: sftpApi,
  log: function (message, level) {
    postLog(typeof level === 'string' ? level : 'info', stringify(message));
  },
  console: consoleShim,
  sleep: sleep,
  target: Object.freeze(Object.assign({}, workerData.session)),
  params: workerData.params === undefined ? {} : workerData.params,
  TextEncoder: TextEncoder,
  TextDecoder: TextDecoder,
};
Object.freeze(globals);

var context = vm.createContext(globals, {
  name: 'webterm-script',
  // 禁掉 eval / new Function / WebAssembly：否则沙箱形同虚设
  codeGeneration: { strings: false, wasm: false },
});

/* ---------------- 运行 ---------------- */

function shapeError(err) {
  if (err && typeof err === 'object') {
    var out = {
      name: err.name || 'Error',
      message: err.message || String(err),
    };
    if (err.code) out.code = String(err.code);
    if (err.stack) out.stack = String(err.stack);
    return out;
  }
  return { name: 'Error', message: String(err) };
}

function safeResult(value) {
  if (value === undefined || value === null) return value;
  var type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return util.inspect(value, { depth: 2, breakLength: 100, compact: true });
  }
}

function isTimeoutError(err) {
  return !!err && /Script execution timed out/i.test(String(err.message || ''));
}

(async function main() {
  var value;
  try {
    var script = new vm.Script('(async () => {\n' + workerData.code + '\n})()', {
      filename: SCRIPT_FILENAME,
      lineOffset: -1,
    });
    value = await script.runInContext(context, { timeout: workerData.timeoutMs });
  } catch (err) {
    parentPort.postMessage({
      t: 'error',
      error: shapeError(err),
      timedOut: isTimeoutError(err),
    });
    return;
  }
  parentPort.postMessage({ t: 'done', result: safeResult(value) });
})();
`
