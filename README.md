# WebTerm

基于 Node.js 的浏览器 SSH / Telnet 客户端，对标 SecureCRT / Xshell。

服务跑在本机负责协议栈与连接管理，浏览器只负责渲染与交互。免安装、跨平台，配置与会话集中在一处管理。

> 当前进度：**阶段 8（体验打磨）已交付** —— 设置中心（外观 / 高亮 / 快捷键 / 通知 / 语言五页）、UI 主题三态与 9 套终端配色、字体与光标设置、`Ctrl+F` 终端搜索（正则 / 计数 / 上下跳转）、关键词高亮规则、2/4 宫格分屏（可拖分隔条）、可自定义快捷键（含冲突与浏览器保留键提示）、Toast 与桌面通知、中英双语、窄屏抽屉与骨架屏。
> 前一阶段：阶段 7（日志与审计）—— 三种会话日志格式（纯文本 / 带时间戳 / HTML 彩色快照）、按天归档与 20 MB 轮转、保留天数定时清理、可配正则脱敏、日志管理页（筛选 / 分页预览 / 下载 / 删除）、审计流水（含客户端 IP）。
> 更早：阶段 6（自动化与批量运维）—— 触发器、按钮栏多步宏、沙箱脚本、同步输入广播、批量执行（并发 + 结果表 + 导出 CSV）。
> 详细设计见 [`docs/01-功能框架与需求说明书.md`](docs/01-功能框架与需求说明书.md) 与 [`docs/02-实现计划.md`](docs/02-实现计划.md)；
> 测试方法见 [`docs/03-测试指南.md`](docs/03-测试指南.md)；界面截图见 [`docs/screenshots/`](docs/screenshots/)。

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.12.0**（Vite 8 与 better-sqlite3 13 的下限） |
| 包管理器 | npm 10+（使用 npm workspaces，无需 pnpm/yarn） |
| 浏览器 | Chrome / Edge 110+、Firefox 115+、Safari 16+ |

```bash
node -v   # 应输出 v22.12.0 或更高
```

---

## 快速开始

```bash
# 1. 安装依赖（根目录执行，workspaces 会一并安装子包）
npm install

# 2. 启动开发环境：后端 8080 + 前端 5173 并行
npm run dev
```

浏览器打开 <http://localhost:5173>。

点击「新建连接」，先选协议（**SSH** / **Telnet**）再填主机信息即可建立终端。可先点「测试连接」确认连通性：SSH 会回报协商算法与主机密钥指纹，Telnet 会回报设备欢迎语。

> 没有可用远端主机时，用内置的 mock 服务端即可完整体验：`node packages/server/dev/mock-ssh-server.mjs`（2222）或 `node packages/server/dev/mock-telnet-server.mjs`（2323），详见「本地联调」一节。

---

## 阶段 1 已交付能力

| 能力 | 说明 |
| --- | --- |
| 多标签终端 | xterm.js 渲染，切换标签不丢滚动缓冲、不断开连接 |
| PTY 尺寸同步 | 拖拽窗口 / 切换面板时自动 `window-change`，远端行宽实时跟随 |
| 背压保护 | 双信号（客户端 ACK + WS 发送缓冲）控速，`cat` 大文件不会打爆内存 |
| 编码支持 | UTF-8 零拷贝直通；GBK / GB18030 / Big5 由服务端增量转码，无跨包乱码 |
| 算法自动降级 | 现代算法协商失败自动切换 legacy 档案，老旧交换机 / 路由器免配置 |
| 主机密钥 TOFU | 首连记录指纹，指纹变化即拒绝，防中间人 |
| 连接诊断 | 「测试连接」区分「连不上」/「认证失败」/「认证通过但拒绝会话」三类故障 |
| 断线重连 | 网络抖动自动重连（3 次退避），令牌失效则明确提示 |

**快捷键**：`Alt+T` 新建连接 · `Alt+W` 关闭标签 · `Alt+↑/↓` 切换标签

---

## 阶段 3 已交付能力（SFTP）

| 能力 | 说明 |
| --- | --- |
| 双栏文件管理 | 左「本机（服务端磁盘）」/ 右「远端主机」；双击进出目录、地址栏可手输、表头排序（目录恒定置顶）、Ctrl / Shift 多选 |
| 复用终端连接 | 可从标签栏的终端标签直接开 SFTP，在同一条 SSH 连接上开文件通道 —— 老设备的 VTY 线路只有几条，重复登录会把后来的会话挡在门外 |
| 拖拽互传 | 一侧选中拖到另一侧即传输；同侧拖拽 = 移动（用 `rename` 实现，两端都支持且原子）；从操作系统拖文件进远端栏 = 浏览器上传 |
| 传输队列 | 并发上限可配（默认 3）、同目标串行、滑动平均速度与 ETA、目录聚合进度；暂停 / 继续 / 取消 / 重试；断点续传 |
| 覆盖保护 | 默认不覆盖，目标已存在时任务失败并列出冲突路径，确认后才覆盖 |
| 浏览器通道 | 大文件走 `application/octet-stream` 原始流（XHR 上报进度），下载支持 HTTP Range |
| 文本预览与远程编辑 | 编辑后直接回写远端，并沿用原权限；保存带打开时的 `mtime`，被他人改过则 409 拒绝而不是静默覆盖；二进制文件只读并说明原因 |
| 路径安全 | 本地侧词法 + `realpath` 双重校验，`../..`、绝对路径越界、符号链接越界一律 403 |

---

## 阶段 4 已交付能力（Telnet，端口 23）

| 能力 | 说明 |
| --- | --- |
| 协议选择 | 「新建连接」与「会话编辑」都有 SSH / Telnet 切换；切协议时端口在 22 / 23 间跟随（手改过的端口不覆盖） |
| 选项协商 | 完整状态机处理 `DO`/`DONT`/`WILL`/`WONT` 与子协商；对端拒绝后不再重复请求，不打扰老设备 |
| TERMINAL-TYPE | 把会话的 `TERM` 上报给设备，远端全屏程序（`top` / `vi`）据此排版 |
| NAWS 窗口尺寸 | 拖拽窗口 / 切换标签时把新尺寸上报给设备 |
| 本地回显兜底 | 设备不声明 `WILL ECHO` 时由本端补回显（含退格 `\b \b`、不越界），解决「打字看不见」这个 Telnet 最常见的观感问题；设备声明回显时绝不重复回显 |
| IAC 转义 | 收发两侧都把 `0xFF` 写成 `FF FF`，裸 0xFF 不会被当成命令吃掉后续字节 |
| 明文风险提示 | 对话框常驻警示，且**采集不到任何凭据** —— 口令在终端里交互输入，不进配置、不落盘 |
| 能力裁剪 | Telnet 没有认证阶段与文件子系统：目标里不允许出现凭据、没有跳板链、不支持算法档案；标签栏不提供 SFTP 入口，服务端对 Telnet 会话开 SFTP 直接 400 |
| 探测 | 「测试连接」对 Telnet 只回答「TCP 通不通 + 对端说不说话」，并把设备欢迎语带回来 |
| 零新增依赖 | 用 Node 内置 `net` 实现传输层，未引入第三方 Telnet 库 |

