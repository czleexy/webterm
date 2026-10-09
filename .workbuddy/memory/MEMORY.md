# WebTerm 项目备忘

> 浏览器里的 SSH / Telnet 终端（对标 SecureCRT）。monorepo：`packages/{shared,server,web}`。
> **阶段 0~9 全部完成**（…→ 插件与打包），CI 出 Docker 镜像。详细看 `README.md` / `docs/02-实现计划.md` / `docs/03-测试指南.md`（FAQ 很全）；细节史在各日 `YYYY-MM-DD.md`。

## 1. 开发环境（Windows + WorkBuddy 沙箱）

**Git Bash 默认 PATH 是坏的**，每条 bash 命令先：
`export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:/bin:/c/Windows/System32:/c/Windows"`

| 工具 | 用法 |
| --- | --- |
| node | `C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（另有 22.12.0；项目下限 22.12.0） |
| npm | 无裸 `npm`；`node "<ver>/node_modules/npm/bin/npm-cli.js" <args>`。**跑 `npm run build/package` 等带钩子的脚本时，还要把 `<ver>` 目录加进 PATH**（pre* 钩子里的裸 `npm` 靠 `<ver>/npm.cmd` 找到） |
| git | `.../PortableGit/versions/1.2.0/cmd/git.exe`，**未配 user.name/email**：`git -c user.name=… -c user.email=… commit` |
| python | `.../python/envs/default/Scripts/python.exe`（venv，有 PyYAML） |
| puppeteer | `.../node/workspace/node_modules`，先 `export NODE_PATH=` 该目录 |

**环境坑位（都踩过、都费时间）**
- ⚠️ **编辑工具偶发「报成功但没落盘」** → 改完关键文件必须 grep 核实
- ⚠️ **bash 里 `&` 起的进程随该条调用结束而死**：起服务+测试写在同一条调用；跨调用用 `run_in_background`
- ⚠️ **带多行参数的 bash 命令可能被执行两次**：`git commit` 报「nothing to commit / could not read log file」但**其实已提交**。看 `git log`/`git status` 别看退出码；提交消息写文件用 `-F`，`git push` 单独一条
- ⚠️ **「单轮删除 > 50 文件」保护**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）会拦脚本里的 `rmSync` 大目录（如重打包 release）。**别用 `env -u CODEBUDDY_SAFE_DELETE_BULK_*` 放行 —— 已失效且有害（node 静默退出）**。重生成大目录前先把旧的 `mv` 到 `/tmp`（release/ 是 gitignored，安全）
- ⚠️ **`node script.mjs` 别写成 `node "$NODE" script.mjs`**（把 node.exe 当脚本读，报 MZ SyntaxError）
- ⚠️ **Python `subprocess` 在 Windows 用 `text=True` 会把 `\n` 翻成 `\r\n`**：喂 bash 的脚本必须传 bytes
- ⚠️ tsc 增量缓存造幽灵类型错误 → `rm -f packages/*/dist/.tsbuildinfo` 重跑
- ⚠️ PowerShell 工具不回传 stdout；`MSYS_NO_PATHCONV=1 taskkill /F /PID <pid>`；根构建偶发 rolldown 报错重跑即可；网络分主机抖动（github.com 超时但 api.github.com / ghcr.io / shields.io 正常，备多条通道）

**行尾**：`core.autocrlf=true`，blob 一律 LF；`.gitattributes` 已钉 `*.yml/*.yaml` eol=lf。

## 2. 项目约定

- `packages/shared` 必须先构建（pre* 钩子处理）；终端数据一律 WS 二进制帧；凭据不明文落盘；Telnet 会话不挂凭据（zod 拒绝 `credentialId`）
- `verbatimModuleSyntax`：类型导入必须 `import type`
- 静态托管只在生产模式生效；开发前端 `http://localhost:5173`（别用 127.0.0.1）
- `npm start` 走 `start-production.mjs` 显式设生产模式（NODE_ENV 不会被 npm 自动设）
- 服务端只听 127.0.0.1；**无 HTTP 访问认证（F7.4 未交付）**，绑非回环必须 `WEBTERM_ALLOW_INSECURE_LAN=1`
- 端口：开发 8080 / mock 2222-2225；E2E 8096/8098/8099/8100/8106/8131，mock 2231-2253/2346/2347/2361/2441-2451

## 3. 依赖约束

- Vite **8.3.0**（plugin-react@6 强制）→ Node 下限 22.12.0；`@tailwindcss/vite@4.3.3` 兼容 Vite 8
- TS **5.9.3**；`@xterm/xterm` **6.0.0**
- `ssh2` 是 CJS：ESM 里用 `createRequire`；`generateKeyPairSync('ed25519',{passphrase})` 必须同时给 `cipher`
- `better-sqlite3@13`：**预编译要求 glibc ≥ 2.33**，老 glibc（麒麟 V10=2.28/2.31）加载不了 → 发布包内置 `rebuild-native.sh`（删 prebuilds → `npm rebuild` 源码编译；GCC<10 连 `-std=c++20` 都不认识，需 g++-10 + `CC/CXX`），或用 Docker 镜像。2026-10-09 提交 `f99849c`

## 4. 关键实现约束（按主题，详见 docs/03 FAQ）

- **保险库**：主密钥 scrypt(N=2^15,r=8) 只存内存；**必须显式 maxmem**；AES-256-GCM `iv|tag|ct`；锁定态 423；WS 用一次性 attach token。Origin 校验未落地
- **日志**：脱敏必须行对齐后再替换；HTML 快照刻意不脱敏；预览按字节扫 0x0A 建索引 + 分页；写合并 256KB/200ms
- **自动化**：沙箱 = vm + worker.terminate()（vm timeout 盖不住 await 后的死循环）；行尾 `\r\r\n` 要把尾 `\r` 剥净；自动应答防自激振荡（尾行快照+carriedOver）；批量执行只支持 SSH
- **Telnet**：配置是按 protocol 的判别联合；本地回显兜底（设备声明 WILL ECHO 就不重复）；无 SFTP（400）；mock 只认 LF 是 mock 的锅
- **体验**：分屏用 CSS Grid 自绘（react-resizable-panels 会重建终端→重连 SSH）；xterm 提案 API 必须 `allowProposedApi: true`（否则静默 0 结果）；搜索条悬浮；快捷键 event.code + 捕获阶段
- **插件**：`node:vm` 不是安全沙箱，permissions 只做提示；动作必须同步返回；输出订阅全局一份（wantsOutput + syncOutputSubscriptions）；`TRIGGER_ACTION_TYPES` 白名单漏加=静默失效
- **排障速查**：终端背压 64KB（客户端要回 ack）；分屏裁滚动缓冲是 reflow 不是重建；ssh2 服务端跳板事件名是 `'tcpip'`；SFTP 写流失败先 destroy 后回调（error 不发，要 close 兜底）；取消删半成品 EBUSY 退避重试；HTML 回放必须 `serializeAsHTML()`

## 5. 真机 `hwssh@192.168.1.254:22`

老旧非标设备（标识串 `SSH-2.0--`；仅 dh-group14-sha1/gex-sha1；拒绝 shell/exec/sftp）。OpenSSH 10.3 同样失败 → 设备侧限制。端到端靠 `dev/mock-ssh-server.mjs`（MOCK_LEGACY=1）。

## 6. 浏览器 E2E 要点

无 Playwright，用 puppeteer-core + 系统 Chrome（`executablePath`）。独立实例（NODE_ENV=production + 独立端口）。读 `.xterm-rows` 的 textContent（仅视口行）；xterm 键入先 focus `.xterm-helper-textarea`；React 受控组件用原生 setter + input 事件；`typeLine` 只作用于 active 终端；CDP 控通知权限；断言陷阱详见 docs/03。

## 7. CI / 发布

- 远端 `git@github.com:czleexy/webterm.git`（公开），分支 main，标签 `v0.2.0` → `e86d74e`
- `.github/workflows/docker-image.yml`：build（推 GHCR `ghcr.io/czleexy/webterm`）+ smoke（pull → run → /api/health → 首页 HTML → 版本比对）。平台：常规 push 只 amd64；`v*`/手动才 amd64+arm64；provenance:false + GHA 缓存；metadata-action 的自动 label 要用 `labels:` 手工覆盖（licenses/version/title/description）
- ⚠️ **GHCR 实测：包带 `org.opencontainers.image.source` 关联公开仓库后匿名可拉**（推翻「首次必私有」的说法）；`latest` 的平台跟着最近一次构建变，生产钉版本号
- 本机无 docker、无 `gh`：查状态用 `data/tmp/watch-run.mjs`（REST）/ 徽标 / shields.io；GHCR 直接探测 `data/tmp/probe-ghcr.mjs`、`probe-tags.mjs`；落地前校验 `data/tmp/check-workflow.py`（读 `git show :path` 入库形态）
- 发布包：`npm run package` → `release/webterm/`（扁平自包含，vendor/shared 摊平 + file: 依赖；直接写 node_modules 会被 npm install 清掉）。**重生成前先把旧目录 mv 到 /tmp**（撞删除保护）。数据目录分家：便携 `./data`，全局 `~/.webterm`
