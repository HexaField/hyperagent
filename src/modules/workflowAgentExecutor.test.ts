import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoopResult } from './agent'
import { createAgentWorkflowExecutor } from './workflowAgentExecutor'
import type { AgentExecutorArgs } from './workflows'

describe('createAgentWorkflowExecutor', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await fs.rm(dir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  it('invokes the agent loop and propagates metadata when approved', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-agent-'))
    tempDirs.push(sessionDir)
    const runLoop = vi.fn().mockResolvedValue(buildAgentLoopResult('approved'))
    const executor = createAgentWorkflowExecutor({ runLoop, provider: 'goose', model: 'gpt-oss', maxRounds: 4 })

    const args = buildExecutorArgs(sessionDir)
    const result = await executor(args)

    expect(runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'goose',
        model: 'gpt-oss',
        maxRounds: 4,
        sessionDir,
        userInstructions: expect.stringContaining('Task 1')
      })
    )
    expect(result.skipCommit).toBe(false)
    expect(result.commitMessage).toContain('Feature work')
    const agentPayload = result.stepResult?.agent as { outcome?: string } | undefined
    expect(agentPayload?.outcome).toBe('approved')
    const logsPath = result.logsPath
    const perRunPath =
      typeof logsPath === 'string' &&
      logsPath.includes(`${path.sep}.hyperagent${path.sep}`) &&
      logsPath.endsWith('.json')
    expect(logsPath === null || perRunPath).toBe(true)
  })

  it('skips commits when the agent does not approve', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-agent-failed-'))
    tempDirs.push(sessionDir)
    const runLoop = vi.fn().mockResolvedValue(buildAgentLoopResult('failed'))
    const executor = createAgentWorkflowExecutor({ runLoop })

    const args = buildExecutorArgs(sessionDir)
    const result = await executor(args)

    expect(result.skipCommit).toBe(true)
    expect(result.commitMessage).toBeUndefined()
    const agentPayload = result.stepResult?.agent as { outcome?: string } | undefined
    expect(agentPayload?.outcome).toBe('failed')
  })
})

function buildExecutorArgs(sessionDir: string): AgentExecutorArgs {
  const now = new Date().toISOString()
  return {
    project: {
      id: 'project-1',
      name: 'Example Project',
      description: null,
      repositoryPath: sessionDir,
      repositoryProvider: null,
      defaultBranch: 'main',
      createdAt: now
    },
    workflow: {
      id: 'workflow-1',
      projectId: 'project-1',
      plannerRunId: null,
      kind: 'refactor',
      status: 'running',
      data: {},
      createdAt: now,
      updatedAt: now
    },
    step: {
      id: 'step-1',
      workflowId: 'workflow-1',
      taskId: null,
      status: 'pending',
      sequence: 1,
      dependsOn: [],
      data: {
        title: 'Feature work',
        instructions: 'Tighten up the parser implementation and add tests.'
      },
      result: null,
      runnerInstanceId: null,
      runnerAttempts: 0,
      readyAt: null,
      updatedAt: now
    },
    workspace: {
      workspacePath: sessionDir,
      branchName: 'feature/parser-updates',
      baseBranch: 'main'
    },
    radicleSession: undefined
  }
}

function buildAgentLoopResult(outcome: AgentLoopResult['outcome']): AgentLoopResult {
  return {
    outcome,
    reason: outcome === 'approved' ? 'Verifier approved the changes' : 'Verifier rejected the work',
    bootstrap: {
      round: 0,
      raw: '{}',
      parsed: {
        verdict: 'instruct',
        critique: 'Focus on the parser edge cases.',
        instructions: 'Start by outlining the parser adjustments.',
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
            plan: 'Plan the refactor',
            work: 'Implemented the parser updates.',
            requests: ''
          }
        },
        verifier: {
          round: 1,
          raw: '{}',
          parsed: {
            verdict: outcome === 'approved' ? 'approve' : 'fail',
            critique: 'Looks good',
            instructions: outcome === 'approved' ? 'Ship it.' : 'Fix the failing tests.',
            priority: 1
          }
        }
      }
    ]
  }
}
