import path from 'path'
import { describe, expect, it } from 'vitest'
import { createOpencodeStorage } from './opencodeStorage'

const fixtureRoot = path.join(process.cwd(), 'tests/fixtures/opencode-storage')

describe('createOpencodeStorage', () => {
  it('lists sessions sorted by updatedAt and filters by workspace path', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const sessions = await storage.listSessions()
    expect(sessions.map((session) => session.id)).toEqual(['ses_beta', 'ses_alpha'])

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
})
