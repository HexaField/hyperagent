import { Part, Session } from '@opencode-ai/sdk'
import { appendLogEntry } from '../provenance/provenance'
import { extractResponseText, promptSession } from './opencode'

const MAX_JSON_ATTEMPTS = 3

export type AgentStreamEvent = {
  role: string
  round: number
  parts: Part[]
  model: string
  attempt: number
  sessionId?: string
}

export type AgentStreamCallback = (event: AgentStreamEvent) => void

export async function invokeStructuredJsonCall<T>(options: {
  role: string
  systemPrompt: string
  basePrompt: string
  model: string
  session: Session
  runId: string
  directory: string
  onStream?: AgentStreamCallback
  parseResponse: (res: string) => T
}): Promise<{ raw: string; parsed: T }> {
  let prompt = options.basePrompt
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const response = await promptSession(options.session, [options.systemPrompt, prompt], options.model)
    const raw = extractResponseText(response.parts)

    appendLogEntry(
      options.runId,
      {
        model: options.model,
        role: options.role,
        payload: {
          attempt,
          prompt,
          rawResponse: raw
        }
      },
      options.directory
    )

    try {
      const parsed = options.parseResponse(raw)

      options.onStream?.({
        role: options.role,
        round: attempt,
        parts: response.parts,
        model: options.model,
        attempt: 1,
        sessionId: options.session.id
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

export function parseJsonPayload(role: string, res: string): any {
  const jsonText = extractJson(res)
  try {
    return JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error}`)
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
