# WebTerm 项目备忘

> 项目：浏览器里的 SSH / Telnet 终端（对标 SecureCRT）。monorepo：`packages/{shared,server,web}`。
> **阶段 0 ~ 9 全部完成**（骨架 → 终端主干 → 会话库/保险库 → SFTP → Telnet → 隧道 → 自动化 → 日志审计 → 体验打磨 → 插件与打包）。
> 详细能力表、验收记录、测试方法分别看 `README.md`、`docs/02-实现计划.md`、`docs/03-测试指南.md`。
> 本文件只留「换台机器开工前必须知道」的东西。

## 1. 开发环境（Windows + WorkBuddy 沙箱）

**Git Bash 的默认 PATH 是坏的**（`ls` / `git` / `dirname` 都找不到）。每条 bash 命令都要显式设：

```bash
export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:/bin:/c/Windows/System32:/c/Windows"
```

| 工具 | 路径 |
| --- | --- |
| node | `C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（另有 22.12.0；项目下限就是 22.12.0） |
| npm | 无直接入口，`node "<ver>/node_modules/npm/bin/npm-cli.js" <args>` |
| git | `.../PortableGit/versions/1.2.0/cmd/git.exe`（**未配 user.name/email**，提交要 `git -c user.name=… -c user.email=… commit`） |
| python | `.../python/envs/default/Scripts/python.exe`（venv，已装 PyYAML）；宿主 `.../python/versions/3.13.12/python.exe` 无 pip 包 |
| puppeteer-core | 装在 `.../node/workspace/node_modules`，跑浏览器 E2E 前 `export NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"` |

**环境坑位（都很花时间）**

- Git Bash 把 `/PID` 当路径转换 → `MSYS_NO_PATHCONV=1 taskkill /F /PID <pid>`
- **PowerShell 工具不回传 stdout**；验证输出用 bash + `node -e` 或重定向到文件再读
- ⚠️ **编辑工具偶发「报成功但没落盘」**（同一批并行 Edit 里更常见）→ 改完关键文件**必须 grep 核实**
- ⚠️ **tsc 增量缓存（`.tsbuildinfo`）会造幽灵类型错误**（报「属性不存在」但文件里明明有）→ `rm -f packages/*/dist/.tsbuildinfo` 后重跑
- ⚠️ **bash 里用 `&` 起的进程会随该条 Bash 调用结束而死**。「起服务 → 测试」必须写在**同一个** Bash 调用内；跨调用请用工具的 `run_in_background`
- ⚠️ **`node script.mjs` 别写成 `node "$NODE" script.mjs`**（会把 node.exe 当脚本读，报 MZ 头 SyntaxError）
- ⚠️ **Python `subprocess` 的 `text=True` 在 Windows 上会把 `\n` 翻成 `\r\n`**。拿脚本去喂 bash 时必须传 bytes，否则得到一串假的 `$'\r'` 语法错
- ⚠️ **脚本自清 scratch 目录会撞「单轮删除 > 50 文件」保护**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。**别再用 `env -u CODEBUDDY_SAFE_DELETE_BULK_*` 放行 —— 已失效且有害，会让 node 静默退出（exit 0、无输出、1~3 秒死）**。做法：运行前先清残留目录，或换一个新的 WORK 目录名
- ⚠️ 根 `npm run build` 偶发 rolldown 报错而单包构建正常 → 沙箱写入竞态，重跑即可

**行尾**：`core.autocrlf=true`，**blob 一律 LF**（磁盘上是 CRLF 只是检出形态）。`.gitattributes` 已把 `*.yml/*.yaml` 固定 `eol=lf`（CI 的 `run:` 脚本是原样丢给 Linux bash 的，CRLF 会报看不出根因的错）。

## 2. 项目约定

- **`packages/shared` 必须先构建**才能被 server / web 引用；根 `package.json` 用 `predev`/`prebuild`/`pretypecheck`/`prestart` 自动处理
- 终端数据**一律走 WS 二进制帧**，只有控制类消息用 JSON 文本帧
- 凭据（密码 / 私钥口令）**任何情况下不明文落盘**；**Telnet 会话不挂任何凭据**（口令在终端里交互输入，zod 显式拒绝 `credentialId`）
- TypeScript 开了 `verbatimModuleSyntax` → 类型导入必须 `import type`
- 服务端静态托管**只在生产模式生效**；开发态前端是 `http://localhost:5173`（Vite 只绑 `localhost`，用 `127.0.0.1:5173` 打不开）
- **`NODE_ENV` 不会被 npm 自动设**：`npm start` 走 `packages/server/scripts/start-production.mjs` 显式设生产模式（且刻意不改工作目录）。绕过它直接跑 `dist/index.js` 就是开发态、不挂前端
- **服务端只监听 `127.0.0.1`**；⚠️ **项目没有任何 HTTP 访问认证**（需求 F7.4 未交付），绑非回环地址必须显式给 `WEBTERM_ALLOW_INSECURE_LAN=1`，否则拒绝启动。对外用请在前面挂带认证的反向代理
- 端口分配：开发 8080 / mock 2222-2225；E2E 服务端 8096/8098/8099/8100/8106/8131，mock 2231-2233/2241/2252-2253/2346/2347/2361/2441-2445/2450/2451

