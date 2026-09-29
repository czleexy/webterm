# WebTerm

基于 Node.js 的浏览器 SSH / Telnet 客户端，对标 SecureCRT / Xshell。

服务跑在本机负责协议栈与连接管理，浏览器只负责渲染与交互。免安装、跨平台，配置与会话集中在一处管理。

> 当前进度：**阶段 4（Telnet 明文终端）已交付** —— 端口 23、选项协商（TERMINAL-TYPE / NAWS）、本地回显兜底、IAC 转义，与 SSH 共用同一套终端与标签体系。
> 前一阶段：阶段 3（SFTP 文件传输）—— 双栏浏览、传输队列（并发 / 断点续传 / 暂停取消）、拖拽互传、浏览器上传下载、文本预览与远程编辑（带 mtime 冲突检测）。
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
│  │  └─ src/{constants,api,ws,sftp}.ts
│  ├─ server/                Fastify 服务端
│  │  ├─ dev/mock-ssh-server.mjs     开发用 SSH 测试服务端（含 SFTP 子系统）
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
│  │     ├─ terminal/        终端会话（双传输：SSH / Telnet） / 会话注册表 / 编码桥
│  │     └─ api/
│  │        ├─ rest/         REST 路由（health / capabilities / sessions / terminals / vault / credentials / library / sftp）
│  │        ├─ resolver.ts   会话记录 → 明文连接参数
│  │        └─ ws/           终端与 SFTP WebSocket 端点
│  └─ web/                   React 前端
│     └─ src/
│        ├─ api/             REST 请求封装
│        ├─ components/      UI 组件（门禁 / 弹窗 / 标签栏 / 会话库侧栏）
│        ├─ terminal/        xterm 封装 / 连接 Hook / 配色
│        ├─ sftp/            SFTP 双栏工作区 / 文件列表 / 传输抽屉
│        ├─ store/           标签页 / 保险库 / 会话库 / SFTP 状态（Zustand）
│        ├─ theme/           主题状态（Zustand persist）
│        └─ utils/
└─ data/                     运行时数据（已被 git 忽略）
   ├─ webterm.db              SQLite（会话库 + 加密凭据）
   └─ known_hosts.json        主机密钥指纹记录（TOFU）
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

---

## 已实现的阶段

| 阶段 | 状态 |
| --- | --- |
| 0 工程骨架 | ✅ 已完成 |
| 1 终端主干打通 | ✅ 已完成 |
| 2 会话管理与持久化 | ✅ 已完成 |
| 3 SFTP 文件传输 | ✅ 已完成 |
| 4 Telnet 明文终端（插入交付） | ✅ 已完成 |
| 5 ~ 9（端口转发 / 自动化 / 日志审计 / 体验打磨 / 插件打包） | 待开发 |

### 自动化端到端验证

| 套件 | 脚本 | 结果 |
| --- | --- | --- |
| 阶段 2 服务端 | `data/tmp/e2e-phase2.mjs` | 35/35 |
| 阶段 3 服务端 | `data/tmp/e2e-phase3.mjs` | 75/75 |
| 阶段 3 浏览器 | `data/tmp/e2e-browser-p3.mjs` | 55/55 |
| 阶段 4 Telnet 服务端 | `data/tmp/e2e-telnet.mjs` | 53/53 |
| 阶段 4 Telnet 浏览器 | `data/tmp/e2e-browser-telnet.mjs` | 80/80 |

运行方式（含端口分配与 `NODE_PATH` 等前置条件）见 [`docs/03-测试指南.md`](docs/03-测试指南.md)。
