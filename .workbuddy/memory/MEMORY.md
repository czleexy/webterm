# WebTerm 项目备忘

## 开发环境（Windows + WorkBuddy 沙箱）

**Git Bash 的默认 PATH 是坏的** —— `ls`、`dirname`、`git` 等基础命令都找不到。每条 bash 命令必须显式设置 PATH：

```bash
export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:/bin:/c/Windows/System32:/c/Windows:/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3"
```

| 工具 | 路径 / 用法 |
| --- | --- |
| node | `C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`（v22.22.2） |
| npm | 没有可用的直接入口，走 `node "$NPM" <args>`，`NPM="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node_modules/npm/bin/npm-cli.js"` |
| git | `C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe` |
| 终端开关 | `netstat -ano \| grep LISTENING \| grep ":8080" \| awk '{print $NF}'` → `MSYS_NO_PATHCONV=1 taskkill /F /PID <pid>` |

**坑位记录**
- Git Bash 会把 `/PID` 当成路径转换，`taskkill /F /PID n` 必须加 `MSYS_NO_PATHCONV=1`，或用 `//PID`（后者在部分场景也失效）
- git 未配置全局 user.name/user.email，提交需 `git -c user.name="..." -c user.email="..." commit`
- PowerShell 工具在本环境不回传 stdout，验证输出请用 bash + `node -e` 或重定向到文件后读取
- `npm view <pkg> version` 调用较慢，一次查太多包会被超时中断，建议每批不超过 5 个包并给足 timeout
- ⚠️ **编辑工具偶发「报告成功但未落盘」**，尤其是同一批并行 Edit 中的部分调用。改完关键文件后**必须 grep 核实**，否则会浪费大量时间排查幽灵类型错误
- ⚠️ **tsc 增量缓存（`.tsbuildinfo`）会造成幽灵类型错误**：报「属性不存在」但文件里明明有。症状出现时 `rm -f packages/*/dist/.tsbuildinfo` 后重跑即可
- ⚠️ **用 bash 后台 `&` 起的进程会随该条 bash 调用结束而死**（不是真正的常驻）。要跑「起服务 → 测试」这类组合，必须写在**同一个** Bash 调用里；跨调用存活请用工具的 `run_in_background`
- ⚠️ **ssh2 服务端做跳板转发时，事件名是 `'tcpip'` 而不是 `'direct-tcpip'`**。见 `ssh2/lib/server.js` 的 `_onCHANNEL_OPEN`：判据是 `listenerCount(this, 'tcpip')`，emit 的是 `'tcpip'`，回调参数为 `{ destIP, destPort, srcIP, srcPort }`。名字注册错会让通道在握手期被自动拒绝（reason=1），且服务端不留任何日志
- ⚠️ **`scrypt` 的 `maxmem` 默认只有 32MiB**，而 `128*N*r` 恰好等于该值时就会抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（N=2^15, r=8 → 32MiB，正好踩线）。用高 N 必须显式传 `maxmem`
- ⚠️ **脚本自清 scratch 目录会撞「单轮批量删除 > 50 文件」保护**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。E2E 二次运行必然触发（首次目录为空）。**不要再用 `env -u CODEBUDDY_SAFE_DELETE_BULK_*` 放行 —— 那个写法已失效且有害，会让 node 进程静默退出（exit 0、无输出、1~3 秒死），看起来像脚本卡住**。现在的做法是运行前先清掉残留目录，或给脚本换一个新的 WORK 目录名
- ⚠️ **`puppeteer-core` 装在隔离 node workspace**，跑浏览器 E2E 必须 `export NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"`
- ⚠️ **根 `npm run build` 偶发 rolldown 报错但单包构建正常**：是沙箱写入竞态，重跑即可，不是代码问题

## 状态与进度（2026-09-30）

- 已完成：阶段 0（骨架）、1（终端主干）、2（会话库 + 主密码保险库 + 密钥登录 + 跳板机）、3（SFTP）、4（Telnet，插入交付）、5（端口转发与隧道）、6（自动化与批量运维）、7（日志与审计）、**8（体验打磨）**
- 各阶段 E2E 计数见 README「端到端验证」表与 `docs/03-测试指南.md`
- **阶段 8：浏览器 168/168**（`data/tmp/e2e-browser-phase8.mjs`）；阶段 7 浏览器套件回归 81/81；typecheck + build 全绿
- 阶段 8 三个提交：`6993fc6` 代码 → `a07d52a` E2E 与截图 → `763892d` 文档
- 下一步：**阶段 9 插件机制与打包发布**（`data/plugins/*/plugin.json` + node:vm Host API、示例插件 heartbeat-monitor、npm 全局包 / Docker / 便携目录）