> **安全边界**：Telnet 是明文协议，口令与全部会话内容都会以明文经过网络。请仅在受信网络中使用，条件允许时优先改用 SSH。

---

## 阶段 5 已交付能力（端口转发与隧道）

写法与 OpenSSH 完全对齐（`-L` / `-R` / `-D`），熟悉命令行的用户可以把已有经验直接搬过来。头部「隧道」按钮打开管理面板，每条隧道都展示等价的 `ssh` 命令，一眼确认「配的到底是哪一条」。

| 能力 | 说明 |
| --- | --- |
| 本地转发 `-L` | 本机监听一个端口，连接经由 SSH 送到远端网络里的目标（如 `-L 13306:10.0.0.5:3306` 连内网数据库） |
| 远程转发 `-R` | 远端监听一个端口，连接经由 SSH 送回本机的目标；监听端口可填 0 由远端分配，实际端口回填到界面 |
| 动态转发 `-D` | 本机起一个 SOCKS5 代理（RFC 1928，仅 CONNECT、无认证），目标地址由客户端逐次指定（如 `-D 1080`） |
| 隧道挂会话 | 隧道复用该会话已建立的 SSH 连接，不重复登录 —— 与 SFTP 借道终端连接是同一个考量（老设备 VTY 线路少） |
| 随会话自动启动 | 会话编辑弹窗内嵌隧道配置；会话建立时自动启动，个别端口失败只提示不阻断连接 |
| 生命周期 | 会话关闭时**先**撤销远端监听、**再**关闭本机监听，端口立即释放（`netstat` 可验证） |
| 统计面板 | 每条隧道显示状态（启动中 / 运行中 / 已停止 / 错误）、当前与累计连接数、上下行字节数；面板打开期间每 2 秒刷新 |
| 端口占用 | `EADDRINUSE` 不再抛裸 errno，而是「端口已被占用：127.0.0.1:13306 + 换端口建议」；失败的创建不留下幽灵记录 |
| 错误分类 | 端口无权限（403）、目标不可达 / 远端拒绝转发（502，含 `AllowTcpForwarding no` 的针对性说明）、建通道超时（504），都带处置建议 |
| 默认安全 | 监听地址默认 `127.0.0.1`（仅本机可用）；想开放给局域网必须显式填 `0.0.0.0`，界面常驻风险提示 |
| 能力裁剪 | Telnet 会话没有可承载转发通道的协议层：不显示隧道配置，服务端对 Telnet 会话建隧道直接 400 |
| 零新增依赖 | SOCKS5 用增量状态机手写（TCP 分包不会撕裂请求），未引入第三方代理库 |

---

## 阶段 6 已交付能力（自动化与批量运维）

重复的运维动作——答一个 `(yes/no)?`、发一串固定命令、批量查一遍磁盘——全部交给服务端在后台完成。顶栏「自动化」按钮打开面板（触发器 / 按钮栏 / 脚本 / 批量执行四个分区），「同步输入」按钮控制多终端广播。

### 触发器

在终端输出上**逐行**匹配，命中后立即执行一组动作。与「前端正则过滤」的关键区别：匹配与自动应答都在**服务端**完成，因此哪怕浏览器没打开、标签在后台，设备该答的还是会答上。

| 能力 | 说明 |
| --- | --- |
| 匹配模式 | 正则（支持捕获组）或**纯文本包含** —— 设备提示串里满是 `<`、`>`、`(`、`?`，让用户自己转义纯属为难人 |
| 修饰符 | 白名单 `i` / `m` / `s` / `u`，**刻意排除 `g` / `y`**：它们会让正则对象带 `lastIndex` 状态，出现「时灵时不灵」这类极难排查的问题 |
| 动作 | 自动应答（可延时、可关回车、支持 `$0`…`$9` 引用捕获组）、高亮标色、浏览器通知、记录标签、执行脚本 |
| 作用域 | 全局（对所有会话）或会话级（只对某个会话库节点）。全局规则会作用在「你只是随手连上去看一眼」的设备上，因此界面上把两者的差别写在明处 |
| 冷却 | 同一规则在 `cooldownMs` 内只触发一次。分页提示 `--More--` 会在一屏里出现几十次，没有冷却就会瞬间连发 |
| 尾行处理 | `(yes/no)? ` 这类提示**不换行**，只在对端静默 60 ms 后才当作一行处理，避免分片到达时匹配到半截 |
| 防自激 | 「命中 → 自动应答 → 应答被回显 → 又命中」是死循环。用「尾行快照 + `carriedOver` 标记」掐断 |
| 可视化 | 编辑弹窗里有实时正则校验与**试匹配面板**：贴一段真实设备输出，直接看到哪几行命中、`$0` / `$1` 各是什么 —— 捕获组编号与动作模板严格对齐 |
| 常备规则 | 六条内置规则一键添加（确认提示自动应答、SSH 首连接受指纹、`--More--` 自动翻页、`[confirm]` 自动回车、报错行高亮、登录成功打标签） |
| 命中可见 | 命中后终端里追加一行 `⚡ 触发器「X」命中 → 自动应答 "yes"`。自动应答最危险的失败模式不是「没答」，而是**答了但用户不知道**；全屏 TUI 场景可关掉这一行 |
| 运行态 | 命中次数、最近触发时间、最近一次动作失败原因（如「引用的脚本已被删除」）。规则不会因为引用失效而静默消失 |
| 未读角标 | 后台标签被触发器动过时，标签栏上出现 `⚡n`，切过去即清零 |

### 按钮栏（多步宏）

把「发送 → 等待 → 再发送」固化成一次点击。宏按钮直接长在**终端工具栏下方**——点「查看磁盘使用」时，用户心里想的是「在这个标签上跑」，不该先去面板选目标。

- 步骤字段是顺序语义：先 `send`，再等 `delayMs`（无条件等），再等输出命中 `expect`（等到为止，有上限）。两者用途不同，**没有合并成一个「等待」**。
- 执行进度实时回显（`第 2/3 步 · 等待 "$ "`），执行中按钮置灰。
- 同一会话同时只允许一个自动化任务；冲突时提交阶段就返回 **409 `BUSY`**，而不是先回 202 再失败。

### 脚本（沙箱）

