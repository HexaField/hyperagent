import axios from 'axios'
import { DEFAULT_MODEL_MAX_CTX, extractOrCreateJSON, loadSessionMeta, runCLI } from './llm.shared'
import { runProviderInvocation, runProviderInvocationStream } from './providerRunner'
import { getProviderAdapter, type ProviderAdapter, type ProviderInvocationContext } from './providers'

const MODEL_MAX_CTX = DEFAULT_MODEL_MAX_CTX

export type LLMResponse = {
  success: boolean
  data?: string
  error?: string
}

export type Provider = 'ollama' | 'opencode' | 'goose' | 'ollama-cli'

export type LLMStreamEvent = {
  chunk: string
  provider: Provider
  model: string
  attempt: number
  sessionId?: string
}

export type LLMStreamCallback = (event: LLMStreamEvent) => void

export type CallLLMOptions = {
  retries?: number
  sessionId?: string
  sessionDir?: string
  onStream?: LLMStreamCallback
  signal?: AbortSignal
}

function wrapAsJSONCodeFence(obj: any): string {
  const pretty = JSON.stringify(obj, null, 2)
  // Avoid template literal containing backticks to prevent parser confusion; build with concatenation.
  return '\n\n```json\n' + pretty + '\n```\n'
}

/**
 * callLLM - unified LLM caller with simple provider adapters and retries.
 * - provider: 'ollama' | 'opencode' | 'goose'
 * - emits incremental chunks through `onStream` when provided
 * - ensures the returned `data` contains a JSON code-fence so callers can reliably parse it.
 */
export async function callLLM(
  systemPrompt: string,
  userQuery: string,
  provider: Provider = 'ollama',
  model = 'llama3.2',
  optionsOrRetries?: number | CallLLMOptions
): Promise<LLMResponse> {
  let retries = 2
  let sessionId: string | undefined = undefined
  let sessionDir: string | undefined = undefined
  let onStream: LLMStreamCallback | undefined = undefined
  let signal: AbortSignal | undefined = undefined
  if (typeof optionsOrRetries === 'number') {
    retries = optionsOrRetries
  } else if (typeof optionsOrRetries === 'object' && optionsOrRetries) {
    if (typeof optionsOrRetries.retries === 'number') retries = optionsOrRetries.retries
    if (typeof optionsOrRetries.sessionId === 'string') sessionId = optionsOrRetries.sessionId
    if (typeof optionsOrRetries.sessionDir === 'string') sessionDir = optionsOrRetries.sessionDir
    if (typeof optionsOrRetries.onStream === 'function') onStream = optionsOrRetries.onStream
    if (optionsOrRetries.signal) signal = optionsOrRetries.signal
  }
  // Ensure session meta exists when sessionId provided
  if (sessionId) {
    loadSessionMeta(sessionId, sessionDir)
  }
  const tokenCount = (systemPrompt.length + userQuery.length) / 4 // rough estimate

  console.log('LLM token count', tokenCount)
  if (tokenCount > 0 && tokenCount > MODEL_MAX_CTX) {
    console.warn(
      `LLM prompt token count (${tokenCount}) exceeds model max context (${MODEL_MAX_CTX}). Prompt may be truncated or rejected.`
    )
  }

  let lastErr: any = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const emitChunk = onStream
      ? (chunk: string) => {
          if (!chunk) return
          onStream({
            chunk,
            provider,
            model: String(model),
            attempt,
            sessionId
          })
        }
      : undefined
    try {
      const adapter = getProviderAdapter(provider)
      if (!adapter) {
        throw new Error(`Unsupported LLM provider: ${provider}`)
      }
      const providerCtx: ProviderInvocationContext = {
        providerId: provider,
        systemPrompt,
        userPrompt: userQuery,
        combinedPrompt: `${systemPrompt}\n${userQuery}`,
        modelId: String(model),
        sessionId,
        sessionDir,
        signal,
        onChunk: emitChunk
      }
      const raw = await executeAdapter(adapter, providerCtx)

      console.log('LLM', provider, model, 'raw response', raw)

      const parsed = extractOrCreateJSON(raw)
      const fenced = wrapAsJSONCodeFence(parsed)

      return { success: true, data: fenced }
    } catch (err) {
      lastErr = err
      console.log(`LLM attempt ${attempt} failed`, err)
      if (attempt < retries) {
        // small backoff
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        continue
      }
    }
  }

  return { success: false, error: String(lastErr) }
}

async function executeAdapter(adapter: ProviderAdapter, ctx: ProviderInvocationContext): Promise<string> {
  if (adapter.invoke) {
    return adapter.invoke(ctx)
  }
  if (!adapter.buildInvocation) {
    throw new Error(`Provider ${adapter.id} does not implement invoke or buildInvocation`)
  }
  const invocation = adapter.buildInvocation({
    sessionId: ctx.sessionId ?? '',
    modelId: ctx.modelId,
    text: ctx.combinedPrompt,
    workspacePath: ctx.sessionDir ?? ctx.workspacePath,
    messages: ctx.messages,
    session: ctx.session
  })
  const command = invocation.command || 'opencode'
  const runnerWrapper = async (args: string[], _options?: any) => {
    void _options
    const out = await runCLI(command, args, '', ctx.sessionDir, {
      onStdout: (chunk) => {
        if (chunk) ctx.onChunk?.(chunk)
      }
    })
    return { stdout: out, stderr: '' }
  }
  if (ctx.onChunk) {
    let acc = ''
    try {
      for await (const chunk of runProviderInvocationStream(invocation, {
        cwd: ctx.sessionDir,
        opencodeCommandRunner: runnerWrapper,
        signal: ctx.signal
      })) {
        acc += chunk
        if (chunk) ctx.onChunk?.(chunk)
      }
    } catch {
      const invocationResult = await runProviderInvocation(invocation, {
        cwd: ctx.sessionDir,
        opencodeCommandRunner: runnerWrapper
      })
      acc = invocationResult?.stdout || invocationResult?.responseText || acc
    }
    return acc
  }
  const invocationResult = await runProviderInvocation(invocation, {
    cwd: ctx.sessionDir,
    opencodeCommandRunner: runnerWrapper
  })
  return invocationResult?.stdout || invocationResult?.responseText || ''
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

// getEmbedding now uses Ollama exclusively - no fallbacks
export async function getEmbedding(text: string, model?: string) {
  const clean = text.replace(/\n/g, ' ')
  const embedModel = model || process.env.OLLAMA_EMBEDDING_MODEL || 'bge-m3:latest'
  const payload = { model: embedModel, input: clean }

  try {
    const resp = await axios.post(`${OLLAMA_URL}/api/embed`, payload, { timeout: 120_000 })
    const data = resp.data

    // Ollama /api/embed response format: { "embeddings": [[...]] }
    if (data && Array.isArray(data.embeddings)) {
      if (data.embeddings[0] && Array.isArray(data.embeddings[0])) {
        return data.embeddings[0]
      } else {
        throw new Error(`No embeddings were returned for text ${text}.`)
      }
    }

    // No fallbacks - fail immediately if embeddings not available
    throw new Error(
      `Embeddings API returned unexpected format for model ${embedModel}. Response: ${JSON.stringify(data)}. Ensure Ollama is running at ${OLLAMA_URL} and the model supports embeddings.`
    )
  } catch (error: any) {
    if (error.response) {
      throw new Error(
        `Ollama embeddings API error (${error.response.status}): ${JSON.stringify(error.response.data)}. Ensure model ${embedModel} is installed (run: ollama pull ${embedModel}) and Ollama is running at ${OLLAMA_URL}.`
      )
    }
    throw error
  }
}
