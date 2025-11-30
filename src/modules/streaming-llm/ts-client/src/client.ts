export type ChatOptions = {
  temperature?: number
  maxNewTokens?: number
}

export type ChatEvent =
  | { type: 'token'; token: string; conversationId?: string }
  | { type: 'done'; conversationId?: string }
  | { type: 'error'; message: string; conversationId?: string }

export type StreamChatParams = {
  backendUrl: string
  agentId: string
  conversationId?: string
  options?: ChatOptions
  onEvent: (event: ChatEvent) => void
  socketFactory?: (url: string) => WebSocket
}

export type SendMessageParams = {
  message: string
  conversationId?: string
  agentId?: string
  options?: ChatOptions
}

export type StreamChatHandle = {
  sendMessage: (params: SendMessageParams) => void
  stop: () => void
}

export interface Agent {
  id: string
  name: string
  system_prompt: string
  markdown_context: string
}

export interface AgentUpdateRequest {
  id: string
  name: string
  system_prompt: string
  markdown_context: string
}

export async function streamChat({
  backendUrl,
  agentId,
  conversationId,
  options,
  onEvent,
  socketFactory
}: StreamChatParams): Promise<StreamChatHandle> {
  const socket = socketFactory ? socketFactory(backendUrl) : defaultSocketFactory(backendUrl)
  let isClosed = false
  const pendingPayloads: string[] = []
  let isSettled = false
  let latestConversationId = conversationId

  const rememberConversationId = (value?: string): void => {
    if (typeof value === 'string' && value.length > 0) {
      latestConversationId = value
    }
  }

  const ensureSendReady = (payload: string): void => {
    if (isClosed) {
      throw new Error('Cannot send message: socket already closed')
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      pendingPayloads.push(payload)
      return
    }

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send message: socket is not open')
    }

    socket.send(payload)
  }

  const flushPending = (): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      return
    }
    while (pendingPayloads.length) {
      const payload = pendingPayloads.shift()
      if (payload) {
        socket.send(payload)
      }
    }
  }

  const sendMessage = ({
    message,
    conversationId: overrideConversationId,
    agentId: overrideAgentId,
    options: overrideOptions
  }: SendMessageParams): void => {
    if (typeof message !== 'string') {
      throw new Error('message is required')
    }

    if (overrideConversationId) {
      rememberConversationId(overrideConversationId)
    }

    const payload = JSON.stringify({
      agent_id: overrideAgentId ?? agentId,
      conversation_id: overrideConversationId ?? latestConversationId,
      user_message: message,
      options: overrideOptions ?? options
    })

    ensureSendReady(payload)
  }

  const stop = (): void => {
    if (!isClosed) {
      pendingPayloads.length = 0
      socket.close()
      isClosed = true
    }
  }

  return await new Promise<StreamChatHandle>((resolve, reject) => {
    const settleResolve = () => {
      if (isSettled) {
        return
      }
      isSettled = true
      resolve({ sendMessage, stop })
    }

    const settleReject = (error: Error) => {
      if (isSettled) {
        return
      }
      isSettled = true
      try {
        socket.close()
      } catch {
        // ignore close errors
      }
      reject(error)
    }

    socket.onopen = () => {
      flushPending()
      settleResolve()
    }

    socket.onmessage = (event: MessageEvent) => {
      try {
        const data = parseJson(event.data)
        const conversation = data.conversation_id ?? data.conversationId
        rememberConversationId(conversation)
        if (data.type === 'token') {
          onEvent({ type: 'token', token: data.token ?? '', conversationId: conversation })
        } else if (data.type === 'done') {
          onEvent({ type: 'done', conversationId: conversation })
        } else if (data.type === 'error') {
          onEvent({ type: 'error', message: data.message ?? 'Unknown error', conversationId: conversation })
        }
      } catch (err) {
        onEvent({ type: 'error', message: (err as Error).message })
      }
    }

    socket.onerror = () => {
      onEvent({ type: 'error', message: 'WebSocket error' })
      if (!isSettled) {
        settleReject(new Error('WebSocket error'))
      }
    }

    socket.onclose = () => {
      pendingPayloads.length = 0
      isClosed = true
      if (!isSettled) {
        settleReject(new Error('WebSocket closed before opening'))
      }
    }
  })
}

export async function listAgents(apiBase = 'http://localhost:8000'): Promise<Agent[]> {
  const res = await fetch(`${apiBase}/agents`)
  await ensureOk(res)
  const payload = await res.json()
  return payload.agents
}

export async function getAgent(agentId: string, apiBase = 'http://localhost:8000'): Promise<Agent> {
  const res = await fetch(`${apiBase}/agents/${agentId}`)
  await ensureOk(res)
  return res.json()
}

export async function updateAgent(agent: AgentUpdateRequest, apiBase = 'http://localhost:8000'): Promise<Agent> {
  const res = await fetch(`${apiBase}/agents/${agent.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: agent.name,
      system_prompt: agent.system_prompt,
      markdown_context: agent.markdown_context
    })
  })
  await ensureOk(res)
  return res.json()
}

export async function deleteAgent(agentId: string, apiBase = 'http://localhost:8000'): Promise<void> {
  const res = await fetch(`${apiBase}/agents/${agentId}`, {
    method: 'DELETE'
  })
  if (res.status === 204) {
    return
  }
  await ensureOk(res)
}

function defaultSocketFactory(url: string): WebSocket {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Global WebSocket is not available. Provide socketFactory when using Node.js.')
  }
  return new WebSocket(url)
}

function parseJson(value: unknown): any {
  if (typeof value === 'string') {
    return JSON.parse(value)
  }
  return value
}

async function ensureOk(res: Response): Promise<void> {
  if (!res.ok) {
    const message = await res.text()
    throw new Error(message || `HTTP ${res.status}`)
  }
}
