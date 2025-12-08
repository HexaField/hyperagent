import { runAgentWorkflow, type AgentWorkflowDefinition, type AgentWorkflowRunOptions } from '@hexafield/agent-workflow'
import { spawn } from 'node:child_process'
import path from 'node:path'

export type AgentExecutionMode = 'local' | 'docker'

export type AgentRunInvocation = {
  workflow: {
    id: string
    source: 'builtin'
    definition: AgentWorkflowDefinition
  }
  prompt: string
  model: string
  workspacePath: string
  runId: string
  execution: AgentExecutionMode
  personaId?: string | null
}

const DEFAULT_IMAGE = 'hyperagent-workflow-runner:latest'
const DEFAULT_TIMEOUT_MS = 900_000
const PASSTHROUGH_ENV = [
  'WORKFLOW_AGENT_PROVIDER',
  'WORKFLOW_GITHUB_COPILOT_PAT',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY'
]

export async function runAgent(invocation: AgentRunInvocation): Promise<void> {
  const { execution } = invocation
  if (execution === 'docker') {
    await runAgentInDocker(invocation)
    return
  }
  await runAgentLocally(invocation)
}

async function runAgentLocally(invocation: AgentRunInvocation): Promise<void> {
  const { workflow, prompt, model, workspacePath, runId } = invocation
  const options: AgentWorkflowRunOptions = {
    runID: runId,
    userInstructions: prompt,
    model,
    sessionDir: workspacePath,
    workflowId: workflow.id,
    workflowSource: workflow.source,
    workflowLabel: workflow.definition.description
  }
  await runAgentWorkflow(workflow.definition, options)
}

async function runAgentInDocker(invocation: AgentRunInvocation): Promise<void> {
  const { workflow, prompt, model, workspacePath, runId, personaId } = invocation
  const image = process.env.WORKSPACE_AGENT_DOCKER_IMAGE?.trim() || DEFAULT_IMAGE
  const timeoutMs = Number(process.env.WORKSPACE_AGENT_DOCKER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const resolvedWorkspace = path.resolve(workspacePath)

  const args = [
    'run',
    '--rm',
    '-v',
    `${resolvedWorkspace}:/workspace`,
    '-e',
    `AGENT_WORKSPACE_PATH=/workspace`,
    '-e',
    `AGENT_PROMPT=${escapeEnvValue(prompt)}`,
    '-e',
    `AGENT_MODEL=${escapeEnvValue(model)}`,
    '-e',
    `AGENT_WORKFLOW_ID=${escapeEnvValue(workflow.id)}`,
    '-e',
    `AGENT_WORKFLOW_SOURCE=${escapeEnvValue(workflow.source)}`,
    '-e',
    `AGENT_RUN_ID=${escapeEnvValue(runId)}`
  ]

  if (personaId) {
    args.push('-e', `AGENT_PERSONA_ID=${escapeEnvValue(personaId)}`)
  }

  PASSTHROUGH_ENV.forEach((key) => {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length) {
      args.push('-e', `${key}=${escapeEnvValue(value)}`)
    }
  })

  args.push(image, 'node', 'dist/src/runner/agentSessionRunner.js')

  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Agent docker run timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`Agent docker run failed with exit code ${code ?? 'unknown'}`))
        return
      }
      resolve()
    })
  })
}

const escapeEnvValue = (value: string) => value.replace(/\n/g, '\\n')
