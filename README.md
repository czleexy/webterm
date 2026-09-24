# WebTerm

基于 Node.js 的浏览器 SSH 客户端，对标 SecureCRT / Xshell。

服务跑在本机负责 SSH 协议栈与连接管理，浏览器只负责渲染与交互。免安装、跨平台，配置与会话集中在一处管理。

> 当前进度：**阶段 0（工程骨架）已完成** —— 前后端链路打通，API 可用；SSH 终端将在阶段 1 交付。
> 详细设计见 [`docs/01-功能框架与需求说明书.md`](docs/01-功能框架与需求说明书.md) 与 [`docs/02-实现计划.md`](docs/02-实现计划.md)。

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

页面顶部状态点显示「服务在线」即表示前后端链路已打通。

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
├─ docs/                     设计与计划文档
├─ packages/
│  ├─ shared/                前后端共享常量与类型（必须先构建）
│  │  └─ src/{constants,api}.ts
│  ├─ server/                Fastify 服务端
│  │  └─ src/
│  │     ├─ index.ts         进程入口（加载配置 → 建目录 → 监听）
│  │     ├─ app.ts           Fastify 实例装配 + 静态托管 + 404 处理
│  │     ├─ config/          环境变量校验（zod）
│  │     └─ api/rest/        REST 路由
│  └─ web/                   React 前端
│     └─ src/
│        ├─ api/             REST 请求封装
│        ├─ components/      UI 组件
│        ├─ hooks/           数据订阅
│        ├─ theme/           主题状态（Zustand persist）
│        └─ utils/
└─ data/                     运行时数据（已被 git 忽略）
   ├─ webterm.db             SQLite（阶段 2 起使用）
   ├─ logs/                  会话日志（阶段 6 起使用）
   ├─ keys/                  导入的 SSH 私钥（阶段 2 起使用）
   └─ tmp/                   远程文件编辑中转（阶段 3 起使用）
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
  "version": "0.1.0",
  "uptimeSec": 42,
  "nodeVersion": "v22.22.2",
  "startedAt": "2026-09-24T03:20:11.000Z",
  "activeTabs": 0
}
```

未匹配到路由的 `/api/*` 请求统一返回 `{ "error": "NOT_FOUND", "message": "..." }`。

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
| 1 终端主干打通 | ⏳ 下一步 |
| 2–8 | 待开发 |
