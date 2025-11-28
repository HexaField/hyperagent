import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  fetchOpencodeRuns,
  fetchOpencodeSessionDetail,
  fetchOpencodeSessions,
  killOpencodeSession,
  postOpencodeMessage,
  startOpencodeRun
} from './codingAgent'
import { fetchJson } from './http'

vi.mock('./http', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = fetchJson as unknown as Mock

beforeEach(() => {
  fetchJsonMock.mockReset()
})

describe('opencode client helpers', () => {
  it('fetches sessions with optional workspace filter', async () => {
    fetchJsonMock.mockResolvedValue({ sessions: [] })
    await fetchOpencodeSessions({ workspacePath: '/repo' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions?workspacePath=%2Frepo')
  })

  it('fetches session details and runs', async () => {
    fetchJsonMock.mockResolvedValue({ session: {}, messages: [] })
    await fetchOpencodeSessionDetail('ses_test')
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test')

    fetchJsonMock.mockResolvedValue({ runs: [] })
    await fetchOpencodeRuns()
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/runs')
  })

  it('starts and kills sessions', async () => {
    fetchJsonMock.mockResolvedValue({ run: { sessionId: 'ses_test' } })
    await startOpencodeRun({ workspacePath: '/repo', prompt: 'Hello' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/repo', prompt: 'Hello' })
    })

    fetchJsonMock.mockResolvedValue({ success: true })
    await killOpencodeSession('ses_test')
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test/kill', { method: 'POST' })
  })

  it('posts messages to sessions', async () => {
    const detail = { session: { id: 'ses_test' }, messages: [] }
    fetchJsonMock.mockResolvedValue(detail)
    await postOpencodeMessage('ses_test', { text: 'Hello' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', text: 'Hello' })
    })
  })
})
