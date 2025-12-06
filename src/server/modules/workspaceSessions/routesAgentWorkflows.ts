import { Router, type RequestHandler } from 'express'
import {
  configureAgentWorkflowParsers,
  deleteAgentWorkflow,
  listAgentWorkflowSummaries,
  readAgentWorkflow,
  saveAgentWorkflow
} from '../../../modules/agent/workflow-store'
import { workflowDefinitionSchema, type AgentWorkflowDefinition } from '../../../modules/agent/workflow-schema'
import type { WorkspaceSessionsDeps } from './routesTypes'

const createListHandler = (): RequestHandler => async (_req, res) => {
  try {
    const workflows = await listAgentWorkflowSummaries()
    res.json({ workflows })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list workflows'
    res.status(500).json({ error: message })
  }
}

const createGetHandler = (): RequestHandler => async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : ''
  if (!id.trim()) {
    res.status(400).json({ error: 'workflow id is required' })
    return
  }
  try {
    const workflow = await readAgentWorkflow(id)
    if (!workflow) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    res.json({ workflow: workflow.definition, source: workflow.source })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read workflow'
    res.status(500).json({ error: message })
  }
}

const parseDefinition = (input: unknown): AgentWorkflowDefinition => {
  if (!input || typeof input !== 'object') throw new Error('workflow definition is required')
  return workflowDefinitionSchema.parse(input)
}

const createCreateHandler = (): RequestHandler => async (req, res) => {
  try {
    const definition = parseDefinition(req.body?.workflow ?? req.body)
    const saved = await saveAgentWorkflow(definition)
    await configureAgentWorkflowParsers()
    res.status(201).json({ workflow: saved.definition, id: saved.id, source: saved.source })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save workflow'
    res.status(400).json({ error: message })
  }
}

const createUpdateHandler = (): RequestHandler => async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : ''
  if (!id.trim()) {
    res.status(400).json({ error: 'workflow id is required' })
    return
  }
  try {
    const existing = await readAgentWorkflow(id)
    if (existing?.source === 'builtin') {
      res.status(400).json({ error: 'Built-in workflows cannot be modified. Save as a new workflow id instead.' })
      return
    }
    const definition = parseDefinition(req.body?.workflow ?? req.body)
    const patchedDefinition: AgentWorkflowDefinition = { ...definition, id }
    const saved = await saveAgentWorkflow(patchedDefinition)
    await configureAgentWorkflowParsers()
    res.json({ workflow: saved.definition, id: saved.id, source: saved.source })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update workflow'
    res.status(400).json({ error: message })
  }
}

const createDeleteHandler = (): RequestHandler => async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : ''
  if (!id.trim()) {
    res.status(400).json({ error: 'workflow id is required' })
    return
  }
  try {
    const existing = await readAgentWorkflow(id)
    if (existing?.source === 'builtin') {
      res.status(400).json({ error: 'Built-in workflows cannot be deleted' })
      return
    }
    const ok = await deleteAgentWorkflow(id)
    res.json({ success: ok })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete workflow'
    res.status(500).json({ error: message })
  }
}

export const createAgentWorkflowsRouter = ({ wrapAsync }: WorkspaceSessionsDeps) => {
  const router = Router({ mergeParams: true })
  router.get('/api/agent-workflows', wrapAsync(createListHandler()))
  router.get('/api/agent-workflows/:id', wrapAsync(createGetHandler()))
  router.post('/api/agent-workflows', wrapAsync(createCreateHandler()))
  router.put('/api/agent-workflows/:id', wrapAsync(createUpdateHandler()))
  router.delete('/api/agent-workflows/:id', wrapAsync(createDeleteHandler()))
  return router
}
