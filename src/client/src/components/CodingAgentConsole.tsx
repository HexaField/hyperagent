import type { RunMeta } from '@hexafield/agent-workflow'
import type { JSX } from 'solid-js'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import { fileDiffsToUnifiedPatch } from '../../../shared/diffPatch'
import { WIDGET_TEMPLATES } from '../constants/widgetTemplates'
import {
  createCodingAgentPersona,
  deleteCodingAgentPersona,
  fetchCodingAgentPersonas,
  fetchCodingAgentSessions,
  getCodingAgentPersona,
  postCodingAgentMessage,
  startCodingAgentRun,
  updateCodingAgentPersona,
  type LogEntry,
  type PersonaDetail,
  type PersonaSummary
} from '../lib/codingAgent'
import ConversationPane from './ConversationPane'
import { createConversationScrollController } from './conversationScrollController'

const REFRESH_INTERVAL_MS = 4000
const STORAGE_PREFIX = 'coding-agent-console:v1'
const SESSION_OVERRIDES_SUFFIX = ':session-settings'
const STATE_EVENT = 'coding-agent-console:state'
const SEARCH_PARAM_SESSION = 'codingAgentSession'
const DEFAULT_WORKSPACE_KEY = '__default__'
const SESSION_PARAM_DELIMITER = '|'
// Providers removed: keep model-only overrides
const DEFAULT_MODELS = [
  { id: 'github-copilot/gpt-5-mini', label: 'GitHub Copilot · GPT-5 Mini' },
  { id: 'github-copilot/gpt-4o', label: 'GitHub Copilot · GPT-4o' },
  { id: 'openai/gpt-4o-mini', label: 'OpenAI · GPT-4o Mini' }
]
type SessionOverride = {
  modelId?: string
  personaId?: string
  launchMode?: 'local' | 'docker'
}
const DEFAULT_MODEL_ID = 'github-copilot/gpt-5-mini'
type PersistedState = {
  selectedSessionId?: string | null
}
type SessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'terminated'

type SessionRow = {
  id: string
  title: string | null
  updatedAt: string
  run: RunMeta
  state: SessionState
}

function normalizeWorkspaceKey(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_WORKSPACE_KEY
}

function storageKeyFor(workspaceKey: string): string {
  return `${STORAGE_PREFIX}:${workspaceKey}`
}

function sessionOverridesKeyFor(workspaceKey: string): string {
  return `${storageKeyFor(workspaceKey)}${SESSION_OVERRIDES_SUFFIX}`
}

function defaultPersonaKeyFor(workspaceKey: string): string {
  return `${storageKeyFor(workspaceKey)}:defaultPersona`
}

function normalizeModelId(_providerId: string | null | undefined, value: string | null | undefined): string {
  if (!value) return DEFAULT_MODEL_ID
  return DEFAULT_MODELS.some((m) => m.id === value) ? value : DEFAULT_MODEL_ID
}

function modelLabel(_providerId: string | null | undefined, modelId: string | null | undefined): string {
  const normalized = normalizeModelId(null, modelId)
  return DEFAULT_MODELS.find((m) => m.id === normalized)?.label ?? normalized
}

function readStoredState(workspaceKey: string): PersistedState {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(storageKeyFor(workspaceKey))
    if (!raw) return {}
    try {
      return (JSON.parse(raw) as PersistedState) ?? {}
    } catch {
      return {}
    }
  } catch {
    return {}
  }
}

function persistState(workspaceKey: string, patch: Partial<PersistedState>) {
  if (typeof window === 'undefined') return
  const key = storageKeyFor(workspaceKey)
  const prevRaw = window.localStorage.getItem(key)
  let prev: PersistedState = {}
  if (prevRaw) {
    try {
      prev = JSON.parse(prevRaw) ?? {}
    } catch {}
  }
  const next: PersistedState = { ...prev, ...patch }
  const nextRaw = JSON.stringify(next)
  if (nextRaw === prevRaw) return
  try {
    window.localStorage.setItem(key, nextRaw)
  } catch {}
  const detail = { workspaceKey, state: next }
  try {
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail }))
  } catch {}
}

function formatSessionSearchParam(workspaceKey: string, sessionId: string | null): string | undefined {
  if (!sessionId) return undefined
  return `${workspaceKey}${SESSION_PARAM_DELIMITER}${sessionId}`
}

function parseSessionSearchParam(value: string | null): { workspaceKey: string; sessionId: string } | null {
  if (!value) return null
  const delimiterIndex = value.indexOf(SESSION_PARAM_DELIMITER)
  if (delimiterIndex === -1) {
    return { workspaceKey: DEFAULT_WORKSPACE_KEY, sessionId: value }
  }
  const workspaceKey = value.slice(0, delimiterIndex)
  const sessionId = value.slice(delimiterIndex + 1)
  if (!workspaceKey || !sessionId) return null
  return { workspaceKey, sessionId }
}

function displayRoleLabel(role: string | null | undefined): string {
  if (!role) return 'Message'
  const normalized = role.trim().toLowerCase()
  if (!normalized) return 'Message'
  if (normalized === 'user' || normalized === 'you' || normalized === 'human') return 'You'
  if (['assistant', 'agent', 'assistant-step', 'coder', 'planner', 'critic'].includes(normalized)) return 'Agent'
  if (normalized === 'worker') return 'Worker Agent'
  if (normalized === 'verifier') return 'Verifier Agent'
  if (normalized === 'system') return 'System'
  if (normalized === 'tool') return 'Tool'
  return role.trim()
}

function extractUserMessageText(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null
  if (typeof payload === 'string') return payload
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload)
  if (typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const candidates = [record.text, record.message, record.raw]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return null
}