| 能力 | 说明 |
| --- | --- |
| 沙箱 | `node:vm` + `createContext` 白名单。可用全局只有 `session` / `sftp` / `log` / `console` / `sleep` / `target` / `params`；**没有 `require`、`process`、`fs`，也没有 `eval` 与 `new Function`**（`codeGeneration.strings = false`） |
| **可终止** | 这是本阶段最费功夫的一处：`vm` 的 `timeout` **只覆盖第一段同步执行**——同步 `while(true){}` 会被掐掉，但 `await` 之后进的死循环、`await new Promise(()=>{})` 全都挂死。因此做成**双层沙箱**：vm 负责隔离，worker 负责可终止（`worker.terminate()` 兜底）。五种死循环形态实测都在 ~1.5 s 内被强制终止，服务与其它会话不受影响 |
| 会话 API | `session.send` / `write` / `waitFor` / `expect` / `readUntil` / `read` / `clear` / `run` / `info` |
| SFTP API | `sftp.list` / `stat` / `read` / `write` / `exists` |
| 编辑器 | CodeMirror 6：JS 语法高亮 + **内置 API 补全**（补全项直接来自共享契约的文档表 —— 文档即补全）+ 运行输出面板（分级着色、超限计数、返回值与错误分行显示） |
| 语法闸门 | 保存前用与运行**完全相同**的包装编译一次（`lineOffset` 校正行号），保证「校验通过」等价于「运行前能编译」 |
| 三种绑定 | 手动运行、会话建立后自动运行（`runOnConnect`）、被触发器动作调用 |
| 错误分类 | 越界访问（`require` / `process` / `eval`）被归为 `SANDBOX` 并附「可用全局」提示，而不是笼统的 `RUNTIME` |
| 运行记录 | 内存里保留最近 50 次，单次日志上限 500 条（超出的只计数，`droppedLogs`），避免脚本刷爆内存 |

### 同步输入（广播模式）

一次按键同时投递给多个终端，配合警告条使用。

- **目标集在开启的那一刻锁定**，新开的标签不会自动加入。动态计算会让新标签**静默地**开始接收别人的按键——在能往生产设备写命令的工具里，这种「悄悄多了一个受害者」不可接受。
- 目标被关掉会自动从名单里剔除，不会留一个不存在的目标让「广播中(N)」这个数字骗人。
- 输入**不做去抖与合并**：方向键、Tab 补全、Ctrl 组合键都依赖时序，合并会让远端收到的序列彻底错位。
- 警示条**常驻**工作区顶部（不只靠一个小指示灯），写明接收方数量与最近一次投递结果，并提供「立即停止」。**Alt+B** 可一键开关。

### 批量执行

选一组会话 → 输一条命令 → `Promise.allSettled` 并发 → 一张结果表 → 导出 CSV。

| 能力 | 说明 |
| --- | --- |
| 两种目标来源 | `terminalId` **复用已登录的 SSH 连接**另开 exec 通道（不占新 VTY 线路，交换机的 VTY 常常只有几条）；`sessionId` 从会话库取配置独立建连、跑完即断 |
| 只支持 SSH | 要拿到退出码就必须用 exec 通道，而 Telnet 没有这一层（用提示符猜退出码不可靠）。Telnet 目标被**明确拒绝并给出理由**，不给「看起来跑了、结果不可信」的成功 |
| 结果表 | 主机 / 协议 / 退出码 / 耗时 / 输出摘；展开可见 **stdout 与 stderr 分栏**（混在一起就只能靠猜哪台出错了） |
| 并发与超时 | 固定并发度任务池，保持输入顺序；单目标超时独立，一个卡住不影响其他 |
| 截断 | 单目标输出上限 256 KB，超出截断并标注原始大小 |
| 导出 | CSV 带 **UTF-8 BOM**（否则中文 Windows 版 Excel 打开全是乱码），换行用 `\r\n` |

---

## 阶段 7 已交付能力（日志与审计）

会话日志与会话配置放在一起（编辑会话时的「会话日志」组），落盘在服务端 `data/logs/`，随时可在顶栏「日志」入口里按会话 / 日期筛选、预览、下载、删除。

### 会话日志三种格式

| 格式 | 生成方 | 落地文件 | 适用 |
| --- | --- | --- | --- |
| 纯文本 | 服务端流式追加 | `{YYYY-MM-DD}.log` | 事后 `grep`、喂给别的工具；**可脱敏** |
| 带时间戳 | 服务端流式追加 | `{YYYY-MM-DD}.log` | 需要知道「这行是什么时候来的」；**可脱敏** |
| HTML（保留色彩） | **浏览器**用 `SerializeAddon.serializeAsHTML()` 定期序列化整份缓冲后上传 | `{YYYY-MM-DD}.html` | 双击即回放彩色终端；**不做脱敏**（见下） |

```text
data/logs/
  PlainLog-83e79e/          ← {清洗后的会话名}-{sha256(sessionId) 前 6 位}
    2026-09-30.log
    2026-09-30.part1.log    ← 单文件超 20 MB 自动切分
  HtmlLog-bd1653/
    2026-09-30.html
```

### 关键设计取舍

| 方面 | 说明 |
| --- | --- |
| 目录名带短哈希 | 只按会话名建目录的话，两台不同主机上的同名会话会**互相覆盖**。加上 `sessionId` 的短哈希既保人读性又不冲突；会话改名时目录不漂移（映射单独持久化） |
| HTML 快照用 `.html` 扩展名 | 浏览器只对 `.html` 做「打开即渲染」，`.log` 会被当纯文本下载。验收要求「HTML 日志在浏览器打开颜色正确」依赖这一点 |
| HTML 快照不做脱敏 | 它是**字节级忠实的终端回放**，在 HTML 标记里做文本替换会破坏结构、把颜色改坏。要脱敏就用纯文本 / 带时间戳格式 —— 这条边界在设置页也写明了 |
| 脱敏按行对齐 | 逐 chunk 脱敏会被传输分片切断正则（`password=sec` + `ret123` 两半都不匹配），**敏感内容原样落盘**。所以先按行缓冲、整行到齐再替换 |
| 写入批量合并 | 一行一次 `appendFile` 在 21 MB 输出下要近 30 万次系统调用。合并成 256 KB 或 200 ms 定时刷盘 |
| 预览不读全文 | 首次访问时按**字节**扫一遍 `0x0A` 建行偏移索引，之后任意窗口 O(1) `seek + read`。索引按 `size + mtime` 失效，LRU 缓存 8 个文件 |
| 审计 detail 存整句 | 库里存的是「07:12 test 用户从 127.0.0.1 上传了 a.zip」这样的人读句子，而不是留给前端拼的结构化字段 —— 审计的价值在事后能看懂 |
| Telnet 同样可记日志 | 日志挂在「会话输出流」这一层，与协议无关；Telnet 会话自动获得同样能力 |

### 脱敏规则

设置页可维护多条正则（默认带一条 `password\s*=\s*\S+` → `password=***`）。规则在**写入前**作用于纯文本 / 带时间戳格式：