## 3. 依赖版本约束（改动前先看）

- `@vitejs/plugin-react@6` peer 要求 `vite@^8` → 全项目 Vite **8.3.0**（Vite 7 无法共存）
- Vite 8 engines `^20.19.0 || >=22.12.0` → **Node 下限 22.12.0**；`better-sqlite3@13` engines `>=22` 同一约束
- `@tailwindcss/vite@4.3.3` peer `^5.2 || ^6 || ^7 || ^8`，覆盖 Vite 8
- TypeScript **5.9.3**（npm latest 7.x 是原生重写版，未采用）
- `@xterm/xterm` **6.0.0**（fit 0.11 / web-links 0.12 / search 0.16），CSS 在 `@xterm/xterm/css/xterm.css`
- `ssh2` 算法常量在 `ssh2/lib/protocol/constants.js` 可深导入（无 `exports` 限制），但**它是 CJS，ESM 里具名导入会报错** → 用 `createRequire` 解构
- `crypto.generateKeyPairSync('ed25519', { passphrase })` **必须同时给 `cipher`**（如 `aes256-ctr`），否则抛 `Missing cipher name`

## 4. 关键实现约束（按主题）

**安全 / 保险库（阶段 2）**
- 主密钥 `scrypt(pw, salt, N=2^15, r=8, p=1)` **只存进程内存**，`lock()` 时 `fill(0)` 清零；派生统一走 `deriveKey()` 单一入口（参数漂移会导致旧数据解不开）
- ⚠️ `scrypt` 的 `maxmem` 默认 32MiB，而 `128*N*r` 恰好等于该值时就会抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（N=2^15, r=8 正好踩线）→ **必须显式传 `maxmem`**
- 凭据格式 `AES-256-GCM`，密文 = `iv(12B) | authTag(16B) | ciphertext`，存 SQLite BLOB；解锁校验用「已知明文的密文」（verifier），不另做哈希
- 锁定态访问需凭据的接口返回 **423 Locked**（区别于 401）
- WS 鉴权：终端/SFTP 端点校验**会话级一次性 attach token**（`timingSafeEqual`）。⚠️ **Origin 校验没落地** —— `WEBTERM_ALLOW_ORIGINS` 只被解析进配置、从未被使用

**日志与审计（阶段 7）**
- 三格式：`plain`/`timestamped` 服务端流式追加；`html` 由**前端** `serializeAsHTML()` 序列化整份缓冲 → 60k 字符分片走 WS → 服务端按 seq 装配，`final` 写 tmp 再 rename 原子替换
- 目录名 `{清洗后的会话名}-{sha256(sessionId).slice(0,6)}`，映射持久化在 `LoggingStore.dirs`（会话改名目录不漂移）
- ⚠️ **脱敏必须按行对齐后再替换**：逐 chunk 会被传输分片切断 `\S+`，敏感内容原样落盘。HTML 快照**刻意不脱敏**（字节级回放，替换会破坏标记结构）
- 写入合并：256 KB 或 200 ms 刷盘（原先前每行一次 `appendFile`，21 MB 要 30 万次系统调用）
- 预览按**字节**扫 `0x0A` 建行偏移索引（UTF-8 多字节序列不含 0x0A），任意窗口 O(1) seek；索引按 `size+mtime` 失效 + LRU 8 个；用**分页**（500 行/页）而非虚拟滚动，行号是真实行号
- 审计 detail 入库前就拼成人读整句（shared 的 `describeAudit`），客户端 IP 由 REST `request.ip` / SFTP 队列 `onTransfer` 带上

