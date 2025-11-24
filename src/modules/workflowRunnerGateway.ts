import { spawn } from 'node:child_process'
import { once } from 'node:events'

export type WorkflowRunnerGateway = {
  enqueue: (payload: WorkflowRunnerPayload) => Promise<void>
}

export type WorkflowRunnerPayload = {
  workflowId: string
  stepId: string
  runnerInstanceId: string
}

export type DockerWorkflowRunnerOptions = {
  dockerBinary?: string
  image?: string
  callbackBaseUrl: string
  callbackToken?: string
  timeoutMs?: number
}

const DEFAULT_IMAGE = 'curlimages/curl:8.11.1'
const DEFAULT_TIMEOUT_MS = 120_000

export function createDockerWorkflowRunnerGateway(options: DockerWorkflowRunnerOptions): WorkflowRunnerGateway {
  const binary = options.dockerBinary ?? 'docker'
  const image = options.image ?? DEFAULT_IMAGE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    enqueue: (payload) => invokeDockerCurl(binary, image, timeoutMs, options, payload)
  }
}

async function invokeDockerCurl(
  dockerBinary: string,
  image: string,
  timeoutMs: number,
  options: DockerWorkflowRunnerOptions,
  payload: WorkflowRunnerPayload
): Promise<void> {
  const callbackUrl = buildCallbackUrl(options.callbackBaseUrl, payload.workflowId, payload.stepId)
  const body = JSON.stringify({
    workflowId: payload.workflowId,
    stepId: payload.stepId,
    runnerInstanceId: payload.runnerInstanceId
  })

  const args = ['run', '--rm', image, '-sS', '-X', 'POST', callbackUrl, '-H', 'Content-Type: application/json']
  if (options.callbackToken) {
    args.push('-H', `X-Workflow-Runner-Token: ${options.callbackToken}`)
  }
  args.push('-d', body)

  await runDockerCommand(dockerBinary, args, timeoutMs)
}

function buildCallbackUrl(baseUrl: string, workflowId: string, stepId: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${trimmed}/api/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/callback`
}

async function runDockerCommand(binary: string, args: string[], timeoutMs: number): Promise<void> {
  const child = spawn(binary, args, { stdio: 'ignore' })
  const timeout = setTimeout(() => {
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [code] = (await once(child, 'close')) as [number | null]
    if (code !== 0) {
      throw new Error(`docker ${args.join(' ')} failed with exit code ${code}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}
