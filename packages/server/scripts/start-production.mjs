/**
 * `npm start` 的生产模式入口。
 *
 * 为什么需要这一层：`npm start` 的语义是「跑起构建好的生产环境」，
 * 但 NODE_ENV 并不会被 npm 自动设上 —— 不设就等于开发态，而开发态
 * **不托管前端产物**（那是刻意的：开发时前端由 Vite 提供，托管 dist
 * 会让人访问到过期页面）。结果就是 `npm run build && npm start`
 * 打开浏览器只看到一段纯文本横幅，很容易被当成构建失败。
 *
 * 用 Node 包装而不是在 npm script 里写 `NODE_ENV=production node ...`：
 * 后者是 POSIX 语法，Windows 上 npm 走 cmd.exe，会直接报语法错误。
 * 装 cross-env 只为设一个变量不值得。
 *
 * 这里刻意**不改工作目录**：`npm start` 在 packages/server 下执行，
 * 数据目录因此仍落在 packages/server/data，与既有约定一致。
 * 运行期不涉及任何 TypeScript，直接用 node 跑。
 */
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'

await import('../dist/index.js')
