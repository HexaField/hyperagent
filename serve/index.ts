import cors from 'cors'
import express from 'express'
import fs from 'fs/promises'
import os from 'os'

// Import opencode helpers from the project
import { closeOpencodeServer, createSession, extractResponseText, promptSession } from '@hexafield/agent-workflow'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT ? Number(process.env.PORT) : 11545

// In-memory session store (simple)
const sessions = new Map<string, any>()

app.post(['/v1/api/generate', '/v1/generate', '/v1/chat/completions'], async (req, res) => {
  try {
    const body = req.body || {}
    const model = body.model || body.model_id || 'opencode/default'
    console.log(body)
    const prompts = body.messages || body.prompt || []
    const promptArr = Array.isArray(prompts)
      ? prompts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      : [String(prompts)]

    let session: any = null
    const providedSessionId = body.sessionId || body.session || body.id

    if (providedSessionId && sessions.has(providedSessionId)) {
      session = sessions.get(providedSessionId)
    } else {
      // Create a new session. Allow passing a `directory` to scope the session.
      const directory = os.tmpdir()
      await fs.mkdir(directory, { recursive: true })
      session = await createSession(directory)
      sessions.set(session.id, session)
    }

    const responseParts = await promptSession(session, promptArr, model)
    const extract = extractResponseText(responseParts.parts)

    const text = typeof extract === 'string' ? extract : JSON.stringify(extract)

    console.log(text, typeof extract)

    res.json({
      id: session.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.split('/')[1],
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })

    // Return a compact Ollama-compliant shape
    // res.json({
    //   model,
    //   reponse: text,
    //   done: true,
    //   message: {
    //     role: 'assistant',
    //     content: text
    //   },
    //   done_reason: 'stop'
    // })
    res.status(200)
  } catch (err: any) {
    console.error('Generate error:', err?.stack ?? err)
    res.status(500).json({ error: String(err?.message ?? err) })
  }
})

const models = [
  {
    name: 'opencode/big-pickle',
    id: 'opencode/default',
    description: 'Default Opencode model'
  },
  {
    name: 'github-copilot/gpt-5-mini',
    id: 'github-copilot/gpt-5-mini',
    description: 'GitHub Copilot GPT-5 Mini model'
  }
]

// list models
app.get('/v1/models', async (_req, res) => {
  console.log('Models requested')
  res.json({
    data: models
  })
  res.status(200)
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Opencode Ollama-compat server listening on http://localhost:${PORT}`)
})

// on process exit, close server

process.on('SIGINT', () => {
  console.log('Shutting down server...')
  closeOpencodeServer()
  process.exit()
})
