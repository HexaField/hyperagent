import type { JSX } from 'solid-js'
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { LogEntry } from '../lib/codingAgent'
import type { Part } from '../lib/messageParts'
import { extractDiffText, extractToolCalls } from '../lib/messageParts'
import ToolRenderer from '../lib/ToolRenderer'
import DiffViewer from './DiffViewer'
import TodoList from './TodoList'
import ToolCallList from './ToolCallList'

const STEP_TYPE_LABELS: Record<string, string> = {
  'step-start': 'Step started',
  step_start: 'Step started',
  'step-finish': 'Step finished',
  step_finish: 'Step finished',
  'step-removed': 'Step removed',
  step_removed: 'Step removed'
}

const safeParseJson = (raw: string): any | null => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const extractNestedText = (payload: any): string | null => {
  if (payload === null || payload === undefined) return null
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    return trimmed.length ? trimmed : null
  }
  if (typeof payload !== 'object') return null
  const candidates = [
    payload.text,
    payload.message,
    payload.output,
    payload.summary,
    payload.details,
    payload.value,
    payload.raw
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  const nestedSources = [payload.part, payload.payload, payload.data, payload.response]
  for (const source of nestedSources) {
    const nested = extractNestedText(source)
    if (nested) return nested
  }
  return null
}

const normalizeStepText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('{')) return trimmed
  const parsed = safeParseJson(trimmed)
  if (!parsed) return null
  const extracted = extractNestedText(parsed)
  return extracted ?? null
}

const deriveStepDetails = (part: any): string | null => {
  const candidates: Array<unknown> = [
    part?.text,
    part?.summary,
    part?.description,
    part?.details,
    part?.output,
    part?.state?.output,
    part?.state?.message
  ]
  for (const entry of candidates) {
    const text = normalizeStepText(entry)
    if (text) return text
  }
  return null
}

const parseStepEventPayload = (raw: string | null): any | null => {
  if (!raw) return null
  const parsed = safeParseJson(raw)
  if (!parsed) return null
  const type = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : ''
  if (!type.startsWith('step_')) return null
  return parsed
}

type SectionConfig = {
  labels: string[]
  defaultOpen: string
}

const SECTION_CONFIGS: Record<string, SectionConfig> = {
  worker: { labels: ['Plan', 'Work', 'Requests'], defaultOpen: 'Requests' },
  verifier: { labels: ['Verdict', 'Critique', 'Instructions'], defaultOpen: 'Verdict' }
}

const SECTION_LABEL_LOOKUP = new Set(
  Object.values(SECTION_CONFIGS).flatMap((config) => config.labels.map((label) => label.toLowerCase()))
)

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const MAX_PART_EXTRACTION_DEPTH = 4

const isLikelyPart = (value: unknown): value is Part => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.type === 'string' ||
    typeof candidate.tool === 'string' ||
    typeof candidate.toolName === 'string' ||
    typeof candidate.text === 'string'
  )
}

const extractPartsFromPayload = (payload: unknown, depth = 0): Part[] | null => {
  if (payload === null || payload === undefined || depth > MAX_PART_EXTRACTION_DEPTH) return null
  if (Array.isArray(payload)) return payload as Part[]
  if (isLikelyPart(payload)) return [payload]
  if (isPlainObject(payload)) {
    for (const value of Object.values(payload)) {
      const resolved = extractPartsFromPayload(value, depth + 1)
      if (resolved && resolved.length) return resolved
    }
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = safeParseJson(trimmed)
      if (parsed) return extractPartsFromPayload(parsed, depth + 1)
    }
  }
  return null
}

const extractDiffPatchFromPayload = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const diff = (payload as any).diff
  if (!diff || typeof diff !== 'object') return null
  const patch = typeof diff.patch === 'string' ? diff.patch.trim() : ''
  return patch.length ? patch : null
}

const resolveMessageText = (payload: unknown): string | null => {
  if (payload === null || payload === undefined) return null
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = safeParseJson(trimmed)
      if (parsed) {
        const extracted = extractNestedText(parsed)
        if (extracted) return extracted
      }
    }
    return trimmed
  }
  const extracted = extractNestedText(payload)
  if (extracted) return extracted
  if (isPlainObject(payload) && typeof payload.raw === 'string') {
    return resolveMessageText(payload.raw)
  }
  return null
}

