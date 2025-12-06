import { For, Show, createMemo, createSignal } from 'solid-js'
import NodeGraph, { type GraphEdge, type GraphNode } from '../components/NodeGraph'
import { verifierWorkerWorkflowDocument } from '../data/verifierWorkerWorkflow'

const NODE_TYPES = ['task', 'decision', 'io', 'automation'] as const

export type WorkflowNodeType = (typeof NODE_TYPES)[number]

export type WorkflowNodeDocument = {
  id: string
  label: string
  type?: WorkflowNodeType
  description?: string
  owner?: string
  guard?: string
  position?: { x: number; y: number }
  x?: number
  y?: number
  outputs?: string[]
  metadata?: Record<string, unknown>
}

export type WorkflowEdgeDocument = {
  id?: string
  from: string
  to: string
  label?: string
  condition?: string
  guard?: string
}

export type WorkflowDocument = {
  name: string
  version?: string
  summary?: string
  nodes: WorkflowNodeDocument[]
  edges: WorkflowEdgeDocument[]
  metadata?: Record<string, unknown>
}

type NodeMeta = {
  id: string
  label: string
  type: WorkflowNodeType
  description: string
  owner: string
  guard: string
  outputs: string
}

type GraphChange = { nodes: GraphNode[]; edges: GraphEdge[] }

type SelectedNode = { node: GraphNode; meta: NodeMeta }

const stepTypeForRole = (role?: string): WorkflowNodeType => {
  if (role === 'verifier') return 'decision'
  if (role === 'worker') return 'task'
  return 'automation'
}

const promptText = (prompt: unknown): string => {
  if (Array.isArray(prompt)) return prompt.filter((line) => typeof line === 'string').join('\n')
  return typeof prompt === 'string' ? prompt : ''
}

const spacingPosition = (index: number) => {
  const col = index % 4
  const row = Math.floor(index / 4)
  return { x: 160 + col * 220, y: 150 + row * 170 }
}

const buildWorkflowFromDefinition = (definition: typeof verifierWorkerWorkflowDocument): WorkflowDocument => {
  const nodes: WorkflowNodeDocument[] = []
  const edges: WorkflowEdgeDocument[] = []
  let index = 0

  const addNode = (id: string, role: string, prompt?: unknown) => {
    nodes.push({
      id,
      label: id,
      type: stepTypeForRole(role),
      description: promptText(prompt),
      owner: role,
      position: spacingPosition(index++)
    })
  }

  if (definition.flow.bootstrap) {
    addNode(definition.flow.bootstrap.key, definition.flow.bootstrap.role, definition.flow.bootstrap.prompt)
  }

  const roundSteps = definition.flow.round.steps
  roundSteps.forEach((step) => addNode(step.key, step.role, step.prompt))

  if (definition.flow.bootstrap) {
    edges.push({
      id: `${definition.flow.bootstrap.key}-${definition.flow.round.start}`,
      from: definition.flow.bootstrap.key,
      to: definition.flow.round.start,
      label: 'bootstrap'
    })
  }

  roundSteps.forEach((step, stepIndex) => {
    if ('next' in step && step.next) {
      edges.push({ id: `${step.key}-${step.next}`, from: step.key, to: step.next, label: 'next' })
      return
    }
    if (stepIndex === roundSteps.length - 1) {
      edges.push({
        id: `${step.key}-loop-${definition.flow.round.start}`,
        from: step.key,
        to: definition.flow.round.start,
        label: 'iterate'
      })
    }
  })

  return {
    name: definition.id,
    version: definition.id.split('.').at(-1) ?? 'v1',
    summary: definition.description ?? 'Multi-agent workflow',
    nodes,
    edges,
    metadata: { kind: 'agent-workflow', source: definition.id }
  }
}

const defaultWorkflow: WorkflowDocument = buildWorkflowFromDefinition(verifierWorkerWorkflowDocument)

const toGraphNode = (doc: WorkflowNodeDocument, index: number): GraphNode => {
  const fallback = spacingPosition(index)
  const x = typeof doc.position?.x === 'number' ? doc.position.x : typeof doc.x === 'number' ? doc.x : fallback.x
  const y = typeof doc.position?.y === 'number' ? doc.position.y : typeof doc.y === 'number' ? doc.y : fallback.y
  return {
    id: doc.id,
    label: doc.label || doc.id,
    x,
    y
  }
}

