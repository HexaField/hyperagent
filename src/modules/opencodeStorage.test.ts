import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeStorage, resolveDefaultOpencodeRoot } from './provider'

const fixtureRoot = path.join(process.cwd(), 'tests/fixtures/opencode-storage')

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
    expect(assistant?.text).toContain('Outlined plan')
    expect(assistant?.modelId).toBe('github-copilot/gpt-5-mini')
  })

  it('includes tool, step-start, and step-finish parts in message text', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_tool')
    expect(detail).not.toBeNull()
    expect(detail?.session.title).toBe('Tool Session')
    expect(detail?.messages).toHaveLength(1)
    const assistant = detail?.messages.find((message) => message.role === 'assistant')
    expect(assistant?.text).toContain('🔧 Tool: Running npm install')
    expect(assistant?.text).toContain('▶️ Step: Installing dependencies')
    expect(assistant?.text).toContain('✅ Step: Dependencies installed successfully')
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
