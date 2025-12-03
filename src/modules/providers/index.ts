import './adapters/gooseAdapter'
import './adapters/ollamaAdapter'
import './adapters/ollamaCliAdapter'
import './adapters/opencodeAdapter'
import type { ConversationMessage, SessionDetail } from './types'
export { getProviderAdapter, listProviders, registerProvider } from './registry'

export type ProviderInvocationContext = {
  providerId: string
  systemPrompt: string
  userPrompt: string
  combinedPrompt: string
  modelId: string
  sessionId?: string
  sessionDir?: string
  workspacePath?: string
  messages?: ConversationMessage[]
  session?: SessionDetail | null
  signal?: AbortSignal
  onChunk?: (chunk: string) => void
}

export type ProviderAdapter = {
  id: string
  label: string
  /**
   * Optional validator to check whether a given modelId is supported by the provider.
   */
  validateModel?: (modelId: string) => Promise<boolean> | boolean
  /**
   * If provided, handle the invocation completely inside the adapter (HTTP/SDK/etc).
   */
  invoke?: (ctx: ProviderInvocationContext) => Promise<string>
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
  }) => { cliArgs?: string[]; payload?: unknown; command?: string }
}
