import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { callLLM } from './llm'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

const providers: Array<{ provider: string; cmd: string; model: string }> = [
  { provider: 'ollama-cli', cmd: 'ollama', model: 'llama3.2' },
  { provider: 'opencode', cmd: 'opencode', model: 'github-copilot/gpt-5-mini' },
  { provider: 'goose', cmd: 'goose', model: 'github_copilot/gpt-5-mini' }
]

describe('LLM CLI integrations', () => {
  for (const p of providers) {
    it(`provider ${p.provider}`, async () => {
      const exists = commandExists(p.cmd)
      // Fail fast if the CLI isn't installed; the user requested tests to fail in this case.
      expect(exists, `Required CLI '${p.cmd}' not found on PATH`).toBe(true)

      const expectedAnswer = `integration-${p.provider}`
      const systemPrompt =
        'You are a JSON-only responder. Output ONLY valid JSON with exactly two keys: "answer" (string) and "status" (string). Do not include any surrounding markdown or explanation.'
      const userPrompt = `Return a JSON object: {"answer":"${expectedAnswer}","status":"ok"}`

      const res = await callLLM(systemPrompt, userPrompt, p.provider, p.model)

      // When real CLI runs, we expect success and a JSON code fence wrapper.
      expect(res.success).toBe(true)
      expect(res.data).toBeDefined()
      expect(res.data).toContain('```json')

      // Extract JSON block from the fenced response and parse it.
      const m = (res.data as string).match(/```json\s*([\s\S]*?)\s*```/)
      const jsonText = m ? m[1] : (res.data as string)
      let parsed: any
      try {
        parsed = JSON.parse(jsonText)
      } catch (e) {
        // If parsing fails, fail the test with helpful output.
        throw new Error(`Failed to parse JSON from LLM response: ${e}\nraw:${jsonText}`)
      }

      // Assert the JSON shape and values.
      expect(typeof parsed).toBe('object')
      expect(typeof parsed.answer).toBe('string')
      expect(parsed.answer).toBe(expectedAnswer)
      expect(parsed.status).toBe('ok')
    }, 60_000) // allow longer timeout for integration tests
  }

  for (const p of providers) {
    it(`provider ${p.provider} session reuse persists meta.json`, async () => {
      const exists = commandExists(p.cmd)
      expect(exists, `Required CLI '${p.cmd}' not found on PATH`).toBe(true)

      // Prepare per-provider session directory under the repo tmp tree
      const baseTmp = path.join(os.tmpdir(), '.test', 'itest-sessions')
      fs.mkdirSync(baseTmp, { recursive: true })
      const sessionDir = path.join(baseTmp, `${p.provider}-${Date.now()}`)
      fs.mkdirSync(sessionDir, { recursive: true })

      const sid = `itest-${p.provider}-${Date.now()}`
      const expected1 = `integration-${p.provider}-1`
      const expected2 = `integration-${p.provider}-2`

      const systemPrompt =
        'You are a JSON-only responder. Output ONLY valid JSON with exactly two keys: "answer" (string) and "status" (string). Do not include any surrounding markdown or explanation.'
      const userPrompt1 = `Return a JSON object: {"answer":"${expected1}","status":"ok"}`
      const userPrompt2 = `Return a JSON object: {"answer":"${expected2}","status":"ok"}`

      const r1 = await callLLM(systemPrompt, userPrompt1, p.provider, p.model, { sessionId: sid, sessionDir })
      const r2 = await callLLM(systemPrompt, userPrompt2, p.provider, p.model, { sessionId: sid, sessionDir })

      // Basic expectations still hold
      expect(r1.success).toBe(true)
      expect(r2.success).toBe(true)
      expect(r1.data).toContain('```json')
      expect(r2.data).toContain('```json')

      // Validate .hyperagent.json persisted in the sessionDir with log entries
      const metaPath = path.join(sessionDir, '.hyperagent.json')
      expect(fs.existsSync(metaPath)).toBe(true)
      const metaRaw = fs.readFileSync(metaPath, 'utf8')
      const meta = JSON.parse(metaRaw)
      expect(meta && typeof meta === 'object').toBe(true)
      const log = Array.isArray(meta.log) ? meta.log : []
      const providerEntries = log.filter((entry: any) => entry.provider === p.provider)
      expect(providerEntries.length).toBeGreaterThanOrEqual(2)
      const joined = providerEntries.map((entry: any) => JSON.stringify(entry.payload || {})).join('\n')
      expect(joined).toContain(expected1)
      expect(joined).toContain(expected2)
    }, 60_000)
  }

  it('opencode provider can write files to tmpdir', async () => {
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    const pwd = process.cwd()
    const sessionDir = path.join(pwd, '.tests', `opencode-filetest-${Date.now()}`)
    fs.mkdirSync(sessionDir, { recursive: true })
    // const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-filetest-'))

    fs.writeFileSync(
      path.join(sessionDir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission: {
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
            doom_loop: 'allow',
            external_directory: 'deny'
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const targetFile = path.join(sessionDir, `file-${Date.now()}.txt`)
    const expectedContent = `opencode-file-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const systemPrompt = `You are an autonomous coding agent with full filesystem access. When the user requests a file to be written, you must create it exactly as specified before responding. Always confirm success in JSON.`
    const userPrompt = `Write a UTF-8 text file located at ${targetFile} with the exact contents:\n${expectedContent}\nRespond only with JSON: {"status":"done","path":"${targetFile}"}`

    const res = await callLLM(systemPrompt, userPrompt, 'opencode', 'github-copilot/gpt-5-mini', {
      sessionId: `opencode-file-${Date.now()}`,
      sessionDir
    })

    expect(res.success).toBe(true)
    expect(fs.existsSync(targetFile)).toBe(true)
    const data = fs.readFileSync(targetFile, 'utf8')
    expect(data.trim()).toBe(expectedContent)
  }, 30_000)

  it('opencode provider honors explicitly created sessions', async () => {
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    const sessionName = `itest-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const create = spawnSync('opencode', ['session', 'create', sessionName])
    expect(
      create.status,
      `Unable to create opencode session '${sessionName}': ${create.stderr?.toString?.() || ''}`
    ).toBe(0)

    const sessionDir = path.join(os.tmpdir(), '.test', `opencode-session-${Date.now()}`)
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionDir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission: {
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
            external_directory: 'deny'
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const expectedAnswer = `session-check-${Date.now()}`
    const systemPrompt =
      'You are a JSON-only responder. Output ONLY valid JSON with exactly two keys: "answer" (string) and "status" (string). Do not include any surrounding markdown or explanation.'
    const userPrompt = `Return a JSON object: {"answer":"${expectedAnswer}","status":"ok"}`

    const res = await callLLM(systemPrompt, userPrompt, 'opencode', 'github-copilot/gpt-5-mini', {
      sessionId: sessionName,
      sessionDir
    })

    expect(res.success).toBe(true)
    expect(res.data).toContain('```json')

    const metaPath = path.join(sessionDir, '.hyperagent.json')
    expect(fs.existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    const log = Array.isArray(meta.log) ? meta.log : []
    const opencodeEntries = log.filter((entry: any) => entry.provider === 'opencode')
    expect(opencodeEntries.length).toBeGreaterThan(0)

    spawnSync('opencode', ['session', 'delete', sessionName])
  }, 60_000)
})
