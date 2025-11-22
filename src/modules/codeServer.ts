import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'

export type CodeServerOptions = {
  host?: string
  port?: number
  repoRoot?: string
  binary?: string
  env?: NodeJS.ProcessEnv
  publicBasePath?: string
}

export type CodeServerHandle = {
  child: ChildProcessWithoutNullStreams
  running: boolean
  publicUrl: string
}

export type CodeServerController = {
  ensure: () => Promise<CodeServerHandle | null>
  shutdown: () => Promise<void>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 13337
const DEFAULT_BINARY = 'code-server'
const DEFAULT_PUBLIC_BASE = '/code-server'

export function createCodeServerController (rawOptions: CodeServerOptions = {}): CodeServerController {
  const options = normalizeOptions(rawOptions)
  let codeServerPromise: Promise<CodeServerHandle | null> | null = null

  const ensure = async () => {
    if (!codeServerPromise) {
      codeServerPromise = startCodeServer(options, () => {
        codeServerPromise = null
      }).catch(error => {
        console.warn('Unable to launch code-server:', error.message)
        codeServerPromise = null
        return null
      })
    }
    return codeServerPromise
  }

  const shutdown = async () => {
    const handle = codeServerPromise && (await codeServerPromise)
    if (!handle) return
    handle.child.kill('SIGTERM')
    codeServerPromise = null
  }

  return { ensure, shutdown }
}

function normalizeOptions (options: CodeServerOptions): Required<CodeServerOptions> {
  const host = options.host || process.env.CODE_SERVER_HOST || DEFAULT_HOST
  const port = options.port || Number(process.env.CODE_SERVER_PORT || DEFAULT_PORT)
  const repoRoot = options.repoRoot || process.env.CODE_SERVER_ROOT || path.resolve(process.cwd())
  const binary = options.binary || process.env.CODE_SERVER_BIN || DEFAULT_BINARY
  const env = { ...process.env, ...options.env }
  const publicBasePath = options.publicBasePath || DEFAULT_PUBLIC_BASE
  return { host, port, repoRoot, binary, env, publicBasePath }
}

function startCodeServer (
  options: Required<CodeServerOptions>,
  onExit: () => void
): Promise<CodeServerHandle> {
  return new Promise((resolve, reject) => {
    const args = [
      '--bind-addr',
      `${options.host}:${options.port}`,
      '--auth',
      'none',
      '--disable-update-check',
      options.repoRoot
    ]

    const child = spawn(options.binary, args, {
      cwd: options.repoRoot,
      env: options.env
    })

    let resolved = false

    const ready = () => {
      if (resolved) return
      resolved = true
      resolve({
        child,
        running: true,
        publicUrl: buildPublicUrl(options.publicBasePath, options.repoRoot)
      })
    }

    child.stdout.on('data', data => {
      const text = data.toString()
      process.stdout.write(`[code-server] ${text}`)
      if (text.includes('HTTP server listening')) {
        ready()
      }
    })

    child.stderr.on('data', data => {
      const text = data.toString()
      process.stderr.write(`[code-server] ${text}`)
    })

    child.on('error', error => {
      if (resolved) return
      resolved = true
      reject(error)
    })

    child.on('exit', code => {
      if (!resolved) {
        reject(new Error(`code-server exited with code ${code}`))
      }
      onExit()
    })

    setTimeout(() => {
      if (!resolved) {
        ready()
      }
    }, 2000)
  })
}

function buildPublicUrl (basePath: string, repoRoot: string): string {
  const normalized = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  return `${normalized}/?folder=${encodeURIComponent(repoRoot)}`
}
