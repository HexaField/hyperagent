import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunResponse } from './agent/agent'
import type {
  AgentWorkflowRunOptions,
  AgentWorkflowTurn
} from './agent/agent-orchestrator'
import { type VerifierWorkerWorkflowDefinition, type VerifierWorkerWorkflowResult } from './agent/workflows'
import {
  createAgentWorkflowExecutor,
  type VerifierStructuredResponse,
  type WorkerStructuredResponse
} from './workflowAgentExecutor'
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
    const runWorkflow = vi.fn<[AgentWorkflowRunOptions], Promise<AgentRunResponse<VerifierWorkerWorkflowResult>>>(
      async (options) => {
        expect(options.model).toBe('gpt-oss')
        expect(options.maxRounds).toBe(4)
        expect(options.sessionDir).toBe(sessionDir)
        return { runId: 'test-run', result: Promise.resolve(buildWorkflowResult('approved')) }
      }
    )
    const executor = createAgentWorkflowExecutor({ runWorkflow, model: 'gpt-oss', maxRounds: 4 })

    const args = buildExecutorArgs(sessionDir)
    const result = await executor(args)

    expect(runWorkflow).toHaveBeenCalled()
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
    const runWorkflow = vi
      .fn<[AgentWorkflowRunOptions], Promise<AgentRunResponse<VerifierWorkerWorkflowResult>>>()
      .mockResolvedValue({ runId: 'failed-run', result: Promise.resolve(buildWorkflowResult('failed')) })
    const executor = createAgentWorkflowExecutor({ runWorkflow })

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

function buildWorkflowResult(outcome: VerifierWorkerWorkflowResult['outcome']): VerifierWorkerWorkflowResult {
  const verifierParsed: VerifierStructuredResponse = {
    verdict: outcome === 'approved' ? 'approve' : 'fail',
    critique: 'Looks good',
    instructions: outcome === 'approved' ? 'Ship it.' : 'Fix the failing tests.',
    priority: 1
  }
  const workerParsed: WorkerStructuredResponse = {
    status: 'done',
    plan: 'Plan the refactor',
    work: 'Implemented the parser updates.',
    requests: ''
  }
  const workerTurn = {
    key: 'builder',
    role: 'builder',
    round: 1,
    raw: JSON.stringify(workerParsed),
    parsed: workerParsed
  } as unknown as AgentWorkflowTurn<VerifierWorkerWorkflowDefinition>
  const verifierTurn = {
    key: 'reviewer',
    role: 'reviewer',
    round: 1,
    raw: JSON.stringify(verifierParsed),
    parsed: verifierParsed
  } as unknown as AgentWorkflowTurn<VerifierWorkerWorkflowDefinition>
  const bootstrapTurn = {
    key: 'bootstrap',
    role: 'reviewer',
    round: 0,
    raw: JSON.stringify({
      critique: 'Focus on parser edge cases.',
      instructions: 'Outline adjustments.',
      verdict: 'instruct',
      priority: 2
    }),
    parsed: {
      verdict: 'instruct',
      critique: 'Focus on parser edge cases.',
      instructions: 'Outline adjustments.',
      priority: 2
    }
  } as unknown as NonNullable<VerifierWorkerWorkflowResult['bootstrap']>
  return {
    outcome,
    reason: outcome === 'approved' ? 'Verifier approved the changes' : 'Verifier rejected the work',
    bootstrap: bootstrapTurn,
    rounds: [
      {
        round: 1,
        steps: { builder: workerTurn, reviewer: verifierTurn } as unknown as Record<
          string,
          AgentWorkflowTurn<VerifierWorkerWorkflowDefinition>
        >
      }
    ]
  }
}
