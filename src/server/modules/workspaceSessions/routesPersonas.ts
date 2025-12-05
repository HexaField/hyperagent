import { Router, type RequestHandler } from 'express'
import { deletePersona, listPersonas, readPersona, writePersona } from './personas'
import type { WorkspaceSessionsDeps } from './routesTypes'

const createListHandler = (): RequestHandler => async (_req, res) => {
  try {
    const personas = await listPersonas()
    res.json({ personas })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list personas'
    res.status(500).json({ error: message })
  }
}

const createGetHandler = (): RequestHandler => async (req, res) => {
  const id = req.params.id
  if (!id) {
    res.status(400).json({ error: 'persona id is required' })
    return
  }
  try {
    const detail = await readPersona(id)
    if (!detail) {
      res.status(404).json({ error: 'Unknown persona' })
      return
    }
    res.json({ persona: detail })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read persona'
    res.status(500).json({ error: message })
  }
}

const createCreateHandler = (): RequestHandler => async (req, res) => {
  const body = req.body ?? {}
  const markdown = typeof body.markdown === 'string' ? body.markdown : null
  const suggestedId = typeof body.id === 'string' ? body.id : undefined
  if (!markdown) {
    res.status(400).json({ error: 'markdown is required' })
    return
  }
  try {
    const { id, path } = await writePersona(suggestedId, markdown)
    res.status(201).json({ id, path })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create persona'
    res.status(500).json({ error: message })
  }
}

const createUpdateHandler = (): RequestHandler => async (req, res) => {
  const id = req.params.id
  const body = req.body ?? {}
  const markdown = typeof body.markdown === 'string' ? body.markdown : null
  if (!id) {
    res.status(400).json({ error: 'persona id is required' })
    return
  }
  if (!markdown) {
    res.status(400).json({ error: 'markdown is required' })
    return
  }
  try {
    const result = await writePersona(id, markdown)
    res.json({ id: result.id, path: result.path })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update persona'
    res.status(500).json({ error: message })
  }
}

const createDeleteHandler = (): RequestHandler => async (req, res) => {
  const id = req.params.id
  if (!id) {
    res.status(400).json({ error: 'persona id is required' })
    return
  }
  try {
    const ok = await deletePersona(id)
    res.json({ success: ok })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete persona'
    res.status(500).json({ error: message })
  }
}

export const createPersonasRouter = ({ wrapAsync }: WorkspaceSessionsDeps) => {
  const router = Router()
  router.get('/api/coding-agent/personas', wrapAsync(createListHandler()))
  router.get('/api/coding-agent/personas/:id', wrapAsync(createGetHandler()))
  router.post('/api/coding-agent/personas', wrapAsync(createCreateHandler()))
  router.put('/api/coding-agent/personas/:id', wrapAsync(createUpdateHandler()))
  router.delete('/api/coding-agent/personas/:id', wrapAsync(createDeleteHandler()))
  return router
}