function updateSearchParam(name: string, value: string | null | undefined) {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    if (value === undefined || value === null || value === '') {
      url.searchParams.delete(name)
    } else {
      url.searchParams.set(name, value)
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {}
}

function readSessionOverrides(workspaceKey: string): Record<string, SessionOverride> {
  if (typeof window === 'undefined') return {}
  return parseSessionOverrides(window.localStorage.getItem(sessionOverridesKeyFor(workspaceKey))) ?? {}
}

function parseSessionOverrides(raw: string | null): Record<string, SessionOverride> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const next: Record<string, SessionOverride> = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!sessionId || typeof value !== 'object' || value === null) continue
      const entry = value as Partial<SessionOverride> & { modelId?: string; personaId?: string }
      const normalized: SessionOverride = {}
      if (entry.modelId) normalized.modelId = normalizeModelId(null, String(entry.modelId))
      if (entry.personaId) normalized.personaId = String(entry.personaId)
      if (entry.launchMode && (entry.launchMode === 'local' || entry.launchMode === 'docker')) {
        normalized.launchMode = entry.launchMode
      }
      if (Object.keys(normalized).length > 0) {
        next[sessionId] = normalized
      }
    }
    return next
  } catch {
    return null
  }
}

function persistSessionOverrides(workspaceKey: string, overrides: Record<string, SessionOverride>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(sessionOverridesKeyFor(workspaceKey), JSON.stringify(overrides))
  } catch {}
}

export type CodingAgentConsoleProps = {
  workspaceFilter?: string
  onWorkspaceFilterChange?: (value: string) => void
  lockWorkspace?: boolean
  defaultPrompt?: string
  heading?: string
  description?: string
  class?: string
  onRunStarted?: (sessionId: string) => void
  headerActions?: JSX.Element
  hideHeader?: boolean
}

