import { fetchJson } from './http'

export type TerminalSession = {
  id: string
  userId: string
  projectId: string | null
  shellCommand: string
  initialCwd: string | null
  status: 'active' | 'closed' | 'error'
  createdAt: string
  closedAt: string | null
}

export type CreateTerminalSessionInput = {
  cwd?: string
  shell?: string
  projectId?: string | null
}

export async function listTerminalSessions(): Promise<TerminalSession[]> {
  const payload = await fetchJson<{ sessions: TerminalSession[] }>('/api/terminal/sessions')
  return payload.sessions
}

export async function createTerminalSession(input: CreateTerminalSessionInput = {}): Promise<TerminalSession> {
  const payload = await fetchJson<{ session: TerminalSession }>('/api/terminal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  return payload.session
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'Failed to close terminal session')
  }
}

export function createTerminalWebSocket(sessionId: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${protocol}://${window.location.host}/ws/terminal/${sessionId}`
  return new WebSocket(url)
}