const CollapsibleSection = (props: { title: string; defaultOpen?: boolean; children?: JSX.Element }) => {
  const [open, setOpen] = createSignal(Boolean(props.defaultOpen))
  return (
    <details
      class="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]"
      open={open()}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-semibold text-[var(--text)]">
        <span>{props.title}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          class={`transition-transform duration-150 ${open() ? 'rotate-90' : ''}`}
        >
          <path fill="currentColor" d="M9 6l6 6-6 6" />
        </svg>
      </summary>
      <div class="border-t border-[var(--border)] px-3 py-2">{props.children}</div>
    </details>
  )
}

type SectionExtractionResult = {
  prefix: string | null
  sections: Record<string, string | null>
}

function extractLabeledSections(text: string, labels: string[]): SectionExtractionResult {
  const normalized = new Map(labels.map((label) => [label.toLowerCase(), label]))
  const buffers = new Map(labels.map((label) => [label, [] as string[]]))
  const prefixLines: string[] = []
  let current: string | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine ?? ''
    const headingMatch = line.match(/^([A-Za-z ]+?):\s*(.*)$/)
    if (headingMatch) {
      const key = headingMatch[1]?.trim().toLowerCase()
      const canonical = key ? normalized.get(key) : undefined
      if (canonical) {
        current = canonical
        const remainder = headingMatch[2]?.trim()
        if (remainder) buffers.get(canonical)?.push(remainder)
        continue
      }
    }
    if (current) {
      buffers.get(current)?.push(line)
    } else {
      prefixLines.push(line)
    }
  }

  const sections: Record<string, string | null> = {}
  for (const label of labels) {
    const chunk = buffers.get(label)?.join('\n').trim()
    sections[label] = chunk && chunk.length ? chunk : null
  }

  const prefix = prefixLines.join('\n').trim()
  return { prefix: prefix || null, sections }
}

const formatSectionValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value.filter(Boolean).join('\n') || null
    try {
      const serialized = JSON.stringify(value, null, 2)
      return serialized ?? null
    } catch {
      return null
    }
  }
  if (typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value, null, 2)
      return serialized ?? null
    } catch {
      return null
    }
  }
  return null
}

type SectionExtractionOptions = {
  omitKeys?: string[]
}

function extractSectionsFromObject(
  obj: Record<string, unknown>,
  labels: string[],
  options?: SectionExtractionOptions
): SectionExtractionResult {
  const normalized = new Map(labels.map((label) => [label.toLowerCase(), label]))
  const lowerToSourceKey = new Map(Object.keys(obj).map((key) => [key.toLowerCase(), key]))
  const omit = new Set((options?.omitKeys ?? []).map((key) => key.toLowerCase()))
  const sections: Record<string, string | null> = {}
  for (const label of labels) {
    const sourceKey = lowerToSourceKey.get(label.toLowerCase())
    if (sourceKey && omit.has(sourceKey.toLowerCase())) {
      sections[label] = null
      continue
    }
    const rawValue = sourceKey ? obj[sourceKey] : undefined
    sections[label] = formatSectionValue(rawValue)
  }

  const prefixLines: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase()
    if (normalized.has(lower) || omit.has(lower)) continue
    const formatted = formatSectionValue(value)
    if (formatted) prefixLines.push(`${key}: ${formatted}`)
  }

  const prefix = prefixLines.join('\n').trim()
  return { prefix: prefix || null, sections }
}

const coerceSectionPayload = (value: string | Record<string, unknown>): string | Record<string, unknown> | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = safeParseJson(trimmed)
      if (parsed && isPlainObject(parsed)) return parsed
    }
    return trimmed
  }
  return isPlainObject(value) ? value : null
}

