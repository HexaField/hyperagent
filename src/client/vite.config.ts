import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const DEV_PORT = Number(process.env.VITE_DEV_PORT || 5555)
const API_TARGET = process.env.VITE_API_TARGET || 'https://localhost:5556'
const HOST = process.env.VITE_DEV_HOST || undefined
const defaultCertPath =
  process.env.VITE_TLS_CERT_PATH ||
  process.env.UI_TLS_CERT_PATH ||
  path.resolve(__dirname, '../certs/hyperagent.cert.pem')
const defaultKeyPath =
  process.env.VITE_TLS_KEY_PATH || process.env.UI_TLS_KEY_PATH || path.resolve(__dirname, '../certs/hyperagent.key.pem')

const readTlsAsset = (filePath: string, label: 'certificate' | 'key') => {
  try {
    return fs.readFileSync(filePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to read TLS ${label} for Vite at ${filePath}: ${reason}. Run \"npm run certs:generate\" or set VITE_TLS_${
        label === 'certificate' ? 'CERT' : 'KEY'
      }_PATH.`
    )
  }
}

const httpsOptions = {
  cert: readTlsAsset(defaultCertPath, 'certificate'),
  key: readTlsAsset(defaultKeyPath, 'key')
}

const proxyConfig = {
  '/api': {
    target: API_TARGET,
    changeOrigin: true,
    secure: false
  },
  '/code-server': {
    target: API_TARGET,
    changeOrigin: true,
    ws: true,
    secure: false
  },
  '/ws/terminal': {
    target: API_TARGET,
    changeOrigin: true,
    ws: true,
    secure: false
  }
}

export default defineConfig({
  plugins: [solid()],
  root: path.resolve(__dirname),
  server: {
    port: DEV_PORT,
    proxy: proxyConfig,
    host: HOST,
    https: httpsOptions
  },
  preview: {
    port: DEV_PORT,
    proxy: proxyConfig,
    https: httpsOptions
  },
  build: {
    outDir: 'dist'
  }
})
