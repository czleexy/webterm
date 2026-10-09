# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
版本号在仓库里有多处，改版本时需一起调整，否则界面会提示前后端版本不一致：

- `packages/shared/src/constants.ts` 的 `APP_VERSION`（界面与 `/api/health` 用的就是这个）
- 根与三个子包的 `package.json`（发布包版本、npm 包版本）
- `package-lock.json`（改完跑 `npm install --package-lock-only` 同步，否则 `npm ci` 会直接失败）

---

## [未发布]

### 新增

- **容器镜像由 CI 构建并发布到 GHCR**：`.github/workflows/docker-image.yml` 在推送到 `main` 时构建
  并推送 `ghcr.io/czleexy/webterm`（标签 `latest` / `main` / `sha-<commit>` / 语义版本），
  并有一个 smoke 作业真的把镜像跑起来验收：`docker run -p 8080:8080` → 等 `/api/health`
  → 断言首页 `text/html` 且含 `id="root"` → 比对镜像内版本与 `package.json`。
  于是「镜像能跑」这件事由构建记录出证据，不再依赖人工在本地跑一次。
- 新增 `.gitattributes`：`*.yml` / `*.yaml` 固定 `eol=lf`。CI 的 `run:` 脚本是原样交给 Linux bash 的，
  文件若以 CRLF 入库会报 `$'\r': command not found` 这类看不出根因的错。
- 新增落地前校验与运行观察脚本：`data/tmp/check-workflow.py`（解析 + 结构核对 + 确认 `uses:` 版本存在 +
  对每段 `run:` 做 `bash -n`）、`data/tmp/probe-ghcr.mjs`（从 GHCR **外部匿名**探测可拉取性与镜像元数据）、
  `data/tmp/watch-run.mjs`（本机无 `gh` CLI，直接打 REST API 盯运行）
- **发布包内置 `rebuild-native.sh`**：better-sqlite3 的预编译二进制要求 glibc ≥ 2.33，
  麒麟 V10 / CentOS 7 这类老 glibc 发行版加载不了。脚本在目标机器上做环境诊断
  （glibc / 编译器 / 工具链检查，含 GCC < 10 不支持 C++20 的提前拦截）→ 删预编译 →
  `npm rebuild better-sqlite3` 源码编译 → 内存库验证。README 增补对应排障章节。

### 变更

- 镜像标签改为由 `docker/metadata-action` 生成，并显式覆盖三项：`licenses=MIT`
  （自动值在没有 LICENSE 文件时为空，会把 Dockerfile 里的声明盖掉）、
  `version`（分支构建时自动值是分支名 `main`，那是「构建来源」不是「版本」）、
  `description`（自动值取 GitHub 仓库简介，比 Dockerfile 里的说明还简陋）
- 平台策略：常规 push 只构建 `linux/amd64`；打 `v*` 标签或手动触发才构建 `amd64+arm64`
  （arm64 要走 QEMU，项目内有 better-sqlite3 / rolldown / oxide 等原生模块，模拟下慢好几倍）
- 关闭 buildx 的 provenance 证明：默认会多出一个 `unknown/unknown` 平台条目，
  Portainer 之类的工具会看得一脸问号
- README「生产部署 ③ Docker」改为**以拉取 CI 镜像为主**，自建镜像降为备选

### 说明

- 阶段 9 验收清单第 2 条（`docker run -p 8080:8080 webterm` 可访问）**至此有实测证据**：
  commit `9f6f0a8` 的构建两个作业全绿；外部匿名探测确认可 pull、`linux/amd64`、非 root、
  暴露 8080、带 `HEALTHCHECK`、97.9 MB（压缩后）
- 已打标签 `v0.2.0`，产出 `0.2.0` / `0.2` 的**多架构**镜像（`linux/amd64` + `linux/arm64`）。
  该标签之后的应用代码与阶段 9 收口提交 `cd5298e` 完全一致（其后提交只涉及 CI、文档与仓库配置）
