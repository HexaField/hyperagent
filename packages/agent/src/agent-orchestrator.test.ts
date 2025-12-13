import {
  getWorkflowRunDiff,
  loadWorkflowDefinition,
  runAgentWorkflow,
  UserInputsFromDefinition
} from '@hexafield/agent-workflow/agent-orchestrator'
import { RunMeta } from '@hexafield/agent-workflow/provenance'
import { singleAgentWorkflowDefinition, verifierWorkerWorkflowDefinition } from '@hexafield/agent-workflow/workflows'
import { FileDiff } from '@opencode-ai/sdk'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from './opencodeTestHooks'

const model = 'github-copilot/gpt-5-mini'

const commandExists = (cmd: string): boolean => {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

const initGitRepo = (directory: string) => {
  execSync('git init', { cwd: directory, stdio: 'ignore' })
  execSync('git config user.email "agent@example.com"', { cwd: directory, stdio: 'ignore' })
  execSync('git config user.name "HyperAgent"', { cwd: directory, stdio: 'ignore' })
  execSync('git add .', { cwd: directory, stdio: 'ignore' })
  execSync('git commit --allow-empty -m "Initialize workspace"', { cwd: directory, stdio: 'ignore' })
}

describe('Agent orchestrator workflows', () => {
  opencodeTestHooks()

  it('executes the verifier-worker workflow from static JSON', async () => {
    const sessionDir = path.join(process.cwd(), `.tests/orchestrator-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      permission: {
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
        doom_loop: 'allow',
        external_directory: 'deny'
      }
    }
    fs.writeFileSync(path.join(sessionDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2))

    initGitRepo(sessionDir)

    const workflowPath = path.join(sessionDir, 'verifier-worker.workflow.json')
    fs.writeFileSync(workflowPath, JSON.stringify(verifierWorkerWorkflowDefinition, null, 2), 'utf8')
    const workflow = loadWorkflowDefinition(workflowPath) as typeof verifierWorkerWorkflowDefinition

    const scenario = 'Create a readme.md file that includes the text "Hello, world".'

    type UserInputs = UserInputsFromDefinition<typeof verifierWorkerWorkflowDefinition>
    const userPayload: UserInputs = { instructions: scenario }

    const response = await runAgentWorkflow(workflow, {
      user: userPayload,
      model,
      sessionDir,
      maxRounds: 5
    })

    const result = await response.result

    expect(result.bootstrap?.key).toBe('bootstrap')
    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    const workerStep = firstRound.steps.worker
    if (!workerStep || workerStep.role !== 'worker') {
      throw new Error('Expected worker step in first round')
    }
    const verifierStep = firstRound.steps.verifier
    if (!verifierStep || verifierStep.role !== 'verifier') {
      throw new Error('Expected verifier step in first round')
    }
    expect(workerStep.parsed.plan?.length ?? 0).toBeGreaterThan(0)
    expect(verifierStep.parsed.instructions?.length ?? 0).toBeGreaterThan(0)
    expect(['approved', 'failed', 'max-rounds']).toContain(result.outcome)

    const hyperagentDir = path.join(sessionDir, '.hyperagent')
    const metaFiles = fs
      .readdirSync(hyperagentDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(hyperagentDir, f))

    expect(metaFiles.length).toBeGreaterThan(0)
    const logs = metaFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as RunMeta)

    for (const entry of logs) {
      const worker = entry.agents.find((agent) => agent.role === 'worker')
      const verifier = entry.agents.find((agent) => agent.role === 'verifier')
      expect(worker?.sessionId).toBeDefined()
      expect(verifier?.sessionId).toBeDefined()
      const userMessages = entry.log.filter((log) => log.role === 'user')
      expect(userMessages.length).toBeGreaterThan(0)
    }

    const readmePath = path.join(sessionDir, 'readme.md')
    expect(fs.existsSync(readmePath)).toBe(true)
    expect(fs.readFileSync(readmePath, 'utf8').toLowerCase()).toContain('hello, world')

    const workerDiffs = await getWorkflowRunDiff(response.runId, sessionDir, { role: 'worker' })
    expect(workerDiffs.length).toBeGreaterThan(0)
    expect(workerDiffs.some((diff: FileDiff) => diff.file.toLowerCase().includes('readme.md'))).toBe(true)
  }, 120_000)

  it('executes the single-agent workflow definition once', async () => {
    const sessionDir = path.join(process.cwd(), `.tests/orchestrator-single-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      permission: {
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
        doom_loop: 'allow',
        external_directory: 'deny'
      }
    }
    fs.writeFileSync(path.join(sessionDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2))

    initGitRepo(sessionDir)

    const workflowPath = path.join(sessionDir, 'single-agent.workflow.json')
    fs.writeFileSync(workflowPath, JSON.stringify(singleAgentWorkflowDefinition, null, 2), 'utf8')
    const workflow = loadWorkflowDefinition(workflowPath) as typeof singleAgentWorkflowDefinition

    const scenario = 'Create a log.txt file that includes a single line "orchestrator".'

    const response = await runAgentWorkflow(workflow, {
      user: { instructions: scenario },
      model,
      sessionDir,
      maxRounds: 1
    })

    const result = await response.result
    expect(result.rounds.length).toBeGreaterThan(0)
    const firstStep = result.rounds[0].steps.agent
    expect(firstStep).toBeDefined()
    expect(result.outcome).toBe('completed')

    const logPath = path.join(sessionDir, 'log.txt')
    expect(fs.existsSync(logPath)).toBe(true)
    expect(fs.readFileSync(logPath, 'utf8').toLowerCase()).toContain('orchestrator')

    const diffs = await getWorkflowRunDiff(response.runId, sessionDir, { role: 'agent' })
    expect(diffs.length).toBeGreaterThan(0)
  }, 60_000)
})
