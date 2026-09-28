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

## 状态与进度（2026-09-28）

- 已完成：阶段 0（骨架）、阶段 1（终端主干）、阶段 2（会话库 + 主密码保险库 + 密钥登录 + 跳板机）
- 下一步：阶段 3 SFTP 文件传输
- 阶段 2 的完整 E2E 脚本在 `data/tmp/e2e-phase2.mjs`（自管 4 个 mock + 服务端重启），**其执行曾被环境敏感内容审批拦截**，需要用户授权后重跑确认

## 项目约定

- **`packages/shared` 必须先构建**才能被 server / web 引用；根 `package.json` 已用 `predev` / `prebuild` / `pretypecheck` / `prestart` 自动处理
- 终端数据传输**一律使用 WebSocket 二进制帧**，仅控制类消息用 JSON 文本帧
- 凭据（密码、私钥口令）**任何时候都不明文落盘**
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

- 主密钥由 `scrypt(password, salt, N=2^15, r=8, p=1)` 派生，**只存进程内存**，`lock()` 时 `fill(0)` 清零
- 凭据存储格式：`AES-256-GCM`，密文 = `iv(12B) | authTag(16B) | ciphertext`，整体存 SQLite BLOB
- 解锁校验用「已知明文的密文」（verifier），不用独立哈希 —— 少一套逻辑，且 GCM 的 authTag 天然防篡改
- 锁定态访问需凭据的接口返回 **423 Locked**（区别于 401 认证失败）
- mock SSH 服务端支持 `direct-tcpip`（当跳板机用）与 `MOCK_AUTH=publickey`（公钥经 stdin 传入，不落盘）

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
- 读 xterm 终端内容：`document.querySelector('.xterm-rows')` 的子 div 逐行取 `textContent`
- 给 xterm 键入：先 `page.click('.xterm-helper-textarea')` 聚焦，再 `page.keyboard.type(...)`