- 可用的镜像引用：

  ```bash
  docker run -p 8080:8080 ghcr.io/czleexy/webterm:0.2.0     # 钉住版本（多架构）
  docker run -p 8080:8080 ghcr.io/czleexy/webterm:latest    # 跟随默认分支
  docker run -p 8080:8080 ghcr.io/czleexy/webterm:sha-e86d74e01b26a94d9363c10a4063c07a2fdd28e4
  ```

---

## [0.2.0] - 2026-09-30

阶段 9：插件机制与打包发布。**全部 10 个阶段收口**，功能集合冻结。

### 新增

**插件机制**

- 插件清单 `plugin.json`（zod 校验）：`id` / `name` / `version` / `apiVersion` / `main` / `permissions` / `config` 声明式配置项（`string` / `number` / `boolean`，含默认值与 `min`/`max`）
- 插件运行时：目录扫描、`node:vm` 上下文执行入口、受限 Host API 注入、崩溃隔离（坏插件只让自己进入 `error` 状态并在界面上如实显示原因）
- 三类注册项：触发器动作（接进触发器编辑器的动作下拉）、命令（插件卡片上的按钮）、面板（表格数据）
- 事件订阅：`session:opened` / `session:closed` / `session:output`
- Host API：`host.sessions.*`、`host.getConfig` / `host.config`、`host.log`、`host.notify`
- 配置热更新：保存即生效，不重载插件；提交前按清单声明做类型转换 + 范围钳制 + 丢弃未知键
- 启停与重载：停用即卸载（定时器与输出订阅一并回收），支持改完代码重载
- 插件面板：新顶栏入口（带「加载失败」角标）、按状态排序的卡片列表、配置表单、命令按钮、面板表格、日志折叠区
- 全局事件通道 `WS /ws/events`：广播 `plugin-notify` / `plugins-changed`，指数退避重连（1s→30s），30 秒协议级 ping 保活
- 新增设置项「插件通知时提醒」，可单独关掉插件通知而不影响其他通知

**示例插件**

- `data/plugins/heartbeat-monitor`：定时向会话发送心跳命令、长时间无回应则告警（失败阈值可配）、恢复时另发一次通知；提供「心跳确认」触发器动作、三个命令（立即检查 / 全部发送心跳 / 重置统计）、一张按会话的存活状态表。演示了插件机制的全部能力，可直接当骨架抄

**打包与发布**

- `bin/webterm.mjs`：统一 CLI 入口，兼容「源码仓库」与「发布包」两种目录布局；支持 `--port` / `--host` / `--data-dir` / `--help` / `--version`，默认进生产模式
- `scripts/package-portable.mjs`（`npm run package`）：产出自包含的 `release/webterm/`，同时就是 npm 包内容（含 `bin` 声明与 `bundledDependencies`，`npm pack` 出的 tarball 可直接 `npm i -g`）；附带 `start.cmd` / `start.sh`（便携启动，数据目录固定在自身目录下）
- 新增 `WEBTERM_WEB_DIR`：发布形态下由启动器显式注入前端产物目录，服务端不再靠相对路径猜自己在什么形态里运行
- `Dockerfile`：多阶段构建（构建期装 python3/make/g++ 以应对 better-sqlite3 无预编译包的平台；运行期只带生产依赖）、非 root 用户运行、`HEALTHCHECK` 用 node 内置 `fetch` 探活、两个挂载点 `/data` 与 `/files`
- `docker-compose.yml`：具名卷（避免 bind mount 到不存在目录时属主为 root 导致 EACCES）、宿主端口只绑 `127.0.0.1`、`mem_limit`
- `scripts/check-dockerfile.mjs`（`npm run check:dockerfile`）：无 docker 环境下的静态自检 —— Dockerfile 引用的路径是否存在、`.dockerignore` 是否误挡了必需文件
- `npm start` 改为显式以生产模式启动。此前它沿用 `NODE_ENV` 的默认值，实际跑的是「开发态」，导致 `npm run build && npm start` 打开浏览器只有一段纯文本
- `packages/web/dist` 缺失时不再让 pino 因解析不到 `pino-pretty`（devDependency）而抛错退出，改为退化到 JSON 日志

