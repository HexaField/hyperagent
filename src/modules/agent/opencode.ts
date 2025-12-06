import type { FileDiff, GlobalEvent, OpencodeClient, Part, Session, TextPart } from '@opencode-ai/sdk'

let opencodeServer: {
  url: string
  close(): void
} | null = null
const opencodeClients: { [directory: string]: OpencodeClient } = {}

type SummaryWithDiffs = { title?: string; body?: string; diffs: FileDiff[] }

type SessionMessageEntry = {
  info: {
    id?: string
    summary?: SummaryWithDiffs | boolean
  }
  parts: Part[]
}

type SessionDiffRecord = {
  files: FileDiff[]
  receivedAt: number
}

type DirectoryEventStream = {
  controller: AbortController
  promise: Promise<void>
}

const sessionDiffCache = new Map<string, SessionDiffRecord>()
const sessionDiffWaiters = new Map<string, Array<(files: FileDiff[]) => void>>()
const directoryEventStreams = new Map<string, DirectoryEventStream>()
const SESSION_DIFF_EVENT_TIMEOUT_MS = 1500

const recordSessionDiff = (sessionID: string, files: FileDiff[]) => {
  if (!sessionID || !Array.isArray(files) || files.length === 0) return
  sessionDiffCache.set(sessionID, { files, receivedAt: Date.now() })
  const waiters = sessionDiffWaiters.get(sessionID)
  if (waiters?.length) {
    for (const notify of waiters) {
      try {
        notify(files)
      } catch {}
    }
    sessionDiffWaiters.delete(sessionID)
  }
}

const getCachedSessionDiff = (sessionID: string): FileDiff[] | null => {
  const record = sessionDiffCache.get(sessionID)
  return record?.files ?? null
}

const waitForSessionDiff = (sessionID: string, timeoutMs: number): Promise<FileDiff[] | null> => {
  const cached = getCachedSessionDiff(sessionID)
  if (cached?.length) {
    return Promise.resolve(cached)
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)

    const handler = (files: FileDiff[]) => {
      cleanup()
      resolve(files)
    }

    const cleanup = () => {
      clearTimeout(timer)
      const waiters = sessionDiffWaiters.get(sessionID)
      if (!waiters) return
      const idx = waiters.indexOf(handler)
      if (idx >= 0) {
        waiters.splice(idx, 1)
      }
      if (waiters.length === 0) {
        sessionDiffWaiters.delete(sessionID)
      }
    }

    const waiters = sessionDiffWaiters.get(sessionID) ?? []
    waiters.push(handler)
    sessionDiffWaiters.set(sessionID, waiters)
  })
}

const handleGlobalEvent = (event: GlobalEvent | undefined) => {
  const payload = event?.payload
  if (!payload || typeof payload !== 'object') return

  if (payload.type === 'session.diff') {
    const sessionID = payload.properties?.sessionID
    const diff = payload.properties?.diff
    if (sessionID && Array.isArray(diff) && diff.length > 0) {
      recordSessionDiff(sessionID, diff)
    }
  }
}

