import type { OpencodeClient, Part, Session, TextPart } from '@opencode-ai/sdk'

let opencodeServer: {
  url: string
  close(): void
} | null = null
const opencodeClients: { [directory: string]: OpencodeClient } = {}

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
  if (opencodeClients[directory]) return opencodeClients[directory]
  const server = await getOpencodeServer()
  const sdk = await getSdk()
  const opencode = await sdk.createOpencodeClient({
    baseUrl: server.url,
    directory: directory
  })
  opencodeClients[directory] = opencode
  return opencode
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

export const extractResponseText = (response: Part[]): string => {
  console.log(response)
  return (
    response
      .filter((part) => part.type === 'text')
      .reverse()
      .at(-1) as TextPart
  ).text
}