### 变更

- 版本号从 `0.1.0` 对齐到 `0.2.0`（此前 `APP_VERSION` 与各 `package.json` 不一致，界面与包版本对不上）
- 顶栏新增「插件」入口；设置面板的通知分区新增一项
- 首页实施进度更新为「已完成阶段 0 ~ 9」，阶段 9 标记为已完成

### 安全

- **新增局域网安全闸**：`WEBTERM_HOST` 为非回环地址时，必须同时设置 `WEBTERM_ALLOW_INSECURE_LAN=1`，否则拒绝启动并打印存在哪些风险。原因见下一条
- **修正文档中的不实描述**。README、`.env.example` 与部分代码注释此前写着「开放局域网需先设置访问密码」，但项目**从未实现 HTTP 访问认证**（需求文档中的 F7.4「服务访问控制」仍未交付）。保险库主密码保护的是保存的凭据，不是对网页的访问。现在文档如实说明这一点，并给出推荐做法（保持监听回环 + SSH 端口转发，或放在带认证的反向代理之后）

### 修复

- 触发器动作类型白名单（`db/automation.ts` 的 `ACTION_TYPES`）此前是硬编码的五项，新增插件动作后会导致「规则能存、接口能查、运行时什么都不做且不报错」。已提取为 `packages/shared` 的 `TRIGGER_ACTION_TYPES` 常量，DB 层直接引用
- 插件配置的越界值此前会被原样写入数据库，只在读回时才钳制。现改为提交前规范化（类型转换 + 范围钳制 + 丢弃未知键）再落库
- 阶段 5 浏览器套件中「端口是否在监听」的判据由 `netstat -ano` 改为反向 bind 验证：前者要起 `cmd.exe`，在受限环境里会 `EBUSY`，导致「查不了」与「没监听」无法区分

### 已知限制

- 插件在 `node:vm` 中执行，**这不是安全沙箱**（与宿主同进程）。清单里的 `permissions` 目前只作界面提示，不做拦截
- 尚无 HTTP 访问认证（F7.4 未实现），不要把服务直接暴露到公网
- 前端主 bundle 约 1.3 MB（gzip 后约 384 KB），尚未做代码分割

---

## [0.1.0] - 2026-09-24

阶段 0 ~ 8 的实现过程，按阶段逐次交付：

| 阶段 | 内容 |
| --- | --- |
| 0 | 工程骨架（npm workspaces / Fastify / Vite / 一键启动） |
| 1 | 终端主干：ssh2 + WebSocket 二进制帧 + xterm.js + 背压控制 |
| 2 | 会话管理与持久化：SQLite、主密码保险库（scrypt + AES-256-GCM）、密钥认证、跳板机 |
| 3 | SFTP：双栏浏览、传输队列、断点续传、远程编辑 |
| 4 | Telnet（插入交付）：选项协商状态机、NAWS、本地回显兜底 |
| 5 | 端口转发与隧道：`-L` / `-R` / `-D`（SOCKS5）、随会话自动启动 |
| 6 | 自动化与批量运维：触发器、按钮栏多步宏、沙箱脚本、同步输入广播、批量执行 |
| 7 | 日志与审计：三种日志格式、按天归档与轮转、正则脱敏、行偏移索引分页预览、审计流水 |
| 8 | 体验打磨：设置中心、UI 主题与 9 套终端配色、终端搜索、关键词高亮、2/4 宫格分屏、可自定义快捷键、Toast 与桌面通知、中英双语、响应式 |

各阶段的端到端验证结果见 [README 的「端到端验证」](README.md#端到端验证)。

[0.2.0]: https://github.com/czleexy/webterm/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/czleexy/webterm/releases/tag/0.1.0
