import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentWorkflow } from '../../src/modules/agent/agent-orchestrator'
import { verifierWorkerWorkflowDefinition } from '../../src/modules/agent/workflows'

describe('runVerifierWorkerLoop (real opencode)', () => {
  let tmp: string
  let sessionDir: string

  beforeEach(() => {
    // create an isolated session dir under tmp
    tmp = os.tmpdir()
    sessionDir = path.join(tmp, `hyperagent-e2e-agent-${Date.now()}`)
    fs.mkdirSync(sessionDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true })
  })

  it('executes using the real opencode CLI (if available) and completes or fails gracefully', async () => {
    const response = await runAgentWorkflow(verifierWorkerWorkflowDefinition, {
      userInstructions: 'Please produce a concise JSON object describing a trivial task outcome.',
      model: 'opencode/big-pickle',
      sessionDir
    })

    const result = await response.result

    // Basic assertions: result should have the expected shape
    expect(result).toHaveProperty('outcome')
    expect(result).toHaveProperty('bootstrap')
    expect(result).toHaveProperty('rounds')
  }, 30_000)
})
