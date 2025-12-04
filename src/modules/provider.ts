// Minimal compatibility types and constants for the legacy provider module
// These are lightweight stand-ins to satisfy TypeScript imports across the repo.

export type OpencodeRunner = any
export type CodingAgentRunner = any
export type CodingAgentStorage = any
export type CodingAgentCommandRunner = any
export type CodingAgentCommandOptions = { cwd?: string }
export type CodingAgentCommandResult = { stdout: string; stderr: string }

export const DEFAULT_CODING_AGENT_PROVIDER = 'opencode'
export const DEFAULT_CODING_AGENT_MODEL = 'github-copilot/gpt-5-mini'
