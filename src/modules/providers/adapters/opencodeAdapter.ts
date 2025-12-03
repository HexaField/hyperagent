import type { ProviderAdapter, ProviderInvocationContext } from '..'
import { appendLogEntry, extractOrCreateJSON, loadSessionMeta, outClean, runCLI } from '../../llm.shared'
import { runProviderInvocation, runProviderInvocationStream } from '../../providerRunner'
import { registerProvider } from '../registry'

const normalizePromptArg = (text: string): string => {
  if (!text) return ''
  return text.startsWith('-') ? ` ${text}` : text
}

async function chooseModel(modelId: string, sessionDir?: string): Promise<string> {
  if (modelId.includes('/')) return modelId
  try {
    const modelsRaw = await runCLI('opencode', ['models'], '', sessionDir)
    const lines = modelsRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (!lines.length) return modelId
    const preferredLocal = lines.find((l) => /^opencode\//i.test(l))
    const preferredProvider = lines.find((l) => /github-?copilot|gpt|o3|claude|gemini/i.test(l))
    return preferredLocal || preferredProvider || lines[0] || modelId
  } catch {
    return modelId
  }
}

async function opencodeSessionExists(sessionName: string, sessionDir?: string): Promise<boolean> {
  if (!sessionName) return false
  const probes: string[][] = [
    ['session', 'list', '--format', 'json'],
    ['session', 'list']
  ]
  for (const probe of probes) {
    try {
      const raw = await runCLI('opencode', probe, '', sessionDir)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : Array.isArray(parsed) ? parsed : []
        if (
          Array.isArray(sessions) &&
          sessions.some((entry) => {
            if (!entry) return false
            if (typeof entry === 'string') return entry.trim() === sessionName
            if (typeof entry === 'object') {
              return entry.name === sessionName || entry.session === sessionName || entry.id === sessionName
            }
            return false
          })
        ) {
          return true
        }
      } catch {}
      if (raw.includes(sessionName)) return true
    } catch {}
  }
  return false
}

function stripSessionArgs(args: string[], sessionId: string): string[] {
  const nextArgs = [] as string[]
  for (let i = 0; i < args.length; i++) {
    const current = args[i]
    if (current === '--session') {
      i += 1
      continue
    }
    if (current === sessionId) {
      continue
    }
    nextArgs.push(current)
  }
  return nextArgs
}

async function invokeOpencode(ctx: ProviderInvocationContext): Promise<string> {
  const combined = ctx.combinedPrompt || `${ctx.systemPrompt}\n${ctx.userPrompt}`
  const resolvedModel = await chooseModel(ctx.modelId, ctx.sessionDir)
  const invocation = adapter.buildInvocation
    ? adapter.buildInvocation({
        sessionId: ctx.sessionId ?? '',
        modelId: resolvedModel,
        text: combined,
        workspacePath: ctx.sessionDir ?? ctx.workspacePath
      })
    : {
        cliArgs: ['run', normalizePromptArg(combined), '--format', 'json', '--model', resolvedModel],
        command: 'opencode'
      }
  const baseArgs = [...(invocation.cliArgs ?? [])]
  let cliArgs = baseArgs
  if (ctx.sessionId) {
    const usable = await opencodeSessionExists(ctx.sessionId, ctx.sessionDir)
    if (!usable) {
      console.warn(`Opencode session "${ctx.sessionId}" not found or unavailable; continuing without --session flag.`)
      cliArgs = stripSessionArgs(baseArgs, ctx.sessionId)
    }
  }
  const command = invocation.command || 'opencode'
  let emitted = false
  const runnerWrapper = async (args: string[], _options?: any) => {
    void _options
    const out = await runCLI(command, args, '', ctx.sessionDir, {
      onStdout: (chunk) => {
        emitted = true
        if (chunk) ctx.onChunk?.(chunk)
      }
    })
    return { stdout: out, stderr: '' }
  }
  const invocationPayload = { ...invocation, cliArgs }
  let res = ''
  if (ctx.onChunk) {
    let accumulated = ''
    try {
      for await (const chunk of runProviderInvocationStream(invocationPayload, {
        cwd: ctx.sessionDir,
        opencodeCommandRunner: runnerWrapper,
        signal: ctx.signal
      })) {
        accumulated += chunk
        if (chunk) {
          emitted = true
          ctx.onChunk?.(chunk)
        }
      }
    } catch {
      const fallback = await runProviderInvocation(invocationPayload, {
        cwd: ctx.sessionDir,
        opencodeCommandRunner: runnerWrapper
      })
      accumulated = (fallback && fallback.stdout) || (fallback && fallback.responseText) || accumulated
    }
    res = accumulated
  } else {
    const result = await runProviderInvocation(invocationPayload, {
      cwd: ctx.sessionDir,
      opencodeCommandRunner: runnerWrapper
    })
    res = (result && result.stdout) || (result && result.responseText) || ''
  }

  const finalRes = res
    .split('\n')
    .map(extractOrCreateJSON)
    .reverse()
    .find((obj) => (obj && typeof obj === 'object' && obj.type === 'text' && obj.part) || obj.text)

  let text = finalRes?.part?.text ?? finalRes?.text?.text ?? ''
  if (!text) {
    try {
      const maybe = extractOrCreateJSON(res)
      if (maybe && typeof maybe === 'object') {
        text = JSON.stringify(maybe)
      }
    } catch {}
  }
  const cleaned = text || outClean(res)
  if (!emitted && cleaned) ctx.onChunk?.(cleaned)
  if (ctx.sessionId) {
    const meta = loadSessionMeta(ctx.sessionId, ctx.sessionDir)
    appendLogEntry(
      meta,
      {
        provider: ctx.providerId,
        model: resolvedModel,
        payload: { output: cleaned }
      },
      ctx.sessionDir
    )
  }
  return cleaned
}

const adapter: ProviderAdapter = {
  id: 'opencode',
  label: 'Opencode CLI',
  validateModel: () => true,
  buildInvocation: ({ sessionId, modelId, text }) => {
    const cliArgs = ['run', normalizePromptArg(text), '--format', 'json', '--model', modelId]
    const trimmedSession = sessionId.trim()
    if (trimmedSession.length) {
      cliArgs.push('--session', trimmedSession)
    }
    return { cliArgs, command: 'opencode' }
  },
  invoke: invokeOpencode
}

registerProvider(adapter)

export default adapter
