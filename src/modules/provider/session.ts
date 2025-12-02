import { spawnSync } from 'child_process'

export function createProviderSession(sessionId: string, sessionDir: string, providerId?: string): void {
  const provider = providerId ?? 'opencode'
  if (provider === 'opencode') {
    spawnSync('opencode', ['session', 'create', sessionId], { cwd: sessionDir })
    return
  }
  throw new Error(`createProviderSession: unsupported provider ${provider}`)
}

export default { createProviderSession }
