import type { FileDiff, Part, Session } from '@opencode-ai/sdk'
import { z } from 'zod'
import { extractResponseText, getMessageDiff, promptSession } from './opencode'
import { appendLogEntry } from './provenance'

const MAX_JSON_ATTEMPTS = 3

export type AgentRunResponse<T = unknown> = {
  runId: string
  result: Promise<T>
}

export type AgentStreamEvent = {
  step: string
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
  step: string
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
        step: options.step,
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

export function parseJsonPayload(role: string, parserName: string, schema: z.ZodTypeAny) {
  return (res: string): unknown => {
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