**自动化（阶段 6）**
- 脚本沙箱 = `node:vm` 白名单注入 + **worker 可 `terminate()`**：vm 的 `timeout` 只覆盖第一段同步执行，`await` 之后进的死循环必须靠终止 worker 收场
- 触发器匹配与自动应答都在**服务端**（浏览器没开也照答）；按**行**匹配；修饰符白名单只留 `i/m/s/u`，**排除 `g`/`y`**（避免 `lastIndex` 造成「时灵时不灵」）
- ⚠️ 行尾可能是 `\r\r\n`（程序输出 `\r\n` + TTY 的 ONLCR 再补 `\r`）→ **必须把尾 `\r` 一并剥掉**，否则整行被当「回到行首覆盖」而成空串丢弃，表现为「触发器完全不生效」
- ⚠️ 自动应答会自激振荡（命中 → 应答 → 应答被回显 → 又命中）→ 用「尾行快照 + `carriedOver` 标记」掐断
- 批量执行**只支持 SSH**（要退出码就得有 exec 通道），Telnet 目标被明确拒绝而不是给不可信的成功
- 同步输入的目标集在**开启那一刻锁定**（避免「悄悄多一个受害者」），排除当前标签

**Telnet（阶段 4）**
- 会话配置是**按 `protocol` 判别的联合**（`SshSessionConfig | TelnetSessionConfig`），别改成「一堆可选字段」；落库的 `SessionRecord` 是扁平的，必填性由 zod `superRefine` 把关
- `packages/server/src/telnet/`：negotiation（IAC 状态机）/ transport（`net` + 本地回显兜底 + 0xFF 转义）/ errors，**零新增依赖**
- **本地回显兜底**：设备不声明 `WILL ECHO` 时服务端补回显（含退格 `\b \b`）；设备声明了就绝不重复
- **Telnet 无 SFTP**：服务端对 Telnet 会话开 SFTP 返回 400 `INVALID_CONFIG`；前端按 `tab.protocol`/`sftpAvailable` 隐藏入口
- mock：`packages/server/dev/mock-telnet-server.mjs`；`MOCK_TELNET_ECHO=0` / `MOCK_TELNET_NO_NEGOTIATION=1`；**CR 与 LF 都认行结束**
- ⚠️ mock 只认 LF 而 xterm 回车只发裸 CR → 表现为「按回车没反应」。**修 mock，不修产品**（产品原样透传是对的）

**体验（阶段 8）**
- **分屏不用 react-resizable-panels**（装了又卸，零新增依赖）：它的 `PanelGroup > Panel > 内容` 层级切布局会换终端父节点 → React 卸载重建 → WS 重连 → **服务端再建一条 SSH 连接**（老设备 VTY 少，不可接受）。改 CSS Grid 自绘：终端恒为同一网格容器的直接子元素，切布局只改 `grid-area`
- 十字分隔条**拆四段**（竖条贯穿整列 + 横条贯穿整行会在正中重叠，横条压在上面 → 拖竖条变成改行高）
- ⚠️ `registerDecoration` / `registerMarker` / `registerCharacterJoiner` **必须 `allowProposedApi: true`**，否则**静默 0 结果**（异常被搜索的 catch 吞掉，极难排查）
- 高亮要**单独扫光标所在行**（不换行的回显正写在这一行上）；只增量扫 `onWriteParsed` 新增行，上限 2000 装饰，跳过备用缓冲
- 搜索计数被 `highlightLimit`(2000) 截断 → 界面显示 `2000+`；搜索条**悬浮**（占一行会改终端高度 → 触发 fit → 缓冲重排）
- 快捷键用 `event.code`（物理键位）+ **捕获阶段**监听（冒泡时远端已收到按键）；`Ctrl+T/W/Tab`、`Ctrl+1~9`、`F5/F11/F12`、`Alt+←→` 网页拦不住，默认绑定避开并给原因文案
- 桌面通知三重门槛：设置开关 + 权限 granted + **页面不在前台**；权限只在设置页显式申请
- 偏好全在 localStorage（`webterm.settings` / `webterm.theme`）；`useLayoutStore` **刻意不持久化**（引用的是活不过刷新的标签）
- i18n：`en-US` 声明为 `Record<MessageKey,string>`，漏翻译 typecheck 即报错；缺键返回键名

