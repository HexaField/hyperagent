import {
  runAgentWorkflow,
  workflowCreateWorkflowDefinition,
  workflowDefinitionSchema,
  type AgentWorkflowDefinition
} from '@hexafield/agent-workflow'
import { Router, type RequestHandler } from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { WorkspaceSessionsDeps } from './routesTypes'
import { deleteWorkflow, hydrateWorkflow, listWorkflows, readWorkflow, writeWorkflow } from './workflows'

const requireDefinition = (body: unknown): AgentWorkflowDefinition => {
  const payload = (body as { definition?: unknown })?.definition
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('definition is required'), { status: 400 })
  }
  return payload as AgentWorkflowDefinition
}

const requireId = (id: string | undefined) => {
  if (!id) {
    throw Object.assign(new Error('workflow id is required'), { status: 400 })
  }
  return id
}

const toHttp = <T extends RequestHandler>(handler: T): RequestHandler => {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error: any) {
      const status = error?.status ?? 500
      res.status(status).json({ error: error?.message ?? 'Unexpected error' })
    }
  }
}

const createTempSessionDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-create-'))
  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'deny'
    }
  }
  await fs.writeFile(path.join(dir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), 'utf8')
  return dir
}

const runWorkflowCreateDraft = async (instructions: string, template?: AgentWorkflowDefinition) => {
  const sessionDir = await createTempSessionDir()
  try {
    const templateNote = template
      ? `Base template (AgentWorkflowDefinition JSON):\n${JSON.stringify(template, null, 2)}`
      : 'No base template provided.'

    const userInstructions = [
      'You will respond via the createWorkflow parser payload {id, content}.',
      'Set content to a JSON string (not TypeScript) that is a valid AgentWorkflowDefinition matching the request.',
      'Do not include code fences or markdown; the content must be raw JSON text.',
      `User request:\n${instructions}`,
      templateNote,
      'The content must parse as JSON and satisfy the workflowDefinitionSchema.'
    ].join('\n\n')
    try {
      const run = await runAgentWorkflow(workflowCreateWorkflowDefinition, {
        userInstructions,
        model: workflowCreateWorkflowDefinition.model ?? 'github-copilot/gpt-5-mini',
        sessionDir
      })

      const result = await run.result
      console.dir(result, { depth: null })
      const rounds = Array.isArray(result?.rounds) ? result.rounds : []
      const steps = rounds.flatMap((round) => Object.values(round.steps ?? {}))
      const parsedPayload = steps
        .map((step: unknown) => (step as { parsed?: unknown } | undefined)?.parsed)
        .find((payload: unknown) => payload && typeof payload === 'object' && 'content' in payload) as
        | { content?: unknown }
        | undefined
      console.log('parsedPayload:', parsedPayload)

      if (!parsedPayload || typeof parsedPayload.content !== 'string') {
        throw new Error('workflow-create did not return JSON content')
      }

      const definition = workflowDefinitionSchema.parse(JSON.parse(parsedPayload.content))
      console.log('definition:', definition)
      return { definition, rawText: parsedPayload.content }
    } catch (error: any) {
      const message = error?.message ?? 'workflow-create draft failed'
      const withStatus = Object.assign(new Error(message), { status: error?.status ?? 502 })
      throw withStatus
    }
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true })
  }
}

const createListHandler = (): RequestHandler => async (_req, res) => {
  const items = await listWorkflows()
  res.json({ workflows: items })
}

const createGetHandler = (): RequestHandler => async (req, res) => {
  const id = requireId(req.params.id)
  const detail = await readWorkflow(id)
  if (!detail) {
    res.status(404).json({ error: 'Unknown workflow' })
    return
  }
  res.json({ workflow: detail })
}

const createCreateHandler = (): RequestHandler => async (req, res) => {
  const definition = requireDefinition(req.body)
  const result = await writeWorkflow(definition)
  res.status(201).json(result)
}

const createUpdateHandler = (): RequestHandler => async (req, res) => {
  const id = requireId(req.params.id)
  const definition = requireDefinition(req.body)
  if ((definition as { id?: string }).id && (definition as { id?: string }).id !== id) {
    res.status(400).json({ error: 'definition.id must match path id' })
    return
  }
  const result = await writeWorkflow({ ...definition, id })
  res.json(result)
}

const createDeleteHandler = (): RequestHandler => async (req, res) => {
  const id = requireId(req.params.id)
  const ok = await deleteWorkflow(id)
  if (!ok) {
    res.status(404).json({ error: 'Unknown workflow' })
    return
  }
  res.json({ success: true })
}

const createValidateHandler = (): RequestHandler => async (req, res) => {
  const definition = requireDefinition(req.body)
  const hydrated = await hydrateWorkflow(definition)
  res.json({ definition: hydrated })
}

const createDraftHandler = (): RequestHandler => async (req, res) => {
  const instructions = (req.body as { instructions?: unknown })?.instructions
  const template = (req.body as { template?: unknown })?.template
  if (typeof instructions !== 'string' || !instructions.trim()) {
    res.status(400).json({ error: 'instructions is required' })
    return
  }
  try {
    const parsedTemplate = template ? workflowDefinitionSchema.parse(template) : undefined
    const draft = await runWorkflowCreateDraft(instructions, parsedTemplate)
    console.log('draft created:', draft)
    res.json({ definition: draft.definition, rawText: draft.rawText })
  } catch (error: any) {
    const status = error?.status ?? 502
    const message = error?.message ?? 'Workflow draft failed'
    res.status(status).json({ error: message })
  }
}

export const createWorkflowsRouter = ({ wrapAsync }: WorkspaceSessionsDeps) => {
  const router = Router()
  router.get('/api/workflows', wrapAsync(toHttp(createListHandler())))
  router.get('/api/workflows/:id', wrapAsync(toHttp(createGetHandler())))
  router.post('/api/workflows', wrapAsync(toHttp(createCreateHandler())))
  router.put('/api/workflows/:id', wrapAsync(toHttp(createUpdateHandler())))
  router.delete('/api/workflows/:id', wrapAsync(toHttp(createDeleteHandler())))
  router.post(
    '/api/workflows/:id/hydrate',
    wrapAsync(
      toHttp(async (req, res) => {
        const id = requireId(req.params.id)
        const detail = await readWorkflow(id)
        if (!detail) {
          res.status(404).json({ error: 'Unknown workflow' })
          return
        }
        res.json({ workflow: detail })
      })
    )
  )
  router.post('/api/workflows/validate', wrapAsync(toHttp(createValidateHandler())))
  router.post('/api/workflows/draft', wrapAsync(toHttp(createDraftHandler())))
  return router
}
