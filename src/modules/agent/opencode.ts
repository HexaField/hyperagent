import type { OpencodeClient, Part, Session, TextPart } from '@opencode-ai/sdk'
import fs from 'fs/promises'
import path from 'path'

let opencodeServer: {
  url: string
  close(): void
} | null = null

export const closeOpencodeServer = () => {
  if (opencodeServer) {
    opencodeServer.close()
    opencodeServer = null
  }
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
  opencodeServer = await sdk.createOpencodeServer()
  return opencodeServer
}

const opencodeClients: { [directory: string]: OpencodeClient } = {}

/**
 * Creates and returns an Opencode client connected to the singleton server.
 *
 * @param directory - The directory to be used by the Opencode client.
 * @returns An instance of OpencodeClient.
 */
export const getOpencodeClient = async (directory: string): Promise<OpencodeClient> => {
  if (opencodeClients[directory]) return opencodeClients[directory]
  const server = await getOpencodeServer()
  const sdk = await getSdk()
  const opencode = await sdk.createOpencodeClient({
    baseUrl: server.url,
    directory: directory
  })
  return opencode
}

/**
 * Creates and returns a new Opencode session for the specified directory.
 *
 * @param directory - The directory for which the session is created.
 * @returns A Promise that resolves to a Session object.
 */
export const createSession = async (directory: string): Promise<Session> => {
  const opencode = await getOpencodeClient(directory)

  const session = await opencode.session.create({
    query: {
      directory
    }
  })

  if (!session?.data!) throw new Error('Failed to create Opencode session')

  return session?.data!
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

export const extractResponseText = (response: Part[]): string => {
  console.log(response)
  return (
    response
      .filter((part) => part.type === 'text')
      .reverse()
      .at(-1) as TextPart
  ).text
}

// --- Opencode storage and run-record helpers (migrated here to avoid duplication)
export type OpencodeSessionSummary = {
  id: string
  title: string | null
  workspacePath: string | null
  projectId: string | null
  createdAt?: string
  updatedAt?: string
  summary?: { additions: number; deletions: number; files: number }
}

export type OpencodeMessagePart = {
  id: string
  type: string
  text?: string
  start?: number | null
  end?: number | null
}

export type OpencodeSessionDetail = {
  session: OpencodeSessionSummary
  messages: Array<any>
}

export type OpencodeStorage = {
  rootDir?: string
  listSessions: (opts?: { workspacePath?: string }) => Promise<OpencodeSessionSummary[]>
  getSession: (id: string) => Promise<OpencodeSessionDetail | null>
}

export const createOpencodeStorage = ({ rootDir }: { rootDir?: string }): OpencodeStorage => {
  const storageRoot = rootDir

  const storagePaths = storageRoot
    ? {
        storageDir: path.join(storageRoot, 'storage'),
        messageRoot: path.join(storageRoot, 'storage', 'message'),
        partRoot: path.join(storageRoot, 'storage', 'part')
      }
    : null

  const listSessions = async (_opts?: { workspacePath?: string }) => {
    if (!storagePaths) return []
    try {
      const metaDir = path.join(storagePaths.storageDir, 'session', 'global')
      const entries = await fs.readdir(metaDir).catch(() => [])
      const sessions: any[] = []
      for (const fname of entries) {
        if (!fname.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(metaDir, fname), 'utf8')
          const parsed = JSON.parse(raw)
          sessions.push({
            id: parsed.id,
            title: parsed.title ?? null,
            directory: parsed.directory ?? null,
            time: parsed.time ?? {}
          })
        } catch {}
      }
      return sessions
    } catch {
      return []
    }
  }

  const getSession = async (id: string) => {
    if (!storagePaths) return null
    try {
      const sessionMetaPath = path.join(storagePaths.storageDir, 'session', 'global', `${id}.json`)
      const metaRaw = await fs.readFile(sessionMetaPath, 'utf8')
      const meta = JSON.parse(metaRaw)
      const messageDir = path.join(storagePaths.messageRoot, id)
      const msgs: any[] = []
      const msgFiles = await fs.readdir(messageDir).catch(() => [])
      for (const mf of msgFiles) {
        if (!mf.endsWith('.json')) continue
        try {
          const mraw = await fs.readFile(path.join(messageDir, mf), 'utf8')
          const mobj = JSON.parse(mraw)
          // load parts
          const partsDir = path.join(storagePaths.partRoot, mobj.id)
          const partFiles = await fs.readdir(partsDir).catch(() => [])
          const parts: any[] = []
          for (const pf of partFiles) {
            if (!pf.endsWith('.json')) continue
            try {
              const praw = await fs.readFile(path.join(partsDir, pf), 'utf8')
              const pobj = JSON.parse(praw)
              parts.push(pobj)
            } catch {}
          }
          msgs.push({ ...mobj, parts })
        } catch {}
      }
      return {
        session: {
          id: meta.id,
          title: meta.title ?? null,
          workspacePath: meta.directory ?? null,
          projectId: null,
          createdAt: meta.time?.created ? new Date(meta.time.created).toISOString() : new Date().toISOString(),
          updatedAt: meta.time?.updated ? new Date(meta.time.updated).toISOString() : new Date().toISOString(),
          summary: meta.summary ?? { additions: 0, deletions: 0, files: 0 }
        },
        messages: msgs
      }
    } catch {
      return null
    }
  }

  return { rootDir: storageRoot, listSessions, getSession }
}

export type OpencodeRunRecord = {
  sessionId: string
  pid: number
  workspacePath: string
  prompt: string
  title: string | null
  model: string | null
  providerId: string | null
  logFile: string
  startedAt: string
  updatedAt: string
  status: 'running' | 'finished' | 'failed'
  exitCode: number | null
  signal: string | null
}

export default {
  getOpencodeServer,
  getOpencodeClient,
  createSession,
  promptSession,
  extractResponseText,
  createOpencodeStorage
}