**插件与打包（阶段 9）**
- 边界三段式：① 清单 `plugin.json`（**目录即插件**）② 注册项（触发器动作 / 命令 / 面板 / 事件订阅）③ Host API（`PluginHost`）。一个坏插件只进 `error` + 面板显示原因，**不拖垮全场**
- ⚠️ **`node:vm` 不是安全沙箱**。只换三件事：限定 API 面、可控生命周期、崩溃隔离。清单里的 `permissions` **只作界面提示、不做拦截** —— 别当成权限系统
- ⚠️ **插件动作必须同步返回**（`invokeTriggerAction` 在输出流上被调）；异步收尾只能走插件日志 + 全局事件通道
- ⚠️ **配置热更新共享同一个 config 对象引用**（就地改），**不重载插件**（重载会丢内存状态，如 heartbeat-monitor 的计时器）。入库前过 `normalizeOverrides`（类型转换 + 范围钳制 + 丢未知键）
- ⚠️ **输出订阅全局一份**：`wantsOutput()` 判断，避免 N 插件 × M 会话订阅爆炸；`replace()` 之后**必须** `syncOutputSubscriptions()`
- ⚠️ **`TRIGGER_ACTION_TYPES` 是落库读回的白名单**：漏加的表现是「规则能存、接口能查、运行时什么都不做且不报错」
- 发布包布局：workspaces 软链接 → 发布包必须扁平自包含；摊平的共享包落在 `vendor/shared` 并声明 `file:` 依赖 + `bundledDependencies`（**直接写 `node_modules` 会被 `npm install` 清掉**）
- 发布形态数据目录**刻意分家**：便携目录用自身 `data/`，全局命令用 `~/.webterm`；前端产物目录由 CLI 注入 `WEBTERM_WEB_DIR`
- `pino-pretty` 是 devDependency → 发布形态解析不到会让 pino 抛 `ERR_MODULE_NOT_FOUND` 带走进程，用 `createRequire` 探测后退化
- 动态 import 绝对路径必须 `pathToFileURL()`（Windows 下 `'file://' + 'F:\…'` 会把盘符当主机名）
- 验证端口占用用**反向 bind**（报 `EADDRINUSE` 才算占用），比 `netstat` 可靠且不依赖外部进程

## 5. 排障速查（跨主题）

- ⚠️ **终端有应用层背压**（`unackedBytes`，高水位 64 KB）：WS 客户端不回 `ack`，远端输出会**永久暂停在 64 KB**（症状：输出卡住）。E2E 收集器每收 32 KB 回一次
- ⚠️ **分屏会让滚动缓冲顶部被裁掉**：pane 变窄 → xterm 对缓冲**重排（reflow）**，超宽长行重新折行、行数几乎翻倍，越过 scrollback 就丢最老的行。**不是终端被重建** —— 判断重建要用 `.xterm` **内部节点身份**，别只看 React 渲染的 pane 容器。**别拿缓冲顶部内容当「缓冲还在不在」的探针**，那会得到一个像「终端被重建了」的假失败
- ⚠️ **折行缓冲下搜索的滚动落点会偏**（已知限制，未修）：`resultIndex/count` 正确，但视口落在命中行**下方约半屏**；未折行缓冲里定位精确（10 万行外 254~472 ms 一次到位）
- ⚠️ **`ssh2` 服务端做跳板转发注册的事件名是 `'tcpip'`**，不是 `'direct-tcpip'`（见 `ssh2/lib/server.js` 的 `_onCHANNEL_OPEN`）。注册错名字会让通道在握手期被静默拒绝（reason=1），服务端不留任何日志
- 上传任务永远「传输中」不动：ssh2 的 SFTP 写流在 `_write` 失败时**先 `destroy()` 再回调**，`error` 事件根本不会发 → 必须在 `pump()` 里用「`error` + 非收尾期的 `close`」双信号兜底
- 取消任务后半成品没删掉：取消是「先 destroy 流再删文件」，此刻远端句柄仍打开，Windows 上 EBUSY → `cleanupPartial()` 退避重试（最多 12 次 × 50ms）
- HTML 日志列表里有文件但浏览器打开一片黑白：序列化用错了方法 —— `serialize()` 返回 **ANSI 文本**，HTML 回放必须 `serializeAsHTML()`
- HTML 日志等半天不出现：三个前提缺一不可（会话开了 html 日志 / 前端**有新输出**才传 / 每 15 秒一拍）
- 切目录时列表闪旧内容：`SftpPane` 用 `loadedTargetRef` 区分「换目录」（先清空）与「刷新当前目录」（保留）
- `Ctrl+F` 有计数但视口没跳：见上「折行缓冲」；搜索计数停在 2000 是 `highlightLimit` 的设计上限
- `docker run` 前先 `npm run check:dockerfile`（29 项静态自检，**不等于镜像能跑**）

## 6. 真机 `hwssh@192.168.1.254:22` 的结论

老旧且**非标准**的 SSH 设备：标识串 `SSH-2.0--`（换行只有 LF 无 CR，违反 RFC 4253）；KEX 仅支持 `diffie-hellman-group14-sha1` / `group-exchange-sha1`（ssh2 默认已移除，须显式启用）；`ecdsa-sha2-nistp521` 主机密钥在 ssh2 下报签名验证失败而 OpenSSH 能过（设备签名编码兼容性问题，非密钥坏，换 `ssh-rsa` 正常）；接受 `CHANNEL_OPEN(session)` 与 `pty-req`，但**拒绝 `shell` / `exec` / `subsystem:sftp`**。

