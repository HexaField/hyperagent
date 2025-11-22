import path from 'path'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  root: path.resolve(__dirname),
  server: {
    port: 5555,
    proxy: {
      '/api': {
        target: 'http://localhost:5556',
        changeOrigin: true
      },
      '/code-server': {
        target: 'http://localhost:5556',
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