const startDirectoryEventStream = (directory: string, client: OpencodeClient) => {
  if (directoryEventStreams.has(directory)) return

  const controller = new AbortController()
  const promise = (async () => {
    try {
      const { stream } = await client.global.event({ signal: controller.signal })
      for await (const message of stream) {
        handleGlobalEvent(message as GlobalEvent)
      }
    } catch (error) {
      console.warn('[opencode] global event stream closed', {
        directory,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      directoryEventStreams.delete(directory)
    }
  })()

  directoryEventStreams.set(directory, { controller, promise })
}

const stopDirectoryEventStreams = () => {
  for (const { controller } of directoryEventStreams.values()) {
    controller.abort()
  }
  directoryEventStreams.clear()
}

const extractSummaryDiffs = (summary: SummaryWithDiffs | boolean | undefined): FileDiff[] => {
  if (!summary || typeof summary === 'boolean') return []
  return Array.isArray(summary.diffs) ? summary.diffs : []
}

const resetOpencodeClients = () => {
  for (const key of Object.keys(opencodeClients)) {
    delete opencodeClients[key]
  }
}

export const closeOpencodeServer = () => {
  if (opencodeServer) {
    opencodeServer.close()
    opencodeServer = null
  }
  resetOpencodeClients()
  stopDirectoryEventStreams()
  sessionDiffCache.clear()
  sessionDiffWaiters.clear()
}

// opencode freaks out if you try to import it statically
const getSdk = async () => await import('@opencode-ai/sdk')

/**
 * Starts a singleton Opencode server instance for use by clients.
 *
 * @returns An object containing the server URL and a close function.
 */
export const getOpencodeServer = async (): Promise<{
  url: string
  close(): void
}> => {
  if (opencodeServer) return opencodeServer
  const sdk = await getSdk()
  const preferredPort = process.env.OPENCODE_SERVER_PORT
  const port = preferredPort && Number.isFinite(Number(preferredPort)) ? Number(preferredPort) : 0
  const server = await sdk.createOpencodeServer({ port })
  opencodeServer = {
    url: server.url,
    close: () => {
      server.close()
      opencodeServer = null
      resetOpencodeClients()
    }
  }
  return opencodeServer
}

/**
 * Creates and returns an Opencode client connected to the singleton server.
 *
 * @param directory - The directory to be used by the Opencode client.
 * @returns An instance of OpencodeClient.
 */
export const getOpencodeClient = async (directory: string): Promise<OpencodeClient> => {
  if (!opencodeServer) {
    resetOpencodeClients()
  }

  if (!opencodeClients[directory]) {
    const server = await getOpencodeServer()
    const sdk = await getSdk()
    const opencode = await sdk.createOpencodeClient({
      baseUrl: server.url,
      directory: directory
    })
    opencodeClients[directory] = opencode
    startDirectoryEventStream(directory, opencode)
  } else {
    startDirectoryEventStream(directory, opencodeClients[directory])
  }

  return opencodeClients[directory]
}

type CreateSessionOptions = {
  name?: string
}

/**
 * Creates and returns a new Opencode session for the specified directory.
 *
 * @param directory - The directory for which the session is created.
 * @returns A Promise that resolves to a Session object.
 */
export const createSession = async (directory: string, options: CreateSessionOptions = {}): Promise<Session> => {
  const opencode = await getOpencodeClient(directory)

  const session = await opencode.session.create({
    query: {
      directory
    },
    body: options.name ? { title: options.name } : undefined
  })

  if (!session?.data!) throw new Error('Failed to create Opencode session')

  return session?.data!
}

export const getSession = async (directory: string, id: string): Promise<Session | null> => {
  const opencode = await getOpencodeClient(directory)

  const sessions = await opencode.session.list({
    query: {
      directory
    }
  })

  if (!sessions?.data || sessions.data.length === 0) return null

  return sessions.data.find((session) => session.id === id) || null
}

/** Prompts the specified Opencode session with a given prompt.
 *
 * @param directory - The directory associated with the session.
 * @param session - The Opencode session to be prompted.
 * @param prompt - The prompt text to send to the session.
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns A Promise that resolves to the response data from the prompt.
 */
export const promptSession = async (session: Session, prompts: string[], model: string, signal?: AbortSignal) => {
  const opencode = await getOpencodeClient(session.directory)

  const [providerID, modelID] = model.split('/')

  const response = await opencode.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID, modelID },
      parts: prompts.map((prompt) => ({ type: 'text', text: prompt }))
    },
    signal
  })

  if (!response?.data!) throw new Error('Failed to prompt Opencode session')

  return response?.data!
}

export const getSessionDiff = async (session: Session, messageID?: string): Promise<FileDiff[]> => {
  const opencode = await getOpencodeClient(session.directory)
  const directoryQuery = session.directory ? { directory: session.directory } : {}

  const cached = getCachedSessionDiff(session.id)
  if (cached?.length) {
    return cached
  }

  if (messageID) {
    const awaited = await waitForSessionDiff(session.id, SESSION_DIFF_EVENT_TIMEOUT_MS)
    if (awaited?.length) {
      return awaited
    }
  }

  const requestDiff = async (candidate?: string | null): Promise<FileDiff[]> => {
    const response = await opencode.session.diff({
      path: { id: session.id },
      query: candidate ? { ...directoryQuery, messageID: candidate } : directoryQuery
    })

    if (!response?.data!) throw new Error('Failed to retrieve Opencode session diff')

    return response.data
  }

  const tried = new Set<string | null>()
  const tryCandidate = async (candidate: string | null): Promise<FileDiff[] | null> => {
    const key = candidate ?? null
    if (tried.has(key)) return null
    tried.add(key)
    try {
      const diff = await requestDiff(candidate)
      if (diff.length > 0) {
        return diff
      }
    } catch {}
    return null
  }

  const candidateQueue: Array<string | null> = []
  if (messageID) {
    candidateQueue.push(messageID)
  }
  candidateQueue.push(null)

  let messagesList: SessionMessageEntry[] = []
  try {
    const messages = await opencode.session.messages({
      path: { id: session.id },
      query: { ...directoryQuery, limit: 20 }
    })
    if (Array.isArray(messages?.data)) {
      messagesList = messages.data as SessionMessageEntry[]
      for (const entry of messagesList) {
        if (typeof entry.info?.id === 'string') {
          candidateQueue.push(entry.info.id)
        }
      }
    }
  } catch {}

  for (const candidate of candidateQueue) {
    const diff = await tryCandidate(candidate)
    if (diff && diff.length > 0) {
      recordSessionDiff(session.id, diff)
      return diff
    }
  }

  if (messageID) {
    try {
      const message = await opencode.session.message({
        path: { id: session.id, messageID },
        query: directoryQuery
      })
      const summaryDiffs = extractSummaryDiffs(message?.data?.info?.summary)
      if (summaryDiffs.length > 0) {
        recordSessionDiff(session.id, summaryDiffs)
        return summaryDiffs
      }
    } catch {}
  }

  for (const entry of messagesList) {
    const summaryDiffs = extractSummaryDiffs(entry.info?.summary)
    if (summaryDiffs.length > 0) {
      recordSessionDiff(session.id, summaryDiffs)
      return summaryDiffs
    }
  }

  return []
}

export const extractResponseText = (response: Part[]): string => {
  console.log(response)
  return (
    response
      .filter((part) => part.type === 'text')
      .reverse()
      .at(-1) as TextPart
  ).text
}
