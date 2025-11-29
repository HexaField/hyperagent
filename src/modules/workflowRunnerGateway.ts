import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
  caCertPath?: string
}

const DEFAULT_IMAGE = 'curlimages/curl:8.11.1'
const DEFAULT_TIMEOUT_MS = 900_000

export function createDockerWorkflowRunnerGateway(options: DockerWorkflowRunnerOptions): WorkflowRunnerGateway {
  const binary = options.dockerBinary ?? 'docker'
  const image = options.image ?? DEFAULT_IMAGE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const resolvedCaCertPath = resolveCaCertPath(options.caCertPath)

  return {
    enqueue: (payload) => invokeDockerCurl(binary, image, timeoutMs, options, resolvedCaCertPath, payload)
  }
}

async function invokeDockerCurl(
  dockerBinary: string,
  image: string,
  timeoutMs: number,
  options: DockerWorkflowRunnerOptions,
  caCertConfig: CaCertConfig | null,
  payload: WorkflowRunnerPayload
): Promise<void> {
  const callbackUrl = buildCallbackUrl(options.callbackBaseUrl, payload.workflowId, payload.stepId)
  const body = JSON.stringify({
    workflowId: payload.workflowId,
    stepId: payload.stepId,
    runnerInstanceId: payload.runnerInstanceId
  })

  const args = buildDockerArgs(image, caCertConfig)
  const curlArgs = ['-sS', '--fail-with-body', '-X', 'POST', callbackUrl, '-H', 'Content-Type: application/json']
  if (options.callbackToken) {
    curlArgs.push('-H', `X-Workflow-Runner-Token: ${options.callbackToken}`)
  }
  if (caCertConfig) {
    curlArgs.push('--cacert', caCertConfig.containerPath)
  }
  curlArgs.push('-d', body)

  await runDockerCommand(dockerBinary, [...args, ...curlArgs], timeoutMs)
}

type CaCertConfig = {
  hostPath: string
  containerPath: string
}

const CA_CONTAINER_PATH = '/hyperagent-runner/ca.pem'

function resolveCaCertPath(candidate?: string): CaCertConfig | null {
  if (!candidate) {
    return null
  }
  const resolved = path.resolve(candidate)
  if (!fs.existsSync(resolved)) {
    console.warn('[workflow-runner] Provided CA certificate not found, skipping trusted mount.', { path: candidate })
    return null
  }
  return {
    hostPath: resolved,
    containerPath: CA_CONTAINER_PATH
  }
}

function buildDockerArgs(image: string, caCertConfig: CaCertConfig | null): string[] {
  const args = ['run', '--rm']
  if (caCertConfig) {
    args.push('-v', `${caCertConfig.hostPath}:${caCertConfig.containerPath}:ro`)
  }
  args.push(image)
  return args
}

function buildCallbackUrl(baseUrl: string, workflowId: string, stepId: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${trimmed}/api/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/callback`
}

async function runDockerCommand(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore' })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
    }

    child.once('error', (error) => {
      cleanup()
      reject(error)
    })

    child.once('close', (code) => {
      cleanup()
      if (code !== 0) {
        reject(new Error(`docker ${args.join(' ')} failed with exit code ${code}`))
        return
      }
      resolve()
    })
  })
}
