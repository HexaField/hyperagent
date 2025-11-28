import type { Provider } from '../../../src/modules/llm'
import { DEFAULT_CODING_AGENT_PROVIDER } from '../../../src/modules/provider'

export const DEFAULT_PORT = Number(process.env.UI_SERVER_PORT || 5556)
export const CODE_SERVER_HOST = process.env.CODE_SERVER_HOST || '127.0.0.1'
export const GRAPH_BRANCH_LIMIT = Math.max(Number(process.env.REPO_GRAPH_BRANCH_LIMIT ?? 6) || 6, 1)
export const GRAPH_COMMITS_PER_BRANCH = Math.max(Number(process.env.REPO_GRAPH_COMMITS_PER_BRANCH ?? 25) || 25, 1)
export const WORKFLOW_AGENT_PROVIDER =
  normalizeWorkflowProvider(process.env.WORKFLOW_AGENT_PROVIDER) ?? ('opencode' as Provider)
export const WORKFLOW_AGENT_MODEL = process.env.WORKFLOW_AGENT_MODEL ?? 'github-copilot/gpt-5-mini'
export const WORKFLOW_AGENT_MAX_ROUNDS = parsePositiveInteger(process.env.WORKFLOW_AGENT_MAX_ROUNDS)
export const CODING_AGENT_PROVIDER_ID = DEFAULT_CODING_AGENT_PROVIDER
export const FALLBACK_CODING_AGENT_MODEL_IDS = ['github-copilot/gpt-5-mini', 'github-copilot/gpt-4o', 'openai/gpt-4o-mini']
export const KNOWN_CODING_AGENT_MODEL_LABELS: Record<string, string> = {
  'github-copilot/gpt-5-mini': 'GitHub Copilot · GPT-5 Mini',
  'github-copilot/gpt-4o': 'GitHub Copilot · GPT-4o',
  'openai/gpt-4o-mini': 'OpenAI · GPT-4o Mini'
}

export function normalizeWorkflowProvider(raw?: string | null): Provider | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  const allowed: Provider[] = ['ollama', 'opencode', 'goose', 'ollama-cli']
  return allowed.find((entry) => entry === normalized) as Provider | undefined
}

export function parsePositiveInteger(raw?: string | null): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  const rounded = Math.floor(parsed)
  return rounded > 0 ? rounded : undefined
}

export function normalizePublicOrigin(raw?: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

export function buildExternalUrl(pathOrUrl: string | null, origin: string | null): string | null {
  if (!pathOrUrl) return null
  if (!origin) return pathOrUrl
  try {
    const url = new URL(pathOrUrl, origin)
    return url.toString()
  } catch {
    return pathOrUrl
  }
}

export function mergeFrameAncestorsDirective(policy: string | string[] | undefined, ancestor: string): string {
  const normalized = Array.isArray(policy) ? policy.join('; ') : policy ?? ''
  const directives = normalized
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length && !entry.toLowerCase().startsWith('frame-ancestors'))
  directives.push(`frame-ancestors 'self' ${ancestor}`)
  return directives.join('; ')
}
