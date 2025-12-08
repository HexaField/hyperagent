import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplates } from '../../data/workflowTemplates'
import { fetchJson } from '../../shared/api/httpClient'
import { draftWorkflowFromPrompt } from '../workflowDraft'

vi.mock('../../shared/api/httpClient', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/httpClient')>('../../shared/api/httpClient')
  return { ...actual, fetchJson: vi.fn() }
})

const mockFetchJson = vi.mocked(fetchJson)

describe('draftWorkflowFromPrompt', () => {
  const template = workflowTemplates[0]
  const mockDefinition = template.definition

  beforeEach(() => {
    mockFetchJson.mockReset()
  })

  it('returns workflow-create draft when endpoint responds', async () => {
    mockFetchJson.mockResolvedValue({ definition: mockDefinition, rawText: JSON.stringify(mockDefinition) })

    const result = await draftWorkflowFromPrompt({ instructions: 'Add release notes generator', template })

    expect(mockFetchJson).toHaveBeenCalled()
    expect(result.source).toBe('workflow-create')
    expect(result.definition.id).toBe(mockDefinition.id)
  })

  it('surfaces failures when draft endpoint errors', async () => {
    mockFetchJson.mockRejectedValue(new Error('boom'))

    await expect(
      draftWorkflowFromPrompt({ instructions: 'Create a workflow that lints and tests the repo.', template: null })
    ).rejects.toThrow(/draft/i)
  })
})
