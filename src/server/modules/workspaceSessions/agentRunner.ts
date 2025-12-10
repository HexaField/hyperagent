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
    // Capture stdout/stderr so we can include container output in error messages
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    const forward = (data: Buffer | string, target: 'stdout' | 'stderr') => {
      try {
        const text = data instanceof Buffer ? data.toString('utf8') : String(data)
        if (target === 'stdout') {
          process.stdout.write(text)
          stdout += text
        } else {
          process.stderr.write(text)
          stderr += text
        }
      } catch {}
    }

    if (child.stdout) child.stdout.on('data', (d) => forward(d, 'stdout'))
    if (child.stderr) child.stderr.on('data', (d) => forward(d, 'stderr'))

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error(`Agent docker run timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            `Agent docker run failed with exit code ${code ?? 'unknown'}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        )
        return
      }
      resolve()
    })
  })
}

const escapeEnvValue = (value: string) => value.replace(/\n/g, '\\n')
