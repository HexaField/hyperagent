export type Part = {
  id: string
  type: string
  text?: string | null
  start?: string | null
  end?: string | null
  [key: string]: any
}

export type ToolCall = {
  id: string
  text: string
  start?: string | null
  end?: string | null
  durationMs?: number | null
}

export function extractToolCalls(parts: Part[] | undefined): ToolCall[] {
  if (!parts || parts.length === 0) return []
  const calls: ToolCall[] = []
  for (const p of parts) {
    if (!p) continue
    if (p.type === 'tool') {
      const start = typeof p.start === 'string' ? p.start : p.start ? String(p.start) : null
      const end = typeof p.end === 'string' ? p.end : p.end ? String(p.end) : null
      let duration: number | null = null
      if (start && end) {
        const s = Date.parse(start)
        const e = Date.parse(end)
        if (!isNaN(s) && !isNaN(e)) duration = Math.max(0, e - s)
      }
      calls.push({
        id: p.id,
        text: (p.text ?? '').toString(),
        start,
        end,
        durationMs: duration
      })
    }
  }
  return calls
}

export function extractDiffText(part: Part | undefined): string | null {
  if (!part) return null
  // Common locations for diffs: part.text, part.diff, part.payload
  if (typeof part.text === 'string' && /diff --git|Index:|^@@ /m.test(part.text)) return part.text
  if (typeof part.diff === 'string' && /diff --git|Index:|^@@ /m.test(part.diff)) return part.diff
  if (typeof part.payload === 'string' && /diff --git|Index:|^@@ /m.test(part.payload)) return part.payload
  // Check for diffs stored in state.output or state.metadata.diff (used by edit tools)
  if (part.state) {
    const s = part.state as any
    if (typeof s.output === 'string' && /diff --git|Index:|^@@ /m.test(s.output)) return s.output
    if (s.metadata && typeof s.metadata.diff === 'string' && /diff --git|Index:|^@@ /m.test(s.metadata.diff))
      return s.metadata.diff
  }
  return null
}
