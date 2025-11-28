export * from '../opencodeRunner'
export * from '../opencodeStorage'

export type { OpencodeRunRecord as CodingAgentRunRecord, OpencodeRunner as CodingAgentRunner } from '../opencodeRunner'
export type {
  OpencodeMessage as CodingAgentMessage,
  OpencodeSessionDetail as CodingAgentSessionDetail,
  OpencodeSessionSummary as CodingAgentSessionSummary,
  OpencodeStorage as CodingAgentStorage
} from '../opencodeStorage'

// Provider-agnostic facade exports. These re-export the opencode-specific
// implementations for backward compatibility while providing a single import
// surface for provider-based code.
export {
  DEFAULT_OPENCODE_MODEL as DEFAULT_CODING_AGENT_MODEL,
  DEFAULT_OPENCODE_PROVIDER as DEFAULT_CODING_AGENT_PROVIDER,
  DEFAULT_OPENCODE_PROVIDER as DEFAULT_PROVIDER_ID,
  DEFAULT_OPENCODE_MODEL as DEFAULT_PROVIDER_MODEL,
  createOpencodeRunner as createCodingAgentRunner,
  createOpencodeRunner as createProviderRunner
} from '../opencodeRunner'
export {
  createOpencodeStorage as createCodingAgentStorage,
  createOpencodeStorage as createProviderStorage
} from '../opencodeStorage'

// No default export — consumers should import named exports from this facade.
