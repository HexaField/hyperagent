import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { workflowDefinitionSchema, type AgentWorkflowDefinition } from '../../../modules/agent/workflow-schema'

export type WorkflowSummary = {
  id: string
  description?: string
  model?: string
  roles: string[]
  updatedAt: string
}

export type WorkflowDetail = {
  id: string
  definition: AgentWorkflowDefinition
  updatedAt: string
  path: string
}

function getWorkflowDir(): string {
  return process.env.OPENCODE_WORKFLOW_DIR ?? path.join(os.homedir(), '.config', 'opencode', 'workflows')
}

function sanitizeId(candidate: string): string {
  if (!candidate || typeof candidate !== 'string') return `workflow-${Date.now()}`
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `workflow-${Date.now()}`
}

async function ensureDir(): Promise<string> {
  const dir = getWorkflowDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function workflowPathFor(id: string): string {
  const dir = getWorkflowDir()
  const name = sanitizeId(id) + '.json'
  const candidate = path.join(dir, name)
  const resolved = path.resolve(candidate)
  if (!resolved.startsWith(path.resolve(dir))) {
    throw new Error('Invalid workflow id')
  }
  return resolved
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const dir = await ensureDir()
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const list: WorkflowSummary[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const full = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(full)
      const raw = await fs.readFile(full, 'utf8')
      const parsed = JSON.parse(raw)
      const definition = workflowDefinitionSchema.parse(parsed)
      const roles = Object.keys(definition.roles ?? {})
      list.push({
        id: definition.id,
        description: definition.description,
        model: definition.model,
        roles,
        updatedAt: stat.mtime.toISOString()
      })
    } catch {
      // Skip unreadable/invalid entries; they can be repaired via hydrate endpoint later.
    }
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readWorkflow(id: string): Promise<WorkflowDetail | null> {
  await ensureDir()
  try {
    const file = workflowPathFor(id)
    const stat = await fs.stat(file)
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const definition = workflowDefinitionSchema.parse(parsed)
    return { id: definition.id, definition, updatedAt: stat.mtime.toISOString(), path: file }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

export async function writeWorkflow(definition: AgentWorkflowDefinition): Promise<{ id: string; path: string }> {
  await ensureDir()
  const hydrated = workflowDefinitionSchema.parse(definition)
  const id = sanitizeId(hydrated.id)
  const file = workflowPathFor(id)
  const payload = JSON.stringify(hydrated, null, 2)
  await fs.writeFile(file, payload, 'utf8')
  return { id, path: file }
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  await ensureDir()
  try {
    const file = workflowPathFor(id)
    await fs.unlink(file)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

export async function hydrateWorkflow(definition: AgentWorkflowDefinition): Promise<AgentWorkflowDefinition> {
  return workflowDefinitionSchema.parse(definition)
}