const renderStructuredSections = (
  body: string | Record<string, unknown> | null,
  role?: string | null
): JSX.Element | null => {
  if (!body) return null
  const payload = coerceSectionPayload(body)
  if (!payload) return null
  const normalizedRole = role?.toLowerCase() ?? null
  const candidateKeys: string[] = []
  if (normalizedRole && SECTION_CONFIGS[normalizedRole]) candidateKeys.push(normalizedRole)
  for (const key of Object.keys(SECTION_CONFIGS)) {
    if (!candidateKeys.includes(key)) candidateKeys.push(key)
  }

  const renderConfig = (extraction: SectionExtractionResult, config: SectionConfig) => (
    <div class="space-y-2">
      {extraction.prefix ? <p class="whitespace-pre-wrap text-sm text-[var(--text)]">{extraction.prefix}</p> : null}
      <For each={config.labels}>
        {(label) => {
          const content = extraction.sections[label]
          if (!content) return null
          return (
            <CollapsibleSection title={label} defaultOpen={label === config.defaultOpen}>
              <p class="whitespace-pre-wrap text-sm text-[var(--text)]">{content}</p>
            </CollapsibleSection>
          )
        }}
      </For>
    </div>
  )

  let fallbackView: JSX.Element | null = null

  for (const key of candidateKeys) {
    const config = SECTION_CONFIGS[key]
    if (!config) continue
    const extraction =
      typeof payload === 'string'
        ? extractLabeledSections(payload, config.labels)
        : extractSectionsFromObject(payload, config.labels, key === 'verifier' ? { omitKeys: ['priority'] } : undefined)
    const hasAnySection = config.labels.some((label) => Boolean(extraction.sections[label]))
    const hasPrefix = Boolean(extraction.prefix)
    if (!hasAnySection && !hasPrefix) continue
    const view = renderConfig(extraction, config)
    if (hasAnySection) return view
    if (!fallbackView && hasPrefix) fallbackView = view
  }

  return fallbackView
}

const renderStepPart = (part: any, label: string, role?: string | null): JSX.Element => {
  const body = deriveStepDetails(part)
  const structured = renderStructuredSections(body, role)
  if (!structured && (!body || !body.trim())) return null
  return (
    <div class="mb-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm">
      <div class="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <span>{label}</span>
      </div>
      {structured ? (
        <div class="mt-2">{structured}</div>
      ) : (
        <Show when={body} fallback={null} keyed>
          {(content) => <p class="mt-1 whitespace-pre-wrap text-[var(--text)]">{content}</p>}
        </Show>
      )}
    </div>
  )
}

const STRUCTURED_BODY_PATHS = ['body', 'payload', 'data', 'response', 'value', 'message', 'content', 'result', 'state']
const MAX_STRUCTURED_BODY_DEPTH = 4

const hasSectionLabelKeys = (obj: Record<string, unknown>): boolean => {
  return Object.keys(obj).some((key) => SECTION_LABEL_LOOKUP.has(key.toLowerCase()))
}

const extractStructuredBody = (payload: unknown, depth = 0): Record<string, unknown> | null => {
  if (depth > MAX_STRUCTURED_BODY_DEPTH || payload === null || payload === undefined) return null
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = safeParseJson(trimmed)
      if (parsed) return extractStructuredBody(parsed, depth + 1)
    }
    return null
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractStructuredBody(item, depth + 1)
      if (nested) return nested
    }
    return null
  }
  if (!isPlainObject(payload)) return null
  if (hasSectionLabelKeys(payload)) return payload
  for (const key of STRUCTURED_BODY_PATHS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const nested = extractStructuredBody(payload[key], depth + 1)
      if (nested) return nested
    }
  }
  return null
}

type TodoPayload = {
  content?: string
  text?: string
  id?: string | number
  priority?: 'high' | 'medium' | 'low'
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

const parseTodoListPayload = (candidate: string | null) => {
  if (!candidate) return null
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (!Array.isArray(parsed)) return null
    const entries = parsed.filter(
      (item): item is TodoPayload => isPlainObject(item) && ('content' in item || 'text' in item)
    )
    if (entries.length === 0) return null
    return entries.map((entry, index) => ({
      content: String(entry.content ?? entry.text ?? ''),
      id: String(entry.id ?? `todo-${index + 1}`),
      priority: entry.priority ?? 'low',
      status: entry.status ?? 'pending'
    }))
  } catch {
    return null
  }
}

type FileTagPayload = { path?: string; preview?: string }
type DiagnosticEntry = { severity?: string; level?: string; message?: string; msg?: string; range?: unknown }
type DiagnosticsPayload = { path?: string; diagnostics?: DiagnosticEntry[] }

