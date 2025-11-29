import { render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson } from '../../shared/api/httpClient'
import WorkflowDetailView from '../WorkflowDetailView'

vi.mock('../../shared/api/httpClient', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = vi.mocked(fetchJson)

describe('WorkflowDetailView', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders agent trace, instructions, and diff metadata', async () => {
    const workflowDetail = buildWorkflowDetail()
    const diffPayload = {
      workflowId: 'wf-1',
      stepId: 'step-1',
      commitHash: '1234567890abcdef',
      branch: 'feature/agent-flow',
      message: 'refactor',
      diffText: 'diff --git a/file.ts b/file.ts\n@@ -0,0 +1 @@\n+hello'
    }

    fetchJsonMock.mockImplementation((input: RequestInfo) => {
      if (input === '/api/workflows/wf-1') {
        return Promise.resolve(workflowDetail)
      }
      if (input === '/api/workflows/wf-1/steps/step-1/diff') {
        return Promise.resolve(diffPayload)
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    })

    render(() => <WorkflowDetailView workflowId="wf-1" />)

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/api/workflows/wf-1'))

    expect(await screen.findByText(/Task brief & agent trace/i)).toBeDefined()
    expect(await screen.findByText('Implement the parser improvements.')).toBeDefined()
    expect(await screen.findByText(/Outcome ·/i)).toBeDefined()
    expect(await screen.findByText(/feature\/agent-flow · 1234567890/i)).toBeDefined()

    // Wait for the diff to load and file to appear
    await waitFor(() => {
      expect(screen.queryByText('Select a step with commits to preview the diff.')).toBeNull()
    })

    // Verify that file is shown with correct number of changes
    expect(await screen.findByText('file.ts')).toBeDefined()
    expect(await screen.findByText('1 changes')).toBeDefined()

    // File should be collapsed by default (▶), click to expand
    const fileHeader = await screen.findByText('file.ts')
    const expandButton = fileHeader.closest('.diff-file-header') as HTMLElement
    expandButton?.click()

    // Now verify diff content is visible
    expect(await screen.findByText('@@ -0,0 +1 @@')).toBeDefined()
    expect(await screen.findByText('+hello')).toBeDefined()
  })
})

function buildWorkflowDetail() {
  const now = new Date().toISOString()
  const agentPayload = {
    userInstructions: 'Project context and task envelope',
    outcome: 'approved',
    reason: 'Verifier approved the plan',
    bootstrap: {
      round: 0,
      raw: '{}',
      parsed: {
        verdict: 'instruct',
        critique: 'Focus on parser edge cases.',
        instructions: 'Outline the parser adjustments',
        priority: 2
      }
    },
    rounds: [
      {
        worker: {
          round: 1,
          raw: '{}',
          parsed: {
            status: 'done',
            plan: 'Plan parser updates',
            work: 'Updated parser code',
            requests: ''
          }
        },
        verifier: {
          round: 1,
          raw: '{}',
          parsed: {
            verdict: 'approve',
            critique: 'Looks solid',
            instructions: 'Ship it',
            priority: 1
          }
        }
      }
    ]
  }

  return {
    workflow: {
      id: 'wf-1',
      projectId: 'project-1',
      status: 'running',
      kind: 'custom',
      data: {},
      createdAt: now,
      updatedAt: now
    },
    steps: [
      {
        id: 'step-1',
        workflowId: 'wf-1',
        status: 'completed',
        sequence: 1,
        data: {
          title: 'Parser updates',
          instructions: 'Implement the parser improvements.'
        },
        updatedAt: now,
        result: {
          instructions: 'Implement the parser improvements.',
          summary: 'Verifier approved the plan',
          workspace: {
            workspacePath: '/tmp/workspace',
            branchName: 'feature/agent-flow',
            baseBranch: 'main'
          },
          commit: {
            branch: 'feature/agent-flow',
            commitHash: '1234567890abcdef',
            message: 'refactor',
            changedFiles: ['file.ts']
          },
          agent: agentPayload
        }
      }
    ]
  }
}
