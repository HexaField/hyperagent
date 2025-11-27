import type { JSX } from 'solid-js'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import { WIDGET_TEMPLATES } from '../constants/widgetTemplates'
import { fetchCodingAgentProviders, type CodingAgentProvider } from '../lib/codingAgent'
import {
  fetchOpencodeRuns,
  fetchOpencodeSessionDetail,
  fetchOpencodeSessions,
  killOpencodeSession,
  startOpencodeRun,
  type OpencodeMessage as CodingAgentMessage,
  type OpencodeRunRecord as CodingAgentRunRecord,
  type OpencodeSessionDetail as CodingAgentSessionDetail,
  type OpencodeSessionSummary as CodingAgentSessionSummary
} from '../lib/opencode'
import ThemeToggle from './ThemeToggle'
import SingleWidgetHeader from './layout/SingleWidgetHeader'

const REFRESH_INTERVAL_MS = 4000
const STORAGE_PREFIXES = ['coding-agent-console:v1', 'opencode-console:v1'] as const
const STORAGE_PREFIX = STORAGE_PREFIXES[0]
const SESSION_OVERRIDES_SUFFIX = ':session-settings'
const LEGACY_MODEL_OVERRIDES_SUFFIX = ':models'
const STATE_EVENT = 'coding-agent-console:state'
const STATE_EVENT_ALIASES = [STATE_EVENT, 'opencode-console:state'] as const
const SEARCH_PARAM_SESSION = 'codingAgentSession'
const LEGACY_SEARCH_PARAM_SESSION = 'opencodeSession'
const DEFAULT_WORKSPACE_KEY = '__default__'
const FALLBACK_CODING_AGENT_PROVIDERS: CodingAgentProvider[] = [
  {
    id: 'opencode',
    label: 'Coding Agent (Opencode CLI)',
    defaultModelId: 'github-copilot/gpt-5-mini',
    models: [
      { id: 'github-copilot/gpt-5-mini', label: 'GitHub Copilot · GPT-5 Mini' },
      { id: 'github-copilot/gpt-4o', label: 'GitHub Copilot · GPT-4o' },
      { id: 'openai/gpt-4o-mini', label: 'OpenAI · GPT-4o Mini' }
    ]
  }
]
type CodingAgentProviderId = CodingAgentProvider['id']
type CodingAgentModelOption = CodingAgentProvider['models'][number]
type SessionOverride = {
  providerId?: CodingAgentProviderId
  modelId?: string
}
const DEFAULT_PROVIDER = FALLBACK_CODING_AGENT_PROVIDERS[0]
const DEFAULT_MODEL_ID = DEFAULT_PROVIDER.defaultModelId
type PersistedState = {
  selectedSessionId?: string | null
}
type SessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'terminated'

type SessionRow = CodingAgentSessionSummary & {
  run: CodingAgentRunRecord | null
  state: SessionState
}

function normalizeWorkspaceKey(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_WORKSPACE_KEY
}

function storageKeyFor(workspaceKey: string, prefix: string = STORAGE_PREFIX): string {
  return `${prefix}:${workspaceKey}`
}

function sessionOverridesKeyFor(workspaceKey: string, prefix: string = STORAGE_PREFIX): string {
  return `${storageKeyFor(workspaceKey, prefix)}${SESSION_OVERRIDES_SUFFIX}`
}

function legacyModelOverridesKeyFor(workspaceKey: string, prefix: string = STORAGE_PREFIX): string {
  return `${storageKeyFor(workspaceKey, prefix)}${LEGACY_MODEL_OVERRIDES_SUFFIX}`
}

function readStoredState(workspaceKey: string): PersistedState {
  if (typeof window === 'undefined') return {}
  for (const prefix of STORAGE_PREFIXES) {
    try {
      const raw = window.localStorage.getItem(storageKeyFor(workspaceKey, prefix))
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState | null
        if (parsed && typeof parsed === 'object') {
          return parsed
        }
      }
    } catch {}
  }
  return {}
}

function readPersistedState(workspaceKey: string): PersistedState {
  const state: PersistedState = { ...readStoredState(workspaceKey) }
  if (typeof window === 'undefined') return state
  try {
    const params = new URLSearchParams(window.location.search)
    const sessionParam = params.get(SEARCH_PARAM_SESSION) ?? params.get(LEGACY_SEARCH_PARAM_SESSION)
    if (sessionParam) state.selectedSessionId = sessionParam
  } catch {}
  return state
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
  for (const eventName of STATE_EVENT_ALIASES) {
    try {
      window.dispatchEvent(new CustomEvent(eventName, { detail }))
    } catch {}
  }
}

