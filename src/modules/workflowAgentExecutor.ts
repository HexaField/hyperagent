import fs from 'fs/promises'
import path from 'path'
import { runVerifierWorkerLoop, type AgentLoopResult, type AgentStreamCallback } from './agent'
import type { Provider } from './llm'
import type { AgentExecutor, AgentExecutorArgs, AgentExecutorResult } from './workflows'

export type AgentWorkflowExecutorOptions = {
  runLoop?: typeof runVerifierWorkerLoop
  provider?: Provider
  model?: string
  maxRounds?: number
  onStream?: AgentStreamCallback
}

export function createAgentWorkflowExecutor(options: AgentWorkflowExecutorOptions = {}): AgentExecutor {
  const runLoop = options.runLoop ?? runVerifierWorkerLoop
  const provider = options.provider
  const model = options.model
  const maxRounds = options.maxRounds
  const onStream = options.onStream
  const agentMetadata = {
    provider: provider ?? null,
    model: model ?? null
  }

  return async function executeWithAgent(args: AgentExecutorArgs): Promise<AgentExecutorResult> {
    const sessionDir = resolveSessionDir(args)
    await ensureProviderConfig(sessionDir)
    const userInstructions = buildInstructions(args)
    try {
      const loopResult = await runLoop({
        userInstructions,
        provider,
        model,
        maxRounds,
        sessionDir,
        onStream
      })
      const shouldCommit = loopResult.outcome === 'approved'
      const logsPath = await detectLogsPath(sessionDir)
      return {
        stepResult: buildStepResultFromLoop(loopResult, userInstructions, agentMetadata),
        commitMessage: shouldCommit ? buildCommitMessage(args, loopResult) : undefined,
        skipCommit: !shouldCommit,
        logsPath: logsPath ?? null
      }
    } catch (error) {
      return await buildFallbackAgentResult({ sessionDir, userInstructions, args, cause: error })
    }
  }
}

function buildStepResultFromLoop(
  loopResult: AgentLoopResult,
  userInstructions: string,
  metadata?: { provider: string | null; model: string | null }
) {
  return {
    instructions: userInstructions,
    summary: loopResult.reason,
    agent: {
      userInstructions,
      outcome: loopResult.outcome,
      reason: loopResult.reason,
      bootstrap: loopResult.bootstrap,
      rounds: loopResult.rounds,
      provider: metadata?.provider ?? null,
      model: metadata?.model ?? null
    }
  }
}

function resolveSessionDir(args: AgentExecutorArgs): string {
  if (args.workspace?.workspacePath) {
    return args.workspace.workspacePath
  }
  if (args.project.repositoryPath) {
    return args.project.repositoryPath
  }
  throw new Error('Agent executor requires a workspace or project repository path')
}

function buildInstructions({ project, workflow, step }: AgentExecutorArgs): string {
  const title = extractString((step.data ?? {})['title']) || `Step ${step.sequence}`
  const instructions = extractString((step.data ?? {})['instructions'])
  const briefing = [
    `Project: ${project.name}`,
    `Repository path: ${project.repositoryPath}`,
    `Workflow kind: ${workflow.kind}`,
    `Task ${step.sequence}: ${title}`,
    instructions ? `Detailed instructions:\n${instructions}` : null,
    'Apply code changes directly in this workspace and rely on git to track your work.'
  ]
    .filter(Boolean)
    .join('\n\n')
  return briefing
}

function buildCommitMessage({ workflow, step }: AgentExecutorArgs, result: AgentLoopResult): string {
  const title = extractString((step.data ?? {})['title']) || `Step ${step.sequence}`
  const suffix = result.reason ? ` — ${result.reason}` : ''
  return `${workflow.kind}: ${title}${suffix}`.trim()
}

function extractString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }
  return null
}

async function ensureOpencodeConfig(sessionDir: string): Promise<void> {
  const configPath = path.join(sessionDir, 'opencode.json')
  try {
    await fs.access(configPath)
    return
  } catch {
    // create default config below
  }
  const payload = {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'deny'
    }
  }
  try {
    await fs.writeFile(configPath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    console.warn('Failed to write opencode.json for workflow agent session', error)
  }
}

/**
 * Provider-agnostic config bootstrap. Currently delegates to opencode-specific
 * config creation for backward compatibility.
 */
export async function ensureProviderConfig(sessionDir: string, providerId?: string): Promise<void> {
  void providerId
  // For now we only support the opencode provider's config file.
  await ensureOpencodeConfig(sessionDir)
}

async function detectLogsPath(sessionDir: string): Promise<string | undefined> {
  const dir = path.join(sessionDir, '.hyperagent')
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const fullPath = path.join(dir, entry.name)
          const stat = await fs.stat(fullPath)
          return { fullPath, mtime: stat.mtimeMs }
        })
    )
    if (!candidates.length) return undefined
    candidates.sort((a, b) => b.mtime - a.mtime)
    return candidates[0].fullPath
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

type FallbackAgentArgs = {
  sessionDir: string
  userInstructions: string
  args: AgentExecutorArgs
  cause: unknown
}

async function buildFallbackAgentResult({ sessionDir, userInstructions, args, cause }: FallbackAgentArgs) {
  const reason = buildFallbackReason(cause)
  const fallbackPlan = synthesizePlan(userInstructions)
  const workerTurn = {
    round: 1,
    raw: JSON.stringify({ plan: fallbackPlan.join('\n') }),
    parsed: {
      status: 'working',
      plan: fallbackPlan.join('\n'),
      work: fallbackPlan.slice(0, 2).join('\n'),
      requests: ''
    }
  }
  const verifierTurn = {
    round: 1,
    raw: JSON.stringify({ instructions: fallbackPlan.join('\n') }),
    parsed: {
      verdict: 'fail',
      critique: 'Local workflow agent unavailable, using deterministic checklist.',
      instructions: fallbackPlan.join('\n'),
      priority: 1
    }
  }
  const fallbackAgent = {
    userInstructions,
    outcome: 'failed' as const,
    reason,
    bootstrap: verifierTurn,
    rounds: [{ worker: workerTurn, verifier: verifierTurn }]
  }
  const fallbackStepResult = {
    instructions: userInstructions,
    summary: 'Generated fallback workflow guidance because the configured agent provider is unavailable.',
    note: 'Install and configure the workflow agent provider to replace this fallback output.',
    agent: fallbackAgent
  }
  const fallbackLogPath = await writeFallbackLog(sessionDir, fallbackStepResult)
  return {
    stepResult: fallbackStepResult,
    skipCommit: true,
    logsPath: fallbackLogPath ?? null
  }
}

function buildFallbackReason(error: unknown): string {
  if (error instanceof Error) {
    return `Workflow agent fallback triggered: ${error.message}`
  }
  return 'Workflow agent fallback triggered due to unknown error.'
}

function synthesizePlan(instructions: string): string[] {
  const trimmed = instructions.trim()
  if (!trimmed) return ['Review workspace context', 'Apply requested changes', 'Report blocking issues']
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return ['Review workspace context', 'Apply requested changes', 'Report blocking issues']
  const bullets: string[] = []
  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s*/, '').trim()
    if (!normalized) continue
    bullets.push(normalized)
    if (bullets.length >= 5) break
  }
  return bullets.length ? bullets : ['Review workspace context', 'Apply requested changes', 'Report blocking issues']
}

async function writeFallbackLog(sessionDir: string, payload: Record<string, unknown>) {
  try {
    const dir = path.join(sessionDir, '.hyperagent')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `workflow-fallback-${Date.now()}.json`)
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
    return file
  } catch {
    return null
  }
}
