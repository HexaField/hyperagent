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
  repositoryPath: string
  persistencePath: string
}

export type DockerRunnerMount = {
  hostPath: string
  containerPath?: string
  readOnly?: boolean
}

export type DockerWorkflowRunnerOptions = {
  dockerBinary?: string
  image?: string
  callbackBaseUrl: string
  callbackToken?: string
  timeoutMs?: number
  caCertPath?: string
  extraEnv?: Record<string, string | undefined>
  passThroughEnv?: string[]
  mounts?: DockerRunnerMount[]
}

const DEFAULT_IMAGE = 'hyperagent-workflow-runner:latest'
const DEFAULT_TIMEOUT_MS = 900_000
const DEFAULT_ENV_PASSTHROUGH = [
  'WORKFLOW_AGENT_PROVIDER',
  'WORKFLOW_AGENT_MODEL',
  'WORKFLOW_AGENT_MAX_ROUNDS',
  'WORKFLOW_AUTHOR_NAME',
  'WORKFLOW_AUTHOR_EMAIL',
  'RADICLE_REMOTE',
  'RADICLE_CLI_PATH',
  'RADICLE_TEMP_DIR',
  'WORKFLOW_GITHUB_COPILOT_PAT'
]

export function createDockerWorkflowRunnerGateway(options: DockerWorkflowRunnerOptions): WorkflowRunnerGateway {
  const binary = options.dockerBinary ?? 'docker'
  const image = options.image ?? DEFAULT_IMAGE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const resolvedCaCertPath = resolveCaCertPath(options.caCertPath)
  const envPassthrough = [...new Set([...(options.passThroughEnv ?? []), ...DEFAULT_ENV_PASSTHROUGH])]

  return {
    enqueue: (payload) => invokeDockerRunner(binary, image, timeoutMs, options, resolvedCaCertPath, envPassthrough, payload)
  }
}

async function invokeDockerRunner(
  dockerBinary: string,
  image: string,
  timeoutMs: number,
  options: DockerWorkflowRunnerOptions,
  caCertConfig: CaCertConfig | null,
  envPassthrough: string[],
  payload: WorkflowRunnerPayload
): Promise<void> {
  const repositoryPath = ensureAbsolutePath(payload.repositoryPath, 'Workflow repository path')
  assertDirectoryAccessible(repositoryPath, 'Workflow repository path')
  const persistencePath = resolvePersistencePath(payload.persistencePath)
  const persistenceDir = path.dirname(persistencePath)
  assertDirectoryAccessible(persistenceDir, 'Workflow database directory')

  const args = ['run', '--rm']
  const mountMap = new Map<string, NormalizedMount>()
  const registerMount = (mount: NormalizedMount) => {
    const key = `${mount.hostPath}->${mount.containerPath}`
    const existing = mountMap.get(key)
    if (existing) {
      existing.readOnly = existing.readOnly && mount.readOnly
      return
    }
    mountMap.set(key, mount)
  }

  registerMount({ hostPath: repositoryPath, containerPath: repositoryPath, readOnly: false })
  registerMount({ hostPath: persistenceDir, containerPath: persistenceDir, readOnly: false })

  if (caCertConfig) {
    registerMount({ hostPath: caCertConfig.hostPath, containerPath: caCertConfig.containerPath, readOnly: true })
  }

  const configuredMounts = [...(options.mounts ?? []), ...getEnvConfiguredMounts()]
  configuredMounts.forEach((mountSpec) => {
    const normalized = normalizeMount(mountSpec)
    if (normalized) {
      registerMount(normalized)
    }
  })

  for (const mount of mountMap.values()) {
    args.push('-v', formatMountArgument(mount))
  }

  const envVars: Record<string, string> = {
    WORKFLOW_ID: payload.workflowId,
    WORKFLOW_STEP_ID: payload.stepId,
    WORKFLOW_RUNNER_ID: payload.runnerInstanceId,
    WORKFLOW_REPO_PATH: repositoryPath,
    WORKFLOW_DB_PATH: persistencePath
  }
  envVars.WORKFLOW_CALLBACK_BASE_URL = options.callbackBaseUrl
  if (options.callbackToken) {
    envVars.WORKFLOW_CALLBACK_TOKEN = options.callbackToken
  }
  if (caCertConfig) {
    envVars.NODE_EXTRA_CA_CERTS = caCertConfig.containerPath
  }
  const extraEnv = options.extraEnv ?? {}
  for (const key of Object.keys(extraEnv)) {
    const value = extraEnv[key]
    if (typeof value === 'string' && value.trim().length) {
      envVars[key] = value.trim()
    }
  }
  envPassthrough.forEach((key) => {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length) {
      envVars[key] = value.trim()
    }
  })

  Object.entries(envVars).forEach(([name, value]) => {
    if (value !== undefined) {
      args.push('-e', `${name}=${value}`)
    }
  })

  args.push(image)

  await runDockerCommand(dockerBinary, args, timeoutMs)
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

