import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { fetchCodingAgentProviders } from './codingAgent'
import { fetchJson } from './http'

vi.mock('./http', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = fetchJson as unknown as Mock

beforeEach(() => {
  fetchJsonMock.mockReset()
})

describe('coding agent client helpers', () => {
  it('fetches providers from the API', async () => {
    const providers = [
      {
        id: 'coding-agent-cli',
        label: 'Coding Agent CLI',
        defaultModelId: 'github-copilot/gpt-5-mini',
        models: [{ id: 'github-copilot/gpt-5-mini', label: 'GitHub Copilot · GPT-5 Mini' }]
      }
    ]
    fetchJsonMock.mockResolvedValue({ providers })

    const result = await fetchCodingAgentProviders()

    expect(fetchJsonMock).toHaveBeenCalledWith('/api/coding-agent/providers')
    expect(result).toEqual(providers)
  })

  it('returns an empty list when the request fails', async () => {
    fetchJsonMock.mockRejectedValue(new Error('boom'))

    const result = await fetchCodingAgentProviders()

    expect(result).toEqual([])
  })
})
