import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { DEFAULT_SERVER_PORT, DEFAULT_WEB_PORT } from '@webterm/shared'

const backendOrigin = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`
const backendWsOrigin = `ws://127.0.0.1:${DEFAULT_SERVER_PORT}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: DEFAULT_WEB_PORT,
    strictPort: true,
    proxy: {
      // 开发态把 API 与终端 WebSocket 都代理到后端，避免跨域
      '/api': { target: backendOrigin, changeOrigin: false },
      '/ws': { target: backendWsOrigin, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