| 项 | 说明 |
| --- | --- |
| 上限 | 最多 32 条，可逐条启用 / 停用 |
| 语法校验 | 编辑时就地校验，非法正则（如 `([unclosed`）当场标红，不会等到保存才报错 |
| 保留天数 | 1 ~ 3650 天，默认 30；**改完立即生效**（不等下一个整点），过期目录连同文件一并清理 |

### 审计事件

八类事件写入 SQLite `audit_log`（纯追加表 + `(at)` / `(event, at)` 索引），全部记录客户端 IP：

| 事件 | 中文句式样例 |
| --- | --- |
| `connect` / `disconnect` | 用户从 127.0.0.1 建立了到 demo@127.0.0.1 的连接（SSH） |
| `upload` / `download` | 用户从 127.0.0.1 上传了 a.zip（2.4 MB） |
| `macro_run` | 用户从 127.0.0.1 执行了宏「审计宏」 |
| `script_run` | 用户从 127.0.0.1 运行了脚本「内联脚本」 |
| `log_delete` | 用户从 127.0.0.1 删除了 1 个日志文件 |
| `settings_change` | 用户从 127.0.0.1 更新了日志与审计设置（保留 30 天，脱敏规则 2 条） |

---

## 阶段 8 已交付能力（体验打磨）

顶栏 ⚙ 打开设置中心，五个标签页：**外观 / 高亮 / 快捷键 / 通知 / 语言**。所有设置存在浏览器
`localStorage`（`webterm.settings`、`webterm.theme`），刷新、重开标签页都保留，服务端不参与。

### 外观：UI 主题与终端配色分开

| 维度 | 选项 |
| --- | --- |
| 界面明暗 | `浅色` / `深色` / `跟随系统`（`prefers-color-scheme`，系统切换时实时跟随） |
| 终端配色 | `跟随界面` + 8 套具名：Dracula / Nord / Gruvbox Dark / Monokai / Tokyo Night / Solarized Dark / Solarized Light / GitHub Light |
| 字体 | 字号 11~20、行高 1~1.6、6 组等宽字族预设、光标形状（块/下划线/竖线）与闪烁、回滚缓冲 1000~200000 行、连字开关 |

设置页右上角有**实时预览块**，改任何一项立刻能看到效果。UI 明暗与终端配色是**两件事**：
界面切深色时终端会跟着变（选「跟随界面」时），但也可以让界面深色、终端用 Solarized Light。

> 连字（ligature）开关在当前 DOM 渲染器下**没有视觉效果** —— xterm 的字符连接器只在 WebGL 渲染器生效。
> 这个开关是为将来接 WebGL 预留的，界面里也照实标注了，不会让用户以为是自己配错了。

### 终端搜索（`Ctrl+F`）

悬浮在终端右上角（不占布局，所以开关搜索不会让终端重新排版）。支持**正则**、**大小写**、**全词**，
结果计数形如 `3 / 128`，上一个 / 下一个与 `Shift+Enter` 反向跳转，命中处有装饰高亮、当前命中另有强调色。

> 计数上限是 2000（装饰上限），超过时显示成 `2000+` —— 不把 10 万处命中报成 2000 处。
>
> 实测：缓冲 **102400 行**、关键字在视口 **10 万行之外**时，**449 ~ 472 ms** 定位并滚入视口；
> 反向（视口在顶部、关键字在末尾）**254 ~ 265 ms**。

### 关键词高亮

按行匹配的规则表，命中行铺一层**底色装饰**（文字与 ANSI 颜色压在底色之上，不会被盖掉）。
内置四条（错误 / 警告 / 失败 / 成功，前两条默认开启），可增删改、可开关，最多 32 条，非法正则会**就地标红**。

只给语义色（红/橙/黄/绿/蓝/紫/青），具体深浅按当前主题明暗折算 —— 这样同一套规则在浅色与深色主题下都不会糊成一片。

### 分屏（1 / 2 / 4 格）

| 布局 | 快捷键 |
| --- | --- |
| 单格 | `Alt+1` |
| 左右分屏 | `Alt+2` |
| 四宫格 | `Alt+4` |
| 聚焦下一格 / 上一格 | `Alt+Shift+↓` / `Alt+Shift+↑` |

分隔条可拖、可双击复位；四宫格的十字在正中拆成四段，**拖竖条只改列宽、拖横条只改行高**。
格子头部有格号、会话切换下拉与「清空」——「清空」只腾出格子，**不关闭会话**。

> **分屏不会重建终端**。这一点是被老交换机逼出来的：终端一旦被卸载重建，WebSocket 会重连、
> 服务端会**再建一条 SSH 连接**，而这类设备的 VTY 线路很少，多切几次分屏就把线路占满了。
> 所以没有用 `react-resizable-panels`（它的 `PanelGroup > Panel > 内容` 层级会在切布局时改变终端的父节点），
> 而是让所有终端**恒为同一个 CSS Grid 容器的直接子元素**，切布局只改 `grid-area` 与显示状态。
>
> 副作用要知道：分屏后 pane 变窄，xterm 会对滚动缓冲做**重排（reflow）**，超宽的长行被重新折行、
> 行数几乎翻倍，越过 `scrollback` 上限后**最老的那些行会被丢掉**。这是真实终端缩放窗口时本来就有的行为。

### 快捷键

16 个动作全部可自定义（新建连接 / 关标签 / 切标签 / 终端搜索 / 复制选中 / 同步输入 / 三种布局 /
聚焦切换 / 打开设置·日志·自动化·隧道）。录制式绑定，`Esc` 取消。

两件如实说明的事：

- **按物理键位（`event.code`）绑定**：`key` 会随键盘布局与 Shift 变化，`code` 才对应你按下的那个键。
- **浏览器保留键拦不住**：`Ctrl+T` / `Ctrl+W` / `Ctrl+Tab` / `Ctrl+1~9` / `F5` / `F11` / `F12` /
  `Alt+←→` 这些网页无法 `preventDefault()`，默认绑定一律避开；真要绑上去，设置页会给出「系统 / 浏览器占用」
  的原因文案，而不是静默失效。

### 通知

- **Toast**：右下角队列（最多同时 4 条），警告 / 错误 / 成功 / 信息四种色调，可手动关、也会自动消失。布局切换、断开连接、复制选中等都会给一条。
- **桌面通知**：连接断开、批量任务完成时触发。三重门槛 —— ①设置里的开关 ②浏览器权限已授予 ③**页面不在前台**（避免与 Toast 重复，也避免 macOS 上盖住终端）。权限只在设置页由你显式点「请求授权」时申请，不会在加载时弹窗索取。

### 中英双语与响应式

顶栏文案、侧栏、首页、设置页、终端工具栏、提示条全部走同一份词典；`en-US` 声明为
`Record<MessageKey, string>`，**漏翻译在 `typecheck` 阶段就会报错**；缺键时返回键名而不是空串。

