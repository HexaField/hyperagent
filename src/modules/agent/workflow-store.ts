import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { configureWorkflowParsers, type WorkflowParserRegistry } from './agent'
import { singleAgentWorkflowDefinition, verifierWorkerWorkflowDefinition, collectParserSchemasFromDefinitions } from './workflows'
import { workflowDefinitionSchema, type AgentWorkflowDefinition } from './workflow-schema'

export type WorkflowSource = 'builtin' | 'user'

export type AgentWorkflowSummary = {
  id: string
  description?: string
  model?: string
  roles: string[]
  updatedAt?: string
  path?: string
  source: WorkflowSource
}

export type StoredAgentWorkflow = {
  id: string
  source: WorkflowSource
  path?: string
  updatedAt?: string
  definition: AgentWorkflowDefinition
}

const CONFIG_ROOT = process.env.HYPERAGENT_CONFIG_DIR || path.join(os.homedir(), '.hyperagent')
const WORKFLOW_DIR_NAME = 'agent-workflows'

const builtinWorkflows: StoredAgentWorkflow[] = [
  {
    id: singleAgentWorkflowDefinition.id,
    source: 'builtin',
    definition: singleAgentWorkflowDefinition
  },
  {
    id: verifierWorkerWorkflowDefinition.id,
    source: 'builtin',
    definition: verifierWorkerWorkflowDefinition
  }
]

const sanitizeId = (candidate: string): string => {
  const normalized = (candidate || 'workflow')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.length ? normalized : `workflow-${Date.now()}`
}

const workflowsRoot = (): string => path.resolve(CONFIG_ROOT)

const workflowsDir = (): string => path.join(workflowsRoot(), WORKFLOW_DIR_NAME)

const ensureWorkflowsDir = async (): Promise<string> => {
  const dir = workflowsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const workflowPathFor = (id: string): string => {
  const dir = workflowsDir()
  const name = `${sanitizeId(id)}.json`
  const candidate = path.resolve(path.join(dir, name))
  if (!candidate.startsWith(path.resolve(dir))) {
    throw new Error('Invalid workflow id')
  }
  return candidate
}

const summarizeDefinition = (wf: StoredAgentWorkflow): AgentWorkflowSummary => ({
  id: wf.id,
  description: wf.definition.description,
  model: wf.definition.model,
  roles: Object.keys(wf.definition.roles ?? {}),
  updatedAt: wf.updatedAt,
  path: wf.path,
  source: wf.source
})

const validateDefinition = (definition: AgentWorkflowDefinition): AgentWorkflowDefinition => {
  const parsed = workflowDefinitionSchema.parse(definition)
  const normalizedId = sanitizeId(parsed.id)
  if (normalizedId !== parsed.id) {
    return { ...parsed, id: normalizedId } as AgentWorkflowDefinition
  }
  return parsed as AgentWorkflowDefinition
}

const loadUserWorkflowFromFile = async (filePath: string): Promise<StoredAgentWorkflow | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const definition = validateDefinition(parsed as AgentWorkflowDefinition)
    const stat = await fs.stat(filePath)
    return {
      id: definition.id,
      source: 'user',
      path: filePath,
      updatedAt: stat.mtime.toISOString(),
      definition
    }
  } catch (error) {
    console.warn('[agent-workflows] Failed to read workflow file', { filePath, error })
    return null
  }
}

export async function listUserAgentWorkflows(): Promise<StoredAgentWorkflow[]> {
  const dir = await ensureWorkflowsDir()
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const items: StoredAgentWorkflow[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(dir, entry.name)
    const workflow = await loadUserWorkflowFromFile(filePath)
    if (workflow) items.push(workflow)
  }
  return items.sort((a, b) => (a.updatedAt && b.updatedAt ? b.updatedAt.localeCompare(a.updatedAt) : 0))
}

export async function listAgentWorkflowSummaries(): Promise<AgentWorkflowSummary[]> {
  const user = await listUserAgentWorkflows()
  const combined = [...builtinWorkflows, ...user]
  return combined.map((wf) => summarizeDefinition(wf))
}

export async function readAgentWorkflow(id: string): Promise<StoredAgentWorkflow | null> {
  const sanitized = sanitizeId(id)
  const builtin = builtinWorkflows.find((wf) => wf.id === sanitized)
  if (builtin) return builtin
  const dir = await ensureWorkflowsDir()
  const file = path.join(dir, `${sanitized}.json`)
  return await loadUserWorkflowFromFile(file)
}

export async function saveAgentWorkflow(definition: AgentWorkflowDefinition): Promise<StoredAgentWorkflow> {
  const validated = validateDefinition(definition)
  const dir = await ensureWorkflowsDir()
  const file = workflowPathFor(validated.id)
  await fs.writeFile(file, JSON.stringify(validated, null, 2), 'utf8')
  const stat = await fs.stat(file)
  return {
    id: validated.id,
    source: 'user',
    path: file,
    updatedAt: stat.mtime.toISOString(),
    definition: validated
  }
}

export async function deleteAgentWorkflow(id: string): Promise<boolean> {
  const sanitized = sanitizeId(id)
  const dir = await ensureWorkflowsDir()
  const file = path.join(dir, `${sanitized}.json`)
  try {
    await fs.unlink(file)
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function resolveAgentWorkflowDefinition(
  id: string | null | undefined
): Promise<StoredAgentWorkflow | null> {
  if (!id) return null
  return await readAgentWorkflow(id)
}

export async function loadAllAgentWorkflows(): Promise<StoredAgentWorkflow[]> {
  const user = await listUserAgentWorkflows()
  return [...builtinWorkflows, ...user]
}

export async function configureAgentWorkflowParsers(): Promise<WorkflowParserRegistry> {
  const all = await loadAllAgentWorkflows()
  const registry = collectParserSchemasFromDefinitions(...all.map((wf) => wf.definition))
  configureWorkflowParsers(registry)
  return registry
}

export function listBuiltinAgentWorkflows(): StoredAgentWorkflow[] {
  return builtinWorkflows
}