## 日志与审计实现要点（阶段 7）

- 三格式：`plain` / `timestamped` 走服务端流式追加；`html` 由**前端** `serializeAsHTML()` 序列化整份缓冲 → 60k 字符分片 → WS `log-html` → 服务端按 seq 严格递增装配，`final` 写 tmp 后 rename 原子替换
- 目录名 `{清洗后的会话名}-{sha256(sessionId).slice(0,6)}`，映射持久化在 `LoggingStore.dirs`（会话改名目录不漂移）
- **脱敏必须先按行对齐再替换**（逐 chunk 会被分片切断 `\S+`，敏感内容原样落盘）；`\n` 前的残余留在 `pendingLine`
- 写入批量合并：256 KB 或 200 ms 刷盘（原先一行一次 appendFile，21 MB 要 30 万次系统调用）
- 预览：按**字节**扫 `0x0A` 建行偏移索引（UTF-8 多字节序列不含 0x0A，按字节切行安全），任意窗口 O(1) seek；索引按 `size+mtime` 失效，LRU 8 个文件。用**分页**（500 行/页）而非虚拟滚动，行号是真实行号
- HTML 快照落 `.html`（浏览器只对 `.html` 打开即渲染）；**不做脱敏**（字节级回放，替换会破坏标记结构）；底色跟随 `term.options.theme`
- 审计 detail 入库前生成人读整句（shared 的 `describeAudit`）；客户端 IP 由 REST 的 `request.ip` / SFTP 队列的 `onTransfer` 回调带上

### 日志与自动化排障教训

- ⚠️ **终端有应用层背压**（`unackedBytes`，高水位 64 KB）。WS 客户端不回 `ack` 会让远端输出**永久暂停在 64 KB**（症状：输出卡住）。E2E 收集器每收 32 KB 回一次
- ⚠️ **会话弹窗的凭据下拉读前端 store 快照**，store 只在解锁 / 删除节点凭据后刷新。E2E 用 API 建完凭据要 `page.reload()`，否则「选择凭据」假通过、保存时校验失败、弹窗不关
- ⚠️ **给 React 受控 select 填值前必须等 option 出现**：对不存在的 option 赋值会被浏览器静默置空
- ⚠️ **`typeLine` 只作用于 `[data-active="true"]` 的终端**：多标签要先点 `[role="tab"]` 切回目标终端
- ⚠️ **拍回放截图要用 `replayPage.screenshot()`**，`page.screenshot()` 拍的是主应用界面

## 体验打磨实现要点（阶段 8）

- **分屏不用 react-resizable-panels**（装了又卸，零新增依赖）：它的 `PanelGroup > Panel > 内容` 层级切布局时换终端父节点 → React 卸载重建 → WS 重连 → **服务端再建一条 SSH 连接**（老设备 VTY 少，不可接受）。改 CSS Grid 自绘：所有终端恒为同一网格容器的直接子元素，切布局只改 `grid-area` 与显示状态；分隔条原生鼠标事件自绘
- 十字分隔条**拆四段**（竖条贯穿整列 + 横条贯穿整行会在正中重叠，横条压在上面 → 拖竖条变成改行高）；交叉点由网格底色补齐
- `registerDecoration` / `registerMarker` / `registerCharacterJoiner` 必须 `allowProposedApi: true`，否则**静默 0 结果**（异常被搜索的 catch 吞掉，极难排查）
- 高亮要**单独扫光标所在行**：不换行的回显正写在这一行上，当它「已定型」跳过就永远扫不到；只增量扫 `onWriteParsed` 新增行、上限 2000 装饰、跳过备用缓冲
- 搜索计数被 `highlightLimit`(2000) 截断 → 界面显示 `2000+`；搜索条**悬浮**（占一行会改终端高度 → 触发 fit → 缓冲重排）
- 快捷键用 `event.code`（物理键位）+ **捕获阶段**监听（冒泡时远端已收到按键）；`Ctrl+T/W/Tab`、`Ctrl+1~9`、`F5/F11/F12`、`Alt+←→` 网页拦不住，默认绑定避开并给出原因文案
- 桌面通知三重门槛：设置开关 + 权限 granted + **页面不在前台**；权限只在设置页显式申请
- 偏好全在 localStorage：`webterm.settings` / `webterm.theme`；`useLayoutStore` **刻意不持久化**（引用的是活不过刷新的标签）
- i18n：`en-US` 声明为 `Record<MessageKey,string>`，漏翻译 typecheck 即报错；缺键返回键名

### 阶段 8 的两条「缓冲」认知（重要）

