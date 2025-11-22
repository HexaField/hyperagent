import cors from 'cors'
import express from 'express'
import type { Request, Response } from 'express'
import fs from 'fs/promises'
import { createProxyMiddleware } from 'http-proxy-middleware'
import os from 'os'
import path from 'path'
import { runVerifierWorkerLoop, type AgentStreamEvent } from '../../src/modules/agent'
import type { Provider } from '../../src/modules/llm'
import { createCodeServerController } from '../../src/modules/codeServer'

const PORT = Number(process.env.UI_SERVER_PORT || 5175)
const CODE_SERVER_PORT = Number(process.env.CODE_SERVER_PORT || 13337)
const CODE_SERVER_HOST = process.env.CODE_SERVER_HOST || '127.0.0.1'
const REPO_ROOT = path.resolve(__dirname, '../../')

const codeServerController = createCodeServerController({
  host: CODE_SERVER_HOST,
  port: CODE_SERVER_PORT,
  repoRoot: REPO_ROOT,
  publicBasePath: '/code-server'
})

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/devtools/code-server', async (_req, res) => {
  const handle = await codeServerController.ensure()
  res.json({ running: Boolean(handle?.running), url: handle?.publicUrl ?? null })
})

app.post('/api/agent/run', async (req: Request, res: Response) => {
  const { prompt, provider, model, maxRounds } = req.body ?? {}
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  })

  let closed = false
  req.on('close', () => {
    closed = true
  })

  const emit = (packet: Record<string, unknown>) => {
    if (closed) return
    res.write(`data: ${JSON.stringify(packet)}\n\n`)
  }

  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-session-'))
  emit({ type: 'session', payload: { sessionDir } })

  const streamHandler = (event: AgentStreamEvent) => {
    if (closed) return
    emit({ type: 'chunk', payload: event })
  }

  try {
    const providerToUse = typeof provider === 'string' && provider.length ? (provider as Provider) : undefined
    const modelToUse = typeof model === 'string' && model.length ? model : undefined
    const normalizedMaxRounds = typeof maxRounds === 'number' ? maxRounds : undefined

    const result = await runVerifierWorkerLoop({
      userInstructions: prompt,
      provider: providerToUse,
      model: modelToUse,
      maxRounds: normalizedMaxRounds,
      sessionDir,
      onStream: streamHandler
    })
    emit({ type: 'result', payload: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Agent loop failed'
    if (!closed) {
      emit({
        type: 'error',
        payload: {
          message
        }
      })
    }
  } finally {
    if (!closed) {
      emit({ type: 'end' })
      res.end()
    }
  }
})

const codeServerProxy = createProxyMiddleware({
  target: `http://${CODE_SERVER_HOST}:${CODE_SERVER_PORT}`,
  changeOrigin: true,
  ws: true,
  pathRewrite: {
    '^/code-server': ''
  }
})

app.use('/code-server', (_req, _res, next) => {
  void codeServerController.ensure()
  next()
})
app.use('/code-server', codeServerProxy)

async function createAppServer () {
  const server = app.listen(PORT, () => {
    console.log(`UI server listening on http://localhost:${PORT}`)
  })
  server.on('upgrade', codeServerProxy.upgrade)
  await codeServerController.ensure()
}

createAppServer().catch(error => {
  console.error('Failed to start UI server', error)
  process.exit(1)
})

process.on('exit', () => {
  void codeServerController.shutdown()
})
process.on('SIGINT', async () => {
  await codeServerController.shutdown()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await codeServerController.shutdown()
  process.exit(0)
})