const coerceDiagnosticEntries = (value: unknown): DiagnosticEntry[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const entries = value.filter((item): item is DiagnosticEntry => isPlainObject(item))
  return entries.length ? entries : undefined
}

const parseFileTagPayload = (
  candidate: string | null
):
  | { type: 'file'; value: FileTagPayload }
  | { type: 'file-diagnostic'; value: DiagnosticsPayload }
  | { type: 'project-diagnostic'; value: DiagnosticsPayload }
  | { type: 'file-diagnostic-array'; value: DiagnosticsPayload[] }
  | null => {
  if (!candidate) return null
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (isPlainObject(parsed)) {
      const path = typeof parsed.path === 'string' ? parsed.path : undefined
      const preview = typeof parsed.preview === 'string' ? parsed.preview : undefined
      if (parsed.type === 'file' && path) return { type: 'file', value: { path, preview } }
      const diagnostics = coerceDiagnosticEntries(parsed.diagnostics)
      if (diagnostics) {
        const payload: DiagnosticsPayload = { path, diagnostics }
        if (parsed.type === 'file-diagnostic' && path) return { type: 'file-diagnostic', value: payload }
        if (parsed.type === 'project-diagnostic') return { type: 'project-diagnostic', value: payload }
      }
    }
    if (Array.isArray(parsed)) {
      const diagnostics: DiagnosticsPayload[] = []
      for (const item of parsed) {
        if (!isPlainObject(item) || typeof item.path !== 'string') continue
        const entries = coerceDiagnosticEntries(item.diagnostics)
        if (!entries || entries.length === 0) continue
        diagnostics.push({ path: item.path, diagnostics: entries })
      }
      if (diagnostics.length) return { type: 'file-diagnostic-array', value: diagnostics }
    }
    return null
  } catch {
    return null
  }
}

const renderFileTag = (fileObj: FileTagPayload) => (
  <div class="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm">
    <div class="font-semibold">File: {fileObj.path}</div>
    {fileObj.preview ? <pre class="mt-2 whitespace-pre-wrap">{String(fileObj.preview)}</pre> : null}
  </div>
)