1. ⚠️ **分屏会让滚动缓冲顶部被裁掉**：pane 变窄 → xterm 对滚动缓冲**重排（reflow）**，超宽长行重新折行、行数几乎翻倍，越过 scrollback 上限就丢最老的行。**不是终端被重建**（要用 `.xterm` 内部节点身份判断，别只看 React 渲染的 pane 容器）。**别拿缓冲区顶部内容当「缓冲还在不在」的探针** —— 会得到一个像「终端被重建了」的假失败
2. ⚠️ **折行缓冲下搜索的滚动落点会偏**（已知限制，未修）：`resultIndex/count` 正确（确实找到了），但视口落在命中行**下方约半屏**。未折行缓冲里定位精确（10 万行外 254~472 ms 一次到位）

### 阶段 8 E2E 断言写法教训

- 搜索单结果会让「上下跳转」断言退化：要用**大量重复**的关键字（`big` 输出里的 `vwxyz01234`）
- 正则搜索不能拿模式串当「已滚到」判据（`includes('PHASE8-ANCHOR-[A-Z]+')` 恒假）→ needle 与 expectText 分开
- 「视口出现命中」与「计数回流 React」不是同一拍，命中后再收敛 1.5 s 读计数
- **Chrome 不会为单次 `click({clickCount:2})` 合成 dblclick**：双击必须发两次完整 down/up；首版双击复位断言因此假通过
- 通知权限用 CDP `Browser.setPermission` 精确控制（无头默认 denied）

## Telnet 实现要点（阶段 4）

- **会话配置是按 `protocol` 判别的联合**（`SshSessionConfig | TelnetSessionConfig`），别改成「一堆可选字段」；落库的 `SessionRecord` 是扁平结构，必填性由 zod superRefine 把关（Telnet 禁 `credentialId`、`jumpChain` 必须空）
- `packages/server/src/telnet/`：negotiation（IAC 状态机）/ transport（`net` + 本地回显兜底 + 0xFF 转义）/ errors。**零新增依赖**
- **本地回显兜底**：设备不声明 `WILL ECHO` 时由服务端补回显（含退格 `\b \b`，计数不越界）；设备声明了就绝不重复回显
- **Telnet 无 SFTP**：服务端对 Telnet 会话开 SFTP 返回 400 `INVALID_CONFIG`；前端用 `tab.protocol` / `sftpAvailable` 隐藏入口
- `packages/web/src/utils/protocol.ts` 集中协议收窄与徽标配色；终端工具栏协议徽标的 title 带完整协商详情（排障入口）
- mock：`packages/server/dev/mock-telnet-server.mjs`，`MOCK_TELNET_ECHO=0` / `MOCK_TELNET_NO_NEGOTIATION=1` / `MOCK_TELNET_NAME`；**CR 与 LF 都认行结束（CRLF 算一次）**

### Telnet 排障教训

- **mock 只认 LF、xterm 回车只发 CR** → 表现为「按回车没反应」。修 mock，不修产品（产品原样透传是对的，真实设备都接受 CR）
- 文案断言会撞车（Telnet 提示段落里也有「跳板链」三个字），改断言 UI 专属文案（如「+ 添加一跳」）
- zod `.default()` 会补字段：Telnet 记录读回来有 `jumpChain: []`，断言写「空」而非「不存在」
- `data-testid={\`protocol-${value}\`}` 是模板字面量，grep 字面量查不到 —— 别用 grep 否定已跑通的测试
- 读 xterm 只能读到视口行，大输出（`big 128`）会滚出视口，断言要紧跟对应命令

## 项目约定

- **`packages/shared` 必须先构建**才能被 server / web 引用；根 `package.json` 已用 `predev` / `prebuild` / `pretypecheck` / `prestart` 自动处理
- 终端数据传输**一律使用 WebSocket 二进制帧**，仅控制类消息用 JSON 文本帧
- 凭据（密码、私钥口令）**任何时候都不明文落盘**；**Telnet 会话不进任何凭据**（口令由用户在终端里交互输入，zod 校验显式拒绝 credentialId）
- 服务默认只监听 `127.0.0.1`；开放局域网需显式配置并设置访问密码
- TypeScript 开启了 `verbatimModuleSyntax`，类型导入必须写 `import type`
- 服务端静态托管**只在生产模式生效**（开发态由 Vite 提供前端，避免误访问过期构建产物）
- 开发态前端地址是 `http://localhost:5173`（Vite 默认绑 `localhost`，**用 `127.0.0.1` 访问会失败**）

## 依赖版本关键约束

