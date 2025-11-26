import { useSearchParams } from '@solidjs/router'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import DiffViewer from '../components/DiffViewer'
import CanvasWorkspace, { type CanvasWidgetConfig } from '../components/layout/CanvasWorkspace'
import OpencodeConsole from '../components/OpencodeConsole'
import WorkflowDetailView from '../components/WorkflowDetailView'
import WorkflowLaunchModal from '../components/WorkflowLaunchModal'
import { WIDGET_TEMPLATES, type WidgetAddEventDetail, type WidgetTemplateId } from '../constants/widgetTemplates'
import { useCanvasNavigator, type CanvasNavigatorController } from '../contexts/CanvasNavigatorContext'
import { useWorkspaceSelection, type WorkspaceRecord } from '../contexts/WorkspaceSelectionContext'
import type { GitFileChange, GitInfo } from '../types/git'

import { fetchJson } from '../lib/http'
import {
  closeTerminalSession,
  createTerminalSession,
  createTerminalWebSocket,
  listTerminalSessions,
  type TerminalSession
} from '../lib/terminal'
import {
  checkoutGitRef,
  commitGitChanges,
  discardGitPath,
  stageGitPaths,
  stashGitPath,
  unstageGitPaths,
  unstashGitPath
} from '../lib/git'

const TEMPLATE_ID_SET = new Set<WidgetTemplateId>(WIDGET_TEMPLATES.map((template) => template.id))

type WidgetInstance = {
  templateId: WidgetTemplateId
  instanceId: string
}

export type WorkflowRecord = {
  id: string
  projectId: string
  kind: string
  status: string
  createdAt: string
  updatedAt: string
}

export type WorkflowStep = {
  id: string
  workflowId: string
  status: string
  sequence: number
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
}

export type WorkflowSummary = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed'
}

export default function WorkspacePage() {
  const selection = useWorkspaceSelection()
  const navigator = useCanvasNavigator()
  const activeWorkspace = selection.currentWorkspace
  const [widgetInstances, setWidgetInstances] = createSignal<WidgetInstance[]>([])

  const widgets = createMemo<CanvasWidgetConfig[]>(() => {
    const workspace = activeWorkspace()
    if (!workspace) return []
    const offsetTracker = new Map<WidgetTemplateId, number>()
    return widgetInstances().map((instance) => {
      const currentOffset = offsetTracker.get(instance.templateId) ?? 0
      offsetTracker.set(instance.templateId, currentOffset + 1)
      return createWidgetConfig({
        templateId: instance.templateId,
        workspace,
        instanceId: instance.instanceId,
        offsetIndex: currentOffset,
        navigator,
        removable: true
      })
    })
  })

  createEffect(() => {
    const workspace = activeWorkspace()
    if (!workspace) return
    if (typeof window === 'undefined') {
      setWidgetInstances(createDefaultWidgetInstances())
      return
    }
    setWidgetInstances(loadWorkspaceWidgetInstances(workspace.id))
  })

  createEffect(() => {
    const workspace = activeWorkspace()
    if (!workspace) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(widgetInstanceStorageKey(workspace.id), JSON.stringify(widgetInstances()))
    } catch {
      // ignore storage errors
    }
  })

  onMount(() => {
    if (typeof window === 'undefined') return
    const handleAddWidget = (event: Event) => {
      const custom = event as CustomEvent<WidgetAddEventDetail>
      const detail = custom.detail
      if (!detail || !TEMPLATE_ID_SET.has(detail.templateId)) return
      const workspace = activeWorkspace()
      if (!workspace) return
      const instanceId = generateWidgetInstanceId(detail.templateId)
      setWidgetInstances((prev) => [...prev, { templateId: detail.templateId, instanceId }])
    }
    window.addEventListener('workspace:add-widget', handleAddWidget)
    onCleanup(() => window.removeEventListener('workspace:add-widget', handleAddWidget))
  })

  return (
    <div class="relative h-full min-h-screen w-full">
      <Show when={!selection.isLoading()} fallback={<WorkspaceLoadingState />}>
        <Show when={activeWorkspace()} fallback={<WorkspaceEmptyState onOpenNavigator={navigator.open} />}>
          {(workspace) => (
            <CanvasWorkspace
              storageKey={`workspace:${workspace().id}`}
              widgets={widgets()}
              onRemoveWidget={(id) => {
                setWidgetInstances((prev) => prev.filter((entry) => entry.instanceId !== id))
              }}
            />
          )}
        </Show>
      </Show>
    </div>
  )
}

const widgetInstanceStorageKey = (workspaceId: string) => `workspace:${workspaceId}:widgets`
const legacyExtraWidgetStorageKey = (workspaceId: string) => `workspace:${workspaceId}:extra-widgets`

