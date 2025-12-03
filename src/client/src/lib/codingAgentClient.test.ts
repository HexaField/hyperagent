import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { fetchJson } from '../shared/api/httpClient'
import {
  fetchCodingAgentRuns,
  fetchCodingAgentSessionDetail,
  fetchCodingAgentSessions,
  killCodingAgentSession,
  postCodingAgentMessage,
  startCodingAgentRun
} from './codingAgent'

vi.mock('../shared/api/httpClient', () => ({
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

    // include personaId when provided
    fetchJsonMock.mockResolvedValue({ run: { sessionId: 'ses_test2' } })
    await startCodingAgentRun({ workspacePath: '/repo', prompt: 'Hello', personaId: 'senior-engineer' })
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/repo', prompt: 'Hello', personaId: 'senior-engineer' })
    })

    fetchJsonMock.mockResolvedValue({ success: true })
    await killCodingAgentSession('ses_test')
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/sessions/ses_test/kill', { method: 'POST' })
  })

  it('manages personas via the API', async () => {
    // list
    fetchJsonMock.mockResolvedValue({ personas: [{ id: 'p1', label: 'P1', updatedAt: 'now' }] })
    const {
      fetchCodingAgentPersonas,
      getCodingAgentPersona,
      createCodingAgentPersona,
      updateCodingAgentPersona,
      deleteCodingAgentPersona
    } = await import('./codingAgent')
    const list = await fetchCodingAgentPersonas()
    expect(list.length).toBeGreaterThan(0)

    // get detail
    fetchJsonMock.mockResolvedValue({ id: 'p1', markdown: 'md', frontmatter: {}, body: '', updatedAt: 'now' })
    const detail = await getCodingAgentPersona('p1')
    expect(detail?.id).toBe('p1')

    // create
    fetchJsonMock.mockResolvedValue({ id: 'created' })
    const created = await createCodingAgentPersona('# hi')
    expect(created?.id).toBe('created')

    // update
    fetchJsonMock.mockResolvedValue({})
    const updated = await updateCodingAgentPersona('created', '# updated')
    expect(updated).toBe(true)

    // delete
    fetchJsonMock.mockResolvedValue({})
    const deleted = await deleteCodingAgentPersona('created')
    expect(deleted).toBe(true)
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
