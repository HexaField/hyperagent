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
    const logsPayload = {
      workflowId: 'wf-1',
      entries: [
        {
          id: 'log-1',
          workflowId: 'wf-1',
          stepId: 'step-1',
          runnerInstanceId: 'runner-1',
          source: 'runner' as const,
          stream: 'stdout' as const,
          message: 'Runner boot sequence',
          timestamp: new Date().toISOString()
        }
      ]
    }
    const eventsPayload = {
      workflowId: 'wf-1',
      events: [
        {
          id: 'evt-1',
          workflowId: 'wf-1',
          stepId: 'step-1',
          type: 'runner.enqueue',
          status: 'succeeded',
          runnerInstanceId: 'runner-1',
          attempts: 1,
          latencyMs: 42,
          metadata: null,
          createdAt: new Date().toISOString()
        },
        {
          id: 'evt-2',
          workflowId: 'wf-1',
          stepId: 'step-1',
          type: 'runner.callback',
          status: 'failed',
          runnerInstanceId: 'runner-1',
          attempts: 1,
          latencyMs: 5,
          metadata: { error: 'Callback responded with 500' },
          createdAt: new Date().toISOString()
        }
      ]
    }

    fetchJsonMock.mockImplementation((input: RequestInfo) => {
      if (input === '/api/workflows/wf-1') {
        return Promise.resolve(workflowDetail)
      }
      if (input === '/api/workflows/wf-1/steps/step-1/diff') {
        return Promise.resolve(diffPayload)
      }
      if (input === '/api/workflows/wf-1/events') {
        return Promise.resolve(eventsPayload)
      }
      if (input === '/api/workflows/wf-1/logs') {
        return Promise.resolve(logsPayload)
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    })

    render(() => <WorkflowDetailView workflowId="wf-1" />)

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/api/workflows/wf-1'))

    await screen.findByText(/Task brief & agent trace/i)
    await screen.findByText('Implement the parser improvements.')
    await screen.findByText(/Outcome ·/i)
    await screen.findByText(/feature\/agent-flow · 1234567890/i)
    await screen.findByText(/Agent · opencode/i)
    await screen.findByText(/Policy decision/i)
    await screen.findByText(/Planner timeline/i)
    await screen.findByText(/Branch & PR status/i)
    await screen.findByText(/Runner telemetry/i)
    await screen.findByText(/Pull request queued/i)
    await screen.findByText(/Callback delivery · failed/i)
    await screen.findByText(/Callback responded with 500/i)
    await screen.findByText(/Live logs/i)
    await screen.findByText('Runner boot sequence')

    // Wait for the diff to load and file to appear
    await waitFor(() => {
      expect(screen.queryByText('Select a step with commits to preview the diff.')).toBeNull()
    })

    // Verify that file is shown with correct number of changes
    const fileEntries = await screen.findAllByText('file.ts')
    const diffFileEntry = fileEntries.find((entry) => entry.closest('.diff-file-header'))
    expect(diffFileEntry).toBeDefined()
    expect(await screen.findByText('1 changes')).toBeDefined()

    // File should be collapsed by default (▶), click to expand
    const expandButton = diffFileEntry?.closest('.diff-file-header') as HTMLElement
    expect(expandButton).toBeDefined()
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
    provider: 'opencode',
    model: 'github-copilot/gpt-5-mini',
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
        taskId: 'task-parser',
        dependsOn: [],
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
          pullRequest: {
            id: 'pr-123'
          },
          agent: agentPayload,
          policyAudit: {
            runnerInstanceId: 'runner-123',
            decision: {
              allowed: true,
              reason: 'Token verified',
              metadata: { protected: true }
            },
            recordedAt: now
          }
        }
      }
    ]
  }
}