窄屏（< 768 px）下会话树收成带遮罩的抽屉，并给出「终端体验受限」的提示条；首次连接的等待期有骨架屏
（「正在连接」超过阈值才显示，连得快就不会闪一下白框）。

---

## 可用脚本

在**根目录**执行：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 并行启动后端（tsx watch）与前端（Vite），Vite 自动代理 `/api` 与 `/ws` 到后端 |
| `npm run typecheck` | 对 server 与 web 做 TypeScript 严格模式类型检查 |
| `npm run build` | 构建 `packages/shared` → `packages/server` → `packages/web` |
| `npm start` | 启动生产服务，由后端托管前端产物，访问 <http://127.0.0.1:8080> |

单独操作某个子包（例如只跑后端）：

```bash
npm run dev -w @webterm/server
npm run dev -w @webterm/web
```

---

## 目录结构

```
webterm/
├─ docs/                     设计与计划文档（含界面截图）
├─ packages/
│  ├─ shared/                前后端共享常量与类型（必须先构建）
│  │  └─ src/{constants,api,ws,sftp,tunnel}.ts
│  ├─ server/                Fastify 服务端
│  │  ├─ dev/mock-ssh-server.mjs     开发用 SSH 测试服务端（含 SFTP 子系统 / 跳板 / 远程转发）
│  │  ├─ dev/mock-telnet-server.mjs  开发用 Telnet 测试设备（选项协商 / NAWS / 回显开关）
│  │  └─ src/
│  │     ├─ index.ts         进程入口（加载配置 → 建目录 → 监听）
│  │     ├─ app.ts           Fastify 实例装配 + 静态托管 + 404 处理
│  │     ├─ config/          环境变量校验（zod）
│  │     ├─ db/              SQLite 打开与迁移、会话库 DAO
│  │     ├─ security/        保险库（主密码 KDF + AES-GCM）、凭据存取
│  │     ├─ ssh/             算法档案 / 连接建立 / 跳板链 / 主机密钥 / 错误分类
│  │     ├─ telnet/          协商状态机 / 传输层 / 错误分类（明文终端协议栈）
│  │     ├─ sftp/            SFTP 会话 / 传输队列 / 本地路径沙箱
│  │     ├─ tunnel/          端口转发：本地 / 远程 / SOCKS5 动态 + 隧道管理器 + 错误分类
│  │     ├─ automation/      触发器引擎 / 宏 / 沙箱脚本（vm 隔离 + worker 可终止）
│  │     ├─ logging/         会话日志写入器（三格式 / 轮转 / 脱敏） + 行偏移索引 + 日志服务
│  │     ├─ terminal/        终端会话（双传输：SSH / Telnet） / 会话注册表 / 编码桥
│  │     └─ api/
│  │        ├─ rest/         REST 路由（health / capabilities / sessions / terminals / vault / credentials / library / sftp / tunnels / automation / logs / audit）
│  │        ├─ resolver.ts   会话记录 → 明文连接参数
│  │        └─ ws/           终端与 SFTP WebSocket 端点
│  └─ web/                   React 前端
│     └─ src/
│        ├─ api/             REST 请求封装
│        ├─ components/      UI 组件（门禁 / 弹窗 / 标签栏 / 会话库侧栏 / 隧道面板）
│        ├─ terminal/        xterm 封装 / 连接 Hook / 配色 / HTML 快照序列化
│        ├─ sftp/            SFTP 双栏工作区 / 文件列表 / 传输抽屉
│        ├─ automation/      自动化面板 / 宏按钮栏 / CodeMirror 脚本编辑器 / 广播与批量执行
│        ├─ logs/            日志与审计面板（会话日志 / 审计 / 设置三标签）
│        ├─ store/           标签页 / 保险库 / 会话库 / SFTP / 隧道状态（Zustand）
│        ├─ theme/           主题状态（Zustand persist）
│        └─ utils/
└─ data/                     运行时数据（已被 git 忽略）
   ├─ webterm.db              SQLite（会话库 + 加密凭据 + 审计流水）
   ├─ known_hosts.json        主机密钥指纹记录（TOFU）
   └─ logs/                   会话日志（按「会话名-短哈希」归档，按天分文件）
```

---

## 环境变量

全部可选，不设置时使用默认值。写在根目录 `.env` 中即可（参考 `.env.example`）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时关闭日志美化并托管前端产物 |
| `WEBTERM_HOST` | `127.0.0.1` | 监听地址。改为 `0.0.0.0` 可局域网访问，**但必须先设置访问密码** |
| `WEBTERM_PORT` | `8080` | 监听端口 |
| `WEBTERM_DATA_DIR` | `./data` | 数据目录 |
| `WEBTERM_LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent` |
| `WEBTERM_ALLOW_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | WebSocket / CORS 来源白名单 |

环境变量校验失败时服务会直接退出并打印具体出错字段，不会带着错误配置运行。

---

## API

> 阶段 8（体验打磨）**没有新增任何接口**：主题、字体、快捷键、高亮规则、通知开关、语言这些全部是纯前端偏好，
> 存在浏览器 `localStorage` 里（`webterm.settings` / `webterm.theme`），服务端不参与。
> 分屏布局（`useLayoutStore`）**刻意不持久化** —— 它引用的是当前标签页里的终端会话，而标签本身活不过刷新。
> 因此下面这份清单与阶段 7 结束时一致。

### `GET /api/health`

```json
{
  "ok": true,
  "name": "WebTerm",
  "version": "0.2.0",
  "uptimeSec": 42,
  "nodeVersion": "v22.22.2",
  "startedAt": "2026-09-24T03:20:11.000Z",
  "activeTabs": 0
}
```

### `GET /api/capabilities`

返回 ssh2 版本、算法档案（modern / legacy 的完整算法清单）、支持的编码、**支持的协议（`ssh` / `telnet`）**与背压水位。前端欢迎页据此展示，排障时可直接查看。

### `POST /api/sessions/probe`

只做「TCP + 握手 + 认证」，不开终端会话。**按协议分流**：

- **SSH**：返回协商算法、主机密钥指纹与告警列表 —— 能区分「连不上」「认证失败」「认证通过但拒绝会话」三类故障。
- **Telnet**：没有认证阶段，因此只验证「TCP 通不通」与「对端说不说话」，并带回设备欢迎语（`banner`），同时附一条明文风险告警。响应里不会出现 `negotiation` / `hostKeyFingerprint`。

请求体为 `{ protocol?, target?, sessionId?, legacyCompat? }`，`protocol` 缺省为 `ssh`。

### `POST /api/terminals` / `GET /api/terminals` / `DELETE /api/terminals/:id`

创建（此时已建立真实连接，失败返回标准 HTTP 状态码 + 错误码）、列出、关闭终端。创建响应含一次性 `attachToken`。

请求体二选一：`{ config }`（快速连接，前端直传）或 `{ sessionId }`（引用会话库，服务端负责解密凭据并组装跳板链）。

`config` 是**按 `protocol` 判别的联合类型**：

```jsonc
// SSH：需要用户名 + 凭据，可用 legacy 算法档案与跳板链
{ "protocol": "ssh",
  "target": { "host": "10.0.0.1", "port": 22, "username": "ops", "authMethod": "password", "password": "…" },
  "terminal": { "cols": 120, "rows": 30, "encoding": "utf8", "term": "xterm-256color" },
  "legacyCompat": "auto" }

