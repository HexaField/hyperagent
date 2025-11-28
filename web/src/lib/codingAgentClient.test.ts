import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  fetchCodingAgentRuns,
  fetchCodingAgentSessionDetail,
  fetchCodingAgentSessions,
  killCodingAgentSession,
  postCodingAgentMessage,
  startCodingAgentRun
} from './codingAgent'
import { fetchJson } from './http'

vi.mock('./http', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = fetchJson as unknown as Mock

beforeEach(() => {
  fetchJsonMock.mockReset()
})

describe('coding agent client helpers', () => {
  it('fetches sessions with optional workspace filter', async () => {
    fetchJsonMock.mockResolvedValue({ sessions: [] })
    await fetchCodingAgentSessions({ workspacePath: '/repo' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions?workspacePath=%2Frepo')
  })

  it('fetches session details and runs', async () => {
    fetchJsonMock.mockResolvedValue({ session: {}, messages: [] })
    await fetchCodingAgentSessionDetail('ses_test')
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test')

    fetchJsonMock.mockResolvedValue({ runs: [] })
    await fetchCodingAgentRuns()
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/runs')
  })

  it('starts and kills sessions', async () => {
    fetchJsonMock.mockResolvedValue({ run: { sessionId: 'ses_test' } })
    await startCodingAgentRun({ workspacePath: '/repo', prompt: 'Hello' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/repo', prompt: 'Hello' })
    })

    fetchJsonMock.mockResolvedValue({ success: true })
    await killCodingAgentSession('ses_test')
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test/kill', { method: 'POST' })
  })

  it('posts messages to sessions', async () => {
    const detail = { session: { id: 'ses_test' }, messages: [] }
    fetchJsonMock.mockResolvedValue(detail)
    await postCodingAgentMessage('ses_test', { text: 'Hello' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', text: 'Hello' })
    })
  })
})
