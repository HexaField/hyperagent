import type { FileDiff, Part, Session } from '@opencode-ai/sdk'
import { z } from 'zod'
import { appendLogEntry } from '../provenance/provenance'
import { extractResponseText, getMessageDiff, promptSession } from './opencode'

const MAX_JSON_ATTEMPTS = 3

export type WorkflowParserRegistry = Record<string, z.ZodTypeAny>

export type WorkflowParserOutputs<TRegistry extends WorkflowParserRegistry> = {
  [Name in keyof TRegistry]: z.infer<TRegistry[Name]>
}

export type WorkflowParserOutput<
  TRegistry extends WorkflowParserRegistry,
  TName extends keyof TRegistry & string
> = WorkflowParserOutputs<TRegistry>[TName]

let workflowParserRegistry: WorkflowParserRegistry | null = null

export function configureWorkflowParsers<const TRegistry extends WorkflowParserRegistry>(
  registry: TRegistry
): TRegistry {
  workflowParserRegistry = registry
  return registry
}

const requireWorkflowParserSchema = (parserName: string): z.ZodTypeAny => {
  if (!workflowParserRegistry) {
    throw new Error('No workflow parsers configured. Call configureWorkflowParsers before running workflows.')
  }
  const schema = workflowParserRegistry[parserName]
  if (!schema) {
    throw new Error(`Workflow parser '${parserName}' is not registered.`)
  }
  return schema
}

export type AgentRunResponse<T = unknown> = {
  runId: string
  result: Promise<T>
}

export type AgentStreamEvent = {
  role: string
  round: number
  parts: Part[]
  model: string
  attempt: number
  runId?: string
}

export type AgentStreamCallback = (event: AgentStreamEvent) => void

export type RunDiffSnapshot = {
  files: FileDiff[]
  source: 'opencode'
  messageId?: string
  capturedAt: string
}

const extractMessageIdFromParts = (parts: Part[]): string | null => {
  const messagePart = parts.find((part) => typeof part.messageID === 'string')
  return messagePart?.messageID ?? null
}

const captureDiffSnapshot = async (args: {
  session: Session
  runId: string
  directory: string
  parts: Part[]
}): Promise<RunDiffSnapshot | null> => {
  const messageId = extractMessageIdFromParts(args.parts)
  if (!messageId) return null

  let files: FileDiff[] = []

  try {
    files = await getMessageDiff(args.session, messageId)
  } catch (error) {
    console.warn('[agent] message diff retrieval failed', {
      runId: args.runId,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  if (!files.length) {
    return null
  }

  return {
    files,
    source: 'opencode',
    messageId: messageId ?? undefined,
    capturedAt: new Date().toISOString()
  }
}

export async function invokeStructuredJsonCall<T>(options: {
  role: string
  systemPrompt: string
  basePrompt: string
  model: string
  session: Session
  runId: string
  directory: string
  onStream?: AgentStreamCallback
  parseResponse?: (res: string) => T
}): Promise<{ raw: string; parsed: T }> {
  let prompt = options.basePrompt
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const response = await promptSession(options.session, [options.systemPrompt, prompt], options.model)
    const raw = extractResponseText(response.parts)

    const diffSnapshot = await captureDiffSnapshot({
      session: options.session,
      runId: options.runId,
      directory: options.directory,
      parts: response.parts
    })

    appendLogEntry(
      options.runId,
      {
        model: options.model,
        role: options.role,
        payload: {
          attempt,
          prompt,
          raw,
          response: response.parts,
          diff: diffSnapshot ?? undefined
        }
      },
      options.directory
    )

    try {
      const parsed = options.parseResponse ? options.parseResponse(raw) : (undefined! as T)

      options.onStream?.({
        role: options.role,
        round: attempt,
        parts: response.parts,
        model: options.model,
        attempt: 1,
        runId: options.session.id
      })
      return { raw, parsed }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn('[agent] structured JSON call failed', {
        role: options.role,
        attempt,
        error: lastError.message
      })
      if (attempt === MAX_JSON_ATTEMPTS) {
        throw lastError
      }
      prompt = buildRetryPrompt(options.basePrompt, lastError.message)
    }
  }

  throw lastError ?? new Error('Structured agent call failed')
}

export function buildRetryPrompt(basePrompt: string, errorMessage: string): string {
  return `${basePrompt}

IMPORTANT: Your previous response was invalid JSON (${errorMessage}). Respond again with STRICT JSON only, without code fences or commentary.`
}

export function parseJsonPayload(_role: string, parserName: string) {
  const schema = requireWorkflowParserSchema(parserName)
  return (role: string, res: string): unknown => {
    const jsonText = extractJson(res)
    let payload: unknown
    try {
      payload = JSON.parse(jsonText)
    } catch (error) {
      throw new Error(`${role} returned invalid JSON: ${error}`)
    }
    try {
      return schema.parse(payload)
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      throw new Error(`[${role}] parser '${parserName}' validation failed: ${details}`)
    }
  }
}

export function extractJson(raw: string): string {
  const match = raw.match(/```json\s*([\s\S]*?)```/i)
  if (match && match[1]) {
    return match[1].trim()
  }
  return raw.trim()
}

export function coerceString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}
