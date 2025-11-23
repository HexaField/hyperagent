import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { Route, Router } from '@solidjs/router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkflowsPage from '../WorkflowsPage'
import { fetchJson } from '../../lib/http'

vi.mock('../../lib/http', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = vi.mocked(fetchJson)

describe('WorkflowsPage', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('opens and closes the workflow session overlay via search params', async () => {
    const workflowSummary = {
      workflow: {
        id: 'wf-1',
        projectId: 'project-1',
        kind: 'session',
        status: 'running',
        createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
        updatedAt: new Date('2024-01-01T00:00:00Z').toISOString()
      },
      steps: []
    }

    const workflowDetail = {
      workflow: workflowSummary.workflow,
      steps: [
        {
          id: 'step-1',
          workflowId: 'wf-1',
          status: 'running',
          sequence: 1,
          updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
          data: { title: 'Investigate issue' },
          result: {
            commit: {
              commitHash: 'abc123'
            }
          }
        }
      ]
    }

    fetchJsonMock.mockImplementation((input: RequestInfo) => {
      if (input === '/api/workflows') {
        return Promise.resolve({ workflows: [workflowSummary] })
      }
      if (input === '/api/workflows/wf-1') {
        return Promise.resolve(workflowDetail)
      }
      if (input === '/api/workflows/wf-1/steps/step-1/diff') {
        return Promise.resolve({
          workflowId: 'wf-1',
          stepId: 'step-1',
          commitHash: 'abc123',
          branch: 'main',
          message: 'Test commit',
          diffText: 'diff --git a/file b/file'
        })
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    })

    window.history.replaceState({}, '', '/workflows?sessionId=wf-1')

    render(() => (
      <Router root={(props) => <>{props.children}</>}>
        <Route path="/workflows" component={WorkflowsPage} />
      </Router>
    ))

    await waitFor(() => expect(screen.getByTestId('workflow-session-viewer')).not.toBeNull())
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/workflows')
    expect(fetchJsonMock).toHaveBeenCalledWith('/api/workflows/wf-1')

    const closeButton = await screen.findByRole('button', { name: /close session/i })
    fireEvent.click(closeButton)

    await waitFor(() => expect(screen.queryByTestId('workflow-session-viewer')).toBeNull())
  })
})