// Telnet：只有主机与端口 —— 协议没有认证阶段，口令在终端里交互输入，不进配置
{ "protocol": "telnet",
  "target": { "host": "10.0.0.9", "port": 23 },
  "terminal": { "cols": 120, "rows": 30, "encoding": "gbk", "term": "xterm-256color" } }
```

`GET /api/terminals` 的列表项带 `protocol` 字段；Telnet 终端的 `username` 恒为空串。对 Telnet 终端开 SFTP 返回 **400 `INVALID_CONFIG`**（Telnet 没有文件子系统）。

### 端口转发与隧道（阶段 5）

隧道挂在某个终端会话的 SSH 连接上，所有写操作都以 `terminalId` 指认宿主；列表接口是全局的 —— 用户关心的是「我一共开了哪些隧道」。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/tunnels` | 全局隧道列表（运行中的排前面） |
| `GET /api/terminals/:id/tunnels` | 某个终端的隧道；目标不是 SSH 会话返回 400 `INVALID_CONFIG` |
| `POST /api/tunnels` | 创建并立即启动，请求体 `{ terminalId, spec }`；`spec` 是按 `type` 判别的联合：`local` / `remote`（带 `targetHost` / `targetPort`）与 `dynamic`（没有目标，端口由客户端逐次指定） |
| `POST /api/tunnels/:id/start` | 启动 / 重启一条已停止的隧道 |
| `POST /api/tunnels/:id/stop` | 停止（保留定义，可再次启动；与「删除」区分开） |
| `DELETE /api/tunnels/:id` | 停止并移除 |

错误码与状态码的对应关系：端口被占用 → **409 `PORT_IN_USE`**、无权监听 → **403 `PORT_DENIED`**、目标不可达 / 远端拒绝转发 → **502 `FORWARD_REJECTED`**、建通道超时 → **504 `FORWARD_TIMEOUT`**。响应的 `message` 里带具体端口与中文处置建议。

隧道定义可以随会话记录落库（`session.tunnels`）：连接建立时自动启动，失败只在终端里给提示、**不阻断连接**。Telnet 记录不允许携带 `tunnels`（400 `VALIDATION_FAILED`）。

### 自动化与批量运维（阶段 6）

触发器 / 宏 / 脚本三类定义都落库，运行态（命中次数、运行记录、宏进度）只存在进程内存里 —— 上一次的偶然失败不应该永久改变用户写下的配置。

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/automation/triggers` | 列出 / 新建规则；返回里带运行时统计（`hitCount` / `lastFiredAt` / `lastError`） |
| `PATCH/DELETE /api/automation/triggers/:id` | 局部更新（只改 `enabled` 也是合法请求）/ 删除；改动后立即对所有已存在的会话生效，不必重连 |
| `POST /api/automation/triggers/test` | 试匹配：`{ pattern, matchMode, flags, sample }`，逐行返回命中、`groups`（`[0]` 是整个匹配、`[n]` 是第 n 个捕获组）与模板展开预览 |
| `GET/POST /api/automation/macros` | 按钮定义列表 / 新建（`steps: [{ send, enter?, delayMs?, expect?, expectTimeoutMs? }]`） |
| `PATCH/DELETE /api/automation/macros/:id` | 改 / 删 |
| `POST /api/automation/macros/run` | 执行宏（`{ terminalId, macroId }` 或 `{ terminalId, steps }` 临时执行），**202** 返回 `runId`，进度经该终端的 WebSocket 推送 |
| `GET/POST /api/automation/scripts` | 脚本列表 / 新建；语法不合法直接 400 `SANDBOX`，不让一个跑不起来的脚本入库 |
| `PATCH/DELETE /api/automation/scripts/:id` | 改（含 `runOnConnect`）/ 删。删除返回 **被引用次数**，用于提示哪些绑定会随之失效 |
| `POST /api/automation/scripts/run` | 运行脚本（`{ terminalId, scriptId }` 或 `{ terminalId, code }` 试运行），同步校验后 **202** 返回 `runId` |
| `POST /api/automation/scripts/validate` | 只编译不执行，返回 `{ ok, error?, line? }` |
| `GET /api/automation/script-runs` | 服务端保留的最近运行记录（含阶段、耗时、返回值、错误、被丢弃的日志条数） |
| `POST /api/automation/batch` | 批量执行：`{ targets: [{ sessionId? \| terminalId?, label? }], command, concurrency?, timeoutMs? }`，**同步返回**完整结果表与汇总 |

错误码：同一会话上已有自动化任务 → **409 `BUSY`**；脚本语法错误 / 沙箱越界 → **400 `SANDBOX`**；会话已关闭 → **409 `SESSION_CLOSED`**；终端或脚本不存在 → **404 `NOT_FOUND`**；参数越界（目标数 / 并发度 / 超时 / 动作数）→ **400 `VALIDATION_FAILED`**。

终端的 WebSocket 新增三类服务端推送：`trigger`（命中，含需要渲染端配合的动作与已在服务端完成的动作摘要）、`script`（`start` / `log` / `done` / `error` / `timeout`）、`macro`（`start` / `step` / `done` / `error`）。

`GET /api/capabilities` 的 `automation` 字段给出全部上限与白名单（匹配模式、可用修饰符、各类数量上限、沙箱可用全局列表），前端据此渲染表单与补全。

### 日志与审计（阶段 7）

| 方法与路径 | 说明 |
| --- | --- |
| `GET/PUT /api/logs/settings` | 读取 / 更新全局设置（`retentionDays` 1~3650、`redactionRules` 最多 32 条）。**改完立即生效**：收紧保留期会当场清一轮过期目录 |
| `GET /api/logs/files?sessionId=&date=` | 日志文件列表，可按会话与日期筛选。每项含 `id`（相对路径）、`dir`/`sessionDir`、`sessionName`、`date`、`format`（文件头嗅探）、`sizeBytes`、`mtime` |
| `GET /api/logs/files/:id/preview?start=&count=` | 按行读取窗口（`start` 缺省 0，`count` 上限 500 行 / 单行 10000 字符）。**不读全文**：行偏移索引 + `seek`，第 10 万行也是毫秒级；返回 `{ lines, start, total?, truncated }` |
| `GET /api/logs/files/:id/download` | 附件流下载，`Content-Disposition` 用 UTF-8 `filename*` 传中文文件名 |
| `DELETE /api/logs/files/:id` | 删除单个文件，记 `log_delete` 审计 |
| `DELETE /api/logs/sessions/:dir` | 整目录删除（「清空某会话的日志」） |
| `GET /api/audit?event=&from=&to=&page=&pageSize=` | 审计流水查询。`event` 非法直接 **400**；`from`/`to` 接受 ISO 8601 或 `YYYY-MM-DD`；返回 `{ entries, total, page, pageSize }` |

路径安全：`id` 与 `dir` 都做越界校验，`../` 之类的穿越请求返回 **400**，不存在的文件返回 **404**。

日志格式与设置随会话走：`POST /api/terminals` 的响应在会话启用了日志时带 `logging: { enabled, format }`，`GET /api/capabilities` 的 `logging` 字段给出格式清单、保留天数范围、规则与体积上限。

WebSocket 新增一类客户端控制消息 `log-html`（`{ t:'log-html', seq, final, data }`）：浏览器把 `serializeAsHTML()` 的结果按 60k 字符分片上传，服务端按 `seq` 严格递增装配，`final` 时写临时文件再 `rename` 原子替换当天快照。`seq` 不连续的整份快照直接丢弃（宁可少一份快照，也不要写出半截的坏文件）。

### 保险库 / 凭据 / 会话库（阶段 2）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/vault/status` | `{ initialized, unlocked, credentialCount? }` |
| `POST /api/vault/setup` | 首次设置主密码（≥8 位）；已初始化返回 409 |
| `POST /api/vault/unlock` | 解锁；密码错误返回 401，未初始化返回 409 |
| `POST /api/vault/lock` | 立即锁定并清零内存中的主密钥 |
| `GET /api/credentials` | 只返回摘要（无明文）：`{ id, name, type, hasPassphrase? }` |
| `POST/PATCH/DELETE /api/credentials[/:id]` | 增改删；删除时若仍被会话引用返回 409 `CREDENTIAL_IN_USE` |
| `GET /api/library` | 返回扁平节点列表（含 `parentId` / `sortOrder` / `session`），前端自行组树 |
| `POST/PATCH/DELETE /api/library[/:id]` | 建节点 / 改名称与归属与会话配置 / 删除（分组递归）；循环引用返回 409 `CYCLE` |

