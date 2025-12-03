import ollama from 'ollama'
import type { ProviderAdapter, ProviderInvocationContext } from '..'
import {
  appendLogEntry,
  DEFAULT_MODEL_MAX_CTX,
  findLatestLogEntry,
  loadSessionMeta,
  type ChatMessage
} from '../../llm.shared'
import { registerProvider } from '../registry'

const modelSettings: Record<string, { maxContext: number }> = {
  'llama3.2': { maxContext: 128000 },
  'gpt-oss:20b': { maxContext: 32000 },
  'llama3.1:8b': { maxContext: 64000 }
}

const sessionMessages = new Map<string, ChatMessage[]>()

async function invokeOllama(ctx: ProviderInvocationContext): Promise<string> {
  const messages = await buildMessages(ctx)
  const response = await ollama.chat({
    model: ctx.modelId,
    options: {
      num_ctx: modelSettings[ctx.modelId]?.maxContext || DEFAULT_MODEL_MAX_CTX
    },
    stream: true,
    messages
  })

  let fullMessage = ''
  for await (const chunk of response as any) {
    if (chunk.message?.content) {
      const text = chunk.message.content
      fullMessage += text
      if (text) ctx.onChunk?.(text)
    }
  }

  if (ctx.sessionId) {
    const stored = sessionMessages.get(ctx.sessionId) || messages
    stored.push({ role: 'assistant', content: fullMessage })
    sessionMessages.set(ctx.sessionId, stored)
    const meta = loadSessionMeta(ctx.sessionId, ctx.sessionDir)
    appendLogEntry(
      meta,
      {
        provider: ctx.providerId,
        model: ctx.modelId,
        payload: { messages: stored }
      },
      ctx.sessionDir
    )
  }

  return fullMessage
}

async function buildMessages(ctx: ProviderInvocationContext): Promise<ChatMessage[]> {
  if (!ctx.sessionId) {
    return [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: ctx.userPrompt }
    ]
  }
  const meta = loadSessionMeta(ctx.sessionId, ctx.sessionDir)
  const lastLog = findLatestLogEntry(
    meta,
    (entry) => entry.provider === ctx.providerId && Array.isArray(entry.payload?.messages)
  )
  const storedMessages = (lastLog?.payload?.messages as ChatMessage[]) || []
  const cloned = JSON.parse(JSON.stringify(storedMessages)) as ChatMessage[]
  if (cloned.length === 0) cloned.push({ role: 'system', content: ctx.systemPrompt })
  cloned.push({ role: 'user', content: ctx.userPrompt })
  sessionMessages.set(ctx.sessionId, cloned)
  return cloned
}

const adapter: ProviderAdapter = {
  id: 'ollama',
  label: 'Ollama (SDK)',
  invoke: invokeOllama
}

registerProvider(adapter)

export default adapter
