import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js'

export type AgentLogEntry = {
  role: 'worker' | 'verifier'
  round: number
  text: string
  provider?: string
  attempt?: number
  sessionId?: string
}

export type AgentResult = {
  outcome: string
  reason: string
  rounds: Array<{
    worker: { parsed: { plan: string; work: string } }
    verifier: { parsed: { critique: string; instructions: string } }
  }>
}

type StreamPacket = {
  type: 'session' | 'chunk' | 'result' | 'error' | 'end'
  payload?: any
}

type AgentChunkPayload = {
  role: 'worker' | 'verifier'
  round: number
  chunk: string
  provider: string
  model: string
  attempt: number
  sessionId?: string
}

const DEFAULT_PROMPT = `Draft a quick project overview for a habit-tracking app.`

export default function Agent() {
  const [prompt, setPrompt] = createSignal(DEFAULT_PROMPT)
  const [isRunning, setIsRunning] = createSignal(false)
  const [logs, setLogs] = createSignal<AgentLogEntry[]>([])
  const [sessionDir, setSessionDir] = createSignal<string | null>(null)
  const [result, setResult] = createSignal<AgentResult | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [codeServerUrl, setCodeServerUrl] = createSignal<string | null>(null)

  let abortController: AbortController | null = null

  const orderedLogs = createMemo(() =>
    [...logs()].sort((a, b) => {
      if (a.round === b.round) {
        return a.role === b.role ? 0 : a.role === 'worker' ? -1 : 1
      }
      return a.round - b.round
    })
  )

  onCleanup(() => {
    abortController?.abort()
  })

  const startRun = async () => {
    if (isRunning()) return
    const trimmed = prompt().trim()
    if (!trimmed) {
      setError('Enter a prompt to start the autonomous agent.')
      return
    }

    abortController?.abort()
    const controller = new AbortController()
    abortController = controller
    setIsRunning(true)
    setLogs([])
    setResult(null)
    setError(null)
    setSessionDir(null)
    setCodeServerUrl(null)

    try {
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt: trimmed }),
        signal: controller.signal
      })

      if (!response.ok || !response.body) {
        throw new Error('Agent server did not return a stream.')
      }

      await streamAgentResponse(response.body)
    } catch (err) {
      if ((err as any)?.name === 'AbortError') return
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
    } finally {
      setIsRunning(false)
      abortController = null
    }
  }

  const streamAgentResponse = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 2)
        processFrame(chunk)
        boundary = buffer.indexOf('\n\n')
      }
    }

    const remaining = buffer.replace(/\r\n/g, '\n').trim()
    if (remaining.length) {
      processFrame(remaining)
    }
  }

  const processFrame = (frame: string) => {
    if (!frame) return
    const payloadLine = frame.startsWith('data:') ? frame.slice(frame.indexOf('data:') + 5).trim() : frame
    if (!payloadLine) return
    try {
      const data = JSON.parse(payloadLine) as StreamPacket
      handleServerPacket(data)
    } catch (err) {
      console.warn('Failed to parse stream frame', frame, err)
    }
  }

  const handleServerPacket = (packet: StreamPacket) => {
    switch (packet.type) {
      case 'session': {
        const payload = packet.payload ?? {}
        setSessionDir(payload.sessionDir ?? null)
        setCodeServerUrl(payload.codeServerUrl ?? null)
        break
      }
      case 'chunk':
        updateLog(packet.payload as AgentChunkPayload)
        break
      case 'result':
        setResult(packet.payload ?? null)
        break
      case 'error':
        setError(packet.payload?.message ?? 'Agent server error')
        break
      case 'end':
        setCodeServerUrl(null)
        break
      default:
        break
    }
  }

  const updateLog = (payload?: AgentChunkPayload) => {
    if (!payload?.chunk) return
    setLogs((current) => {
      const next = [...current]
      const existingIndex = next.findIndex((entry) => entry.role === payload.role && entry.round === payload.round)
      if (existingIndex >= 0) {
        next[existingIndex] = {
          ...next[existingIndex],
          text: next[existingIndex].text + payload.chunk,
          provider: payload.provider,
          attempt: payload.attempt,
          sessionId: payload.sessionId
        }
      } else {
        next.push({
          role: payload.role,
          round: payload.round,
          text: payload.chunk,
          provider: payload.provider,
          attempt: payload.attempt,
          sessionId: payload.sessionId
        })
      }
      return next
    })
  }

  const stopRun = () => {
    abortController?.abort()
    abortController = null
    setIsRunning(false)
    setCodeServerUrl(null)
    setSessionDir(null)
  }

  return (
    <section class="flex flex-col gap-6 rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-[0_18px_30px_rgba(15,23,42,0.08)]">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="space-y-2">
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Autonomous coding agent</p>
          <h2 class="text-2xl font-semibold text-[var(--text)]">Live autonomous agent</h2>
          <p class="text-[var(--text-muted)]">
            Stream the agent's reasoning and inspect the repo inside the embedded code-server.
          </p>
        </div>
        <div class="flex items-center gap-3">
          <button
            class="rounded-xl bg-[#0f172a] px-6 py-2.5 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            onClick={startRun}
            disabled={isRunning()}
          >
            {isRunning() ? 'Running…' : 'Run agent'}
          </button>
          <Show when={isRunning()}>
            <button
              class="rounded-xl border border-[var(--border)] px-5 py-2.5 font-semibold text-[var(--text)]"
              type="button"
              onClick={stopRun}
            >
              Stop
            </button>
          </Show>
        </div>
      </div>

      <div class="grid gap-6 md:grid-cols-2">
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-2">
            <label class="text-sm font-semibold text-[var(--text-muted)]" for="agent-prompt">
              User prompt
            </label>
            <textarea
              id="agent-prompt"
              class="min-h-[120px] rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={4}
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
              placeholder="Describe the task you want the agent to tackle"
            />
          </div>

          <div class="flex flex-col gap-2 text-sm text-[var(--text)]">
            <Show when={error()}>
              <p class="font-semibold text-red-600">{error()}</p>
            </Show>
            <Show when={result()}>
              {(run) => (
                <p>
                  Outcome: <strong>{run().outcome}</strong> — {run().reason}
                </p>
              )}
            </Show>
          </div>

          <div class="flex h-[420px] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
            <For each={orderedLogs()}>
              {(entry) => (
                <article
                  class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm shadow-[0_6px_20px_rgba(15,23,42,0.08)]"
                  classList={{
                    'border-l-4 border-l-blue-600': entry.role === 'worker',
                    'border-l-4 border-l-amber-600': entry.role === 'verifier'
                  }}
                >
                  <header class="mb-2 flex justify-between text-xs text-[var(--text-muted)]">
                    <span class="font-semibold uppercase tracking-wide">
                      {entry.role} · round {entry.round}
                    </span>
                    <span class="italic">
                      {entry.provider || 'unknown'} · attempt {entry.attempt ?? 0}
                    </span>
                  </header>
                  <p class="text-[var(--text)]">{entry.text}</p>
                </article>
              )}
            </For>
            <Show when={!orderedLogs().length && !isRunning()}>
              <div class="flex flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-center text-sm text-[var(--text-muted)]">
                Run the agent to see its live reasoning stream.
              </div>
            </Show>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex flex-col gap-1">
              <p class="text-sm font-semibold text-[var(--text-muted)]">Workspace editor</p>
              <Show
                when={sessionDir()}
                fallback={<p class="text-xs text-[var(--text-muted)]">Run the agent to allocate a workspace folder.</p>}
              >
                {(dir) => (
                  <code
                    class="max-w-full truncate rounded bg-[var(--bg-muted)] px-2 py-1 text-xs text-[var(--text)]"
                    title={dir()}
                  >
                    {dir()}
                  </code>
                )}
              </Show>
            </div>
            <Show when={isRunning() && !codeServerUrl()}>
              <p class="text-xs text-[var(--text-muted)]">Launching code-server…</p>
            </Show>
          </div>
          <Show
            when={codeServerUrl()}
            fallback={
              <div class="flex flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">
                {isRunning()
                  ? 'code-server is starting in the agent workspace…'
                  : 'Run the agent to launch code-server inside its workspace.'}
              </div>
            }
          >
            {(url) => (
              <iframe
                src={url()}
                class="min-h-[360px] w-full flex-1 rounded-2xl border border-[var(--border)] bg-[#0f172a]"
                title="Embedded code-server"
                allow="clipboard-write"
              />
            )}
          </Show>
        </div>
      </div>
    </section>
  )
}