const renderDiagnosticsTag = (diagObj: DiagnosticsPayload) => {
  const diags: DiagnosticEntry[] = Array.isArray(diagObj.diagnostics) ? diagObj.diagnostics : []
  return (
    <div class="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm">
      <div class="font-semibold">Diagnostics for {diagObj.path ?? 'project'}</div>
      <ul class="mt-2 list-disc pl-4">
        {diags.map((d) => (
          <li>
            <div class="font-semibold">{d.severity ?? d.level ?? 'info'}</div>
            <div class="text-xs text-[var(--text-muted)]">{d.message ?? d.msg ?? ''}</div>
            {d.range ? <div class="text-xs text-[var(--text-muted)]">{JSON.stringify(d.range)}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export type MessageScrollerProps = {
  messages: LogEntry[]
  class?: string
  onAutoScrollChange?: (v: boolean) => void
  scrollToBottomTrigger?: number
  sessionId?: string | null
  onMessageClick?: (message: LogEntry) => void
  selectedMessageId?: string | null
  footer?: JSX.Element | null
}

const resolveMessageKey = (message: LogEntry | null | undefined): string | null => {
  if (!message) return null
  if (message.entryId) return String(message.entryId)
  if (message.createdAt) return String(message.createdAt)
  return null
}

export default function MessageScroller(props: MessageScrollerProps) {
  const [container, setContainer] = createSignal<HTMLElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [copiedTargetKey, setCopiedTargetKey] = createSignal<string | null>(null)
  const [selectionMenu, setSelectionMenu] = createSignal<{ text: string } | null>(null)
  let lastMessageKey: string | null = null
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  // store per-session scroll positions to restore after remount
  const SCROLL_POSITIONS_KEY = '__MessageScrollerPositions'
  const existingPositions = (() => {
    try {
      const candidate = Reflect.get(globalThis, SCROLL_POSITIONS_KEY)
      return candidate instanceof Map ? candidate : null
    } catch {
      return null
    }
  })()
  const SCROLL_POSITIONS: Map<string, number> = existingPositions ?? new Map()
  if (!existingPositions) {
    try {
      Reflect.set(globalThis, SCROLL_POSITIONS_KEY, SCROLL_POSITIONS)
    } catch {}
  }

  function scrollToBottom(el: HTMLElement, smooth = true) {
    if (!el) return
    try {
      if (!smooth) {
        el.scrollTop = el.scrollHeight
        return
      }
      // Try a smooth scroll then ensure we end at the exact bottom.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            const last = el.lastElementChild as HTMLElement | null
            if (last && typeof last.scrollIntoView === 'function') {
              last.scrollIntoView({ behavior: 'smooth', block: 'end' })
            } else {
              el.scrollTop = el.scrollHeight
            }
            // After a short delay, force the instant jump to avoid being left slightly above bottom
            setTimeout(() => {
              try {
                el.scrollTop = el.scrollHeight
              } catch {}
            }, 160)
          } catch {}
        })
      })
    } catch {}
  }

  // monitor manual scroll requests
  createEffect(() => {
    const nudge = props.scrollToBottomTrigger ?? 0
    const el = container()
    if (!el) return
    // Clear any persisted scroll position for this session when user requests auto-scroll
    try {
      const sid = props.sessionId
      if (sid) SCROLL_POSITIONS.delete(sid)
    } catch {}
    // Do not change the user's autoScroll preference here.
    // We only clear any persisted scroll position and perform the requested scroll.
    // The parent (CodingAgentConsole) is responsible for flipping its own autoScroll state when the user clicks resume.
    // First attempt a smooth scroll then force an instant settle
    if (!Number.isFinite(nudge)) return
    scrollToBottom(el, true)
  })

  onCleanup(() => {
    if (typeof window !== 'undefined' && copyResetTimer) {
      clearTimeout(copyResetTimer)
    }
  })

  // auto-scroll when messages appended
  createEffect(() => {
    const msgs = props.messages ?? []
    const el = container()
    if (!el) return
    const should = autoScroll()
    // derive a stable key for the last message to detect real appends/changes
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
    const currentKey = resolveMessageKey(last)
    if (should && currentKey && currentKey !== lastMessageKey) {
      try {
        const sid = props.sessionId
        if (sid) SCROLL_POSITIONS.delete(sid)
      } catch {}
      scrollToBottom(el, true)
    }
    lastMessageKey = currentKey
  })

  // track user scrolls and notify parent
  createEffect(() => {
    const el = container()
    if (!el) return
    const handler = () => {
      const distance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
      const atBottom = distance <= 4
      setAutoScroll(atBottom)
      props.onAutoScrollChange?.(atBottom)
      // persist scrollTop per session
      try {
        const sid = props.sessionId
        if (sid) {
          // Only persist when user is not at bottom (we don't need to save bottom)
          if (!atBottom) SCROLL_POSITIONS.set(sid, el.scrollTop)
          else SCROLL_POSITIONS.delete(sid)
        }
      } catch {}
    }
    el.addEventListener('scroll', handler)
    onCleanup(() => el.removeEventListener('scroll', handler))
  })

  // mutation observer for late-layout changes
  createEffect(() => {
    const el = container()
    if (!el) return
    let mo: MutationObserver | null = null
    try {
      mo = new MutationObserver(() => {
        if (autoScroll()) scrollToBottom(el, true)
      })
      mo.observe(el, { childList: true, subtree: true, characterData: true })
    } catch {}
    onCleanup(() => {
      try {
        mo?.disconnect()
      } catch {}
    })
  })

  // restore scroll position for session on mount if user had scrolled (and autoScroll is off)
  createEffect(() => {
    const el = container()
    if (!el) return
    const sid = props.sessionId
    if (!sid) return
    try {
      const saved = SCROLL_POSITIONS.get(sid)
      if (saved !== undefined && saved !== null) {
        // restore only when autoScroll is explicitly off
        if (!autoScroll()) {
          // Small double RAF to let layout settle, then restore saved position
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try {
                el.scrollTop = saved
              } catch {}
            })
          })
        }
      }
    } catch {}
  })

  type DetailsToggleProps = {
    summaryText: string
    duration?: string
    title?: string
    children?: any
    copyHint?: { payload: string; key: string }
  }

  function DetailsWithToggle(props: DetailsToggleProps) {
    const [open, setOpen] = createSignal(false)
    return (
      <details
        class="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)]"
        open={false}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary class="px-3 py-2 cursor-pointer flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="font-medium">{props.summaryText}</div>
            <div class="text-xs text-[var(--text-muted)]">{props.title}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-xs text-[var(--text-muted)]">{props.duration}</div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              class={`ml-2 transition-transform duration-150 ${open() ? 'rotate-90' : ''}`}
            >
              <path fill="currentColor" d="M9 6l6 6-6 6" />
            </svg>
          </div>
        </summary>
        <div class="relative p-3">
          {open() && props.copyHint ? (
            <button
              type="button"
              class="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-muted)] transition hover:bg-blue-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
              aria-label={copiedTargetKey() === props.copyHint.key ? 'Tool output copied' : 'Copy tool output'}
              title="Copy tool output"
              onClick={() => void copyTextPayload(props.copyHint!.payload, props.copyHint!.key)}
            >
              {copiedTargetKey() === props.copyHint.key ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M20.285 6.708a1 1 0 00-1.513-1.3l-8.05 9.368-3.492-3.492a1 1 0 10-1.414 1.414l4.25 4.25a1 1 0 001.495-.06z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M8 2h10a2 2 0 012 2v12h-2V4H8z" />
                  <path
                    fill="currentColor"
                    d="M5 6h10a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zm0 2v12h10V8z"
                  />
                </svg>
              )}
            </button>
          ) : null}
          {props.children}
        </div>
      </details>
    )
  }

  function toolPartClipboardText(message: LogEntry, part: Part): string {
    const meta: string[] = []
    const toolName = String(part.tool ?? part.toolName ?? part.name ?? '')
    if (toolName) meta.push(`Tool: ${toolName}`)
    if (part.title) meta.push(String(part.title))
    if (message.createdAt) meta.push(new Date(message.createdAt).toLocaleString())

    const body: string[] = []
    const append = (value: string | null | undefined) => {
      if (typeof value === 'string' && value.trim()) body.push(value.trim())
    }
    append(typeof part.text === 'string' ? part.text : undefined)
    append(part.output)
    append(part.state?.output)
    const diffText = extractDiffText(part)
    if (diffText) body.push(diffText)

    if (body.length === 0) return ''
    return [...meta, '', ...body].join('\n').trim()
  }

  async function copyTextPayload(payload: string, targetKey: string) {
    if (!payload) return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload)
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea')
        textarea.value = payload
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      } else {
        throw new Error('Clipboard API unavailable')
      }
      setCopiedTargetKey(targetKey)
      if (typeof window !== 'undefined') {
        if (copyResetTimer) clearTimeout(copyResetTimer)
        copyResetTimer = setTimeout(() => setCopiedTargetKey(null), 2000)
      }
    } catch (error) {
      console.error('Failed to copy message', error)
    }
  }

  const closeSelectionMenu = () => {
    setSelectionMenu(null)
    if (typeof window === 'undefined') return
    try {
      const sel = window.getSelection()
      sel?.removeAllRanges?.()
    } catch {}
  }

  const handleSelectionCopy = async () => {
    const menu = selectionMenu()
    if (!menu) return
    await copyTextPayload(menu.text, 'selection')
    closeSelectionMenu()
  }

  function scheduleSelectionMenuUpdate() {
    if (typeof window === 'undefined') return
    setTimeout(() => {
      const root = container()
      if (!root) return
      let sel: Selection | null = null
      try {
        sel = window.getSelection()
      } catch {}
      if (!sel || sel.isCollapsed) return
      const anchorNode = sel.anchorNode
      const focusNode = sel.focusNode
      if (!anchorNode || !focusNode) return
      if (!root.contains(anchorNode) || !root.contains(focusNode)) return
      const text = sel.toString().trim()
      if (!text) return
      setSelectionMenu({ text })
    }, 0)
  }

  createEffect(() => {
    const el = container()
    if (!el) return
    const handlePointerUp = () => scheduleSelectionMenuUpdate()
    const handleKeyUp = () => scheduleSelectionMenuUpdate()
    el.addEventListener('pointerup', handlePointerUp)
    el.addEventListener('keyup', handleKeyUp)
    onCleanup(() => {
      el.removeEventListener('pointerup', handlePointerUp)
      el.removeEventListener('keyup', handleKeyUp)
    })
  })

  createEffect(() => {
    if (typeof window === 'undefined') return
    const handleSelectionChange = () => {
      try {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed) setSelectionMenu(null)
      } catch {}
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    onCleanup(() => document.removeEventListener('selectionchange', handleSelectionChange))
  })

  createEffect(() => {
    if (typeof window === 'undefined') return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSelectionMenu()
    }
    document.addEventListener('keydown', handleKeyDown)
    onCleanup(() => document.removeEventListener('keydown', handleKeyDown))
  })

  function renderMessageParts(message: LogEntry) {
    const parts = extractPartsFromPayload(message.payload) ?? []
    const fallback = resolveMessageText(message.payload)

    const elements: JSX.Element[] = []
    const toolCalls = extractToolCalls(parts)
    let diffRenderedFromParts = false

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (!part) continue
      const normalizedType = typeof part.type === 'string' ? part.type.toLowerCase() : ''

      if (normalizedType && STEP_TYPE_LABELS[normalizedType]) {
        const stepView = renderStepPart(part, STEP_TYPE_LABELS[normalizedType], message.role)
        if (stepView) elements.push(stepView)
        continue
      }

      if (normalizedType === 'text' || normalizedType === 'step-finish') {
        const structured = renderStructuredSections(part.text ?? part.state?.output ?? null, message.role)
        if (structured) {
          elements.push(structured)
          continue
        }
        if (typeof part.text === 'string' && part.text.trim()) {
          elements.push(<p class="mb-1 last:mb-0 break-words">{part.text.trim()}</p>)
        }
        continue
      }

      if (normalizedType === 'tool') {
        const toolName = String(part.tool ?? part.toolName ?? part.name ?? '')
        const title = part.title ?? part.state?.title ?? ''
        const text = typeof part.text === 'string' && part.text.trim() ? part.text.trim() : null
        const outputValue = part.state?.output ?? part.output
        const output = typeof outputValue === 'string' && outputValue.trim() ? outputValue : null

        if (!text && output && parseStepEventPayload(output)) {
          continue
        }

        const nameIndicatesTodo =
          toolName.toLowerCase().includes('todo') || toolName.toLowerCase().includes('todowrite')

        const candidatePayload = output ?? text
        const parsedTodos = parseTodoListPayload(candidatePayload)
        const parsedTags = parseFileTagPayload(candidatePayload)
        const structured = renderStructuredSections(candidatePayload, message.role)
        const diffText = extractDiffText(part)
        const summaryText = toolName || text || 'Tool'
        const messageKey = resolveMessageKey(message) ?? 'message'
        const partKey = String(part.id ?? `${messageKey}-${index}`)
        const toolCopyPayload = toolPartClipboardText(message, part)
        const durationLabel = (() => {
          const start = part.start ? String(part.start) : null
          const end = part.end ? String(part.end) : null
          if (start && end) {
            const d = Math.max(0, Date.parse(end) - Date.parse(start))
            return `${d} ms`
          }
          return ''
        })()

        if (nameIndicatesTodo && parsedTodos) {
          elements.push(<TodoList todos={parsedTodos} />)
          continue
        }

        if (structured && !parsedTodos && !parsedTags && !diffText) {
          elements.push(structured)
          continue
        }

        if (diffText) {
          diffRenderedFromParts = true
        }
        elements.push(
          <DetailsWithToggle
            summaryText={summaryText}
            duration={durationLabel}
            title={title}
            copyHint={toolCopyPayload ? { payload: toolCopyPayload, key: `tool:${messageKey}:${partKey}` } : undefined}
          >
            {parsedTodos ? <TodoList todos={parsedTodos} /> : null}
            {parsedTags
              ? (() => {
                  switch (parsedTags.type) {
                    case 'file':
                      return renderFileTag(parsedTags.value)
                    case 'file-diagnostic':
                    case 'project-diagnostic':
                      return renderDiagnosticsTag(parsedTags.value)
                    case 'file-diagnostic-array':
                      return parsedTags.value.map((item: any) => renderDiagnosticsTag(item))
                    default:
                      return null
                  }
                })()
              : null}
            {diffText ? (
              <div class="mt-2 mb-2">
                <DiffViewer diffText={diffText} />
              </div>
            ) : (output || text) && !parsedTodos ? (
              <ToolRenderer part={part} />
            ) : null}
          </DetailsWithToggle>
        )

        continue
      }

      if (normalizedType === 'file-diff' || normalizedType === 'diff') {
        const diffText = extractDiffText(part)
        if (!diffText) {
          continue
        }
        diffRenderedFromParts = true
        elements.push(
          <div class="mt-2 mb-2">
            <DiffViewer diffText={diffText} />
          </div>
        )
        continue
      }
    }

    if (toolCalls.length > 1) {
      elements.push(<ToolCallList calls={toolCalls} />)
    }

    if (!diffRenderedFromParts) {
      const payloadDiffPatch = extractDiffPatchFromPayload(message.payload)
      if (payloadDiffPatch) {
        elements.push(
          <div class="mt-2 mb-2">
            <DiffViewer diffText={payloadDiffPatch} />
          </div>
        )
        diffRenderedFromParts = true
      }
    }

    if (!elements.length) {
      const structuredCandidate = extractStructuredBody(message.payload)
      const structured = renderStructuredSections(structuredCandidate ?? fallback, message.role)
      if (structured) return structured
      if (fallback) {
        return fallback.split('\n').map((line: string) => <p class="mb-1 last:mb-0 break-words">{line}</p>)
      }
      return null
    }

    return elements
  }

  type MessageGroup = {
    role: string
    messages: LogEntry[]
    timestamp: string
  }

  function groupedMessages(): MessageGroup[] {
    const msgs = props.messages ?? []
    const groups: MessageGroup[] = []
    for (const m of msgs) {
      if (!m) continue
      const roleLabel = typeof m.role === 'string' && m.role.trim().length ? m.role : 'Message'
      if (groups.length === 0 || groups[groups.length - 1].role !== roleLabel) {
        groups.push({ role: roleLabel, messages: [m], timestamp: String(m.createdAt) })
      } else {
        // append to existing group and update timestamp to most recent message
        groups[groups.length - 1].messages.push(m)
        groups[groups.length - 1].timestamp = String(m.createdAt)
      }
    }
    return groups
  }

  return (
    <div ref={(el) => setContainer(el ?? null)} class={props.class ?? ''}>
      <For each={groupedMessages()}>
        {(group) => (
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-2">
            <header class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
              <span class="uppercase tracking-wide">{group.role || 'Message'}</span>
              <span>{new Date(group.timestamp).toLocaleString()}</span>
            </header>
            <div class="whitespace-pre-wrap text-[var(--text)] break-words text-sm">
              <For each={group.messages}>
                {(message) => (
                  <div
                    class="relative mb-3 rounded-xl border border-transparent transition hover:border-[var(--border)] last:mb-0"
                    classList={{
                      'border-blue-500 bg-blue-50 dark:bg-blue-950/30':
                        props.selectedMessageId === resolveMessageKey(message),
                      'cursor-pointer': Boolean(props.onMessageClick)
                    }}
                    role={props.onMessageClick ? 'button' : undefined}
                    tabIndex={props.onMessageClick ? 0 : undefined}
                    onClick={() => props.onMessageClick?.(message)}
                    onKeyDown={(event) => {
                      if (!props.onMessageClick) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        props.onMessageClick(message)
                      }
                    }}
                  >
                    <div>{renderMessageParts(message)}</div>
                  </div>
                )}
              </For>
            </div>
          </article>
        )}
      </For>
      <Show when={props.footer} keyed>
        {(footer) => <div class="mt-3">{footer}</div>}
      </Show>
      <Show when={selectionMenu()} keyed>
        {(menu) => (
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeSelectionMenu}>
            <div
              class="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="mb-2 text-base font-semibold text-[var(--text)]">Text selection</div>
              <p class="mb-3 text-xs text-[var(--text-muted)]">Hold-select to open actions</p>
              <div class="mb-5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text)]">
                {menu.text}
              </div>
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
                  onClick={closeSelectionMenu}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  onClick={() => void handleSelectionCopy()}
                >
                  {copiedTargetKey() === 'selection' ? 'Copied' : 'Copy selection'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