type NormalizedMount = {
  hostPath: string
  containerPath: string
  readOnly: boolean
}

const RUNNER_MOUNTS_ENV = 'WORKFLOW_RUNNER_MOUNTS'

function getEnvConfiguredMounts(): DockerRunnerMount[] {
  const raw = process.env[RUNNER_MOUNTS_ENV]
  if (!raw || !raw.trim().length) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.warn('[workflow-runner] WORKFLOW_RUNNER_MOUNTS must be a JSON array of mount specs')
      return []
    }
    return parsed
      .map((entry) => (typeof entry === 'object' && entry ? entry : null))
      .filter((entry): entry is DockerRunnerMount => Boolean(entry && typeof entry.hostPath === 'string'))
  } catch (error) {
    console.warn('[workflow-runner] Failed to parse WORKFLOW_RUNNER_MOUNTS', {
      error: error instanceof Error ? error.message : error
    })
    return []
  }
}

function normalizeMount(spec: DockerRunnerMount): NormalizedMount | null {
  const resolvedHost = path.resolve(spec.hostPath)
  if (!fs.existsSync(resolvedHost)) {
    console.warn('[workflow-runner] Skipping mount because host path is unavailable', { hostPath: spec.hostPath })
    return null
  }
  const containerPath = spec.containerPath ? spec.containerPath : resolvedHost
  if (!containerPath.startsWith('/')) {
    console.warn('[workflow-runner] Skipping mount with invalid container path', { containerPath })
    return null
  }
  return {
    hostPath: resolvedHost,
    containerPath,
    readOnly: Boolean(spec.readOnly)
  }
}

function formatMountArgument(mount: NormalizedMount): string {
  const mode = mount.readOnly ? ':ro' : ''
  return `${mount.hostPath}:${mount.containerPath}${mode}`
}

function ensureAbsolutePath(candidate: string, description: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${description} must be an absolute path: ${candidate}`)
  }
  return candidate
}

function resolvePersistencePath(candidate: string): string {
  if (!candidate || candidate === ':memory:') {
    throw new Error('Workflow docker runner requires a file-backed persistence database')
  }
  return ensureAbsolutePath(candidate, 'Workflow persistence path')
}

function assertDirectoryAccessible(targetPath: string, description: string): void {
  try {
    const stats = fs.statSync(targetPath)
    if (!stats.isDirectory()) {
      throw new Error(`${description} is not a directory at ${targetPath}`)
    }
  } catch (error) {
    throw new Error(`${description} is unavailable at ${targetPath}: ${error instanceof Error ? error.message : error}`)
  }
}

async function runDockerCommand(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(chunk.toString())
    })
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk.toString())
    })
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
        const stderrOutput = stderrChunks.join('').trim()
        const stdoutOutput = stdoutChunks.join('').trim()
        const errorDetail = stderrOutput || stdoutOutput
        const suffix = errorDetail ? `: ${errorDetail}` : ''
        reject(new Error(`docker ${args.join(' ')} failed with exit code ${code}${suffix}`))
        return
      }
      resolve()
    })
  })
}
