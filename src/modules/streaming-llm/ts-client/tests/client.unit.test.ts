import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listAgents, streamChat, type ChatEvent } from '../src'

const WS_URL = 'ws://test.local/socket'
const HTTP_BASE = 'http://test.local'

describe('streaming-llm TypeScript client – unit specs', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ;(globalThis as any).WebSocket = MockWebSocket
  })

  it('only resolves streamChat after the socket opens', async () => {
    const socket = new MockWebSocket(WS_URL)
    const handlePromise = streamChat({
      backendUrl: WS_URL,
      agentId: 'planner',
      onEvent: () => {},
      socketFactory: () => socket.asWebSocket()
    })

    let resolved = false
    void handlePromise.then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    socket.triggerOpen()
    const handle = await handlePromise
    expect(resolved).toBe(true)

    handle.sendMessage({ message: 'hello world' })
    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0]).user_message).toBe('hello world')
  })

  it('normalizes token/done events regardless of conversation id casing', async () => {
    const socket = new MockWebSocket(WS_URL)
    const events: ChatEvent[] = []
    const handlePromise = streamChat({
      backendUrl: WS_URL,
      agentId: 'planner',
      onEvent: (event) => events.push(event),
      socketFactory: () => socket.asWebSocket()
    })

    socket.triggerOpen()
    await handlePromise

    socket.triggerMessage({ type: 'token', token: 'Hi', conversation_id: 'abc' })
    socket.triggerMessage({ type: 'done', conversationId: 'abc' })

    expect(events).toEqual([
      { type: 'token', token: 'Hi', conversationId: 'abc' },
      { type: 'done', conversationId: 'abc' }
    ])
  })

  it('propagates HTTP errors from REST helpers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom'
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(listAgents(HTTP_BASE)).rejects.toThrow('boom')
    expect(fetchMock).toHaveBeenCalledWith(`${HTTP_BASE}/agents`)
  })
})

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  public readyState = MockWebSocket.CONNECTING
  public sentPayloads: string[] = []
  public onopen: (() => void) | null = null
  public onmessage: ((event: MessageEvent) => void) | null = null
  public onerror: ((event: Event) => void) | null = null
  public onclose: ((event: CloseEvent) => void) | null = null

  constructor(public readonly url: string) {}

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket
  }

  send(payload: string) {
    this.sentPayloads.push(payload)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  triggerMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  triggerError(message = 'error') {
    this.onerror?.({ type: message } as Event)
  }
}
