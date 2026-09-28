# WebTerm

基于 Node.js 的浏览器 SSH 客户端，对标 SecureCRT / Xshell。

服务跑在本机负责 SSH 协议栈与连接管理，浏览器只负责渲染与交互。免安装、跨平台，配置与会话集中在一处管理。

> 当前进度：**阶段 3（SFTP 文件传输）已交付** —— 本地 / 远端双栏浏览、传输队列（并发 / 断点续传 / 暂停取消）、拖拽互传、浏览器上传下载、文本预览与远程编辑（带 mtime 冲突检测）。
> 前一阶段：阶段 2（会话管理与持久化）—— 会话库（分组 / 树）、主密码保险库（AES-256-GCM 加密凭据）、密钥登录、跳板机 ProxyJump。
> 详细设计见 [`docs/01-功能框架与需求说明书.md`](docs/01-功能框架与需求说明书.md) 与 [`docs/02-实现计划.md`](docs/02-实现计划.md)。
> 界面截图见 [`docs/screenshots/`](docs/screenshots/)。

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.12.0**（Vite 7 与 better-sqlite3 13 的下限） |
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

点击「新建 SSH 连接」填入主机信息即可建立终端。可先点「测试连接」确认连通性与认证，并查看实际协商出的算法与主机密钥指纹。

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
│  │  └─ src/{constants,api,ws}.ts
│  ├─ server/                Fastify 服务端
│  │  ├─ dev/mock-ssh-server.mjs   开发用 SSH 测试服务端
│  │  └─ src/
│  │     ├─ index.ts         进程入口（加载配置 → 建目录 → 监听）
│  │     ├─ app.ts           Fastify 实例装配 + 静态托管 + 404 处理
│  │     ├─ config/          环境变量校验（zod）
│  │     ├─ db/              SQLite 打开与迁移、会话库 DAO
│  │     ├─ security/        保险库（主密码 KDF + AES-GCM）、凭据存取
│  │     ├─ ssh/             算法档案 / 连接建立 / 跳板链 / 主机密钥 / 错误分类
│  │     ├─ terminal/        终端会话 / 会话注册表 / 编码桥
│  │     └─ api/
│  │        ├─ rest/         REST 路由（health / capabilities / sessions / terminals / vault / credentials / library）
│  │        ├─ resolver.ts   会话记录 → 明文连接参数
│  │        └─ ws/           终端 WebSocket 端点
│  └─ web/                   React 前端
│     └─ src/
│        ├─ api/             REST 请求封装
│        ├─ components/      UI 组件（门禁 / 弹窗 / 标签栏 / 会话库侧栏）
│        ├─ terminal/        xterm 封装 / 连接 Hook / 配色
│        ├─ store/           标签页 / 保险库 / 会话库状态（Zustand）
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

返回 ssh2 版本、算法档案（modern / legacy 的完整算法清单）、支持的编码与背压水位。前端欢迎页据此展示，排障时可直接查看。

### `POST /api/sessions/probe`

只做「TCP + 握手 + 认证」，不开终端会话。返回协商算法、主机密钥指纹与告警列表 —— 用于「测试连接」，能区分「连不上」「认证失败」「认证通过但拒绝会话」三类故障。

### `POST /api/terminals` / `GET /api/terminals` / `DELETE /api/terminals/:id`

创建（此时已建立真实 SSH 连接，失败返回标准 HTTP 状态码 + 错误码）、列出、关闭终端。创建响应含一次性 `attachToken`。

请求体二选一：`{ config }`（快速连接，前端直传）或 `{ sessionId }`（引用会话库，服务端负责解密凭据并组装跳板链）。

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

未匹配到路由的 `/api/*` 请求统一返回 `{ "error": "NOT_FOUND", "message": "..." }`。

---

## 本地联调：开发用 SSH 测试服务端

没有可用远端主机时，可以起一个内置的测试服务端做端到端验证：

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

---

## 开发约定

- **`packages/shared` 必须先构建**才能被 server / web 引用。`predev` / `prebuild` / `pretypecheck` 已自动处理，无需手动执行。
- 改动 `packages/shared` 后需重新构建（或另开终端跑 `npm run dev -w @webterm/shared` 开启 watch）。
- **终端数据传输一律使用 WebSocket 二进制帧**，只有控制类消息用 JSON 文本帧。
- 凭据（密码、私钥口令）**任何时候都不明文落盘**。
- 服务默认只监听 `127.0.0.1`，开放到局域网需显式配置。

---

## 已实现的阶段

| 阶段 | 状态 |
| --- | --- |
| 0 工程骨架 | ✅ 已完成 |
| 1 终端主干打通 | ✅ 已完成 |
| 2 会话管理与持久化 | ✅ 已完成 |
| 3 SFTP 文件传输 | ✅ 已完成 |
| 4–8 | 待开发 |
