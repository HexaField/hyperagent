import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeStorage, resolveDefaultOpencodeRoot } from './provider'

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures/opencode-storage')

describe('createOpencodeStorage', () => {
  it('lists sessions sorted by updatedAt and filters by workspace path', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const sessions = await storage.listSessions()
    expect(sessions.map((session) => session.id)).toEqual(['ses_beta', 'ses_alpha', 'ses_tool'])

    const filtered = await storage.listSessions({ workspacePath: '/workspace/repo-alpha' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('ses_alpha')
    expect(filtered[0].summary).toEqual({ additions: 3, deletions: 1, files: 1 })
  })

  it('returns session detail with message transcripts', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_alpha')
    expect(detail).not.toBeNull()
    expect(detail?.session.title).toBe('Alpha Session')
    expect(detail?.messages).toHaveLength(2)
    const assistant = detail?.messages.find((message) => message.role === 'assistant')
    // after removing fallback flat text, the structured `parts` should contain the outline
    const textPart = assistant?.parts.find((p) => p.type === 'text' && typeof p.text === 'string')
    expect(textPart && (textPart.text as string)).toContain('Outlined plan')
    expect(assistant?.modelId).toBe('github-copilot/gpt-5-mini')
  })

  it('includes tool, step-start, and step-finish parts in message text', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_tool')
    expect(detail).not.toBeNull()
    expect(detail?.session.title).toBe('Tool Session')
    expect(detail?.messages).toHaveLength(1)
    const assistant = detail?.messages.find((message) => message.role === 'assistant')
    // details should now be present as structured parts
    const toolPart = assistant?.parts.find((p) => p.type === 'tool')
    const startPart = assistant?.parts.find((p) => p.type === 'step-start')
    const finishPart = assistant?.parts.find((p) => p.type === 'step-finish')
    expect(toolPart && (toolPart.text as string)).toContain('Running npm install')
    expect(startPart && (startPart.text as string)).toContain('Installing dependencies')
    expect(finishPart && (finishPart.text as string)).toContain('Dependencies installed successfully')
  })

  it('extracts UI-friendly tool calls and timeline from messages', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_tool')
    expect(detail).not.toBeNull()
    if (!detail) return

    const msg = detail.messages[0]
    // UI mapping: extract tool calls with metadata and durations
    const toolCalls = msg.parts
      .filter((p) => p.type === 'tool')
      .map((p) => ({ id: p.id, text: p.text ?? '', start: p.start, end: p.end }))
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    const call = toolCalls[0]
    expect(call.text).toBe('Running npm install')
    expect(typeof call.start).toBe('string')
    expect(typeof call.end).toBe('string')
    const durationMs = Date.parse(call.end as string) - Date.parse(call.start as string)
    expect(durationMs).toBeGreaterThanOrEqual(0)

    // Timeline: include step-start and step-finish as events in order
    const timeline = msg.parts
      .filter((p) => p.type === 'step-start' || p.type === 'step-finish')
      .map((p) => ({ id: p.id, type: p.type, text: p.text ?? '', time: p.start ?? p.end }))
    expect(timeline.length).toBeGreaterThanOrEqual(2)
    const startEvent = timeline.find((t) => t.type === 'step-start')
    const finishEvent = timeline.find((t) => t.type === 'step-finish')
    expect(startEvent).toBeDefined()
    expect(finishEvent).toBeDefined()
    if (startEvent && finishEvent) {
      expect(Date.parse(startEvent.time as string)).toBeLessThanOrEqual(Date.parse(finishEvent.time as string))
    }
  })

  it('preserves arbitrary metadata on parts and coerces times to ISO', async () => {
    // Build a temporary opencode layout with a custom metadata fields on a part
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-test-'))
    try {
      const storageRoot = tmpRoot
      const storageDir = path.join(storageRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-test')
      const messageDir = path.join(storageDir, 'message', 'ses_test')
      const partDir = path.join(storageDir, 'part', 'msg_custom')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_test',
        directory: '/workspace/test-repo',
        title: 'Test Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_test.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_custom',
        sessionID: 'ses_test',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_custom.json'), JSON.stringify(messageJson), 'utf8')

      const partJson = {
        id: 'prt_custom',
        sessionID: 'ses_test',
        messageID: 'msg_custom',
        type: 'tool',
        text: 'Do something',
        time: { start: now, end: now },
        cost: 0.123,
        tokens: 42,
        extra: { nested: true }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_custom.json'), JSON.stringify(partJson), 'utf8')

      const storage = createOpencodeStorage({ rootDir: storageRoot })
      const detail = await storage.getSession('ses_test')
      expect(detail).not.toBeNull()
      if (!detail) return

      const msg = detail.messages.find((m) => m.id === 'msg_custom')
      expect(msg).toBeDefined()
      const part = msg?.parts.find((p) => p.id === 'prt_custom')
      expect(part).toBeDefined()
      // arbitrary fields should be preserved on the part object
      // @ts-ignore
      expect((part as any).cost).toBe(0.123)
      // @ts-ignore
      expect((part as any).tokens).toBe(42)
      // nested object preserved
      // @ts-ignore
      expect((part as any).extra && (part as any).extra.nested).toBe(true)
      // times coerced to ISO
      expect(typeof part?.start).toBe('string')
      expect(typeof part?.end).toBe('string')
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('resolveDefaultOpencodeRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers candidate directories that already exist', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/demo')
    const localShare = path.join('/Users/demo', '.local', 'share', 'opencode')
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      const value = typeof target === 'string' ? target : target.toString()
      return value === localShare
    })
    expect(resolveDefaultOpencodeRoot()).toBe(localShare)
  })

  it('falls back to the first candidate when none exist', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(os, 'homedir').mockReturnValue('/home/demo')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(resolveDefaultOpencodeRoot()).toBe(path.join('/home/demo', '.local', 'share', 'opencode'))
  })
})