function offsetPosition(base: { x: number; y: number }, offsetIndex: number) {
  const step = 40
  return {
    x: base.x + step * offsetIndex,
    y: base.y + step * offsetIndex
  }
}

function createDefaultWidgetInstances(): WidgetInstance[] {
  return WIDGET_TEMPLATES.map((template) => ({ templateId: template.id, instanceId: template.id }))
}

function parseWidgetInstanceList(value: unknown): WidgetInstance[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (
        entry &&
        typeof entry === 'object' &&
        'instanceId' in entry &&
        'templateId' in entry &&
        typeof entry.instanceId === 'string' &&
        typeof entry.templateId === 'string' &&
        TEMPLATE_ID_SET.has(entry.templateId as WidgetTemplateId)
      ) {
        return {
          templateId: entry.templateId as WidgetTemplateId,
          instanceId: entry.instanceId
        }
      }
      return null
    })
    .filter((entry): entry is WidgetInstance => Boolean(entry))
}

function loadLegacyExtraWidgets(workspaceId: string): WidgetInstance[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(legacyExtraWidgetStorageKey(workspaceId))
    if (!raw) return []
    const parsed = parseWidgetInstanceList(JSON.parse(raw))
    return parsed
  } catch {
    return []
  } finally {
    try {
      window.localStorage.removeItem(legacyExtraWidgetStorageKey(workspaceId))
    } catch {
      /* ignore */
    }
  }
}

function loadWorkspaceWidgetInstances(workspaceId: string): WidgetInstance[] {
  if (typeof window === 'undefined') return createDefaultWidgetInstances()
  try {
    const raw = window.localStorage.getItem(widgetInstanceStorageKey(workspaceId))
    if (raw) {
      const parsed = parseWidgetInstanceList(JSON.parse(raw))
      if (parsed.length) return parsed
    }
    const legacyExtras = loadLegacyExtraWidgets(workspaceId)
    if (legacyExtras.length) {
      const combined = [...createDefaultWidgetInstances(), ...legacyExtras]
      window.localStorage.setItem(widgetInstanceStorageKey(workspaceId), JSON.stringify(combined))
      return combined
    }
  } catch {
    // ignore and fall back below
  }
  return createDefaultWidgetInstances()
}

type CreateWidgetConfigOptions = {
  templateId: WidgetTemplateId
  workspace: WorkspaceRecord
  instanceId: string
  offsetIndex: number
  navigator: CanvasNavigatorController
  removable: boolean
}

function createWidgetConfig(options: CreateWidgetConfigOptions): CanvasWidgetConfig {
  const { templateId, workspace, instanceId, offsetIndex, navigator, removable } = options
  switch (templateId) {
    case 'workspace-summary':
      return {
        id: instanceId,
        title: 'Workspace overview',
        description: 'Repository details and quick actions',
        icon: '🧭',
        initialPosition: offsetPosition({ x: -300, y: -140 }, offsetIndex),
        initialSize: { width: 480, height: 400 },
        startOpen: true,
        removable,
        content: () => <WorkspaceSummary workspace={workspace} onOpenNavigator={navigator.open} />
      }
    case 'workspace-workflows':
      return {
        id: instanceId,
        title: 'Workflows',
        description: 'Run history and queue',
        icon: '🧩',
        initialPosition: offsetPosition({ x: 280, y: -100 }, offsetIndex),
        initialSize: { width: 920, height: 760 },
        startOpen: true,
        removable,
        content: () => <WorkflowsWidget workspaceId={workspace.id} workspaceName={workspace.name} />
      }
    case 'workspace-terminal':
      return {
        id: instanceId,
        title: 'Terminal',
        description: 'Shell access scoped to this workspace',
        icon: '🖥️',
        initialPosition: offsetPosition({ x: -320, y: 420 }, offsetIndex),
        initialSize: { width: 720, height: 520 },
        startOpen: true,
        removable,
        content: () => <WorkspaceTerminalWidget workspaceId={workspace.id} workspacePath={workspace.repositoryPath} />
      }
    case 'workspace-sessions':
      return {
        id: instanceId,
        title: 'Opencode sessions',
        description: 'Background activity feed',
        icon: '🕘',
        initialPosition: offsetPosition({ x: 460, y: 520 }, offsetIndex),
        initialSize: { width: 720, height: 520 },
        startOpen: true,
        removable,
        content: () => <SessionsWidget workspacePath={workspace.repositoryPath} />
      }
    default:
      return {
        id: instanceId,
        title: templateId,
        initialPosition: offsetPosition({ x: 0, y: 0 }, offsetIndex),
        removable,
        content: () => <div>Unknown widget</div>
      }
  }
}

function generateWidgetInstanceId(templateId: WidgetTemplateId) {
  const uniqueSegment =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return `${templateId}-${uniqueSegment}`
}

