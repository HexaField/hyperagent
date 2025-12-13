import { createSession, getMessageDiff, promptSession } from '@hexafield/agent-workflow/opencode'
import { TextPart } from '@opencode-ai/sdk'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from './opencodeTestHooks'

//note: big-pickle likes to have a reasoning step
const MODEL = 'github-copilot/gpt-5-mini' // 'opencode/big-pickle'

const OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    doom_loop: 'allow',
    external_directory: 'deny'
  }
}

const initGitRepo = (directory: string) => {
  try {
    execSync('git init', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.email "agent@example.com"', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.name "HyperAgent"', { cwd: directory, stdio: 'ignore' })
    execSync('git add .', { cwd: directory, stdio: 'ignore' })
    execSync('git commit --allow-empty -m "Initialize workspace"', { cwd: directory, stdio: 'ignore' })
  } catch (error) {
    throw new Error(`Failed to initialize git workspace: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const createSessionDir = () => {
  const sessionDir = path.join(process.cwd(), '.tests', `opencode-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'opencode.json'), JSON.stringify(OPENCODE_CONFIG, null, 2))
  initGitRepo(sessionDir)
  return sessionDir
}

describe('Opencode Module', () => {
  opencodeTestHooks()

  it('should create a session successfully', async () => {
    const sessionDir = createSessionDir()
    const session = await createSession(sessionDir)
    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
    console.log('Created Opencode session with ID:', session.id)
  })

  it('should prompt a session successfully', async () => {
    const sessionDir = createSessionDir()
    const session = await createSession(sessionDir)
    const promptText = 'What is the capital of France?'
    const response = await promptSession(session, [promptText], MODEL)
    console.log('Received response from Opencode session:', response)
    expect(response).toBeDefined()
    expect(response.parts.length).toBe(3)
    const textParts = response.parts[1] as TextPart
    const answer = textParts.text.trim().toLowerCase()
    expect(answer.includes('paris')).toBe(true)
  }, 120_000)

  it('should retrieve message diffs after file edits', async () => {
    const sessionDir = createSessionDir()
    const session = await createSession(sessionDir)
    const promptText = `Create (or overwrite) a file named "opencode-test.md" in the workspace root with the exact contents: "Hello from the Opencode tests" followed by a newline. After writing, confirm the file contents.`
    const response = await promptSession(session, [promptText], MODEL)
    const messageId = response.parts.find((part: any) => typeof part?.messageID === 'string')?.messageID as
      | string
      | undefined

    expect(messageId).toBeDefined()

    const diffs = await getMessageDiff(session, messageId!)
    expect(Array.isArray(diffs)).toBe(true)
    expect(diffs.length).toBeGreaterThan(0)
    const readmeDiff = diffs.find((diff) => diff.file.toLowerCase().includes('opencode-test.md'))
    expect(readmeDiff).toBeTruthy()
    expect(readmeDiff?.after.toLowerCase()).toContain('hello from the opencode tests')
  }, 120_000)
})
