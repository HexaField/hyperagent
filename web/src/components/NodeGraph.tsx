import { For, Show, createMemo, createSignal } from 'solid-js'

export type GraphNode = {
  id: string
  label: string
  x: number
  y: number
}

export type GraphEdge = {
  id: string
  from: string
  to: string
  label?: string
}

export type NodeGraphProps = {
  width?: number
  height?: number
  initialNodes?: GraphNode[]
  initialEdges?: GraphEdge[]
}

const DEFAULT_WIDTH = 860
const DEFAULT_HEIGHT = 520

const DEFAULT_NODES: GraphNode[] = [
  { id: 'node-start', label: 'Start', x: 180, y: 160 },
  { id: 'node-transform', label: 'Transform', x: 420, y: 140 },
  { id: 'node-ship', label: 'Ship', x: 640, y: 320 }
]

const DEFAULT_EDGES: GraphEdge[] = [
  { id: 'edge-start-transform', from: 'node-start', to: 'node-transform' },
  { id: 'edge-transform-ship', from: 'node-transform', to: 'node-ship' }
]

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`

const duplicateNodes = (nodes: GraphNode[]) => nodes.map(node => ({ ...node }))
const duplicateEdges = (edges: GraphEdge[]) => edges.map(edge => ({ ...edge }))

const HANDLE_DIRECTIONS = ['top', 'right', 'bottom', 'left'] as const
const NODE_SNAP_RADIUS = 96

export function NodeGraph (props: NodeGraphProps) {
  const width = () => props.width ?? DEFAULT_WIDTH
  const height = () => props.height ?? DEFAULT_HEIGHT

  const [nodes, setNodes] = createSignal<GraphNode[]>(
    duplicateNodes(props.initialNodes ?? DEFAULT_NODES)
  )
  const [edges, setEdges] = createSignal<GraphEdge[]>(
    duplicateEdges(props.initialEdges ?? DEFAULT_EDGES)
  )
  const [selection, setSelection] = createSignal<string[]>([])
  const [nodeLabel, setNodeLabel] = createSignal('')
  const [editingNodeId, setEditingNodeId] = createSignal<string | null>(null)
  const [editingValue, setEditingValue] = createSignal('')
  const markerId = uid('arrow')

  let canvasRef: HTMLDivElement | undefined
  const [linkDraft, setLinkDraft] = createSignal<{ sourceId: string; x: number; y: number } | null>(null)

  const selectedCount = createMemo(() => selection().length)

  const nodeMap = createMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of nodes()) {
      map.set(node.id, node)
    }
    return map
  })

  const resolvedEdges = createMemo(() => {
    const map = nodeMap()
    return edges()
      .map(edge => {
        const from = map.get(edge.from)
        const to = map.get(edge.to)
        if (!from || !to) return null
        const centerX = (from.x + to.x) / 2
        const centerY = (from.y + to.y) / 2
        return { edge, from, to, centerX, centerY }
      })
      .filter(Boolean) as { edge: GraphEdge; from: GraphNode; to: GraphNode; centerX: number; centerY: number }[]
  })

  const selectionIncludes = (nodeId: string) => selection().includes(nodeId)
  const isEditing = (nodeId: string) => editingNodeId() === nodeId

  const addEdge = (from: string, to: string) => {
    if (from === to) return false
    const exists = edges().some(edge => edge.from === from && edge.to === to)
    if (exists) return false
    setEdges(prev => [...prev, { id: uid('edge'), from, to }])
    return true
  }

  const findNodeNear = (x: number, y: number, excludeId?: string) => {
    let closest: GraphNode | null = null
    let minDistance = NODE_SNAP_RADIUS
    for (const node of nodes()) {
      if (node.id === excludeId) continue
      const distance = Math.hypot(node.x - x, node.y - y)
      if (distance < minDistance) {
        closest = node
        minDistance = distance
      }
    }
    return closest
  }

  const toggleNodeSelection = (nodeId: string) => {
    if (editingNodeId()) return
    setSelection(prev => {
      if (prev.includes(nodeId)) {
        return prev.filter(id => id !== nodeId)
      }
      const next = [...prev.slice(-1), nodeId]
      return next
    })
  }

  type CreateNodeOptions = { label?: string; sourceId?: string; useInput?: boolean }

  const createNode = (x: number, y: number, options: CreateNodeOptions = {}) => {
    const { label: labelOverride, sourceId, useInput } = options
    const label = labelOverride?.trim() || (useInput ? nodeLabel().trim() : '') || `Node ${nodes().length + 1}`
    const newNode: GraphNode = {
      id: uid('node'),
      label,
      x: clamp(x, 36, width() - 36),
      y: clamp(y, 36, height() - 36)
    }
    setNodes(prev => [...prev, newNode])
    if (sourceId) {
      addEdge(sourceId, newNode.id)
    }
    if (useInput) {
      setNodeLabel('')
    }
    return newNode
  }

  const addNode = () => {
    createNode(120 + nodes().length * 90, 120 + (nodes().length % 3) * 90, { useInput: true })
  }

  const connectNodes = () => {
    const [source, target] = selection()
    if (!source || !target || source === target) return
    const added = addEdge(source, target)
    if (!added) return
    setSelection([])
  }

  const resetGraph = () => {
    setNodes(duplicateNodes(props.initialNodes ?? DEFAULT_NODES))
    setEdges(duplicateEdges(props.initialEdges ?? DEFAULT_EDGES))
    setSelection([])
    setNodeLabel('')
  }

  const startNodeDrag = (nodeId: string, pointerEvent: PointerEvent) => {
    if (pointerEvent.button !== 0 || editingNodeId()) return
    pointerEvent.preventDefault()
    pointerEvent.stopPropagation()

    const canvas = canvasRef
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const node = nodeMap().get(nodeId)
    if (!node) return

    const offsetX = node.x - (pointerEvent.clientX - rect.left)
    const offsetY = node.y - (pointerEvent.clientY - rect.top)

    const handleMove = (moveEvent: PointerEvent) => {
      const nextX = clamp(moveEvent.clientX - rect.left + offsetX, 36, width() - 36)
      const nextY = clamp(moveEvent.clientY - rect.top + offsetY, 36, height() - 36)
      setNodes(prev => prev.map(entry => (entry.id === nodeId ? { ...entry, x: nextX, y: nextY } : entry)))
    }

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  const handleNodePointerDown = (nodeId: string, event: PointerEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    const hintTarget = target.closest('.node-graph__hint')
    if (hintTarget) {
      startHandleDrag(nodeId, event)
      return
    }
    startNodeDrag(nodeId, event)
  }

  const startHandleDrag = (nodeId: string, pointerEvent: PointerEvent) => {
    if (pointerEvent.button !== 0 || editingNodeId()) return
    pointerEvent.preventDefault()
    pointerEvent.stopPropagation()
    const canvas = canvasRef
    if (!canvas) return
    const node = nodeMap().get(nodeId)
    if (!node) return

    const rect = canvas.getBoundingClientRect()
    const pointerId = pointerEvent.pointerId
    const originTarget = pointerEvent.target as HTMLElement | null
    // Ensure we keep receiving pointer events even if the cursor leaves the hint hitbox.
    originTarget?.setPointerCapture?.(pointerId)
    const updateDraft = (clientX: number, clientY: number) => {
      const relX = clamp(clientX - rect.left, 36, width() - 36)
      const relY = clamp(clientY - rect.top, 36, height() - 36)
      const snapped = findNodeNear(relX, relY, nodeId)
      const x = snapped?.x ?? relX
      const y = snapped?.y ?? relY
      setLinkDraft({ sourceId: nodeId, x, y })
    }

    updateDraft(pointerEvent.clientX, pointerEvent.clientY)

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      updateDraft(moveEvent.clientX, moveEvent.clientY)
    }

    let dragActive = true

    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove, true)
      window.removeEventListener('pointerup', handleUp, true)
      window.removeEventListener('pointercancel', handleCancel, true)
      originTarget?.removeEventListener('pointermove', handleMove)
      originTarget?.removeEventListener('pointerup', handleUp)
      originTarget?.removeEventListener('pointercancel', handleCancel)
      originTarget?.releasePointerCapture?.(pointerId)
    }

    const finishDrag = (callback?: () => void) => {
      if (!dragActive) return
      dragActive = false
      cleanup()
      callback?.()
    }

    const handleCancel = () => {
      finishDrag(() => setLinkDraft(null))
    }

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      finishDrag(() => {
        const relX = clamp(upEvent.clientX - rect.left, 36, width() - 36)
        const relY = clamp(upEvent.clientY - rect.top, 36, height() - 36)
        const dropElement = document.elementFromPoint(upEvent.clientX, upEvent.clientY) ?? upEvent.target
        const hintedNodeId = (dropElement as HTMLElement | null)?.closest('[data-node-id]')?.getAttribute('data-node-id')
        const targetNode = hintedNodeId && hintedNodeId !== nodeId
          ? nodeMap().get(hintedNodeId)
          : findNodeNear(relX, relY, nodeId)
        const distance = Math.hypot(relX - node.x, relY - node.y)
        if (targetNode) {
          addEdge(nodeId, targetNode.id)
        } else if (distance > 24) {
          createNode(relX, relY, { sourceId: nodeId })
        }
        setLinkDraft(null)
      })
    }

    window.addEventListener('pointermove', handleMove, true)
    window.addEventListener('pointerup', handleUp, true)
    window.addEventListener('pointercancel', handleCancel, true)
    originTarget?.addEventListener('pointermove', handleMove)
    originTarget?.addEventListener('pointerup', handleUp)
    originTarget?.addEventListener('pointercancel', handleCancel)
  }

  const handleCanvasContextMenu = (event: MouseEvent) => {
    if (!canvasRef) return
    const target = event.target as HTMLElement
    if (target.closest('.node-graph__node') || target.closest('.node-graph__hint') || target.closest('.node-graph__edge-label')) {
      return
    }
    event.preventDefault()
    const rect = canvasRef.getBoundingClientRect()
    const relX = clamp(event.clientX - rect.left, 36, width() - 36)
    const relY = clamp(event.clientY - rect.top, 36, height() - 36)
    createNode(relX, relY, { useInput: true })
  }

  const handleEdgeContextMenu = (event: MouseEvent, edgeId: string) => {
    event.preventDefault()
    const existing = edges().find(edge => edge.id === edgeId)
    const next = window.prompt('Edge label', existing?.label ?? '')
    if (next === null) return
    const trimmed = next.trim()
    setEdges(prev =>
      prev.map(edge => (edge.id === edgeId ? { ...edge, label: trimmed || undefined } : edge))
    )
  }

  const beginNodeEdit = (nodeId: string) => {
    const node = nodeMap().get(nodeId)
    if (!node) return
    setEditingNodeId(nodeId)
    setEditingValue(node.label)
  }

  const commitNodeEdit = () => {
    const nodeId = editingNodeId()
    if (!nodeId) return
    const nextLabel = editingValue().trim()
    if (nextLabel.length) {
      setNodes(prev => prev.map(node => (node.id === nodeId ? { ...node, label: nextLabel } : node)))
    }
    setEditingNodeId(null)
    setEditingValue('')
  }

  const cancelNodeEdit = () => {
    setEditingNodeId(null)
    setEditingValue('')
  }

  return (
    <section class="node-graph">
      <div class="node-graph__panel">
        <div class="node-graph__panel-header">
          <div>
            <p class="node-graph__panel-title">Flow Builder</p>
            <p class="node-graph__panel-subtitle">Drag, connect, and label steps to explore ideas.</p>
          </div>
          <button class="node-graph__reset" type="button" onClick={resetGraph}>
            Reset graph
          </button>
        </div>

        <div class="node-graph__controls">
          <input
            class="node-graph__input"
            placeholder="Node label"
            value={nodeLabel()}
            onInput={event => setNodeLabel(event.currentTarget.value)}
          />
          <button class="node-graph__button" type="button" onClick={addNode}>
            Add node
          </button>
          <button
            class="node-graph__button"
            type="button"
            disabled={selectedCount() < 2}
            onClick={connectNodes}
          >
            Connect selection
          </button>
        </div>

        <div class="node-graph__learn">
          <p>Select two nodes to create an edge. Drag nodes to re-arrange the flow.</p>
          <p class="node-graph__hint">Selected: {selectedCount()}</p>
        </div>
      </div>

      <div class="node-graph__surface" onContextMenu={handleCanvasContextMenu}>
        <div
          class="node-graph__canvas"
          ref={canvas => {
            canvasRef = canvas
          }}
          style={{ width: `${width()}px`, height: `${height()}px` }}
        >
          <svg
            class="node-graph__edges"
            width={width()}
            height={height()}
            viewBox={`0 0 ${width()} ${height()}`}
            preserveAspectRatio="none"
          >
          <For each={resolvedEdges()}>
            {entry => (
              <line
                  class="node-graph__edge-line"
                stroke="var(--muted)"
                stroke-width="2"
                x1={entry.from.x}
                y1={entry.from.y}
                x2={entry.to.x}
                y2={entry.to.y}
                marker-end={`url(#${markerId})`}
                  onContextMenu={event => handleEdgeContextMenu(event, entry.edge.id)}
              />
            )}
          </For>
            <Show when={linkDraft()}>
              {draftAccessor => {
                const draft = draftAccessor()
                if (!draft) return null
                const source = nodeMap().get(draft.sourceId)
                if (!source) return null
                return (
                  <line
                    class="node-graph__edge-line node-graph__edge-line--draft"
                    stroke-dasharray="6 4"
                    stroke="var(--muted)"
                    stroke-width="2"
                    x1={source.x}
                    y1={source.y}
                    x2={draft.x}
                    y2={draft.y}
                  />
                )
              }}
            </Show>
          <defs>
            <marker
              id={markerId}
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="2"
              orient="auto"
            >
              <path d="M0,0 L0,4 L4,2 z" fill="var(--muted)" />
            </marker>
          </defs>
          </svg>

          <For each={nodes()}>
            {node => (
              <button
                type="button"
                class={`node-graph__node ${selectionIncludes(node.id) ? 'is-selected' : ''}`}
                style={{ left: `${node.x - 50}px`, top: `${node.y - 24}px` }}
                data-node-id={node.id}
                onPointerDown={event => handleNodePointerDown(node.id, event)}
                onClick={() => toggleNodeSelection(node.id)}
                onDblClick={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  beginNodeEdit(node.id)
                }}
              >
                <Show
                  when={isEditing(node.id)}
                  fallback={<span class="node-graph__node-label">{node.label}</span>}
                >
                  <input
                    class="node-graph__node-input"
                    value={editingValue()}
                    onInput={event => setEditingValue(event.currentTarget.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitNodeEdit()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelNodeEdit()
                      }
                    }}
                    onBlur={commitNodeEdit}
                    ref={el => {
                      requestAnimationFrame(() => {
                        el.focus()
                        el.select()
                      })
                    }}
                  />
                </Show>
                <For each={HANDLE_DIRECTIONS}>
                  {direction => (
                    <span class={`node-graph__hint node-graph__hint--${direction}`} />
                  )}
                </For>
              </button>
            )}
          </For>

          <For each={resolvedEdges()}>
            {entry => (
              <Show when={entry.edge.label}>
                <div
                  class="node-graph__edge-label"
                  style={{ left: `${entry.centerX}px`, top: `${entry.centerY}px` }}
                  onContextMenu={event => handleEdgeContextMenu(event, entry.edge.id)}
                >
                  {entry.edge.label}
                </div>
              </Show>
            )}
          </For>
        </div>
      </div>

      <footer class="node-graph__footer">
        <div>
          <p class="node-graph__footer-title">Nodes</p>
          <div class="node-graph__footer-list">
            <For each={nodes()}>
              {node => (
                <div class="node-graph__tag">
                  <span>{node.label}</span>
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={edges().length}>
          <div>
            <p class="node-graph__footer-title">Edges</p>
            <div class="node-graph__footer-list">
              <For each={edges()}>
                {edge => {
                  const from = nodeMap().get(edge.from)
                  const to = nodeMap().get(edge.to)
                  if (!from || !to) return null
                  return (
                    <div class="node-graph__tag">
                      <span>
                        {from.label} → {to.label}
                      </span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>
      </footer>
    </section>
  )
}

export default NodeGraph