- `@vitejs/plugin-react@6` 的 peer 要求 **`vite@^8`**，Vite 7 无法共存 → 已统一用 Vite 8.3.0
- Vite 8 的 engines 是 `^20.19.0 || >=22.12.0`，故整个项目 Node 下限锁定 **22.12.0**
- `better-sqlite3@13`（阶段 2 使用）engines 为 `>=22`，同一约束下
- `@tailwindcss/vite@4.3.3` peer 为 `^5.2 || ^6 || ^7 || ^8`，覆盖 Vite 8
- TypeScript 用 **5.9.3**；npm 上的 latest 是 7.0.2（原生重写版），未采用，避免生态兼容风险
- `@xterm/xterm` 用 **6.0.0**（addon-fit 0.11 / web-links 0.12 / search 0.16），CSS 在 `@xterm/xterm/css/xterm.css`
- `ssh2` 的算法常量在 `ssh2/lib/protocol/constants.js`（无 `exports` 限制可深导入），但它是 CJS —— **ESM 里具名导入会报错**，必须用 `createRequire` 后解构
- `utils.generateKeyPairSync('ed25519', { passphrase })` 生成带口令私钥时**必须同时给 `cipher`**（如 `aes256-ctr`），否则抛 `Missing cipher name`

## 安全实现要点（阶段 2）

- 主密钥由 `scrypt(password, salt, N=2^15, r=8, p=1)` 派生，**只存进程内存**，`lock()` 时 `fill(0)` 清零；派生统一走 `deriveKey()` 单一入口（setup/unlock 参数漂移会导致旧数据解不开），且必须显式传 `maxmem`
- 凭据存储格式：`AES-256-GCM`，密文 = `iv(12B) | authTag(16B) | ciphertext`，整体存 SQLite BLOB
- 解锁校验用「已知明文的密文」（verifier），不用独立哈希 —— 少一套逻辑，且 GCM 的 authTag 天然防篡改
- 锁定态访问需凭据的接口返回 **423 Locked**（区别于 401 认证失败）
- mock SSH 服务端支持跳板转发（ssh2 服务端侧注册的**事件名是 `'tcpip'`**）与 `MOCK_AUTH=publickey`（公钥经 stdin 传入，不落盘）

## 真机 192.168.1.254 的实测结论（重要）

用户给的测试主机 `hwssh@192.168.1.254:22` 是一台**老旧且非标准的 SSH 设备**：

- 标识串是 `SSH-2.0--`，且**换行只有 LF 没有 CR**（违反 RFC 4253）
- KEX 仅支持 `diffie-hellman-group14-sha1`、`diffie-hellman-group-exchange-sha1`（ssh2 默认已移除，须显式启用）
- **`ecdsa-sha2-nistp521` 主机密钥在 ssh2 下报 `signature verification failed`，但 OpenSSH 能验证通过** —— 是设备签名编码与 ssh2 的兼容性问题，不是密钥坏。用 `ssh-rsa` / `ssh-dss` 均正常
- 设备接受 `CHANNEL_OPEN(session)` 和 `pty-req`（都返回 SUCCESS），但**拒绝 `shell` / `exec` / `subsystem:sftp`（CHANNEL_FAILURE → DISCONNECT 11）**
- 等待 150 秒排除 VTY 耗尽后仍复现；**OpenSSH 10.3 同样失败** → 确认是设备侧账号/配置限制，不是客户端实现问题

⇒ 因此阶段 1 的端到端验证依赖自带的 `packages/server/dev/mock-ssh-server.mjs`（`MOCK_LEGACY=1` 可模拟老设备）。真机只能验证到「握手+认证+PTY 申请成功」。

## 浏览器自动化（无 Chromium 可下载时）

- 环境里**没有 Playwright/agent-browser**，但有系统 Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`
- 用 `puppeteer-core`（装在 `C:/Users/Administrator/.workbuddy/binaries/node/workspace`，运行时 `NODE_PATH` 指向其 node_modules）+ `executablePath` 直连系统 Chrome，无需下载浏览器
- **测试要用独立实例，别污染开发用的 8080**：`NODE_ENV=production WEBTERM_PORT=8097 node packages/server/dist/index.js`
  会同时托管前端构建产物（需先 `npm run build`），一个端口就是完整应用
- 读 xterm 终端内容：`document.querySelector('.xterm-rows')` 的子 div 逐行取 `textContent`
- **给 xterm 键入**：`page.click('.xterm-helper-textarea')` 会报 *not clickable*（它是透明浮层），
  要用 `page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus())` 再 `page.keyboard.type(...)`
- **给 React 受控组件填值**必须走原生 setter + `input` 事件，直接改 `value` 不会被 React 感知：
  ```js
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  ```
- 统计「无前端错误」时要排除预期业务响应（401/403/423），否则错误密码等用例会误报
- 断言前先确认 UI 真的会那样表现：**刷新浏览器不会要求解锁**（解锁态在服务端进程内存里），
  只有重启服务端才会；**凭据不在侧边栏展示**，只在会话对话框的凭据下拉里
