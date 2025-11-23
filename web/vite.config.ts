import dotenv from 'dotenv'
import path from 'path'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const DEV_PORT = Number(process.env.VITE_DEV_PORT || 5555)
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:5556'
const HOST = process.env.VITE_DEV_HOST || undefined

const proxyConfig = {
  '/api': {
    target: API_TARGET,
    changeOrigin: true
  },
  '/code-server': {
    target: API_TARGET,
    changeOrigin: true,
    ws: true
  },
  '/ws/terminal': {
    target: API_TARGET,
    changeOrigin: true,
    ws: true
  }
}

export default defineConfig({
  plugins: [solid()],
  root: path.resolve(__dirname),
  server: {
    port: DEV_PORT,
    proxy: proxyConfig,
    host: HOST
  },
  preview: {
    port: DEV_PORT,
    proxy: proxyConfig
  },
  build: {
    outDir: 'dist'
  }
})
