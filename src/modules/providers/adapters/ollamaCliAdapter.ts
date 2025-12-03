import {
  appendLogEntry,
  loadSessionMeta,
  outClean,
  runCLI
} from '../../llm.shared'
import type { ProviderAdapter, ProviderInvocationContext } from '..'
import { registerProvider } from '../registry'

async function invokeOllamaCLI(ctx: ProviderInvocationContext): Promise<string> {
  const combined = ctx.combinedPrompt || `${ctx.systemPrompt}\n${ctx.userPrompt}`
  const args = ['run', ctx.modelId, combined, '--format', 'json']
  let emitted = false
  const out = await runCLI('ollama', args, '', ctx.sessionDir, {
    onStdout: (chunk) => {
      emitted = true
      if (chunk) ctx.onChunk?.(chunk)
    }
  })
  const cleaned = outClean(out)
  if (!emitted && cleaned) ctx.onChunk?.(cleaned)
  if (ctx.sessionId) {
    const meta = loadSessionMeta(ctx.sessionId, ctx.sessionDir)
    appendLogEntry(
      meta,
      {
        provider: ctx.providerId,
        model: ctx.modelId,
        payload: { output: cleaned }
      },
      ctx.sessionDir
    )
  }
  return cleaned
}

const adapter: ProviderAdapter = {
  id: 'ollama-cli',
  label: 'Ollama CLI',
  invoke: invokeOllamaCLI
}

registerProvider(adapter)

export default adapter