const toGraphEdge = (edge: WorkflowEdgeDocument): GraphEdge => ({
  id: edge.id ?? `${edge.from}-${edge.to}`,
  from: edge.from,
  to: edge.to,
  label: edge.label ?? edge.condition ?? edge.guard
})

const createNodeMeta = (node: GraphNode, doc?: WorkflowNodeDocument): NodeMeta => ({
  id: node.id,
  label: doc?.label ?? node.label,
  type: isNodeType(doc?.type) ? doc!.type : 'task',
  description: doc?.description ?? '',
  owner: doc?.owner ?? '',
  guard: typeof doc?.guard === 'string' ? doc.guard : typeof doc?.metadata?.guard === 'string' ? (doc.metadata.guard as string) : '',
  outputs: Array.isArray(doc?.outputs)
    ? doc?.outputs?.join(', ')
    : Array.isArray(doc?.metadata?.outputs)
      ? (doc?.metadata?.outputs as unknown[]).filter((entry) => typeof entry === 'string').join(', ')
      : ''
})

const normalizeDocument = (input: unknown): WorkflowDocument => {
  if (!input || typeof input !== 'object') throw new Error('Workflow JSON must be an object')
  const payload = input as Partial<WorkflowDocument>
  if (!Array.isArray(payload.nodes)) throw new Error('"nodes" must be an array')
  if (!Array.isArray(payload.edges)) throw new Error('"edges" must be an array')

  const nodes = payload.nodes.map((node, index) => normalizeNode(node, index))
  const validIds = new Set(nodes.map((node) => node.id))
  const edges = payload.edges
    .map(normalizeEdge)
    .filter((edge) => validIds.has(edge.from) && validIds.has(edge.to))

  return {
    name: typeof payload.name === 'string' && payload.name.trim().length ? payload.name.trim() : 'Untitled workflow',
    version: typeof payload.version === 'string' ? payload.version : 'v1',
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    nodes,
    edges,
    metadata: payload.metadata ?? {}
  }
}

const normalizeNode = (node: unknown, index: number): WorkflowNodeDocument => {
  if (!node || typeof node !== 'object') throw new Error('Nodes must be objects')
  const raw = node as Partial<WorkflowNodeDocument>
  const id = typeof raw.id === 'string' && raw.id.trim().length ? raw.id : `node-${index + 1}`
  const label = typeof raw.label === 'string' && raw.label.trim().length ? raw.label : id
  const fallback = spacingPosition(index)
  const x = typeof raw.position?.x === 'number' ? raw.position.x : typeof raw.x === 'number' ? raw.x : fallback.x
  const y = typeof raw.position?.y === 'number' ? raw.position.y : typeof raw.y === 'number' ? raw.y : fallback.y
  const type = isNodeType(raw.type) ? raw.type : 'task'
  const guard = typeof raw.guard === 'string' ? raw.guard : typeof raw.metadata?.guard === 'string' ? (raw.metadata.guard as string) : undefined
  const outputs = Array.isArray(raw.outputs)
    ? raw.outputs
    : Array.isArray(raw.metadata?.outputs)
      ? (raw.metadata.outputs as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : undefined
  return {
    ...raw,
    id,
    label,
    type,
    guard,
    outputs,
    position: { x, y }
  }
}

const normalizeEdge = (edge: unknown): WorkflowEdgeDocument => {
  if (!edge || typeof edge !== 'object') throw new Error('Edges must be objects')
  const raw = edge as Partial<WorkflowEdgeDocument>
  if (!raw.from || !raw.to) throw new Error('Edges require "from" and "to"')
  const from = typeof raw.from === 'string' ? raw.from : String(raw.from)
  const to = typeof raw.to === 'string' ? raw.to : String(raw.to)
  const label = typeof raw.label === 'string' && raw.label.trim().length ? raw.label : undefined
  const condition = typeof raw.condition === 'string' && raw.condition.trim().length ? raw.condition : undefined
  const guard = typeof raw.guard === 'string' && raw.guard.trim().length ? raw.guard : undefined
  return {
    id: typeof raw.id === 'string' && raw.id.trim().length ? raw.id : `${from}-${to}`,
    from,
    to,
    label: label ?? condition ?? guard,
    condition,
    guard
  }
}

const isNodeType = (value: unknown): value is WorkflowNodeType => NODE_TYPES.includes(value as WorkflowNodeType)

const createMetaMap = (doc: WorkflowDocument, graphNodes: GraphNode[]) => {
  const lookup = new Map(doc.nodes.map((node) => [node.id, node]))
  const meta: Record<string, NodeMeta> = {}
  for (const graphNode of graphNodes) {
    meta[graphNode.id] = createNodeMeta(graphNode, lookup.get(graphNode.id))
  }
  return meta
}

const toDocument = (state: {
  name: string
  version: string
  summary: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: Record<string, NodeMeta>
}): WorkflowDocument => {
  return {
    name: state.name,
    version: state.version,
    summary: state.summary,
    nodes: state.nodes.map((node, index) => {
      const meta = state.meta[node.id]
      const base = spacingPosition(index)
      return {
        id: node.id,
        label: meta?.label ?? node.label,
        type: meta?.type ?? 'task',
        description: meta?.description ?? '',
        owner: meta?.owner ?? '',
        guard: meta?.guard ?? '',
        outputs: meta?.outputs?.length ? meta.outputs.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
        position: { x: node.x ?? base.x, y: node.y ?? base.y }
      }
    }),
    edges: state.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      condition: edge.label
    })),
    metadata: { savedAt: new Date().toISOString() }
  }
}

