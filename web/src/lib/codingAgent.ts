import { fetchJson } from './http'

export type CodingAgentProviderModel = {
  id: string
  label: string
}

export type CodingAgentProvider = {
  id: string
  label: string
  defaultModelId: string
  models: CodingAgentProviderModel[]
}

type CodingAgentProvidersResponse = {
  providers?: CodingAgentProvider[]
}

export async function fetchCodingAgentProviders(): Promise<CodingAgentProvider[]> {
  try {
    const payload = await fetchJson<CodingAgentProvidersResponse>('/api/coding-agent/providers')
    const providers = Array.isArray(payload?.providers) ? payload.providers : []
    return providers
  } catch (error) {
    console.error('Failed to fetch coding agent providers', error)
    return []
  }
}
