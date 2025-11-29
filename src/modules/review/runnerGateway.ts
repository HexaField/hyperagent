import { spawn } from 'node:child_process'
import type { ProjectRecord } from '../projects'
import type { PullRequestRecord, ReviewRunRecord } from './types'

export type RunnerEnqueuePayload = {
  run: ReviewRunRecord
  pullRequest: PullRequestRecord
  project: ProjectRecord
}

export type ReviewRunnerGateway = {
  enqueue: (payload: RunnerEnqueuePayload) => Promise<void>
}

export type DockerRunnerGatewayOptions = {
  dockerBinary?: string
  image?: string
  callbackBaseUrl: string
  callbackToken?: string
  logsDir?: string
  timeoutMs?: number
}

const DEFAULT_IMAGE = 'curlimages/curl:8.11.1'
const DEFAULT_TIMEOUT_MS = 120_000

export function createDockerReviewRunnerGateway(options: DockerRunnerGatewayOptions): ReviewRunnerGateway {
  const binary = options.dockerBinary ?? 'docker'
  const image = options.image ?? DEFAULT_IMAGE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    enqueue: (payload) => enqueueRun(binary, image, timeoutMs, options, payload)
  }
}

async function enqueueRun(
  dockerBinary: string,
  image: string,
  timeoutMs: number,
  options: DockerRunnerGatewayOptions,
  payload: RunnerEnqueuePayload
): Promise<void> {
  const callbackUrl = buildCallbackUrl(options.callbackBaseUrl, payload.run.id)
  const body = JSON.stringify({
    runId: payload.run.id,
    pullRequestId: payload.pullRequest.id,
    projectId: payload.project.id,
    status: 'completed',
    logsPath: buildLogsPath(options.logsDir, payload.run.id)
  })

  const args = ['run', '--rm', image, '-sS', '--fail-with-body', '-X', 'POST', callbackUrl, '-H', 'Content-Type: application/json']

  if (options.callbackToken) {
    args.push('-H', `X-Review-Runner-Token: ${options.callbackToken}`)
  }

  args.push('-d', body)

  await runDockerCommand(dockerBinary, args, timeoutMs)
}

function buildCallbackUrl(baseUrl: string, runId: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${trimmed}/api/review-runs/${encodeURIComponent(runId)}/callback`
}

function buildLogsPath(baseDir: string | undefined, runId: string): string | undefined {
  if (!baseDir) return undefined
  const normalized = baseDir.endsWith('/') ? baseDir.slice(0, -1) : baseDir
  return `${normalized}/${runId}`
}

async function runDockerCommand(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore' })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => clearTimeout(timeout)

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
