# syntax=docker/dockerfile:1

# WebTerm 生产镜像
#
# 两条命令可用：
#   docker build -t webterm .
#   docker run -p 8080:8080 webterm        # 打开 http://localhost:8080
#
# 几个刻意的取舍：
#
# * **构建在容器内做，不依赖宿主机的 node**。前端产物（Vite）必须在镜像里构建，
#   否则「镜像里跑的是旧版界面」这种问题会一直阴魂不散。
# * **better-sqlite3 是原生模块**。大多数平台能下到预编译包，但没有对应预编译时
#   npm 会退回源码编译，所以构建阶段必须装 python3/make/g++。运行时阶段不需要，
#   预编译出来的 .node 可直接用。
# * **运行时用非 root 用户**。这是一个能开 SSH 连出去、还能读写文件的进程，
#   给它 root 没有任何好处。
# * **绑定 0.0.0.0**。容器里绑 127.0.0.1 的话端口映射进来也连不上 ——
#   这是容器内最常见的一个「明明映射了端口却打不开」。注意这也意味着
#   容器内必须设 WEBTERM_ALLOW_INSECURE_LAN=1（见下面的 ENV）：
#   WebTerm 当前没有内置访问认证，绑非回环地址必须显式确认。
#   真要对外用，请在容器前面放一层带认证的反向代理，别直接暴露到公网。
# * **容器内的「本地文件」侧（SFTP 面板的左栏）锁在 /files**。默认是用户家目录，
#   而在容器里那等于把整个容器文件系统暴露给浏览器；/files 是个挂载点，
#   用户想传什么就把宿主目录挂到这里。

# ---------------------------------------------------------------------
# 构建阶段：装全量依赖 → 构建 → 裁到只剩生产依赖
# ---------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /src

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 先只拷贝清单文件，让依赖安装这一层能被缓存：改代码不必重装依赖
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN npm ci --no-audit --no-fund

COPY . .

# build 里含 shared → server → web 的顺序，由根 package.json 的 pre* 钩子保证
RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------------
# 运行阶段：只带生产依赖与三份产物
# ---------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="WebTerm" \
      org.opencontainers.image.description="浏览器里的 SSH / Telnet 终端（对标 SecureCRT）" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    WEBTERM_HOST=0.0.0.0 \
    WEBTERM_PORT=8080 \
    WEBTERM_DATA_DIR=/data \
    WEBTERM_LOCAL_ROOT=/files \
    WEBTERM_ALLOW_INSECURE_LAN=1

WORKDIR /app

# node_modules 里保留着 workspaces 软链接（node_modules/@webterm/shared -> ../../packages/shared），
# 因此下面必须把 packages/*/package.json 与对应 dist 放在同样的相对位置上，软链接才解得开
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/bin ./bin

COPY --from=build /src/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /src/packages/shared/dist ./packages/shared/dist
COPY --from=build /src/packages/server/package.json ./packages/server/package.json
COPY --from=build /src/packages/server/dist ./packages/server/dist
COPY --from=build /src/packages/web/package.json ./packages/web/package.json
COPY --from=build /src/packages/web/dist ./packages/web/dist

# 示例插件放在 /app/examples 而不是 /data/plugins：一个会定时发通知的插件
# 不该在用户第一次打开界面时就开始打扰。想试就把目录拷进 /data/plugins。
COPY --from=build /src/data/plugins ./examples/plugins

# 两个挂载点的属主要在建 VOLUME 之前改好，否则具名卷首次挂载时会是 root 所有
RUN mkdir -p /data /files && chown -R node:node /data /files

USER node

VOLUME ["/data", "/files"]
EXPOSE 8080

# 用 node 自带的 fetch 探活，省掉在镜像里装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBTERM_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接跑入口而不是 bin/webterm.mjs：容器里不需要 CLI 的参数解析，
# 且这里 web/ 与 dist/ 的位置是确定的，走 ESM 默认路径解析更少一层。
CMD ["node", "packages/server/dist/index.js"]