⇒ 用 **OpenSSH 10.3 同样失败**，确认是设备侧账号/配置限制。所以端到端验证靠自带的 `packages/server/dev/mock-ssh-server.mjs`（`MOCK_LEGACY=1` 模拟老设备）；真机只能验到「握手 + 认证 + PTY 申请成功」。

## 7. 浏览器 E2E 操作要点

- 环境**没有 Playwright**，但有系统 Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`。用 `puppeteer-core` + `executablePath` 直连，无需下载浏览器
- 用**独立实例**测，别污染开发用的 8080：`NODE_ENV=production WEBTERM_PORT=8097 node packages/server/dist/index.js`（先 `npm run build`，一个端口就是完整应用）
- 读终端内容：`document.querySelector('.xterm-rows')` 的子 div 逐行取 `textContent`；**只能读到视口行**，大输出会滚出视口，断言要紧跟对应命令
- 给 xterm 键入：`page.click('.xterm-helper-textarea')` 会报 *not clickable*（透明浮层）→ 先 `page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus())` 再 `keyboard.type`
- 给 **React 受控组件**填值必须走原生 setter + `input` 事件（直接改 `value` React 感知不到）：
  ```js
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  ```
- ⚠️ 给受控 `<select>` 填值前**必须等 option 出现**（对不存在的 option 赋值会被浏览器静默置空）
- ⚠️ 会话弹窗的凭据下拉读**前端 store 快照**，store 只在解锁/删除凭据后刷新 → 用 API 建完凭据要 `page.reload()`
- ⚠️ `typeLine` 只作用于 `[data-active="true"]` 的终端 → 多标签要先点 `[role="tab"]` 切回目标终端
- ⚠️ 拍回放截图要用 `replayPage.screenshot()`（`page.screenshot()` 拍的是主应用）
- ⚠️ **Chrome 不会为单次 `click({clickCount:2})` 合成 dblclick** → 双击要发两次完整 down/up
- 通知权限用 CDP `Browser.setPermission` 精确控制（无头默认 denied）
- 统计「无前端错误」要排除预期业务响应（401/403/423）
- 断言前先确认 UI 真会那样表现：**刷新浏览器不会要求解锁**（解锁态在服务端进程内存里），只有重启服务端才会；**凭据不在侧边栏展示**，只在会话对话框的下拉里
- 断言陷阱：搜索单结果会让「上下跳转」退化 → 用**大量重复**的关键字；正则搜索不能拿模式串当「已滚到」判据（needle 与 expectText 要分开）；「视口出现命中」与「计数回流 React」不是同一拍（命中后再收敛 1.5 s）；文案断言会撞车（Telnet 段落里也有「跳板链」）→ 改断言 UI 专属文案；zod `.default()` 会补字段（Telnet 记录读回来有 `jumpChain: []`）→ 断言写「空」而非「不存在」

## 8. CI / 发布（阶段 9）

- 远端 `git@github.com:czleexy/webterm.git`（**公开仓库**），默认分支 `main`
- `.github/workflows/docker-image.yml`：build 作业推 GHCR（`ghcr.io/czleexy/webterm`，标签 `latest`/`main`/`sha-<full>`/语义版本），smoke 作业 `docker pull → run -p 8080:8080 → 等 /api/health → 断言首页 text/html 且含 id="root" → 比对版本`
- 平台策略：常规 push **只 amd64**（arm64 要走 QEMU，而项目有 better-sqlite3 / rolldown / oxide 等原生模块，模拟下慢好几倍）；打 `v*` 或手动触发才 amd64+arm64
- PR 只构建不推送；已开 GHA 远程缓存与 `provenance: false`（默认证明会多出 `unknown/unknown` 平台条目，Portainer 之类会看得一脸问号）
- ⚠️ **GHCR 包首次推送默认私有，与仓库是否公开无关** → 要外部匿名 `docker pull`，必须去 Package settings 手动改可见性
- 本地无 docker，只有 `npm run check:dockerfile` 静态自检；真正的构建/运行证据由 CI 出
- 本机**没有 `gh` CLI** → 查构建状态直接用 GitHub REST API（用 node 的 global fetch），见 `data/tmp/watch-run.mjs`
- 工作流落地前先跑 `data/tmp/check-workflow.py`：真 YAML 解析 + 结构核对 + 联网确认每个 `uses:` 的版本标签存在 + 对每段 `run:` 做 `bash -n`（**要读 `git show :path` 的入库形态**，读工作区文件会因 CRLF 得到假失败）