export default function WorkflowEditorPage() {
  const initialGraphNodes = defaultWorkflow.nodes.map((node, index) => toGraphNode(node, index))
  const initialGraphEdges = defaultWorkflow.edges.map(toGraphEdge)

  const [workflowName, setWorkflowName] = createSignal(defaultWorkflow.name)
  const [workflowSummary, setWorkflowSummary] = createSignal(defaultWorkflow.summary ?? '')
  const [workflowVersion, setWorkflowVersion] = createSignal(defaultWorkflow.version ?? 'v1')
  const [graphNodes, setGraphNodes] = createSignal<GraphNode[]>(initialGraphNodes)
  const [graphEdges, setGraphEdges] = createSignal<GraphEdge[]>(initialGraphEdges)
  const [metaMap, setMetaMap] = createSignal<Record<string, NodeMeta>>(createMetaMap(defaultWorkflow, initialGraphNodes))
  const [selection, setSelection] = createSignal<string[]>([])
  const [jsonDraft, setJsonDraft] = createSignal(JSON.stringify(defaultWorkflow, null, 2))
  const [status, setStatus] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const selectedNode = createMemo<SelectedNode | null>(() => {
    const ids = selection()
    if (!ids.length) return null
    const node = graphNodes().find((entry) => entry.id === ids[0])
    if (!node) return null
    const meta = metaMap()[node.id] ?? createNodeMeta(node)
    return { node, meta }
  })

  const updateSelection = (next: string[]) => {
    setSelection(next)
    setStatus(null)
    setError(null)
  }

  const syncGraph = (change: GraphChange) => {
    setGraphNodes(change.nodes)
    setGraphEdges(change.edges)
    setMetaMap((prev) => {
      const next: Record<string, NodeMeta> = {}
      for (const node of change.nodes) {
        next[node.id] = prev[node.id] ?? createNodeMeta(node)
      }
      return next
    })
    setStatus('Canvas updated')
    setError(null)
  }

  const updateNodeMeta = (patch: Partial<NodeMeta>) => {
    const targetId = selection()[0]
    if (!targetId) return
    setMetaMap((prev) => {
      const current = prev[targetId] ?? createNodeMeta({ id: targetId, label: targetId, x: 0, y: 0 })
      return { ...prev, [targetId]: { ...current, ...patch } }
    })
    if (patch.label) {
      setGraphNodes((prev) => prev.map((node) => (node.id === targetId ? { ...node, label: patch.label! } : node)))
    }
    setStatus('Node updated')
    setError(null)
  }

  const removeSelectedNodes = () => {
    const ids = selection()
    if (!ids.length) return
    setGraphNodes((prev) => prev.filter((node) => !ids.includes(node.id)))
    setGraphEdges((prev) => prev.filter((edge) => !ids.includes(edge.from) && !ids.includes(edge.to)))
    setMetaMap((prev) => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    })
    setSelection([])
    setStatus('Removed selected nodes')
    setError(null)
  }

  const serialize = () => {
    const doc = toDocument({
      name: workflowName().trim() || 'Untitled workflow',
      version: workflowVersion().trim() || 'v1',
      summary: workflowSummary().trim(),
      nodes: graphNodes(),
      edges: graphEdges(),
      meta: metaMap()
    })
    const formatted = JSON.stringify(doc, null, 2)
    setJsonDraft(formatted)
    setStatus('Synced canvas into JSON')
    setError(null)
    return formatted
  }

  const copyJson = async () => {
    try {
      const payload = serialize()
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(payload)
        setStatus('Copied JSON to clipboard')
      } else {
        throw new Error('Clipboard not available')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to copy')
    }
  }

  const downloadJson = () => {
    try {
      const payload = serialize()
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${workflowName() || 'workflow'}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setStatus('Downloaded workflow JSON')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to download')
    }
  }

  const loadFromJson = () => {
    try {
      const parsed = JSON.parse(jsonDraft()) as unknown
      const normalized = normalizeDocument(parsed)
      const updatedNodes = normalized.nodes.map((node, index) => toGraphNode(node, index))
      const updatedEdges = normalized.edges.map(toGraphEdge)
      setWorkflowName(normalized.name)
      setWorkflowSummary(normalized.summary ?? '')
      setWorkflowVersion(normalized.version ?? 'v1')
      setGraphNodes(updatedNodes)
      setGraphEdges(updatedEdges)
      setMetaMap(createMetaMap(normalized, updatedNodes))
      setSelection([])
      setStatus('Loaded workflow from JSON')
      setError(null)
      setJsonDraft(JSON.stringify(normalized, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid workflow JSON')
      setStatus(null)
    }
  }

  const resetToDefault = () => {
    const nodes = defaultWorkflow.nodes.map((node, index) => toGraphNode(node, index))
    const edges = defaultWorkflow.edges.map(toGraphEdge)
    setWorkflowName(defaultWorkflow.name)
    setWorkflowSummary(defaultWorkflow.summary ?? '')
    setWorkflowVersion(defaultWorkflow.version ?? 'v1')
    setGraphNodes(nodes)
    setGraphEdges(edges)
    setMetaMap(createMetaMap(defaultWorkflow, nodes))
    setSelection([])
    setJsonDraft(JSON.stringify(defaultWorkflow, null, 2))
    setStatus('Reset to starter workflow')
    setError(null)
  }

  const updateNodeField = (field: keyof NodeMeta, value: string) => {
    updateNodeMeta({ [field]: value } as Partial<NodeMeta>)
  }

  return (
    <div class="flex min-h-screen flex-col bg-[var(--bg-app)] text-[var(--text)]">
      <header class="flex flex-col gap-3 border-b border-[var(--border)] bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 px-6 py-6 text-white shadow-[0_10px_25px_rgba(15,23,42,0.35)]">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <p class="text-xs uppercase tracking-[0.4em] text-white/60">Workflow Builder</p>
            <h1 class="text-2xl font-semibold">2D Node Editor</h1>
            <p class="text-sm text-white/70">Draft, connect, and serialize workflows as JSON for storage or sharing.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20"
              onClick={serialize}
            >
              Sync JSON
            </button>
            <button
              type="button"
              class="rounded-xl border border-white/10 bg-blue-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(59,130,246,0.35)] transition hover:opacity-90"
              onClick={downloadJson}
            >
              Download JSON
            </button>
            <button
              type="button"
              class="rounded-xl border border-white/10 bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(16,185,129,0.25)] transition hover:opacity-90"
              onClick={copyJson}
            >
              Copy
            </button>
            <button
              type="button"
              class="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20"
              onClick={resetToDefault}
            >
              Reset
            </button>
          </div>
        </div>
        <Show when={status() || error()}>
          <div
            class="flex items-center gap-3 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white"
            classList={{ 'border-red-400/60 text-red-100 bg-red-500/10': Boolean(error()) }}
          >
            <span class="text-xs uppercase tracking-[0.3em] text-white/60">State</span>
            <span>{error() ?? status()}</span>
          </div>
        </Show>
      </header>

      <div class="grid flex-1 grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[420px,1fr]">
        <div class="flex flex-col gap-4">
          <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-[0_12px_26px_rgba(15,23,42,0.12)]">
            <div class="mb-3 flex items-center justify-between">
              <div>
                <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Metadata</p>
                <p class="text-lg font-semibold text-[var(--text)]">Workflow context</p>
              </div>
            </div>
            <div class="flex flex-col gap-3">
              <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                Name
                <input
                  class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={workflowName()}
                  onInput={(event) => setWorkflowName(event.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                Version
                <input
                  class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={workflowVersion()}
                  onInput={(event) => setWorkflowVersion(event.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                Summary
                <textarea
                  class="min-h-[72px] rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={workflowSummary()}
                  onInput={(event) => setWorkflowSummary(event.currentTarget.value)}
                />
              </label>
            </div>
          </section>

          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-[0_12px_26px_rgba(15,23,42,0.12)]">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">JSON</p>
                <p class="text-lg font-semibold text-[var(--text)]">Load or refine</p>
              </div>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-1 text-xs font-semibold text-[var(--text)]"
                  onClick={loadFromJson}
                >
                  Load JSON
                </button>
                <button
                  type="button"
                  class="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-1 text-xs font-semibold text-[var(--text)]"
                  onClick={serialize}
                >
                  Update draft
                </button>
              </div>
            </div>
            <textarea
              class="h-[220px] w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-[var(--text)] font-mono text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={jsonDraft()}
              onInput={(event) => setJsonDraft(event.currentTarget.value)}
            />
          </section>

          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-[0_12px_26px_rgba(15,23,42,0.12)]">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Selection</p>
                <p class="text-lg font-semibold text-[var(--text)]">Node inspector</p>
              </div>
              <button
                type="button"
                class="rounded-lg border border-red-300 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-500/20 disabled:opacity-50"
                onClick={removeSelectedNodes}
                disabled={!selection().length}
              >
                Remove
              </button>
            </div>
            <Show
              when={selectedNode()}
              fallback={<p class="text-sm text-[var(--text-muted)]">Select a node to edit its attributes.</p>}
            >
              {(entry) => (
                <div class="flex flex-col gap-3">
                  <div class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">
                    {entry().node.id}
                  </div>
                  <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                    Label
                    <input
                      class="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={entry().meta.label}
                      onInput={(event) => updateNodeField('label', event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                    Type
                    <select
                      class="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={entry().meta.type}
                      onChange={(event) => updateNodeField('type', event.currentTarget.value as WorkflowNodeType)}
                    >
                      <For each={NODE_TYPES}>{(type) => <option value={type}>{type}</option>}</For>
                    </select>
                  </label>
                  <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                    Owner
                    <input
                      class="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={entry().meta.owner}
                      onInput={(event) => updateNodeField('owner', event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                    Guard / condition
                    <input
                      class="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={entry().meta.guard}
                      onInput={(event) => updateNodeField('guard', event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                    Outputs (comma separated)
                    <input
                      class="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={entry().meta.outputs}
                      onInput={(event) => updateNodeField('outputs', event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                    Description
                    <textarea
                      class="min-h-[90px] rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={entry().meta.description}
                      onInput={(event) => updateNodeField('description', event.currentTarget.value)}
                    />
                  </label>
                </div>
              )}
            </Show>
          </section>
        </div>

        <section class="flex flex-col gap-3 rounded-3xl border border-[var(--border)] bg-[var(--bg-card)]/90 p-4 shadow-[0_18px_40px_rgba(15,23,42,0.18)]">
          <div class="flex items-center justify-between px-1">
            <div class="flex flex-col gap-1">
              <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Canvas</p>
              <p class="text-lg font-semibold text-[var(--text)]">Design the workflow</p>
              <p class="text-sm text-[var(--text-muted)]">Drag to move, double-click to rename, right-click edges to label.</p>
            </div>
            <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <div class="rounded-full bg-blue-600 px-3 py-1 text-white">Nodes: {graphNodes().length}</div>
              <div class="rounded-full bg-purple-600 px-3 py-1 text-white">Edges: {graphEdges().length}</div>
            </div>
          </div>
          <div class="overflow-hidden rounded-2xl border border-[var(--border)] bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-3">
            <NodeGraph
              width={1100}
              height={640}
              nodes={graphNodes()}
              edges={graphEdges()}
              onGraphChange={syncGraph}
              onSelectionChange={updateSelection}
            />
          </div>
          <div class="flex flex-wrap gap-3 px-1 text-xs text-[var(--text-muted)]">
            <span class="rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-1">Shift + drag to link nodes</span>
            <span class="rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-1">Right-click edge to edit label</span>
            <span class="rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-1">Paste JSON then "Load JSON" to import</span>
          </div>
        </section>
      </div>
    </div>
  )
}