会话记录（`session`）同样按协议区分：SSH 记录必须带 `username` 与 `credentialId`；**Telnet 记录不允许出现 `credentialId`，跳板链也必须为空**，否则 400 `VALIDATION_FAILED`（避免出现「看着像配了、实际不生效」的配置）。

需要解锁的接口在锁定态返回 **423 Locked** + `error: "LOCKED"`。

### SFTP 文件传输（阶段 3）

双栏的两侧都在**服务端所在机器**上：`local` 是服务端受限的本地根目录（默认用户家目录，有防 `..` 逃逸与符号链接越界的校验），`remote` 是 SSH 目标主机的文件系统。之所以不做「浏览器本地磁盘」这一侧，是因为浏览器的安全模型不允许随意读写本地路径；而 WebTerm 的典型部署就是服务跑在自己机器上、用浏览器访问 localhost，此时服务端磁盘就是用户的磁盘。需要真正跨机器搬运时，另有浏览器上传 / 下载通道。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sftp/sessions` | 列出当前活跃的 SFTP 会话 |
| `POST /api/sftp/sessions` | 建会话，请求体三选一：`{ sessionId }` / `{ config: { target, legacyCompat? } }` / `{ terminalId }`。**`terminalId` 会在该终端已有的 SSH 连接上开 SFTP 通道**，避免对同一台设备重复登录（老设备的 VTY 线路常常只有几条） |
| `DELETE /api/sftp/sessions/:id` | 关闭会话并释放连接 |
| `GET /api/sftp/sessions/:id/list?side=&path=` | 列目录，返回条目（含 `mode` / `modeText` / 类型 / 软链接指向）以及 `parent`、`root` / `home` |
| `POST /api/sftp/sessions/:id/{mkdir,rename,chmod,touch,remove}` | 文件操作；`remove` 支持批量路径 |
| `POST /api/sftp/sessions/:id/preview` | 文本预览：返回内容、`mtime`、`kind`（text/binary）、`truncated`、`editable` |
| `POST /api/sftp/sessions/:id/save` | 回写远端文件；带上打开预览时的 `expectedMtime`，不一致返回 **409 CONFLICT** 而非静默覆盖 |
| `GET/POST /api/sftp/sessions/:id/transfers` | 列出 / 创建传输任务（`direction` 以远端为参照：`upload` = 本地 → 远端） |
| `POST /api/sftp/sessions/:id/transfers/:taskId/:action` | `pause` / `resume` / `cancel` / `retry` |
| `DELETE /api/sftp/sessions/:id/transfers/:taskId` | 从列表移除已结束任务 |
| `POST /api/sftp/sessions/:id/upload?path=&offset=` | 请求体为 `application/octet-stream` 原始流；`offset` 支持续写 |
| `GET /api/sftp/sessions/:id/download?path=` | 支持 HTTP Range（206 + `Content-Range`） |
| `GET /api/sftp/sessions/:id/local/download?path=` | 下载服务端本地面板的文件 |

`WS /ws/sftp/:sftpId?token=<attachToken>` 只推送传输队列的状态：附加时先下发一次全量快照（`transfers`），再推增量（`transfer` / `removed`），这样断线重连后不会因为漏掉几条增量而让界面进度永久停在错误位置。目录列举与文件操作全部走 REST。

### `WS /ws/terminal/:terminalId?token=<attachToken>`

**二进制帧** = 终端原始字节流（输入 / 输出）；**文本帧** = JSON 控制消息（`ready` / `resize` / `exit` / `error` / `flow` / `ack`）。协议定义见 `packages/shared/src/ws.ts`。

`ready` 消息里的 `info` 带 `protocol` 字段；Telnet 会话额外带 `telnetOptions`（远端是否回显、SGA / TERMINAL-TYPE / NAWS 的协商结果、双方启用的选项名），SSH 专有字段统一填 `—`。前端据此在终端工具栏的协议徽标上给出排障提示。

未匹配到路由的 `/api/*` 请求统一返回 `{ "error": "NOT_FOUND", "message": "..." }`。

---

## 本地联调：开发用测试服务端

没有可用远端主机时，可以用内置的测试服务端做端到端验证。

### SSH（+ SFTP）

```bash
node packages/server/dev/mock-ssh-server.mjs
# 监听 127.0.0.1:2222，账号 demo / demo
```

支持的指令：`help` / `echo` / `cols`（验证 PTY 尺寸）/ `big <KB>`（验证背压）/ `utf8` / `gbk`（验证编码）/ `sleep` / `exit`。

用 `MOCK_LEGACY=1` 启动可模拟只支持 SHA-1 算法的老设备，用于验证自动降级：

```bash
MOCK_LEGACY=1 MOCK_PORT=2223 node packages/server/dev/mock-ssh-server.mjs
```

**验证 SFTP**：服务端自带 SFTP 子系统，`/home/demo` 映射到 `MOCK_SFTP_ROOT`：

```bash
MOCK_PORT=2231 MOCK_SFTP_ROOT='D:/tmp/mock-2231' node packages/server/dev/mock-ssh-server.mjs
```

| 变量 | 用途 |
| --- | --- |
| `MOCK_SFTP_ROOT` | SFTP 家目录对应的宿主目录 |
| `MOCK_NO_SFTP=1` | 不提供 SFTP 子系统，验证「远端不支持 SFTP」的提示 |
| `MOCK_SFTP_FAIL_ONCE_AFTER=<字节>` | 累计写入超过该字节后拒绝一次 WRITE，用于验证断点续传 |

**验证跳板链**：本服务端接受 `direct-tcpip`（即充当跳板机），把多个实例串起来即可：
```bash
MOCK_PORT=2222 node packages/server/dev/mock-ssh-server.mjs   # 跳板 A
MOCK_PORT=2223 node packages/server/dev/mock-ssh-server.mjs   # 跳板 B
MOCK_PORT=2224 node packages/server/dev/mock-ssh-server.mjs   # 目标 C
# 会话里配置：主机 127.0.0.1:2224，跳板链填 2222 → 2223
```

**验证远程转发（-R）**：本服务端接受 `tcpip-forward` / `cancel-tcpip-forward` 全局请求，并**真的在对应地址上监听**，再把每个入站连接通过 `forwarded-tcpip` 通道回送 —— 与真实 sshd 行为一致，因此 `-R` 链路可以端到端验证而不必假装成功。配合 WebTerm 的隧道面板（或 `ssh -R`）即可验证反向隧道。

**验证密钥登录**：以公钥模式启动，并把公钥 base64 从 stdin 传入：

```bash
printf '<公钥的 base64 blob>\n' | MOCK_AUTH=publickey MOCK_PORT=2225 node packages/server/dev/mock-ssh-server.mjs
```

### Telnet

```bash
node packages/server/dev/mock-telnet-server.mjs
# 监听 127.0.0.1:2323，无账号（Telnet 本身没有认证阶段）
```

支持的指令：`help` / `ping` / `echo <文本>` / `size`（回显最近一次 NAWS 尺寸）/ `ttype`（回显最近一次 TERMINAL-TYPE）/ `iac`（故意输出裸 `0xFF` 验证转义）/ `big <KB>`（验证背压）/ `quit`。

| 变量 | 用途 |
| --- | --- |
| `MOCK_PORT` | 监听端口，默认 2323 |
| `MOCK_TELNET_ECHO=0` | 不声明也不执行回显，验证**本端本地回显兜底** |
| `MOCK_TELNET_NO_NEGOTIATION=1` | 完全不做选项协商，模拟极简实现 |
| `MOCK_TELNET_NAME` | 设备名（同时作为提示符前缀），默认 `MockTelnet` |

---

## 开发约定

- **`packages/shared` 必须先构建**才能被 server / web 引用。`predev` / `prebuild` / `pretypecheck` 已自动处理，无需手动执行。
- 改动 `packages/shared` 后需重新构建（或另开终端跑 `npm run dev -w @webterm/shared` 开启 watch）。
- **终端数据传输一律使用 WebSocket 二进制帧**，只有控制类消息用 JSON 文本帧。
- 凭据（密码、私钥口令）**任何时候都不明文落盘**；**Telnet 会话不进任何凭据** —— 口令由用户在终端里交互输入。
- 服务默认只监听 `127.0.0.1`，开放到局域网需显式配置。
- 会话配置是**按 `protocol` 判别的联合类型**，SSH / Telnet 的差异止步于类型与 UI 层，`TerminalSession` 之上（编码桥、背压、标签生命周期）完全共用一套实现。新增协议时按这个边界扩展。
- 隧道规格同样是**按 `type` 判别的联合类型**（`local` / `remote` / `dynamic`）—— `dynamic` 没有目标地址，写成可选字段会让矛盾配置在类型上无法被发现。
- 会话关闭时**先撤销隧道（含远端 `cancel-tcpip-forward`）、再断 SSH 连接** —— 顺序反了远端监听就撤不掉，端口会一直被占着。

---

## 已实现的阶段

| 阶段 | 状态 |
| --- | --- |
| 0 工程骨架 | ✅ 已完成 |
| 1 终端主干打通 | ✅ 已完成 |
| 2 会话管理与持久化 | ✅ 已完成 |
| 3 SFTP 文件传输 | ✅ 已完成 |
| 4 Telnet 明文终端（插入交付） | ✅ 已完成 |
| 5 端口转发与隧道 | ✅ 已完成 |
| 6 自动化与批量运维 | ✅ 已完成 |
| 7 日志与审计 | ✅ 已完成 |
| 8 体验打磨 | ✅ 已完成 |
| 9 插件机制与打包发布 | 待开发 |

### 端到端验证

| 套件 | 脚本 | 结果 |
| --- | --- | --- |
| 阶段 2 服务端 | `data/tmp/e2e-phase2.mjs` | 36/36 |
| 阶段 3 服务端 | `data/tmp/e2e-phase3.mjs` | 75/75 |
| 阶段 3 浏览器 | `data/tmp/e2e-browser-p3.mjs` | 55/55 |
| 阶段 4 Telnet 服务端 | `data/tmp/e2e-telnet.mjs` | 53/53 |
| 阶段 4 Telnet 浏览器 | `data/tmp/e2e-browser-telnet.mjs` | 80/80 |
| 阶段 5 隧道服务端 | `data/tmp/e2e-tunnel.mjs` | 65/65 |
| 阶段 5 隧道浏览器 | `data/tmp/e2e-browser-tunnel.mjs` | 97/97 |
| 阶段 6 自动化服务端 | `data/tmp/e2e-automation.mjs` | 196/196 |
| 阶段 6 自动化浏览器 | `data/tmp/e2e-browser-automation.mjs` | 137/137 |
| 阶段 7 日志服务端 | `data/tmp/e2e-logging.mjs` | 69/69 |
| 阶段 7 日志浏览器 | `data/tmp/e2e-browser-logging.mjs` | 81/81 |
| 阶段 8 体验打磨浏览器 | `data/tmp/e2e-browser-phase8.mjs` | 168/168 |

阶段 8 只改前端（设置 / 主题 / 搜索 / 高亮 / 分屏 / 快捷键 / 通知 / i18n / 响应式），
没有服务端改动，因此服务端套件沿用阶段 7 的结果；阶段 7 的浏览器套件在阶段 8 之后重跑过，仍全绿。

运行方式（含端口分配与 `NODE_PATH` 等前置条件）见 [`docs/03-测试指南.md`](docs/03-测试指南.md)。