function updateSearchParam(name: string, value: string | null | undefined) {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    const targetNames = name === SEARCH_PARAM_SESSION ? [SEARCH_PARAM_SESSION, LEGACY_SEARCH_PARAM_SESSION] : [name]
    if (value === undefined || value === null || value === '') {
      for (const param of targetNames) {
        url.searchParams.delete(param)
      }
    } else {
      url.searchParams.set(name, value)
      if (name === SEARCH_PARAM_SESSION) {
        url.searchParams.delete(LEGACY_SEARCH_PARAM_SESSION)
      }
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {}
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

  const [providerResource] = createResource<CodingAgentProvider[]>(fetchCodingAgentProviders)
  const providers = createMemo<CodingAgentProvider[]>(() => {
    const fetched = providerResource() ?? []
    return fetched.length ? fetched : FALLBACK_CODING_AGENT_PROVIDERS
  })
  const providerMap = createMemo(() => new Map(providers().map((provider) => [provider.id, provider])))
  const defaultProvider = createMemo<CodingAgentProvider>(() => providers()[0] ?? DEFAULT_PROVIDER)
  const defaultProviderId = (): CodingAgentProviderId =>
    (defaultProvider()?.id ?? DEFAULT_PROVIDER.id) as CodingAgentProviderId

  const normalizeProviderId = (value: string | null | undefined): CodingAgentProviderId => {
    if (value && providerMap().has(value as CodingAgentProviderId)) {
      return value as CodingAgentProviderId
    }
    return defaultProviderId()
  }

  const providerConfigFor = (providerId: string | null | undefined): CodingAgentProvider => {
    const normalized = normalizeProviderId(providerId)
    return providerMap().get(normalized) ?? defaultProvider() ?? DEFAULT_PROVIDER
  }

  const normalizeModelId = (providerId: string | null | undefined, value: string | null | undefined): string => {
    const config = providerConfigFor(providerId)
    if (!value) return config.defaultModelId
    return config.models.some((option: CodingAgentModelOption) => option.id === value) ? value : config.defaultModelId
  }

  const providerLabel = (providerId: string | null | undefined): string => providerConfigFor(providerId).label

  const modelLabel = (providerId: string | null | undefined, modelId: string | null | undefined): string => {
    const config = providerConfigFor(providerId)
    const normalizedModel = normalizeModelId(config.id, modelId)
    return (
      config.models.find((option: CodingAgentModelOption) => option.id === normalizedModel)?.label ?? normalizedModel
    )
  }

  const parseSessionOverrides = (raw: string | null): Record<string, SessionOverride> | null => {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      const next: Record<string, SessionOverride> = {}
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (!sessionId || typeof value !== 'object' || value === null) continue
        const entry = value as Partial<SessionOverride> & { providerId?: string; modelId?: string }
        const providerId = entry.providerId ? normalizeProviderId(entry.providerId) : undefined
        const hasModel = typeof entry.modelId === 'string' && entry.modelId.trim().length > 0
        if (!providerId && !hasModel) continue
        const resolvedProviderId = providerId ?? defaultProviderId()
        next[sessionId] = {
          ...(providerId ? { providerId } : {}),
          ...(hasModel ? { modelId: normalizeModelId(resolvedProviderId, entry.modelId!) } : {})
        }
      }
      return next
    } catch {
      return null
    }
  }

  const parseLegacyModelOverrides = (raw: string | null): Record<string, SessionOverride> | null => {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      const fallbackProviderId = defaultProviderId()
      const next: Record<string, SessionOverride> = {}
      for (const [sessionId, modelId] of Object.entries(parsed)) {
        if (!sessionId || typeof modelId !== 'string') continue
        next[sessionId] = {
          providerId: fallbackProviderId,
          modelId: normalizeModelId(fallbackProviderId, modelId)
        }
      }
      return next
    } catch {
      return null
    }
  }

  const readSessionOverrides = (key: string): Record<string, SessionOverride> => {
    if (typeof window === 'undefined') return {}
    for (const prefix of STORAGE_PREFIXES) {
      const parsed = parseSessionOverrides(window.localStorage.getItem(sessionOverridesKeyFor(key, prefix)))
      if (parsed) return parsed
    }
    for (const prefix of STORAGE_PREFIXES) {
      const parsed = parseLegacyModelOverrides(window.localStorage.getItem(legacyModelOverridesKeyFor(key, prefix)))
      if (parsed) return parsed
    }
    return {}
  }

  const [sessions, { refetch: refetchSessions }] = createResource(workspaceForFetch, async (value) => {
    const trimmed = value?.trim()
    return await fetchOpencodeSessions(trimmed ? { workspacePath: trimmed } : undefined)
  })
  const [runs, { refetch: refetchRuns }] = createResource(fetchOpencodeRuns)
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)
  const [sessionDetail, { refetch: refetchSessionDetail, mutate: mutateSessionDetail }] = createResource(
    selectedSessionId,
    async (sessionId) => {
      if (!sessionId) return null
      return await fetchOpencodeSessionDetail(sessionId)
    }
  )
  const initialDraftProviderId = defaultProviderId()
  const initialDraftModelId = providerConfigFor(initialDraftProviderId).defaultModelId
  const [draftProviderId, setDraftProviderId] = createSignal<CodingAgentProviderId>(initialDraftProviderId)
  const [draftModelId, setDraftModelId] = createSignal<string>(initialDraftModelId)
  const draftProviderConfig = createMemo(() => providerConfigFor(normalizeProviderId(draftProviderId())))

  createEffect(() => {
    const handle = setInterval(() => {
      void refetchSessions()
      void refetchRuns()
    }, REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(handle))
  })

  createEffect(() => {
    const current = selectedSessionId()
    if (!current) return
    const handle = setInterval(() => {
      void refetchSessionDetail()
    }, REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(handle))
  })

  createEffect(() => {
    providers()
    const current = draftProviderId()
    const normalized = normalizeProviderId(current)
    if (current !== normalized) {
      setDraftProviderId(normalized)
      return
    }
    setDraftModelId((prev) => normalizeModelId(normalized, prev))
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
  const [sessionSettingsProvider, setSessionSettingsProvider] = createSignal<CodingAgentProviderId>(DEFAULT_PROVIDER.id)
  const [sessionSettingsModel, setSessionSettingsModel] = createSignal<string>(DEFAULT_MODEL_ID)
  const [sessionOverrides, setSessionOverrides] = createSignal<Record<string, SessionOverride>>({})
  const [killingSessionId, setKillingSessionId] = createSignal<string | null>(null)
  let drawerHideTimeout: number | null = null
  let lastScrollDistanceFromBottom = 0

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

  const [messagesEl, setMessagesEl] = createSignal<HTMLElement | null>(null)
  const [replyEl, setReplyEl] = createSignal<HTMLTextAreaElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)

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

  const resetDraftConfiguration = (providerId?: CodingAgentProviderId) => {
    const normalized = providerId ? normalizeProviderId(providerId) : defaultProviderId()
    setDraftProviderId(normalized)
    setDraftModelId(providerConfigFor(normalized).defaultModelId)
  }

  function startDraftSession() {
    const workspacePath = workspaceForFetch().trim()
    if (!workspacePath) {
      setError('Workspace path is required')
      return
    }
    setError(null)
    resetDraftConfiguration()
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
        const providerId = normalizeProviderId(draftProviderId())
        const modelId = normalizeModelId(providerId, draftModelId())
        const run = await startOpencodeRun({
          workspacePath,
          prompt: text,
          model: modelId,
          providerId
        })
        setSessionOverrides((prev) => ({
          ...prev,
          [run.sessionId]: {
            ...(prev[run.sessionId] ?? {}),
            providerId,
            modelId: normalizeModelId(providerId, run.model ?? modelId)
          }
        }))
        setDraftingSession(false)
        setDraftingWorkspace(null)
        setReplyText('')
        const ta = replyEl()
        if (ta) ta.style.height = 'auto'
        setPendingSessionId(run.sessionId)
        setSelectedSessionId(run.sessionId)
        await Promise.all([refetchSessions(), refetchRuns()])
        props.onRunStarted?.(run.sessionId)
        if (isMobile()) closeSessionDrawer()
        focusReplyInput()
        return
      }

      const sessionId = selectedSessionId()
      if (!sessionId) return
      const mod = await import('../lib/opencode')
      const modelId = resolveSessionModel(sessionId)
      await mod.postOpencodeMessage(sessionId, { text, modelId })
      setReplyText('')
      const ta = replyEl()
      if (ta) ta.style.height = 'auto'
      await Promise.all([refetchSessionDetail(), refetchSessions()])
      const el = messagesEl()
      if (el) {
        try {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        } catch {}
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post message'
      setError(message)
    } finally {
      setReplying(false)
    }
  }

  const killSession = async (targetId?: string | null) => {
    const sessionId = targetId ?? selectedSessionId()
    if (!sessionId) return
    setKillingSessionId(sessionId)
    setError(null)
    try {
      await killOpencodeSession(sessionId)
      await Promise.all([refetchRuns(), refetchSessions()])
      if (sessionSettingsId() === sessionId) closeSessionSettings()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to end session'
      setError(message)
    } finally {
      setKillingSessionId((current) => (current === sessionId ? null : current))
    }
  }

  let lastHydratedWorkspace: string | null = null
  createEffect(() => {
    const key = workspaceKey()
    if (!key || key === lastHydratedWorkspace) return
    lastHydratedWorkspace = key
    const state = readPersistedState(key)
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
      setSelectedSessionId(null)
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

  createEffect(() => {
    if (!selectedSessionId() || draftingSession()) {
      mutateSessionDetail?.(null)
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
    updateSearchParam(SEARCH_PARAM_SESSION, normalized ?? undefined)
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
    for (const eventName of STATE_EVENT_ALIASES) {
      try {
        window.addEventListener(eventName, stateHandler as EventListener)
      } catch {}
    }

    onCleanup(() => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
      for (const eventName of STATE_EVENT_ALIASES) {
        try {
          window.removeEventListener(eventName, stateHandler as EventListener)
        } catch {}
      }
      try {
        window.removeEventListener('keydown', keydownHandler)
      } catch {}
    })
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
    providers()
    const key = workspaceKey()
    if (!key || typeof window === 'undefined') return
    lastSessionOverridesWorkspace = key
    setSessionOverrides(readSessionOverrides(key))
  })

  createEffect(() => {
    const key = workspaceKey()
    if (!key || typeof window === 'undefined') return
    if (lastSessionOverridesWorkspace !== key) return
    persistSessionOverrides(key, sessionOverrides())
  })

  const selectedDetail = createMemo<CodingAgentSessionDetail | null>(() => {
    if (draftingSession()) return null
    return sessionDetail() ?? null
  })
  const messages = createMemo<CodingAgentMessage[]>(() => selectedDetail()?.messages ?? [])

  createEffect(() => {
    messages()
    const el = messagesEl()
    if (!el) return
    const shouldAutoScroll = autoScroll()
    requestAnimationFrame(() => {
      try {
        if (shouldAutoScroll) {
          el.scrollTop = el.scrollHeight
          lastScrollDistanceFromBottom = 0
        } else {
          const desiredTop = Math.max(0, el.scrollHeight - el.clientHeight - lastScrollDistanceFromBottom)
          el.scrollTop = desiredTop
        }
      } catch {}
    })
  })

  createEffect(() => {
    const el = messagesEl()
    if (!el) return
    const handler = () => {
      const distance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
      const atBottom = distance <= 4
      setAutoScroll(atBottom)
      lastScrollDistanceFromBottom = distance
    }
    el.addEventListener('scroll', handler)
    onCleanup(() => el.removeEventListener('scroll', handler))
  })

  const sessionRows = createMemo<SessionRow[]>(() => {
    const currentSessions = sessions() ?? []
    const runIndex = new Map((runs() ?? []).map((run) => [run.sessionId, run]))
    return currentSessions.map((session) => {
      const run = runIndex.get(session.id) ?? null
      return {
        ...session,
        run,
        state: deriveSessionState(run)
      }
    })
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

  const resolveSessionProvider = (sessionId: string | null | undefined): CodingAgentProviderId => {
    const fallbackProviderId = defaultProviderId()
    if (!sessionId) return fallbackProviderId
    const detail = sessionDetail()
    const detailProvider =
      detail?.session.id === sessionId && typeof detail.session.providerId === 'string'
        ? detail.session.providerId
        : null
    const overrides = sessionOverrides()
    const session = sessionRows().find((row) => row.id === sessionId)
    const candidates = [
      session?.providerId,
      session?.run?.providerId,
      detailProvider,
      overrides?.[sessionId]?.providerId
    ]
    const resolved = candidates
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
      .find((candidate) => candidate.length)
    return resolved ? normalizeProviderId(resolved) : fallbackProviderId
  }

  const resolveSessionModel = (sessionId: string | null | undefined): string => {
    const providerId = resolveSessionProvider(sessionId)
    if (!sessionId) return normalizeModelId(providerId, null)
    const overrides = sessionOverrides()
    const overrideModel = overrides?.[sessionId]?.modelId
    if (overrideModel) return normalizeModelId(providerId, overrideModel)
    const session = sessionRows().find((row) => row.id === sessionId)
    const detail = sessionDetail()
    const detailSession = detail?.session.id === sessionId ? detail.session : null
    const detailModel = detailSession && typeof detailSession.modelId === 'string' ? detailSession.modelId : null
    const detailMessageModel =
      detailSession && Array.isArray(detail?.messages)
        ? (detail.messages
            .slice()
            .reverse()
            .map((message) => (typeof message.modelId === 'string' ? message.modelId.trim() : ''))
            .find((candidate) => candidate.length) ?? null)
        : null
    const candidates = [session?.run?.model, session?.modelId, detailModel, detailMessageModel]
    const resolved = candidates
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
      .find((candidate) => candidate.length)
    return normalizeModelId(providerId, resolved)
  }

  const resolveSessionProviderLabel = (sessionId: string | null | undefined): string => {
    return providerLabel(resolveSessionProvider(sessionId))
  }

  const resolveSessionModelLabel = (sessionId: string | null | undefined): string => {
    const providerId = resolveSessionProvider(sessionId)
    return modelLabel(providerId, resolveSessionModel(sessionId))
  }

  const openSessionSettings = (sessionId: string) => {
    const providerId = resolveSessionProvider(sessionId)
    setSessionSettingsProvider(providerId)
    setSessionSettingsModel(resolveSessionModel(sessionId))
    setSessionSettingsId(sessionId)
  }

  const handleSessionSettingsSave = () => {
    const targetId = sessionSettingsId()
    if (!targetId) return
    const providerId = normalizeProviderId(sessionSettingsProvider())
    const modelId = normalizeModelId(providerId, sessionSettingsModel())
    setSessionOverrides((prev) => ({
      ...prev,
      [targetId]: {
        ...(prev[targetId] ?? {}),
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
                        'border-blue-500 bg-blue-50 dark:bg-blue-950/30': selectedSessionId() === session.id,
                        'border-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-900': session.state === 'running'
                      }}
                      onClick={() => handleSessionSelect(session.id)}
                    >
                      <div class="min-w-0">
                        <p class="truncate font-semibold text-[var(--text)]">{session.title || session.id}</p>
                        <span
                          class={`rounded-full px-2 py-0.5 text-xs font-semibold ${sessionStateBadgeClass(session.state)}`}
                        >
                          {sessionStateLabel(session.state)}
                        </span>
                      </div>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">
                        Updated {new Date(session.updatedAt).toLocaleString()}
                      </p>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">
                        Provider: {resolveSessionProviderLabel(session.id)}
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
        : 'flex flex-col gap-4 rounded-2xl border border-[var(--border)] p-5')
    const hasMessages = () => messages().length > 0
    const transcriptContainerClass = isMobileVariant ? 'relative flex h-full min-h-0 flex-col' : 'relative'
    const transcriptScrollerClass = isMobileVariant
      ? 'flex-1 min-h-0 space-y-3 overflow-y-auto'
      : 'max-h-[520px] space-y-3 overflow-y-auto pr-1'
    const articleClass = 'rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm'

    const scrollToBottomButton = (positionClass: string) => (
      <button
        type="button"
        class={`absolute flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ${positionClass}`}
        classList={{ hidden: autoScroll() }}
        onClick={() => {
          const el = messagesEl()
          if (el) {
            try {
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            } catch {}
          }
          setAutoScroll(true)
        }}
        title="Scroll to bottom"
      >
        ↓
      </button>
    )

    const transcriptList = (
      <div ref={(el) => setMessagesEl(el ?? null)} class={transcriptScrollerClass}>
        <For each={messages()}>
          {(message) => (
            <article class={articleClass}>
              <header class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                <span class="uppercase tracking-wide">{message.role}</span>
                <span>{new Date(message.createdAt).toLocaleString()}</span>
              </header>
              <div class="whitespace-pre-wrap text-[var(--text)] break-words text-sm">
                {renderMessageContent(message.text)}
              </div>
            </article>
          )}
        </For>
      </div>
    )

    const infoBlock = (
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-[var(--text-muted)]">Session detail</p>
          <Show
            when={selectedDetail()}
            keyed
            fallback={
              <p class="text-xs text-[var(--text-muted)]">
                {draftingSession()
                  ? 'Enter the first prompt below to start a new session.'
                  : 'Select a session to inspect its transcript.'}
              </p>
            }
          >
            {(detail) => (
              <div class="flex items-center gap-3">
                <h3 class={`text-base font-semibold text-[var(--text)] ${isMobileVariant ? 'truncate' : ''}`}>
                  {detail.session.title || detail.session.id}
                </h3>
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
            )}
          </Show>
          <Show when={selectedSessionId()} keyed>
            {(sessionId) => (
              <div class="mt-1 flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
                <span>Provider: {resolveSessionProviderLabel(sessionId)}</span>
                <span>Model: {resolveSessionModelLabel(sessionId)}</span>
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

    const noTranscriptBlock = isMobileVariant ? (
      <div class="flex h-full min-h-0 items-center justify-center text-sm text-[var(--text-muted)]">
        No transcript yet.
      </div>
    ) : (
      <p class="text-sm text-[var(--text-muted)]">No transcript yet.</p>
    )

    const transcriptBlock = hasMessages() ? (
      <div class={transcriptContainerClass}>
        {transcriptList}
        {scrollToBottomButton('right-3 bottom-3')}
      </div>
    ) : (
      noTranscriptBlock
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
          onFocus={() => {
            const el = messagesEl()
            if (el) {
              try {
                setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 120)
              } catch {}
            }
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

    const providerFieldId = isMobileVariant ? 'draft-provider-mobile' : 'draft-provider-desktop'
    const modelFieldId = isMobileVariant ? 'draft-model-mobile' : 'draft-model-desktop'

    const draftSessionConfig = (
      <Show when={draftingSession()}>
        <div class="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-2">
              <label class="text-sm font-semibold text-[var(--text)]" for={providerFieldId}>
                Provider
              </label>
              <select
                id={providerFieldId}
                class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                value={draftProviderConfig().id}
                onInput={(event) => {
                  const nextProvider = normalizeProviderId(event.currentTarget.value)
                  setDraftProviderId(nextProvider)
                  setDraftModelId(providerConfigFor(nextProvider).defaultModelId)
                }}
                disabled={replying()}
              >
                <For each={providers()}>{(provider) => <option value={provider.id}>{provider.label}</option>}</For>
              </select>
            </div>
            <div class="space-y-2">
              <label class="text-sm font-semibold text-[var(--text)]" for={modelFieldId}>
                Model
              </label>
              <select
                id={modelFieldId}
                class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                value={draftModelId()}
                onInput={(event) => setDraftModelId(event.currentTarget.value)}
                disabled={replying()}
              >
                <For each={draftProviderConfig().models}>
                  {(option) => <option value={option.id}>{option.label}</option>}
                </For>
              </select>
            </div>
          </div>
          <p class="text-xs text-[var(--text-muted)]">Provider is locked once the session starts.</p>
        </div>
      </Show>
    )

    if (isMobileVariant) {
      return (
        <section class={sectionClass}>
          <div class="flex-1 min-h-0">{transcriptBlock}</div>
          <div class="shrink-0 space-y-3 pt-3">
            {draftSessionConfig}
            {replyForm}
          </div>
        </section>
      )
    }

    return (
      <section class={sectionClass}>
        {infoBlock}
        {draftSessionConfig}
        {transcriptBlock}
        <div class="mt-3">{replyForm}</div>
      </section>
    )
  }

  function renderMessageContent(text: string) {
    return text.split('\n').map((line) => {
      if (line.startsWith('🔧 Tool:')) {
        return (
          <div class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <span>🔧</span>
            <span class="font-medium">Tool:</span>
            <span class="break-words">{line.slice('🔧 Tool:'.length).trim()}</span>
          </div>
        )
      }
      if (line.startsWith('▶️ Step:')) {
        return (
          <div class="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <span>▶️</span>
            <span class="font-medium">Step:</span>
            <span class="break-words">{line.slice('▶️ Step:'.length).trim()}</span>
          </div>
        )
      }
      if (line.startsWith('✅ Step:')) {
        return (
          <div class="flex items-center gap-2 text-green-600 dark:text-green-400">
            <span>✅</span>
            <span class="font-medium">Step:</span>
            <span class="break-words">{line.slice('✅ Step:'.length).trim()}</span>
          </div>
        )
      }
      return <p class="mb-1 last:mb-0 break-words">{line}</p>
    })
  }

  const DesktopLayout = (
    <div class="grid gap-6 lg:grid-cols-[320px,1fr]">
      <section class="flex flex-col gap-5">{SessionsPanel()}</section>
      {SessionDetail()}
    </div>
  )

  const MobileLayout = (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <SingleWidgetHeader
        title={() =>
          selectedDetail() ? selectedDetail()!.session.title || selectedDetail()!.session.id : 'No session selected'
        }
        onBack={() => openSessionDrawer()}
        backLabel="← Sessions"
      />
      <div class="flex-1 min-h-0 overflow-hidden">
        {SessionDetail({ variant: 'mobile', class: 'flex h-full min-h-0 flex-col p-4 overflow-hidden' })}
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
                      <div class="fixed left-0 right-0 top-14 z-50 max-w-none border-t border-b border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
                        <For each={WIDGET_TEMPLATES}>
                          {(template) => (
                            <button
                              type="button"
                              class="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-[var(--bg-muted)]"
                              onClick={() => {
                                try {
                                  if (isMobile()) {
                                    window.dispatchEvent(
                                      new CustomEvent('workspace:open-single-widget', {
                                        detail: { templateId: template.id }
                                      })
                                    )
                                  } else {
                                    window.dispatchEvent(
                                      new CustomEvent('workspace:add-widget', { detail: { templateId: template.id } })
                                    )
                                  }
                                } catch {}
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

      <Show when={widgetMenuOpen()}>
        <>
          <button
            type="button"
            class="fixed inset-0 z-50"
            aria-label="Close widget menu"
            onClick={() => setWidgetMenuOpen(false)}
          />
          <div class="fixed left-0 right-0 top-14 z-50 max-w-none border-t border-b border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
            <For each={WIDGET_TEMPLATES}>
              {(template) => (
                <button
                  type="button"
                  class="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-[var(--bg-muted)]"
                  onClick={() => {
                    try {
                      if (isMobile()) {
                        window.dispatchEvent(
                          new CustomEvent('workspace:open-single-widget', { detail: { templateId: template.id } })
                        )
                      } else {
                        window.dispatchEvent(
                          new CustomEvent('workspace:add-widget', { detail: { templateId: template.id } })
                        )
                      }
                    } catch {}
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
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Session settings</p>
                <h3 class="text-lg font-semibold text-[var(--text)]">{target.title || target.id}</h3>
                <p class="text-xs text-[var(--text-muted)]">ID: {target.id}</p>
              </div>
              <div class="flex-shrink-0">
                <ThemeToggle />
              </div>
            </div>
            <div class="space-y-4">
              <div class="space-y-1">
                <p class="text-sm font-semibold text-[var(--text)]">Provider</p>
                <div class="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-sm">
                  <span>{providerLabel(sessionSettingsProvider())}</span>
                  <span class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Locked</span>
                </div>
              </div>
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
                  <For each={providerConfigFor(sessionSettingsProvider()).models}>
                    {(option) => <option value={option.id}>{option.label}</option>}
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
              <button
                type="button"
                class="ml-auto rounded-xl border border-red-500 px-4 py-2 text-sm font-semibold text-red-500"
                onClick={() => killSession(target.id)}
                disabled={killingSessionId() === target.id}
              >
                {killingSessionId() === target.id ? 'Stopping…' : 'End session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )

  const rootClass = () =>
    [props.class ?? '', isMobile() ? 'flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden' : 'flex h-full flex-col']
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
          <Show when={props.headerActions} keyed>
            {(actions) => <div class="flex-shrink-0">{actions}</div>}
          </Show>
        </header>
      </Show>
      <div class="flex-1 min-h-0">{isMobile() ? MobileLayout : DesktopLayout}</div>
      {SessionSettingsModal()}
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

function deriveSessionState(run: CodingAgentRunRecord | null | undefined): SessionState {
  if (!run) return 'waiting'
  switch (run.status) {
    case 'starting':
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'terminated':
      return 'terminated'
    case 'exited':
      return 'completed'
    default:
      return 'waiting'
  }
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
