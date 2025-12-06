import type { Response } from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { CodeServerController, CodeServerOptions } from '../../../src/modules/codeServer'
import type { Persistence, ProjectRecord } from '../../../src/modules/database'
import type { CodeServerSession, ProxyWithUpgrade } from './codeServerTypes'
import { CODE_SERVER_HOST, buildExternalUrl, mergeFrameAncestorsDirective } from './config'
import type { Logger } from './logging'
import { toErrorMeta } from './logging'

const deriveProjectSessionId = (projectId: string) => `project-${projectId}`

const normalizeBranchName = (value?: string | null) => {
  if (typeof value === 'string' && value.trim().length) {
    return value.trim()
  }
  return 'main'
}

const rewriteCodeServerPath = (pathName: string, sessionId: string): string => {
  const prefix = `/code-server/${sessionId}`
  if (!pathName.startsWith(prefix)) return pathName
  const trimmed = pathName.slice(prefix.length)
  return trimmed.length ? trimmed : '/'
}

const applyProxyResponseHeaders = (
  proxyRes: IncomingMessage,
  res: Response,
  corsOrigin?: string,
  frameAncestorOrigin?: string | null
) => {
  if (corsOrigin) {
    proxyRes.headers['access-control-allow-origin'] = corsOrigin
    proxyRes.headers['access-control-allow-credentials'] = 'true'
    res.setHeader('Access-Control-Allow-Origin', corsOrigin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  if (frameAncestorOrigin) {
    const merged = mergeFrameAncestorsDirective(proxyRes.headers['content-security-policy'], frameAncestorOrigin)
    proxyRes.headers['content-security-policy'] = merged
    res.setHeader('Content-Security-Policy', merged)
  } else if (proxyRes.headers['content-security-policy']) {
    res.setHeader('Content-Security-Policy', proxyRes.headers['content-security-policy'] as string)
  }
  delete proxyRes.headers['x-frame-options']
  res.removeHeader('X-Frame-Options')
}

export type ControllerFactory = (options: CodeServerOptions) => CodeServerController

export type CodeServerSessionManager = {
  startWorkspace: (options: CodeServerWorkspaceOptions) => Promise<CodeServerSession | null>
  ensureProjectSession: (project: ProjectRecord) => Promise<CodeServerSession | null>
  shutdownSession: (sessionId: string) => Promise<void>
  shutdownAll: () => Promise<void>
  getSession: (sessionId: string) => CodeServerSession | null
  listSessionIds: () => string[]
}

type CodeServerWorkspaceOptions = {
  sessionId: string
  sessionDir: string
  project: ProjectRecord
  branch?: string | null
}

type CreateCodeServerSessionManagerOptions = {
  controllerFactory: ControllerFactory
  allocatePort: () => Promise<number>
  persistence: Persistence
  publicOrigin?: string | null
  corsOrigin?: string
  frameAncestorOrigin?: string | null
  logger: Logger
}

export const createCodeServerSessionManager = (
  options: CreateCodeServerSessionManagerOptions
): CodeServerSessionManager => {
  const { controllerFactory, allocatePort, persistence, publicOrigin, corsOrigin, frameAncestorOrigin, logger } =
    options

  persistence.codeServerSessions.resetAllRunning()

  const activeSessions = new Map<string, CodeServerSession>()

  const startWorkspace = async (workspace: CodeServerWorkspaceOptions): Promise<CodeServerSession | null> => {
    if (activeSessions.has(workspace.sessionId)) {
      return activeSessions.get(workspace.sessionId) ?? null
    }

    try {
      const branch = normalizeBranchName(workspace.branch ?? workspace.project.defaultBranch)
      const port = await allocatePort()
      const basePath = `/code-server/${workspace.sessionId}`
      const controller = controllerFactory({
        host: CODE_SERVER_HOST,
        port,
        repoRoot: workspace.sessionDir,
        publicBasePath: basePath
      })
      const handle = await controller.ensure()
      if (!handle) {
        throw new Error('code-server failed to start')
      }
      const sessionPublicUrl = buildExternalUrl(handle.publicUrl, publicOrigin ?? null) ?? handle.publicUrl

      const targetBase = `http://${CODE_SERVER_HOST}:${port}`
      const rewriteProxyOriginHeader = (proxyReq: ClientRequest) => {
        if (!proxyReq.hasHeader('origin')) return
        proxyReq.setHeader('origin', targetBase)
      }

      const proxy = createProxyMiddleware({
        target: targetBase,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathName: string) => rewriteCodeServerPath(pathName, workspace.sessionId),
        on: {
          proxyRes: (proxyRes: IncomingMessage, _req: IncomingMessage, res: Response) => {
            applyProxyResponseHeaders(proxyRes, res, corsOrigin, frameAncestorOrigin)
          },
          proxyReq: (proxyReq: ClientRequest) => {
            rewriteProxyOriginHeader(proxyReq)
          },
          proxyReqWs: (proxyReq: ClientRequest) => {
            rewriteProxyOriginHeader(proxyReq)
          }
        }
      } as any) as ProxyWithUpgrade

      const session: CodeServerSession = {
        id: workspace.sessionId,
        dir: workspace.sessionDir,
        basePath,
        projectId: workspace.project.id,
        branch,
        controller,
        proxy,
        publicUrl: sessionPublicUrl
      }
      activeSessions.set(workspace.sessionId, session)
      persistence.codeServerSessions.upsert({
        id: workspace.sessionId,
        projectId: workspace.project.id,
        branch,
        workspacePath: workspace.sessionDir,
        url: sessionPublicUrl,
        authToken: 'none',
        processId: handle.child.pid ?? null
      })
      return session
    } catch (error) {
      logger.warn('Unable to launch code-server session', {
        sessionId: workspace.sessionId,
        projectId: workspace.project.id,
        error: toErrorMeta(error)
      })
      return null
    }
  }

  const ensureProjectSession = async (project: ProjectRecord): Promise<CodeServerSession | null> => {
    return await startWorkspace({
      sessionId: deriveProjectSessionId(project.id),
      sessionDir: project.repositoryPath,
      project,
      branch: project.defaultBranch
    })
  }

  const shutdownSession = async (sessionId: string): Promise<void> => {
    const session = activeSessions.get(sessionId)
    if (!session) return
    activeSessions.delete(sessionId)
    await session.controller.shutdown()
    persistence.codeServerSessions.markStopped(sessionId)
  }

  const shutdownAll = async (): Promise<void> => {
    const ids = [...activeSessions.keys()]
    await Promise.all(ids.map((id) => shutdownSession(id)))
  }

  return {
    startWorkspace,
    ensureProjectSession,
    shutdownSession,
    shutdownAll,
    getSession: (sessionId: string) => activeSessions.get(sessionId) ?? null,
    listSessionIds: () => [...activeSessions.keys()]
  }
}