function WorkspaceLoadingState() {
  return (
    <div class="flex h-full items-center justify-center text-[var(--text-muted)]">
      <p>Loading workspaces…</p>
    </div>
  )
}

function WorkspaceEmptyState(props: { onOpenNavigator: () => void }) {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 text-center text-[var(--text)]">
      <p class="text-sm uppercase tracking-[0.35em] text-[var(--text-muted)]">No workspaces yet</p>
      <h1 class="text-3xl font-semibold">Create your first workspace</h1>
      <p class="max-w-lg text-[var(--text-muted)]">
        Use the canvas navigator drawer to register a repository. Once a workspace exists, it becomes the center of
        every workflow, terminal session, and opencode transcript.
      </p>
      <button
        class="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white"
        type="button"
        onClick={props.onOpenNavigator}
      >
        Open navigator
      </button>
    </div>
  )
}

type GitDisplayChange = GitFileChange & { key: string; view: 'working' | 'staged' }

function WorkspaceSummary(props: { workspace: WorkspaceRecord; onOpenNavigator: () => void }) {
  const workspace = () => props.workspace
  const [gitState, setGitState] = createSignal<GitInfo | null>(workspace().git ?? null)
  const [commitMessage, setCommitMessage] = createSignal('')
  const [checkoutTarget, setCheckoutTarget] = createSignal(workspace().git?.branch ?? workspace().defaultBranch)
  const [pendingAction, setPendingAction] = createSignal<string | null>(null)
  const [pendingItem, setPendingItem] = createSignal<string | null>(null)
  const [gitError, setGitError] = createSignal<string | null>(null)
  const [isRefreshing, setIsRefreshing] = createSignal(false)

  createEffect(() => {
    const nextGit = workspace().git ?? null
    setGitState(nextGit)
    setCheckoutTarget(nextGit?.branch ?? workspace().defaultBranch)
  })

  const git = () => gitState()
  const status = () => git()?.status ?? null
  const commitInfo = () => git()?.commit ?? null
  const remotes = () => git()?.remotes ?? []
  const remoteCount = () => remotes().length
  const stashes = () => git()?.stashes ?? []
  const branches = () => git()?.branches ?? []
  const diffText = () => {
    const text = git()?.diffText ?? null
    return text && text.trim().length ? text : null
  }
  const branchLabel = () => git()?.branch ?? workspace().defaultBranch

  const changeGroups = createMemo(() => {
    const base = git()?.changes ?? []
    const staged: GitDisplayChange[] = []
    const unstaged: GitDisplayChange[] = []
    base.forEach((entry) => {
      if (entry.stagedStatus && entry.stagedStatus.trim() && entry.stagedStatus !== '?') {
        staged.push({ ...entry, key: `staged:${entry.path}`, view: 'staged' })
      }
      if (entry.isUntracked || (entry.worktreeStatus && entry.worktreeStatus.trim() && entry.worktreeStatus !== ' ')) {
        unstaged.push({ ...entry, key: `working:${entry.path}`, view: 'working' })
      }
    })
    return { staged, unstaged }
  })

  const stagedChanges = () => changeGroups().staged
  const workingChanges = () => changeGroups().unstaged
  const isItemPending = (key: string) => pendingItem() === key

  const runGitAction = async (label: string, executor: () => Promise<GitInfo | null>, itemKey?: string) => {
    setGitError(null)
    setPendingAction(label)
    if (itemKey) setPendingItem(itemKey)
    try {
      const next = await executor()
      if (next) {
        setGitState(next)
        setCheckoutTarget(next.branch ?? workspace().defaultBranch)
      }
      return next
    } catch (error) {
      setGitError(error instanceof Error ? error.message : 'Git action failed')
      return null
    } finally {
      setPendingAction(null)
      if (itemKey) setPendingItem(null)
    }
  }

  const refreshGitInfo = async () => {
    setIsRefreshing(true)
    setGitError(null)
    try {
      const payload = await fetchJson<{ project: WorkspaceRecord }>(`/api/projects/${workspace().id}`)
      const next = payload.project.git ?? null
      setGitState(next)
      setCheckoutTarget(next?.branch ?? workspace().defaultBranch)
    } catch (error) {
      setGitError(error instanceof Error ? error.message : 'Failed to refresh git state')
    } finally {
      setIsRefreshing(false)
    }
  }

  const stageAll = () => {
    const paths = Array.from(new Set(workingChanges().map((change) => change.path)))
    if (!paths.length) return
    void runGitAction('stage-all', () => stageGitPaths(workspace().id, paths))
  }

  const unstageAll = () => {
    const paths = Array.from(new Set(stagedChanges().map((change) => change.path)))
    if (!paths.length) return
    void runGitAction('unstage-all', () => unstageGitPaths(workspace().id, paths))
  }

  const stageSingle = (change: GitDisplayChange) => {
    void runGitAction('stage', () => stageGitPaths(workspace().id, [change.path]), `stage:${change.path}`)
  }

  const unstageSingle = (change: GitDisplayChange) => {
    void runGitAction('unstage', () => unstageGitPaths(workspace().id, [change.path]), `unstage:${change.path}`)
  }

  const discardChange = (change: GitDisplayChange) => {
    void runGitAction('discard', () => discardGitPath(workspace().id, change.path, change.isUntracked), `discard:${change.path}`)
  }

  const stashChange = (change: GitDisplayChange) => {
    void runGitAction('stash', () => stashGitPath(workspace().id, change.path), `stash:${change.path}`)
  }

  const unstashEntry = (path: string, key: string) => {
    void runGitAction('unstash', () => unstashGitPath(workspace().id, path), key)
  }

  const handleCommit = async () => {
    const message = commitMessage().trim()
    if (!message.length) {
      setGitError('Commit message required')
      return
    }
    const result = await runGitAction('commit', () => commitGitChanges(workspace().id, message))
    if (result) {
      setCommitMessage('')
    }
  }

  const handleCheckout = async () => {
    const ref = checkoutTarget().trim()
    if (!ref || ref === branchLabel()) return
    await runGitAction('checkout', () => checkoutGitRef(workspace().id, ref))
  }

  const renderChangeRow = (change: GitDisplayChange, type: 'working' | 'staged') => {
    const rowKey = `${type}:${change.path}`
    const label = describeGitChange(change, type)
    const renameInfo = change.renameFrom && change.renameTo ? `${change.renameFrom} → ${change.renameTo}` : null
    return (
      <div class="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2" data-key={rowKey}>
        <div>
          <p class="text-sm font-semibold text-[var(--text)]">{change.displayPath}</p>
          <p class="text-xs text-[var(--text-muted)]">{renameInfo ?? label}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <Show when={type === 'working'}>
            <button
              class="rounded-lg border border-[var(--border)] px-2 py-1"
              type="button"
              disabled={isItemPending(`stage:${change.path}`) || pendingAction() === 'commit'}
              onClick={() => stageSingle(change)}
            >
              Stage
            </button>
            <button
              class="rounded-lg border border-[var(--border)] px-2 py-1"
              type="button"
              disabled={isItemPending(`discard:${change.path}`)}
              onClick={() => discardChange(change)}
            >
              Discard
            </button>
            <button
              class="rounded-lg border border-[var(--border)] px-2 py-1"
              type="button"
              disabled={isItemPending(`stash:${change.path}`)}
              onClick={() => stashChange(change)}
            >
              Stash
            </button>
          </Show>
          <Show when={type === 'staged'}>
            <button
              class="rounded-lg border border-[var(--border)] px-2 py-1"
              type="button"
              disabled={isItemPending(`unstage:${change.path}`)}
              onClick={() => unstageSingle(change)}
            >
              Unstage
            </button>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="flex h-full flex-col gap-5 p-6 text-[var(--text)]">
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="text-3xl font-semibold">{workspace().name}</h2>
          <span class="rounded-full border border-[var(--border)] px-3 py-1 text-xs uppercase tracking-wide text-[var(--text-muted)]">
            {branchLabel() ?? 'unknown'}
          </span>
          <div class="flex items-center gap-2 text-xs">
            <select
              class="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1"
              value={checkoutTarget()}
              onChange={(event) => setCheckoutTarget(event.currentTarget.value)}
            >
              <For each={branches().length ? branches() : [branchLabel()]}>{(branch) => <option value={branch ?? ''}>{branch ?? 'unknown'}</option>}</For>
            </select>
            <button
              class="rounded-lg border border-[var(--border)] px-3 py-1"
              type="button"
              disabled={!checkoutTarget().trim() || checkoutTarget() === branchLabel() || pendingAction() === 'checkout'}
              onClick={() => void handleCheckout()}
            >
              Checkout
            </button>
          </div>
        </div>
        {workspace().description && <p class="text-sm text-[var(--text-muted)]">{workspace().description}</p>}
      </div>

      <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
        <dl class="grid gap-4 sm:grid-cols-2">
          <div>
            <dt class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Repository</dt>
            <dd class="mt-1">
              <code class="block overflow-hidden text-ellipsis whitespace-nowrap rounded-xl bg-[var(--bg-muted)] px-3 py-2">
                {workspace().repositoryPath}
              </code>
            </dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Created</dt>
            <dd class="mt-1 text-[var(--text)]">{new Date(workspace().createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Default branch</dt>
            <dd class="mt-1 text-[var(--text)]">{workspace().defaultBranch}</dd>
          </div>
          <Show when={commitInfo()}>
            {(latest) => (
              <div>
                <dt class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Latest commit</dt>
                <dd class="mt-1 text-[var(--text)]">
                  <p class="font-semibold">{latest().message ?? 'No commit message'}</p>
                  <p class="text-xs text-[var(--text-muted)]">
                    {latest().hash?.slice(0, 8) ?? 'unknown'} · {formatTimestamp(latest().timestamp)}
                  </p>
                </dd>
              </div>
            )}
          </Show>
        </dl>
      </div>

      <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Working tree</p>
            <p class="text-base font-semibold text-[var(--text)]">
              {status()?.isClean
                ? 'Clean working tree'
                : `${status()?.changedFiles ?? 0} pending change${(status()?.changedFiles ?? 0) === 1 ? '' : 's'}`}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <button
              class="rounded-lg border border-[var(--border)] px-3 py-1"
              type="button"
              disabled={isRefreshing()}
              onClick={() => void refreshGitInfo()}
            >
              {isRefreshing() ? 'Refreshing…' : 'Refresh'}
            </button>
            <button class="rounded-lg border border-[var(--border)] px-3 py-1" type="button" onClick={props.onOpenNavigator}>
              Manage
            </button>
          </div>
        </div>
        <Show when={gitError()}>
          {(message) => <p class="mt-2 text-xs text-red-400">{message()}</p>}
        </Show>
        <form
          class="mt-4 flex flex-col gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void handleCommit()
          }}
        >
          <label class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]" for="workspace-commit-message">
            Commit message
          </label>
          <input
            id="workspace-commit-message"
            class="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2"
            type="text"
            placeholder="Describe your changes"
            value={commitMessage()}
            onInput={(event) => setCommitMessage(event.currentTarget.value)}
          />
          <button
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            type="submit"
            disabled={!stagedChanges().length || pendingAction() === 'commit'}
          >
            {pendingAction() === 'commit' ? 'Committing…' : 'Commit staged changes'}
          </button>
        </form>

        <section class="mt-4 grid gap-4 sm:grid-cols-2">
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-3">
            <header class="flex items-center justify-between gap-3">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Changes ({workingChanges().length})
              </p>
              <button
                class="text-xs text-blue-400 disabled:text-[var(--text-muted)]"
                type="button"
                disabled={!workingChanges().length || pendingAction() === 'stage-all'}
                onClick={stageAll}
              >
                Stage all
              </button>
            </header>
            <div class="mt-3 space-y-2 overflow-auto pr-1">
              <Show when={workingChanges().length} fallback={<p class="text-xs text-[var(--text-muted)]">No unstaged changes.</p>}>
                <For each={workingChanges()}>{(change) => renderChangeRow(change, 'working')}</For>
              </Show>
            </div>
          </div>
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-3">
            <header class="flex items-center justify-between gap-3">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Staged ({stagedChanges().length})
              </p>
              <button
                class="text-xs text-blue-400 disabled:text-[var(--text-muted)]"
                type="button"
                disabled={!stagedChanges().length || pendingAction() === 'unstage-all'}
                onClick={unstageAll}
              >
                Unstage all
              </button>
            </header>
            <div class="mt-3 space-y-2 overflow-auto pr-1">
              <Show when={stagedChanges().length} fallback={<p class="text-xs text-[var(--text-muted)]">No staged changes.</p>}>
                <For each={stagedChanges()}>{(change) => renderChangeRow(change, 'staged')}</For>
              </Show>
            </div>
          </div>
        </section>

        <Show when={stashes().length}>
          <div class="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-3">
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Stashed files</p>
            <div class="mt-2 space-y-2">
              <For each={stashes()}>
                {(entry) => (
                  <div class="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-xs">
                    <span class="text-[var(--text)]">{entry.filePath}</span>
                    <button
                      class="rounded-lg border border-[var(--border)] px-2 py-1"
                      type="button"
                      disabled={isItemPending(`unstash:${entry.name}`)}
                      onClick={() => unstashEntry(entry.filePath, `unstash:${entry.name}`)}
                    >
                      Unstash
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={status()?.summary}>
          {(summary) => (
            <details class="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)]">
              <summary class="cursor-pointer px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Status details
              </summary>
              <pre class="max-h-48 overflow-auto px-4 py-2 text-xs text-[var(--text-muted)]">{summary()}</pre>
            </details>
          )}
        </Show>

        <Show when={diffText()}>
          {(diff) => (
            <details class="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)]" open>
              <summary class="cursor-pointer px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Diff preview
              </summary>
              <div class="p-3">
                <DiffViewer diffText={diff()} />
              </div>
            </details>
          )}
        </Show>

        <Show when={remoteCount() > 0}>
          <div class="mt-4 space-y-2">
            <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Remotes</p>
            <For each={remotes().slice(0, 3)}>
              {(remote) => (
                <div class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2">
                  <p class="text-xs uppercase tracking-wide text-[var(--text-muted)]">{remote.name}</p>
                  <p class="text-sm text-[var(--text)]">{remote.url}</p>
                </div>
              )}
            </For>
            <Show when={remoteCount() > 3}>
              <p class="text-xs text-[var(--text-muted)]">{remoteCount() - 3} more remote(s) hidden.</p>
            </Show>
          </div>
        </Show>
      </div>

      <div class="mt-auto flex flex-wrap gap-3">
        <button
          class="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          type="button"
          onClick={props.onOpenNavigator}
        >
          Manage workspaces
        </button>
      </div>
    </div>
  )
}

const GIT_SYMBOL_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Updated',
  T: 'Type change',
  '?': 'Untracked'
}

function describeGitChange(change: GitFileChange, view: 'working' | 'staged'): string {
  if (change.isUntracked && view === 'working') {
    return 'Untracked'
  }
  const symbol = (view === 'staged' ? change.stagedStatus : change.worktreeStatus)?.trim() ?? ''
  if (!symbol || symbol === '?') {
    return view === 'staged' ? 'Staged change' : 'Changed'
  }
  return GIT_SYMBOL_LABELS[symbol] ?? 'Changed'
}

function WorkflowsWidget(props: { workspaceId: string; workspaceName: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [focusedWorkflowId, setFocusedWorkflowId] = createSignal<string | null>(
    typeof searchParams.sessionId === 'string' && searchParams.sessionId.length ? searchParams.sessionId : null
  )
  const [launchOpen, setLaunchOpen] = createSignal(false)
  onMount(() => {
    const handleLaunchRequest = () => setLaunchOpen(true)
    window.addEventListener('workspace:launch-workflow', handleLaunchRequest)
    onCleanup(() => window.removeEventListener('workspace:launch-workflow', handleLaunchRequest))
  })

  const [workflows, { refetch }] = createResource(
    () => props.workspaceId,
    async (workspaceId) => {
      if (!workspaceId) return [] as WorkflowSummary[]
      const payload = await fetchJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
      return payload.workflows.filter((summary) => summary.workflow.projectId === workspaceId)
    }
  )

  createEffect(() => {
    const linkParam =
      typeof searchParams.sessionId === 'string' && searchParams.sessionId.length ? searchParams.sessionId : null
    if (linkParam) {
      setFocusedWorkflowId(linkParam)
    }
  })

  const statusCounts = createMemo(() => {
    const list = workflows() ?? []
    return list.reduce<Record<string, number>>((counts, summary) => {
      const status = summary.workflow.status
      counts[status] = (counts[status] ?? 0) + 1
      return counts
    }, {})
  })

  const sortedWorkflows = createMemo(() => {
    const list = workflows() ?? []
    return [...list].sort((a, b) => b.workflow.updatedAt.localeCompare(a.workflow.updatedAt))
  })

  const focusWorkflow = (id: string) => {
    setFocusedWorkflowId(id)
    setSearchParams({ sessionId: id })
  }

  const closeDetail = () => {
    setFocusedWorkflowId(null)
    setSearchParams({ sessionId: undefined })
  }

  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h2 class="text-3xl font-semibold">Runs for {props.workspaceName}</h2>
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="rounded-2xl border border-[var(--border)] px-4 py-2 text-sm"
            type="button"
            onClick={() => refetch()}
          >
            Refresh
          </button>
          <button
            class="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => setLaunchOpen(true)}
          >
            Launch workflow
          </button>
        </div>
      </div>
      <section class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Status breakdown</p>
          <ul class="space-y-2">
            <For each={Object.entries(statusCounts())}>
              {([status, count]) => (
                <li class="flex items-center justify-between">
                  <span>{STATUS_LABELS[status] ?? status}</span>
                  <span class="text-[var(--text-muted)]">{count}</span>
                </li>
              )}
            </For>
            <Show when={!Object.keys(statusCounts()).length}>
              <li class="text-[var(--text-muted)]">No runs yet.</li>
            </Show>
          </ul>
        </div>
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <p class="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Recent runs</p>
          <div class="space-y-2">
            <For each={sortedWorkflows()}>
              {(summary) => (
                <button
                  class="flex w-full flex-col rounded-2xl border border-transparent px-3 py-2 text-left hover:border-[var(--border)]"
                  type="button"
                  onClick={() => focusWorkflow(summary.workflow.id)}
                >
                  <div class="flex items-center justify-between text-sm">
                    <span class="font-semibold">{summary.workflow.kind}</span>
                    <span class="text-xs text-[var(--text-muted)]">
                      {new Date(summary.workflow.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  <p class="text-xs text-[var(--text-muted)]">
                    {STATUS_LABELS[summary.workflow.status] ?? summary.workflow.status}
                  </p>
                </button>
              )}
            </For>
            <Show when={!sortedWorkflows().length}>
              <p class="text-sm text-[var(--text-muted)]">No workflows have run for this workspace yet.</p>
            </Show>
          </div>
        </div>
      </section>
      <Show when={focusedWorkflowId()}>
        {(workflowId) => (
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="text-lg font-semibold">Workflow detail</h3>
              <button class="text-sm text-blue-500" type="button" onClick={closeDetail}>
                Close
              </button>
            </div>
            <WorkflowDetailView workflowId={workflowId()} />
          </div>
        )}
      </Show>
      <Show when={launchOpen()}>
        <div
          class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setLaunchOpen(false)}
        >
          <div
            class="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <WorkflowLaunchModal defaultProjectId={props.workspaceId} onClose={() => setLaunchOpen(false)} />
          </div>
        </div>
      </Show>
    </div>
  )
}

function WorkspaceTerminalWidget(props: { workspaceId: string; workspacePath: string }) {
  const [sessions, setSessions] = createSignal<TerminalSession[]>([])
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal('Select or start a session to begin.')
  const [cwdInput, setCwdInput] = createSignal('')
  const [shellInput, setShellInput] = createSignal('')
  const [isCreatingSession, setIsCreatingSession] = createSignal(false)
  const [connectionState, setConnectionState] = createSignal<'idle' | 'connecting' | 'open' | 'closed' | 'error'>(
    'idle'
  )

  let terminalContainer: HTMLDivElement | undefined
  let term: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let socket: WebSocket | null = null
  let detachResizeListener: (() => void) | null = null
  let inputSubscription: { dispose: () => void } | null = null

  createEffect(() => {
    if (!cwdInput() && props.workspacePath) {
      setCwdInput(props.workspacePath)
    }
  })

  const activeSession = createMemo(() => sessions().find((session) => session.id === activeSessionId()) ?? null)

  const refreshSessions = async () => {
    try {
      const list = await listTerminalSessions(props.workspaceId)
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setSessions(list)
      const currentSelection = activeSessionId()
      if (!currentSelection) {
        const preferred = list.find((session) => session.status === 'active') ?? list[0]
        if (preferred) {
          connectToSession(preferred.id)
          return
        }
      } else if (!list.some((session) => session.id === currentSelection)) {
        setActiveSessionId(null)
        term?.reset()
      }
      if (!list.length) {
        setActiveSessionId(null)
        term?.reset()
        setStatusMessage('Start a session to connect.')
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Unable to load terminal sessions')
    }
  }

  const sendResizeUpdate = () => {
    if (!term || socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }

  const scheduleFit = () => {
    if (!fitAddon || !term) return
    requestAnimationFrame(() => {
      if (!fitAddon || !term) return
      fitAddon.fit()
      sendResizeUpdate()
    })
  }

  const ensureTerminal = () => {
    if (term || !terminalContainer) return
    term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#020617',
        foreground: '#e2e8f0',
        cursor: '#38bdf8'
      }
    })
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalContainer)
    fitAddon.fit()
    inputSubscription = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })
    if (typeof window !== 'undefined') {
      const handleResize = () => scheduleFit()
      window.addEventListener('resize', handleResize)
      detachResizeListener = () => {
        window.removeEventListener('resize', handleResize)
        detachResizeListener = null
      }
    }
    scheduleFit()
  }

  const attachSocketHandlers = (sessionId: string) => {
    socket?.close()
    socket = createTerminalWebSocket(sessionId)
    setConnectionState('connecting')
    setStatusMessage('Connecting to terminal…')

    socket.addEventListener('open', () => {
      setConnectionState('open')
      setStatusMessage('Connected.')
      sendResizeUpdate()
    })

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(typeof event.data === 'string' ? event.data : '')
        if (payload.type === 'output' && typeof payload.data === 'string') {
          term?.write(payload.data)
        } else if (payload.type === 'error' && typeof payload.message === 'string') {
          setStatusMessage(payload.message)
          setConnectionState('error')
        } else if (payload.type === 'exit') {
          const exitMessage = `Session exited (code ${payload.exitCode ?? '0'})`
          setStatusMessage(exitMessage)
          setConnectionState('closed')
        }
      } catch {
        /* ignore malformed frames */
      }
    })

    socket.addEventListener('close', () => {
      if (connectionState() !== 'error') {
        setConnectionState('closed')
        setStatusMessage('Terminal disconnected.')
      }
    })

    socket.addEventListener('error', () => {
      setConnectionState('error')
      setStatusMessage('Terminal connection error')
    })
  }

  const connectToSession = (sessionId: string) => {
    ensureTerminal()
    if (!sessionId) return
    if (activeSessionId() !== sessionId) {
      term?.reset()
    }
    setActiveSessionId(sessionId)
    attachSocketHandlers(sessionId)
  }

  const handleStartSession = async (event: Event) => {
    event.preventDefault()
    setIsCreatingSession(true)
    try {
      const session = await createTerminalSession({
        cwd: sanitizeInput(cwdInput()),
        shell: sanitizeInput(shellInput()),
        projectId: props.workspaceId
      })
      setShellInput('')
      if (session) {
        await refreshSessions()
        connectToSession(session.id)
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to start terminal session')
    } finally {
      setIsCreatingSession(false)
    }
  }

  const handleCloseSession = async () => {
    const id = activeSessionId()
    if (!id) return
    try {
      await closeTerminalSession(id)
      setStatusMessage('Session closed')
      await refreshSessions()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to close session')
    }
  }

  createEffect(() => {
    props.workspaceId
    void refreshSessions()
  })

  onCleanup(() => {
    socket?.close()
    socket = null
    detachResizeListener?.()
    inputSubscription?.dispose()
    term?.dispose()
    term = null
    fitAddon?.dispose()
    fitAddon = null
  })

  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <section class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div class="flex h-full flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
          <div class="flex items-center justify-between gap-3">
            <p class="text-sm font-semibold text-[var(--text)]">Sessions for {props.workspacePath}</p>
            <button
              class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
              type="button"
              onClick={() => void refreshSessions()}
            >
              Refresh
            </button>
          </div>
          <p class="text-xs text-[var(--text-muted)]">Select a session to attach the terminal.</p>
          <div class="flex-1 space-y-2 overflow-auto pr-1">
            <For each={sessions()}>
              {(session) => (
                <button
                  class="w-full rounded-2xl border px-3 py-2 text-left"
                  classList={{
                    'border-blue-500 bg-blue-950/30': activeSessionId() === session.id,
                    'border-[var(--border)] bg-[var(--bg-muted)]': activeSessionId() !== session.id
                  }}
                  type="button"
                  onClick={() => connectToSession(session.id)}
                >
                  <div class="flex items-center justify-between text-sm">
                    <span class="font-semibold">{session.id.slice(0, 8)}</span>
                    <span class="text-xs text-[var(--text-muted)]">{session.status}</span>
                  </div>
                  <p class="text-xs text-[var(--text-muted)]">{session.shellCommand || 'Default shell'}</p>
                  <p class="text-xs text-[var(--text-muted)]">{session.initialCwd || 'Inherited directory'}</p>
                  <p class="text-xs text-[var(--text-muted)]">Started {formatTimestamp(session.createdAt)}</p>
                </button>
              )}
            </For>
            <Show when={!sessions().length}>
              <p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>
            </Show>
          </div>
          <form
            class="space-y-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-3"
            onSubmit={handleStartSession}
          >
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">New session</p>
            <label class="text-xs font-semibold text-[var(--text-muted)]" for="workspace-terminal-cwd">
              Working directory
            </label>
            <input
              id="workspace-terminal-cwd"
              class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2"
              type="text"
              value={cwdInput()}
              onInput={(event) => setCwdInput(event.currentTarget.value)}
            />
            <label class="text-xs font-semibold text-[var(--text-muted)]" for="workspace-terminal-shell">
              Shell (optional)
            </label>
            <input
              id="workspace-terminal-shell"
              class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2"
              type="text"
              value={shellInput()}
              onInput={(event) => setShellInput(event.currentTarget.value)}
              placeholder="/bin/zsh"
            />
            <button
              class="w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              type="submit"
              disabled={isCreatingSession()}
            >
              {isCreatingSession() ? 'Starting…' : 'Start session'}
            </button>
          </form>
        </div>
        <div class="flex h-full flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3">
            <div>
              <p class="text-sm font-semibold">
                {activeSession() ? `Attached to ${activeSession()!.id.slice(0, 8)}` : 'Select a session to attach'}
              </p>
              <p class="text-xs text-[var(--text-muted)]">{statusMessage()}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
                type="button"
                onClick={() => void refreshSessions()}
              >
                Refresh
              </button>
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs disabled:opacity-60"
                type="button"
                disabled={!activeSession()}
                onClick={() => void handleCloseSession()}
              >
                Close session
              </button>
            </div>
          </div>
          <div class="flex-1">
            <div
              ref={(node) => {
                terminalContainer = node ?? undefined
                ensureTerminal()
              }}
              class="h-full min-h-[360px] rounded-b-2xl bg-[#020617]"
            />
          </div>
          <div class="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
            Connection: {connectionState()}
          </div>
        </div>
      </section>
    </div>
  )
}

function SessionsWidget(props: { workspacePath: string }) {
  const [filter, setFilter] = createSignal(props.workspacePath ?? '')
  createEffect(() => {
    if (props.workspacePath) {
      setFilter(props.workspacePath)
    }
  })
  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <OpencodeConsole workspaceFilter={filter()} onWorkspaceFilterChange={setFilter} />
    </div>
  )
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'unknown time'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function sanitizeInput(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}
