import type { ConversationMessage, SessionDetail } from './types'

export type ProviderAdapter = {
  id: string
  label: string
  /**
   * Optional validator to check whether a given modelId is supported by the provider.
   */
  validateModel?: (modelId: string) => Promise<boolean> | boolean
  /**
   * Build command-line args or other invocation payload for this provider given
   * a session id, resolved model id, text input and workspace path. Return
   * either `cliArgs` (string[]) for CLI-based providers or `payload` for
   * HTTP/SDK providers. At least one must be provided.
   */
  buildInvocation?: (opts: {
    sessionId: string
    modelId: string
    text: string
    workspacePath?: string
    messages?: ConversationMessage[]
    session?: SessionDetail | null
  }) => { cliArgs?: string[]; payload?: unknown }
}

const registry = new Map<string, ProviderAdapter>()

export function registerProvider(adapter: ProviderAdapter) {
  if (!adapter || !adapter.id) throw new Error('Invalid provider adapter')
  registry.set(adapter.id, adapter)
}

export function getProviderAdapter(providerId: string): ProviderAdapter | null {
  if (!providerId) return null
  return registry.get(providerId) ?? null
}

export function listProviders(): ProviderAdapter[] {
  return Array.from(registry.values())
}

// Default provider adapter for the existing opencode CLI-style provider.
// Keeps behaviour identical to the previous code path.
registerProvider({
  id: 'opencode',
  label: 'Opencode CLI',
  validateModel: () => true,
  buildInvocation: ({ sessionId, modelId, text }) => ({
    cliArgs: ['run', '--session', sessionId, '--format', 'json', '--model', modelId, '--', text]
  })
})

export default { registerProvider, getProviderAdapter, listProviders }
