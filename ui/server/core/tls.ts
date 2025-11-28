import fs from 'fs/promises'

export type TlsConfig = {
  certPath?: string
  keyPath?: string
  cert?: Buffer | string
  key?: Buffer | string
}

export type TlsMaterials = {
  cert: Buffer
  key: Buffer
}

const bufferize = (value: Buffer | string): Buffer => (Buffer.isBuffer(value) ? value : Buffer.from(value))

const readTlsFile = async (filePath: string, label: 'certificate' | 'key'): Promise<Buffer> => {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to read TLS ${label} at ${filePath}: ${reason}. Run "npm run certs:generate" or set UI_TLS_${
        label === 'certificate' ? 'CERT' : 'KEY'
      }_PATH.`
    )
  }
}

export async function resolveTlsMaterials(config: TlsConfig): Promise<TlsMaterials> {
  if (config.cert && config.key) {
    return {
      cert: bufferize(config.cert),
      key: bufferize(config.key)
    }
  }
  if ((config.cert && !config.key) || (!config.cert && config.key)) {
    throw new Error('TLS configuration requires both certificate and key data to be provided together.')
  }
  const certPath = config.certPath
  const keyPath = config.keyPath
  if (!certPath || !keyPath) {
    throw new Error(
      'TLS certificate and key paths must be provided. Set UI_TLS_CERT_PATH and UI_TLS_KEY_PATH or run "npm run certs:generate".'
    )
  }
  const [cert, key] = await Promise.all([readTlsFile(certPath, 'certificate'), readTlsFile(keyPath, 'key')])
  return { cert, key }
}
