import { TextPart } from '@opencode-ai/sdk'
import os from 'os'
import { afterAll, describe, expect, it } from 'vitest'
import { createSession, getOpencodeServer, promptSession } from './opencode'

describe('Opencode Module', () => {
  afterAll(async () => {
    const server = await getOpencodeServer()
    server.close()
  })

  it('should create a session successfully', async () => {
    const tmp = os.tmpdir()
    const session = await createSession(tmp)
    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
    console.log('Created Opencode session with ID:', session.id)
  })

  it('should prompt a session successfully', async () => {
    const tmp = os.tmpdir()
    const session = await createSession(tmp)
    const promptText = 'What is the capital of France?'
    const response = await promptSession(session, [promptText], 'opencode/big-pickle')
    expect(response).toBeDefined()
    expect(response.parts.length).toBe(3)
    const textParts = response.parts[1] as TextPart
    const answer = textParts.text.trim().toLowerCase()
    expect(answer.includes('paris')).toBe(true)
  })
})
