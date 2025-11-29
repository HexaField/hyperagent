import type { CodeServerSessionListResponse, CodeServerSessionRecord } from '../../../src/interfaces/core/codeServer'
import { fetchJson } from '../shared/api/httpClient'

export type { CodeServerSessionRecord as CodeServerSession } from '../../../src/interfaces/core/codeServer'

export async function listCodeServerSessions(): Promise<CodeServerSessionRecord[]> {
  const payload = await fetchJson<CodeServerSessionListResponse>('/api/code-server/sessions')
  return payload.sessions
}
