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

  return async function executeWithAgent(args: AgentExecutorArgs): Promise<AgentExecutorResult> {
    const sessionDir = resolveSessionDir(args)
    await ensureOpencodeConfig(sessionDir)
    const userInstructions = buildInstructions(args)
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
      stepResult: {
        instructions: userInstructions,
        summary: loopResult.reason,
        agent: {
          userInstructions,
          outcome: loopResult.outcome,
          reason: loopResult.reason,
          bootstrap: loopResult.bootstrap,
          rounds: loopResult.rounds
        }
      },
      commitMessage: shouldCommit ? buildCommitMessage(args, loopResult) : undefined,
      skipCommit: !shouldCommit,
      logsPath: logsPath ?? null
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

async function detectLogsPath(sessionDir: string): Promise<string | undefined> {
  const file = path.join(sessionDir, '.hyperagent.json')
  try {
    await fs.access(file)
    return file
  } catch {
    return undefined
  }
}
