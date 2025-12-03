import type { ProviderAdapter } from '.'

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

export default { registerProvider, getProviderAdapter, listProviders }
