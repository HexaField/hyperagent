import {
  appendLogEntry,
  loadSessionMeta,
  outClean,
  runCLI
} from '../../llm.shared'
import type { ProviderAdapter, ProviderInvocationContext } from '..'
import { registerProvider } from '../registry'

async function invokeGoose(ctx: ProviderInvocationContext): Promise<string> {
  const combined = ctx.combinedPrompt || `${ctx.systemPrompt}\n${ctx.userPrompt}`
  const args = ['run', '--text', combined, '--no-session']
  if (ctx.sessionId) args.push('--session-id', ctx.sessionId)
  let emitted = false
  const out = await runCLI('goose', args, '', ctx.sessionDir, {
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
  id: 'goose',
  label: 'Goose CLI',
  invoke: invokeGoose
}

registerProvider(adapter)

export default adapter