export default function CodingAgentConsole(props: CodingAgentConsoleProps) {
  const workspaceForFetch = () => {
    const explicit = props.workspaceFilter
    if (props.lockWorkspace && typeof explicit === 'string') {
      return explicit
    }
    return props.workspaceFilter ?? ''
  }
  const workspaceKey = createMemo(() => normalizeWorkspaceKey(workspaceForFetch()))
  createEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const key = defaultPersonaKeyFor(workspaceKey())
      const id = window.localStorage.getItem(key)
      setDefaultPersonaId(id ?? null)
    } catch {}
  })

  // keep the new-session selector defaulted to the workspace default persona
  // NOTE: persona selection moved to drafting area; no defaulting needed here

  const [sessions, { refetch: refetchSessions }] = createResource(workspaceForFetch, async (value) => {
    const trimmed = value?.trim()
    return await fetchCodingAgentSessions(trimmed ? { workspacePath: trimmed } : undefined)
  })
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)

  createEffect(() => {
    const handle = setInterval(() => {
      void refetchSessions()
    }, REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(handle))
  })

  const [replyText, setReplyText] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [replying, setReplying] = createSignal(false)
  const [draftingSession, setDraftingSession] = createSignal(false)
  const [draftingWorkspace, setDraftingWorkspace] = createSignal<string | null>(null)
  const [pendingSessionId, setPendingSessionId] = createSignal<string | null>(null)
  const [isMobile, setIsMobile] = createSignal(false)
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [drawerVisible, setDrawerVisible] = createSignal(false)
  const [widgetMenuOpen, setWidgetMenuOpen] = createSignal(false)
  const [sessionSettingsId, setSessionSettingsId] = createSignal<string | null>(null)
  const [sessionSettingsModel, setSessionSettingsModel] = createSignal<string>(DEFAULT_MODEL_ID)
  const [sessionOverrides, setSessionOverrides] = createSignal<Record<string, SessionOverride>>({})
  const [defaultPersonaId, setDefaultPersonaId] = createSignal<string | null>(null)
  const [personasModalOpen, setPersonasModalOpen] = createSignal(false)
  const [personasList, setPersonasList] = createSignal<PersonaSummary[]>([])
  const [editingPersonaId, setEditingPersonaId] = createSignal<string | null>(null)
  const [editingPersonaMarkdown, setEditingPersonaMarkdown] = createSignal<string>('')
  const [draftPersonaId, setDraftPersonaId] = createSignal<string | null>(null)
  const [draftPersonaDetail, setDraftPersonaDetail] = createSignal<PersonaDetail | null>(null)
  
  const [draftLaunchMode, setDraftLaunchMode] = createSignal<'local' | 'docker'>('local')
  let drawerHideTimeout: number | null = null
  const scrollController = createConversationScrollController()
  const [selectedSessionPersonaDetail, setSelectedSessionPersonaDetail] = createSignal<PersonaDetail | null>(null)

  const closeSessionSettings = () => setSessionSettingsId(null)

  const ensureDrawerVisible = () => {
    if (!drawerVisible()) setDrawerVisible(true)
  }

  const openSessionDrawer = () => {
    if (typeof window !== 'undefined' && drawerHideTimeout) {
      window.clearTimeout(drawerHideTimeout)
      drawerHideTimeout = null
    }
    ensureDrawerVisible()
    const activate = () => setDrawerOpen(true)
    if (typeof window !== 'undefined') window.requestAnimationFrame(activate)
    else activate()
  }

  const closeSessionDrawer = () => {
    setDrawerOpen(false)
    setWidgetMenuOpen(false)
    if (typeof window === 'undefined') {
      setDrawerVisible(false)
      return
    }
    if (drawerHideTimeout) {
      window.clearTimeout(drawerHideTimeout)
      drawerHideTimeout = null
    }
    drawerHideTimeout = window.setTimeout(() => {
      setDrawerVisible(false)
      drawerHideTimeout = null
    }, 260)
  }

  const [replyEl, setReplyEl] = createSignal<HTMLTextAreaElement | null>(null)

  const openSingleWidgetByTemplate = (templateId: string) => {
    try {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new CustomEvent('workspace:open-single-widget', { detail: { templateId } }))
    } catch {}
  }

  function resizeReply() {
    const ta = replyEl()
    if (!ta) return
    try {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    } catch {}
  }

  function focusReplyInput() {
    requestAnimationFrame(() => {
      const el = replyEl()
      if (!el) return
      try {
        el.focus()
        el.scrollIntoView({ block: 'nearest' })
      } catch {}
    })
  }

  function startDraftSession() {
    const workspacePath = workspaceForFetch().trim()
    if (!workspacePath) {
      setError('Workspace path is required')
      return
    }
    setError(null)
    // Set the draft persona first to avoid a reactive ordering/race where the
    // drafting flag causes other effects to run and clear the selection.
    setDraftPersonaId(defaultPersonaId() ?? null)
    setDraftingSession(true)
    setDraftingWorkspace(workspacePath)
    setPendingSessionId(null)
    setSelectedSessionId(null)
    setReplyText(props.defaultPrompt?.trim() ?? '')
    requestAnimationFrame(() => resizeReply())
    if (isMobile()) closeSessionDrawer()
    focusReplyInput()
  }

  function handleSessionSelect(sessionId: string) {
    setSelectedSessionId(sessionId)
    setDraftingSession(false)
    setDraftingWorkspace(null)
    setPendingSessionId(null)
    if (isMobile()) closeSessionDrawer()
    focusReplyInput()
  }

  async function submitReply() {
    const text = replyText().trim()
    if (!text) return
    setReplying(true)
    setError(null)
    try {
      if (draftingSession()) {
        const workspacePath = draftingWorkspace()?.trim() || workspaceForFetch().trim()
        if (!workspacePath) {
          throw new Error('Workspace path is required')
        }
        const modelId = DEFAULT_MODEL_ID
        const personaToUse = draftPersonaId() ?? defaultPersonaId() ?? undefined
        const run = await startCodingAgentRun({
          workspacePath,
          prompt: text,
              model: modelId,
              personaId: personaToUse,
              launchMode: draftLaunchMode()
        })
        setSessionOverrides((prev) => ({
          ...prev,
          [run.id]: {
            modelId: normalizeModelId(null, modelId),
                ...(personaToUse ? { personaId: personaToUse } : {}),
                launchMode: draftLaunchMode()
          }
        }))
        setDraftingSession(false)
        setDraftingWorkspace(null)
        setReplyText('')
        const ta = replyEl()
        if (ta) ta.style.height = 'auto'
        setPendingSessionId(run.id)
        setSelectedSessionId(run.id)
        await refetchSessions()
        scrollController.requestScrollIfAuto()
        props.onRunStarted?.(run.id)
        if (isMobile()) closeSessionDrawer()
        focusReplyInput()
        return
      }

      const sessionId = selectedSessionId()
      if (!sessionId) return
      const workspacePath = workspaceForFetch().trim()
      if (!workspacePath) {
        setError('Workspace path is required')
        return
      }
      await postCodingAgentMessage(workspacePath, sessionId, { text })
      setReplyText('')
      const ta = replyEl()
      if (ta) ta.style.height = 'auto'
      await refetchSessions()
      scrollController.requestScrollIfAuto()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post message'
      setError(message)
    } finally {
      setReplying(false)
    }
  }

  let lastHydratedWorkspace: string | null = null
  createEffect(() => {
    const key = workspaceKey()
    if (!key || key === lastHydratedWorkspace) return
    lastHydratedWorkspace = key
    const state = readStoredState(key)
    if (state.selectedSessionId) {
      setSelectedSessionId(state.selectedSessionId)
      setPendingSessionId(null)
    } else {
      setSelectedSessionId(null)
      setPendingSessionId(null)
    }
  })

  createEffect(() => {
    if (draftingSession()) return
    const entries = sessions()
    const pending = pendingSessionId()
    if (!entries || entries.length === 0) {
      // Do not clear `selectedSessionId` on transient empty results from polling.
      // Clearing the selection causes the session detail to be nulled and the
      // conversation scroller to remount, which resets scroll position.
      if (pending) setPendingSessionId(null)
      return
    }
    if (pending && entries.some((entry) => entry.id === pending)) {
      setPendingSessionId(null)
    }
    const current = selectedSessionId()
    if (!current) {
      setSelectedSessionId(entries[0].id)
      return
    }
    const hasCurrent = entries.some((entry) => entry.id === current)
    if (!hasCurrent) {
      if (pending && current === pending) return
      setSelectedSessionId(entries[0].id)
    }
  })

  let lastPersistedSessionKey: string | null = null
  let lastPersistedSessionId: string | null = null
  createEffect(() => {
    const key = workspaceKey()
    if (!key) return
    const current = selectedSessionId()
    const normalized = current ?? null
    if (lastPersistedSessionKey === key && lastPersistedSessionId === normalized) return
    lastPersistedSessionKey = key
    lastPersistedSessionId = normalized
    persistState(key, { selectedSessionId: normalized })
    updateSearchParam(SEARCH_PARAM_SESSION, formatSessionSearchParam(key, normalized))
  })

  onMount(() => {
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && widgetMenuOpen()) setWidgetMenuOpen(false)
    }
    if (typeof window !== 'undefined') window.addEventListener('keydown', keydownHandler)

    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 640px)')
    const handler = () => setIsMobile(mq.matches)
    handler()
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler)
    else mq.addListener(handler)

    const stateHandler = (event: Event) => {
      const ce = event as CustomEvent<{ workspaceKey?: string; state?: PersistedState }>
      const detail = ce?.detail
      if (!detail || detail.workspaceKey !== workspaceKey()) return
      const nextSession = detail.state?.selectedSessionId ?? null
      if (nextSession !== selectedSessionId()) {
        setSelectedSessionId(nextSession)
        lastPersistedSessionKey = workspaceKey()
        lastPersistedSessionId = nextSession
        setPendingSessionId(null)
      }
    }
    try {
      window.addEventListener(STATE_EVENT, stateHandler as EventListener)
    } catch {}

    // Load available personas for UI dropdowns
    try {
      void fetchCodingAgentPersonas()
        .then((list) => setPersonasList(list))
        .catch(() => {})
    } catch {}

    let focusHandler: ((e: FocusEvent) => void) | null = null

    onCleanup(() => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
      try {
        window.removeEventListener(STATE_EVENT, stateHandler as EventListener)
      } catch {}
      try {
        window.removeEventListener('keydown', keydownHandler)
      } catch {}
      if (focusHandler) {
        try {
          window.removeEventListener('focusin', focusHandler as EventListener, true)
        } catch {}
      }
    })
  })

  // Keep draft persona detail in sync when the draft selection changes
  createEffect(() => {
    const id = draftPersonaId()
    if (!id) {
      setDraftPersonaDetail(null)
      return
    }
    void (async () => {
      try {
        const detail = await getCodingAgentPersona(id)
        setDraftPersonaDetail(detail)
      } catch {
        setDraftPersonaDetail(null)
      }
    })()
  })

  createEffect(() => {
    if (!isMobile()) closeSessionDrawer()
  })

  onCleanup(() => {
    if (typeof window !== 'undefined' && drawerHideTimeout) {
      window.clearTimeout(drawerHideTimeout)
      drawerHideTimeout = null
    }
  })

  let lastSessionOverridesWorkspace: string | null = null
  createEffect(() => {
    const key = workspaceKey()
    if (!key || typeof window === 'undefined') return
    if (lastSessionOverridesWorkspace === key) return
    lastSessionOverridesWorkspace = key
    setSessionOverrides(readSessionOverrides(key))
  })

  createEffect(() => {
    const key = workspaceKey()
    if (!key || typeof window === 'undefined') return
    if (lastSessionOverridesWorkspace !== key) return
    persistSessionOverrides(key, sessionOverrides())
  })

  const sessionsById = createMemo(() => {
    const runs = sessions() ?? []
    return new Map(runs.map((run) => [run.id, run]))
  })
  const selectedRun = createMemo<RunMeta | null>(() => {
    if (draftingSession()) return null
    const currentId = selectedSessionId()
    if (!currentId) return null
    return sessionsById().get(currentId) ?? null
  })
  const selectedRunSessionIds = createMemo(() => collectRunSessionIds(selectedRun()))
  const messages = createMemo<LogEntry[]>((prev) => {
    if (draftingSession()) return []
    const run = selectedRun()
    if (!run) return []
    const resolved = buildMessagesFromRun(run)
    return reconcileMessages(prev ?? [], resolved)
  }, [])

  createEffect(() => {
    const sessionId = selectedSessionId()
    if (sessionId) {
      scrollController.setContext(sessionId)
      return
    }
    if (draftingSession()) {
      scrollController.setContext('__draft__')
      return
    }
    scrollController.setContext('__no-session__')
  })

  createEffect(() => {
    const list = messages()
    const lastMessage = list.length > 0 ? list[list.length - 1] : null
    scrollController.notifyLatestKey(lastMessage ? messageSignature(lastMessage) : null)
  })

  createEffect(() => {
    const sessionId = selectedSessionId()
    if (!sessionId || draftingSession()) {
      setSelectedSessionPersonaDetail(null)
      return
    }
    const overrides = sessionOverrides()
    const personaId = overrides?.[sessionId]?.personaId ?? null
    if (!personaId) {
      setSelectedSessionPersonaDetail(null)
      return
    }
    void (async () => {
      try {
        const pd = await getCodingAgentPersona(personaId)
        setSelectedSessionPersonaDetail(pd)
      } catch {
        setSelectedSessionPersonaDetail(null)
      }
    })()
  })

  const sessionRows = createMemo<SessionRow[]>(() => {
    const currentRuns = sessions() ?? []
    return currentRuns.map((run) => ({
      id: run.id,
      title: null,
      updatedAt: run.updatedAt ?? run.createdAt,
      run,
      state: deriveSessionState(run)
    }))
  })
  const selectedSessionMeta = createMemo<SessionRow | null>(() => {
    const sessionId = selectedSessionId()
    if (!sessionId) return null
    return sessionRows().find((row) => row.id === sessionId) ?? null
  })

  const sessionSettingsTarget = createMemo<SessionRow | null>(() => {
    const targetId = sessionSettingsId()
    if (!targetId) return null
    return sessionRows().find((row) => row.id === targetId) ?? null
  })

  createEffect(() => {
    const targetId = sessionSettingsId()
    if (!targetId) return
    const exists = sessionRows().some((row) => row.id === targetId)
    if (!exists) closeSessionSettings()
  })

  const resolveSessionModel = (sessionId: string | null | undefined): string => {
    if (!sessionId) return normalizeModelId(null, null)
    const overrides = sessionOverrides()
    const override = overrides?.[sessionId]
    if (override?.modelId) return normalizeModelId(null, override.modelId)
    const session = sessionRows().find((row) => row.id === sessionId)
    return normalizeModelId(null, latestModelId(session?.run))
  }
  const resolveSessionModelLabel = (sessionId: string | null | undefined): string => {
    return modelLabel(null, resolveSessionModel(sessionId))
  }

  const openSessionSettings = (sessionId: string) => {
    setSessionSettingsModel(resolveSessionModel(sessionId))
    setSessionSettingsId(sessionId)
  }

  const handleSessionSettingsSave = () => {
    const targetId = sessionSettingsId()
    if (!targetId) return
    const modelId = normalizeModelId(null, sessionSettingsModel())
    setSessionOverrides((prev) => ({
      ...prev,
      [targetId]: {
        ...prev[targetId],
        modelId
      }
    }))
    closeSessionSettings()
  }

  function SessionsPanel(options?: { class?: string; variant?: 'desktop' | 'drawer' }) {
    const variant = options?.variant ?? 'desktop'
    const isDrawerVariant = variant === 'drawer'
    const sectionClass = isDrawerVariant
      ? `flex h-full flex-col gap-3 rounded-t-3xl bg-[var(--bg-muted)] p-4 ${options?.class ?? ''}`
      : `rounded-2xl border border-[var(--border)] p-4 ${options?.class ?? ''}`
    const listClass = isDrawerVariant
      ? 'flex flex-1 flex-col gap-2 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm'
      : 'flex max-h-[420px] flex-col gap-2 overflow-y-auto text-sm'
    return (
      <section class={sectionClass}>
        <header class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={startDraftSession}
            disabled={draftingSession()}
          >
            {draftingSession() ? 'Drafting…' : 'New session'}
          </button>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
              onClick={() => setPersonasModalOpen(true)}
            >
              Personas
            </button>
          </div>
        </header>
        <Show when={error()} keyed>
          {(message) => <p class="mb-2 text-xs text-red-500">{message}</p>}
        </Show>
        <Show
          when={sessionRows().length > 0}
          fallback={<p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>}
        >
          <ul class={listClass}>
            <For each={sessionRows()}>
              {(session) => (
                <li>
                  <div class="flex items-start gap-2">
                    <button
                      type="button"
                      class="w-full flex-1 rounded-xl border border-[var(--border)] px-3 py-2 text-left transition hover:border-blue-400"
                      classList={{
                        'border-blue-500 bg-blue-50 dark:bg-blue-950/30': selectedSessionId() === session.id
                      }}
                      onClick={() => handleSessionSelect(session.id)}
                    >
                      <div class="min-w-0">
                        <p class="truncate font-semibold text-[var(--text)]">{session.title || session.id}</p>
                      </div>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">
                        Updated {new Date(session.updatedAt).toLocaleString()}
                      </p>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">Model: {resolveSessionModelLabel(session.id)}</p>
                    </button>
                    <button
                      type="button"
                      class="rounded-full border border-[var(--border)] p-2 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
                      aria-label="Session settings"
                      onClick={() => openSessionSettings(session.id)}
                    >
                      ⚙️
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    )
  }

  function SessionDetail(options?: { class?: string; variant?: 'desktop' | 'mobile' }) {
    const variant = options?.variant ?? 'desktop'
    const isMobileVariant = variant === 'mobile'
    const sectionClass =
      options?.class ??
      (isMobileVariant
        ? 'flex h-full min-h-0 flex-col'
        : 'flex flex-col gap-4 rounded-2xl border border-[var(--border)] p-2')
    const transcriptContainerClass = isMobileVariant ? 'relative flex h-full min-h-0 flex-col' : 'relative'
    const transcriptScrollerClass = isMobileVariant
      ? 'flex-1 min-h-0 space-y-3 overflow-y-auto'
      : 'max-h-[520px] space-y-3 overflow-y-auto pr-1'
    const scrollButtonClass = isMobileVariant ? 'right-3 bottom-20' : 'right-3 bottom-3'
    const displayMessages = createMemo(() =>
      messages().map((message) => {
        const label = displayRoleLabel(message.role)
        const normalizedRole = message.role?.trim().toLowerCase()
        const userText = normalizedRole === 'user' ? extractUserMessageText(message.payload) : null
        if (label === (message.role?.trim() ?? message.role) && userText === null) return message
        const next = { ...message }
        if (label !== (message.role?.trim() ?? message.role)) next.role = label
        if (userText !== null) next.payload = userText
        return next
      })
    )

    const infoBlock = (
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-[var(--text-muted)]">Session detail</p>
          <Show
            when={selectedRun()}
            keyed
            fallback={
              <div>
                <Show when={draftingSession()}>
                  <div>
                    <p class="text-xs text-[var(--text-muted)]">Enter the first prompt below to start a new session.</p>
                    <div class="mt-2 flex items-center gap-2">
                      <label class="text-xs text-[var(--text-muted)]">Persona:</label>
                      <select
                        class="rounded border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-1 text-sm"
                        value={draftPersonaId() ?? ''}
                        onInput={(e) => setDraftPersonaId(e.currentTarget.value || null)}
                      >
                        <option value="">(none)</option>
                        <For each={personasList()}>{(p: any) => <option value={p.id}>{p.label ?? p.id}</option>}</For>
                      </select>
                      <div class="ml-2">
                        <label class="text-xs text-[var(--text-muted)] mr-2">Launch:</label>
                        <select
                          class="rounded border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-1 text-sm"
                          value={draftLaunchMode()}
                          onInput={(e) => setDraftLaunchMode((e.currentTarget.value as 'local' | 'docker') ?? 'local')}
                        >
                          <option value="local">Local</option>
                          <option value="docker">Docker</option>
                        </select>
                      </div>
                    </div>
                    <Show when={draftPersonaDetail()} keyed>
                      {(d) => (
                        <div class="mt-2 text-xs text-[var(--text-muted)]">
                          <div>Model: {String(d.frontmatter?.model ?? d.frontmatter?.model ?? '')}</div>
                          <Show when={d.frontmatter?.permission}>
                            {(perm) => (
                              <div>
                                Permissions:{' '}
                                {Object.entries(perm as Record<string, any>)
                                  .map(([k, v]) => `${k}:${v}`)
                                  .join(', ')}
                              </div>
                            )}
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                </Show>
                <Show when={!draftingSession()}>
                  <p class="text-xs text-[var(--text-muted)]">Select a session to inspect its transcript.</p>
                </Show>
              </div>
            }
          >
            {(run) => (
              <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-3">
                  <h3 class={`text-base font-semibold text-[var(--text)] ${isMobileVariant ? 'truncate' : ''}`}>
                    {run.id}
                  </h3>
                  <Show when={selectedSessionPersonaDetail()} keyed>
                    {(pd) => (
                      <div class="ml-3 text-xs text-[var(--text-muted)]">
                        Persona: {String(pd.frontmatter?.title ?? pd.id)}{' '}
                        {pd.frontmatter?.model ? `· ${String(pd.frontmatter.model)}` : ''}
                      </div>
                    )}
                  </Show>
                  <Show when={!isMobileVariant}>
                    <Show when={selectedSessionMeta()?.state} keyed>
                      {(state) => (
                        <span class={`rounded-full px-2 py-0.5 text-xs font-semibold ${sessionStateBadgeClass(state)}`}>
                          {sessionStateLabel(state)}
                        </span>
                      )}
                    </Show>
                  </Show>
                  <Show when={isMobileVariant}>
                    <Show when={selectedSessionMeta()?.state} keyed>
                      {(state) => <span class={`${sessionStateDotClass(state)} ml-2`} />}
                    </Show>
                  </Show>
                </div>
                <Show
                  when={selectedRunSessionIds().length > 0}
                  fallback={<p class="text-xs text-[var(--text-muted)]">No opencode sessions linked yet.</p>}
                >
                  <div class="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span class="font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                      Opencode sessions
                    </span>
                    <For each={selectedRunSessionIds()}>
                      {(sessionId) => (
                        <code
                          class="rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-0.5 font-mono text-[var(--text)]"
                          title={sessionId}
                        >
                          {formatSessionIdDisplay(sessionId)}
                        </code>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="flex flex-wrap items-center gap-3 text-xs">
                  <button
                    type="button"
                    class="rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-1 font-semibold text-[var(--text)] transition hover:border-blue-400 hover:text-blue-500"
                    onClick={() => openSingleWidgetByTemplate('workspace-summary')}
                  >
                    Workspace overview
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>
        <Show when={!isMobileVariant && selectedSessionId() && !draftingSession()}>
          <button
            type="button"
            class="rounded-full border border-[var(--border)] p-2 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
            aria-label="Session settings"
            onClick={() => selectedSessionId() && openSessionSettings(selectedSessionId()!)}
          >
            ⚙️
          </button>
        </Show>
      </div>
    )

    const replyFormClass = 'flex items-end gap-2'

    const replyForm = (
      <form
        class={replyFormClass}
        onSubmit={(e) => {
          e.preventDefault()
          void submitReply()
        }}
      >
        <textarea
          ref={(el) => setReplyEl(el ?? null)}
          class="flex-1 max-h-48 resize-none rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-sm"
          placeholder={draftingSession() ? 'Enter the first prompt to start a session' : 'Reply to session'}
          value={replyText()}
          onInput={(e) => {
            setReplyText(e.currentTarget.value)
            resizeReply()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submitReply()
            }
          }}
          disabled={replying() || (!draftingSession() && !selectedSessionId())}
        />
        <button
          type="button"
          class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          onClick={() => void submitReply()}
          disabled={replying() || (!draftingSession() && !selectedSessionId())}
        >
          {replying() ? (draftingSession() ? 'Starting…' : 'Sending…') : draftingSession() ? 'Start session' : 'Reply'}
        </button>
      </form>
    )

    const conversationPane = (
      <ConversationPane
        messages={displayMessages()}
        sessionId={selectedSessionId()}
        emptyPlaceholder={draftingSession() ? 'Enter the first prompt to start a session.' : 'No transcript yet.'}
        footer={replyForm}
        class={transcriptContainerClass}
        scrollerClass={transcriptScrollerClass}
        scrollButtonClass={scrollButtonClass}
        scrollToLatestSignal={scrollController.scrollSignal()}
        onAutoScrollChange={scrollController.handleAutoScrollChange}
      />
    )

    if (isMobileVariant) {
      return (
        <section class={sectionClass}>
          {infoBlock}
          <div class="flex-1 min-h-0">{conversationPane}</div>
        </section>
      )
    }

    return (
      <section class={sectionClass}>
        {infoBlock}
        {conversationPane}
      </section>
    )
  }

  const DesktopLayout = (
    <div class="grid gap-6 lg:grid-cols-[320px,1fr]">
      <section class="flex flex-col gap-5">{SessionsPanel()}</section>
      {SessionDetail()}
    </div>
  )

  const MobileLayout = (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-[var(--text)] truncate">
            {selectedRun() ? selectedRun()!.id : 'No session selected'}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="ml-3 rounded-full border border-[var(--border)] px-3 py-1 text-xs"
            onClick={() => openSessionDrawer()}
          >
            Sessions
          </button>
          <button
            type="button"
            class="ml-1 rounded-full border border-[var(--border)] px-3 py-1 text-xs"
            onClick={() => openSingleWidgetByTemplate('workspace-summary')}
          >
            Overview
          </button>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-hidden">
        {SessionDetail({ variant: 'mobile', class: 'flex h-full min-h-0 flex-col p-2 overflow-hidden' })}
      </div>
      <Show when={drawerVisible()}>
        <div class="fixed inset-0 z-40 flex bg-[var(--bg-muted)]">
          <button
            type="button"
            aria-label="Close session list"
            class={`absolute inset-0 transition-opacity duration-300 ${drawerOpen() ? 'opacity-100 bg-black/40' : 'pointer-events-none opacity-0'}`}
            onClick={closeSessionDrawer}
          />
          <div
            class={`relative flex h-full w-full max-w-[420px] flex-col bg-[var(--bg-muted)] shadow-2xl transition-transform duration-300 ease-in-out ${drawerOpen() ? 'translate-x-0' : '-translate-x-full'}`}
          >
            <div class="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3 relative">
              <div class="flex items-center gap-2">
                <div class="relative">
                  <button
                    type="button"
                    class="rounded-full border border-[var(--border)] px-3 py-1 text-sm"
                    aria-label="Open widgets menu"
                    onClick={() => setWidgetMenuOpen((v) => !v)}
                  >
                    ☰
                  </button>
                  <Show when={widgetMenuOpen()}>
                    <>
                      <button
                        type="button"
                        class="fixed inset-0"
                        aria-label="Close widget menu"
                        onClick={() => setWidgetMenuOpen(false)}
                      />
                      <div class="fixed left-0 right-0 top-12 z-50 max-w-none border-t border-b border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg max-h-[calc(100vh-3rem)] overflow-y-auto">
                        <For each={WIDGET_TEMPLATES}>
                          {(template) => (
                            <button
                              type="button"
                              class="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-[var(--bg-muted)]"
                              onClick={() => {
                                openSingleWidgetByTemplate(template.id)
                                setWidgetMenuOpen(false)
                              }}
                            >
                              {template.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </>
                  </Show>
                </div>
                <h2 class="text-base font-semibold">Sessions</h2>
              </div>
              <button
                type="button"
                class="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
                onClick={closeSessionDrawer}
              >
                Close
              </button>
            </div>
            <div class="flex-1 overflow-auto px-4 py-4">{SessionsPanel({ variant: 'drawer', class: 'h-full' })}</div>
          </div>
        </div>
      </Show>
    </div>
  )

  const SessionSettingsModal = () => (
    <Show when={sessionSettingsTarget()} keyed>
      {(target) => (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg)]/90 px-4 py-8 backdrop-blur-sm">
          <button
            type="button"
            class="absolute inset-0"
            aria-label="Close session settings"
            tabIndex={-1}
            onClick={closeSessionSettings}
          />
          <div class="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-5 shadow-2xl">
            <div class="mb-4">
              <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Session settings</p>
              <h3 class="text-lg font-semibold text-[var(--text)]">{target.title || target.id}</h3>
              <p class="text-xs text-[var(--text-muted)]">ID: {target.id}</p>
              {(() => {
                const ids = collectRunSessionIds(target.run)
                if (!ids.length) {
                  return <p class="text-xs text-[var(--text-muted)]">No opencode sessions linked yet.</p>
                }
                return (
                  <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span class="font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                      Opencode sessions
                    </span>
                    <For each={ids}>
                      {(sessionId) => (
                        <code
                          class="rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-0.5 font-mono text-[var(--text)]"
                          title={sessionId}
                        >
                          {formatSessionIdDisplay(sessionId)}
                        </code>
                      )}
                    </For>
                  </div>
                )
              })()}
            </div>
            <div class="space-y-4">
              {/* Provider selection removed — model-only settings */}
              <div class="space-y-2">
                <label class="text-sm font-semibold text-[var(--text)]" for="session-settings-model">
                  Model
                </label>
                <select
                  id="session-settings-model"
                  class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-sm"
                  value={sessionSettingsModel()}
                  onInput={(event) => setSessionSettingsModel(event.currentTarget.value)}
                >
                  <For each={DEFAULT_MODELS}>
                    {(option) => <option value={option.id}>{option.label ?? option.id}</option>}
                  </For>
                </select>
              </div>
            </div>
            <div class="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm"
                onClick={closeSessionSettings}
              >
                Cancel
              </button>
              <button
                type="button"
                class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
                onClick={handleSessionSettingsSave}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )

  const PersonasModal = () => (
    <Show when={personasModalOpen()}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg)]/90 px-4 py-8 backdrop-blur-sm">
        <button
          type="button"
          class="absolute inset-0"
          aria-label="Close personas"
          tabIndex={-1}
          onClick={() => setPersonasModalOpen(false)}
        />
        <div class="relative w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-5 shadow-2xl">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Personas</p>
              <h3 class="text-lg font-semibold text-[var(--text)]">Manage personas</h3>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded border px-3 py-1 text-sm"
                onClick={async () => {
                  try {
                    const list = await fetchCodingAgentPersonas()
                    setPersonasList(list)
                  } catch {}
                }}
              >
                Refresh
              </button>
              <button
                type="button"
                class="rounded border px-3 py-1 text-sm"
                onClick={() => setPersonasModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
          <div class="col-span-1">
            <div class="space-y-2">
              <For each={personasList()}>
                {(p: any) => (
                  <div class="p-2 rounded border border-[var(--border)]">
                    <div class="flex items-center justify-between">
                      <div>
                        <div class="text-sm font-semibold">{p.label ?? p.id}</div>
                        <div class="text-xs text-[var(--text-muted)]">{p.description}</div>
                      </div>
                      <div class="flex items-center gap-1">
                        <button
                          class="text-xs rounded px-2 py-1 border"
                          onClick={async () => {
                            const detail = await getCodingAgentPersona(p.id)
                            setEditingPersonaId(detail?.id ?? null)
                            setEditingPersonaMarkdown(detail?.markdown ?? '')
                          }}
                        >
                          Edit
                        </button>
                        <button
                          class="text-xs rounded px-2 py-1 border"
                          onClick={async () => {
                            const ok = await deleteCodingAgentPersona(p.id)
                            const list = await fetchCodingAgentPersonas()
                            setPersonasList(list)
                            // if the persona being edited was deleted, clear the editor
                            if (ok && editingPersonaId() === p.id) {
                              setEditingPersonaId(null)
                              setEditingPersonaMarkdown('')
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div class="mt-2 flex items-center gap-2">
                      <div class="text-xs text-[var(--text-muted)]">
                        <Show when={p.tools} keyed>
                          {(t) => (
                            <div>
                              Tools:{' '}
                              {Object.entries(t as Record<string, any>)
                                .filter(([, v]) => Boolean(v))
                                .map(([k]) => k)
                                .join(', ') || '(none)'}
                            </div>
                          )}
                        </Show>
                      </div>
                      <div class="text-xs text-[var(--text-muted)]">
                        <Show when={p.permission} keyed>
                          {(perm) => (
                            <div>
                              Perms:{' '}
                              {Object.entries(perm as Record<string, any>)
                                .map(([k, v]) => `${k}:${String(v)}`)
                                .join(', ') || '(none)'}
                            </div>
                          )}
                        </Show>
                      </div>
                      {/* Use button removed: select persona when creating a new session via the SessionsPanel dropdown */}
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div class="mt-4">
              <button
                class="rounded px-3 py-2 border"
                onClick={async () => {
                  const template = `---\ndescription: New persona\n---\n\nDescribe the persona here.`
                  const res = await createCodingAgentPersona(template)
                  if (res?.id) {
                    const list = await fetchCodingAgentPersonas()
                    setPersonasList(list)
                  }
                }}
              >
                New Persona
              </button>
            </div>
          </div>
          <div class="col-span-2">
            <Show when={editingPersonaId()} keyed>
              {(id) => (
                <div>
                  <div class="mb-2 flex items-center justify-between">
                    <div class="text-sm font-semibold">Editing: {id}</div>
                    <div class="text-xs text-[var(--text-muted)]">Markdown editor</div>
                  </div>
                  <textarea
                    class="w-full h-64 rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-sm font-mono"
                    value={editingPersonaMarkdown()}
                    onInput={(e) => setEditingPersonaMarkdown(e.currentTarget.value)}
                  />
                  <div class="mt-2 flex items-center gap-2">
                    <button
                      class="rounded px-3 py-1 border"
                      onClick={async () => {
                        const id = editingPersonaId()
                        if (!id) return
                        const ok = await updateCodingAgentPersona(id, editingPersonaMarkdown())
                        const list = await fetchCodingAgentPersonas()
                        setPersonasList(list)
                        // close editor on successful save for clearer feedback
                        if (ok) {
                          setEditingPersonaId(null)
                          setEditingPersonaMarkdown('')
                        }
                      }}
                    >
                      Save
                    </button>
                    <button
                      class="rounded px-3 py-1 border"
                      onClick={() => {
                        setEditingPersonaId(null)
                        setEditingPersonaMarkdown('')
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={!editingPersonaId()}>
              <div class="text-sm text-[var(--text-muted)]">Select a persona to edit or create a new one.</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )

  const rootClass = () =>
    [props.class ?? '', isMobile() ? 'flex h-[calc(100dvh-47px)] flex-col overflow-hidden' : 'flex h-full flex-col']
      .filter(Boolean)
      .join(' ')

  return (
    <div class={rootClass()}>
      <Show when={!props.hideHeader && !isMobile()}>
        <header class="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-base font-semibold text-[var(--text)]">{props.heading ?? 'Coding Agent sessions'}</p>
            <Show when={props.description} keyed>
              {(description) => <p class="text-sm text-[var(--text-muted)]">{description}</p>}
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <Show when={props.headerActions} keyed>
              {(actions) => <div class="flex-shrink-0">{actions}</div>}
            </Show>
          </div>
        </header>
      </Show>
      <div class="flex-1 min-h-0">{isMobile() ? MobileLayout : DesktopLayout}</div>
      {SessionSettingsModal()}
      {PersonasModal()}
    </div>
  )
}

const SESSION_STATE_META: Record<SessionState, { label: string; badgeClass: string }> = {
  running: {
    label: 'Running',
    badgeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200'
  },
  waiting: {
    label: 'Waiting',
    badgeClass: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
  },
  completed: {
    label: 'Completed',
    badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-400/20 dark:text-blue-200'
  },
  failed: {
    label: 'Failed',
    badgeClass: 'bg-red-100 text-red-700 dark:bg-red-400/20 dark:text-red-200'
  },
  terminated: {
    label: 'Stopped',
    badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-100'
  }
}

function reconcileMessages(prev: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (!incoming || incoming.length === 0) return []
  if (!prev || prev.length === 0) return incoming
  const prevEntries = new Map(
    prev.map((message) => [logEntryKey(message), { message, signature: messageSignature(message) }])
  )
  let changed = prev.length !== incoming.length
  const next = incoming.map((message) => {
    const key = logEntryKey(message)
    const prevEntry = prevEntries.get(key)
    if (!prevEntry) {
      changed = true
      return message
    }
    const signature = messageSignature(message)
    if (prevEntry.signature === signature) return prevEntry.message
    changed = true
    return message
  })
  return changed ? next : prev
}

const logEntryKey = (message: LogEntry): string => {
  if (message.entryId) return message.entryId
  if (message.createdAt) return message.createdAt
  return messageSignature(message)
}

function messageSignature(message: LogEntry): string {
  try {
    return JSON.stringify({
      payload: message.payload,
      model: message.model,
      role: message.role,
      createdAt: message.createdAt
    })
  } catch {
    return `${message.entryId ?? ''}-${message.createdAt ?? ''}`
  }
}

const ensureDiffPatchOnEntry = (entry: LogEntry): LogEntry => {
  const payload = entry?.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return entry
  const diff = payload.diff as Record<string, unknown> | undefined
  if (!diff || typeof diff !== 'object') return entry
  const existingPatch = typeof diff.patch === 'string' ? diff.patch.trim() : ''
  if (existingPatch) return entry
  const files = Array.isArray(diff.files) ? (diff.files as any[]) : []
  if (!files.length) return entry
  const patch = fileDiffsToUnifiedPatch(files as any)
  if (!patch) return entry
  const nextPayload = { ...payload, diff: { ...diff, patch } }
  return { ...entry, payload: nextPayload }
}

function buildMessagesFromRun(run: RunMeta): LogEntry[] {
  const log = Array.isArray(run.log) ? run.log : []
  return log.map((entry, index) => {
    const normalized = ensureDiffPatchOnEntry(entry)
    return {
      ...normalized,
      entryId: normalized.entryId || `${run.id}-${index}`
    }
  })
}

function latestModelId(run: RunMeta | null | undefined): string | null {
  if (!run) return null
  const log = Array.isArray(run.log) ? run.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (entry?.model) return entry.model
  }
  return null
}

function deriveSessionState(run: RunMeta | null | undefined): SessionState {
  if (!run) return 'waiting'
  return Array.isArray(run.log) && run.log.length > 0 ? 'running' : 'waiting'
}

function collectRunSessionIds(run: RunMeta | null | undefined): string[] {
  if (!run || !Array.isArray(run.agents)) return []
  const ids: string[] = []
  for (const agent of run.agents) {
    if (!agent) continue
    const value = typeof agent.sessionId === 'string' ? agent.sessionId.trim() : ''
    if (!value || ids.includes(value)) continue
    ids.push(value)
  }
  return ids
}

function formatSessionIdDisplay(value: string): string {
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function sessionStateLabel(state: SessionState): string {
  return SESSION_STATE_META[state].label
}

function sessionStateBadgeClass(state: SessionState): string {
  return SESSION_STATE_META[state].badgeClass
}

function sessionStateDotClass(state: SessionState): string {
  switch (state) {
    case 'running':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-emerald-500 ring-1 ring-[var(--border)]'
    case 'waiting':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-slate-400 ring-1 ring-[var(--border)]'
    case 'completed':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-blue-500 ring-1 ring-[var(--border)]'
    case 'failed':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-red-500 ring-1 ring-[var(--border)]'
    case 'terminated':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-amber-500 ring-1 ring-[var(--border)]'
    default:
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-slate-400 ring-1 ring-[var(--border)]'
  }
}
