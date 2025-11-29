import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import DiffViewer from '../../components/DiffViewer'
import type { GitFileChange, GitInfo } from '../../../../interfaces/core/git'
import type { WorkspaceRecord } from '../../../../interfaces/core/projects'
import {
  checkoutGitRef,
  commitGitChanges,
  discardGitPath,
  generateCommitMessage,
  pullGitRemote,
  pushGitRemote,
  stageGitPaths,
  stashGitPath,
  unstageGitPaths,
  unstashGitPath
} from '../../lib/git'
import { fetchJson } from '../../shared/api/httpClient'
import { formatTimestamp } from '../../shared/utils/datetime'

export type WorkspaceSummaryProps = {
  workspace: WorkspaceRecord
  onOpenNavigator: () => void
}

type GitDisplayChange = GitFileChange & { key: string; view: 'working' | 'staged' }

export function WorkspaceSummary(props: WorkspaceSummaryProps) {
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
  const remoteBranchTarget = () => {
    const candidate = branchLabel()
    if (candidate && candidate.trim().length) {
      return candidate
    }
    const fallback = workspace().defaultBranch
    return fallback && fallback.trim().length ? fallback : 'main'
  }

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
  const isRemoteActionPending = (remoteName: string, mode: 'pull' | 'push') =>
    pendingAction() === `${mode}:${remoteName}`

  const handleRemoteSync = async (remoteName: string, mode: 'pull' | 'push') => {
    const branch = remoteBranchTarget()
    const executor = () =>
      mode === 'pull'
        ? pullGitRemote(workspace().id, remoteName, branch)
        : pushGitRemote(workspace().id, remoteName, branch)
    await runGitAction(`${mode}:${remoteName}`, executor)
  }

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
    void runGitAction(
      'discard',
      () => discardGitPath(workspace().id, change.path, change.isUntracked),
      `discard:${change.path}`
    )
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

  const handleGenerateCommitMessage = async () => {
    setPendingAction('generate-commit')
    setGitError(null)
    try {
      const message = await generateCommitMessage(workspace().id)
      setCommitMessage(message)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate commit message'
      setGitError(message)
    } finally {
      setPendingAction(null)
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
      <div
        class="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2"
        data-key={rowKey}
      >
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
              <For each={branches().length ? branches() : [branchLabel()]}>
                {(branch) => <option value={branch ?? ''}>{branch ?? 'unknown'}</option>}
              </For>
            </select>
            <button
              class="rounded-lg border border-[var(--border)] px-3 py-1"
              type="button"
              disabled={
                !checkoutTarget().trim() || checkoutTarget() === branchLabel() || pendingAction() === 'checkout'
              }
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
            <button
              class="rounded-lg border border-[var(--border)] px-3 py-1"
              type="button"
              onClick={props.onOpenNavigator}
            >
              Manage
            </button>
          </div>
        </div>
        <Show when={gitError()}>{(message) => <p class="mt-2 text-xs text-red-400">{message()}</p>}</Show>
        <form
          class="mt-4 flex flex-col gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void handleCommit()
          }}
        >
          <label
            class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]"
            for="workspace-commit-message"
          >
            Commit message
          </label>
          <div class="relative">
            <input
              id="workspace-commit-message"
              class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 pr-10"
              type="text"
              placeholder="Describe your changes"
              value={commitMessage()}
              onInput={(event) => setCommitMessage(event.currentTarget.value)}
            />
            <button
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-blue-600 disabled:opacity-50"
              onClick={handleGenerateCommitMessage}
              disabled={pendingAction() === 'generate-commit' || (!stagedChanges().length && !workingChanges().length)}
              title="Generate commit message with GitHub Copilot"
            >
              <Show when={pendingAction() === 'generate-commit'} fallback="✨">
                <div class="h-3 w-3 animate-spin rounded-full border border-[var(--text-muted)] border-t-transparent" />
              </Show>
            </button>
          </div>
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
              <Show
                when={workingChanges().length}
                fallback={<p class="text-xs text-[var(--text-muted)]">No unstaged changes.</p>}
              >
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
              <Show
                when={stagedChanges().length}
                fallback={<p class="text-xs text-[var(--text-muted)]">No staged changes.</p>}
              >
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
              {(remote) => {
                const showPull = remote.behind !== undefined && remote.behind > 0
                const showPush = remote.ahead !== undefined && remote.ahead > 0
                const hasDelta = showPull || showPush

                return (
                  <div class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <p class="text-xs uppercase tracking-wide text-[var(--text-muted)]">{remote.name}</p>
                          <Show when={hasDelta}>
                            <span class="text-xs text-[var(--text-muted)]">
                              {showPull && <span class="text-blue-400">↓{remote.behind}</span>}
                              {showPull && showPush && <span class="mx-1">·</span>}
                              {showPush && <span class="text-green-400">↑{remote.ahead}</span>}
                            </span>
                          </Show>
                        </div>
                        <p class="text-sm text-[var(--text)] truncate">{remote.url}</p>
                      </div>
                      <div class="flex gap-2 text-xs">
                        <Show when={showPull}>
                          <button
                            class="rounded-lg border border-[var(--border)] px-3 py-1"
                            type="button"
                            disabled={isRemoteActionPending(remote.name, 'pull')}
                            onClick={() => void handleRemoteSync(remote.name, 'pull')}
                          >
                            {isRemoteActionPending(remote.name, 'pull') ? 'Pulling…' : 'Pull'}
                          </button>
                        </Show>
                        <Show when={showPush}>
                          <button
                            class="rounded-lg border border-[var(--border)] px-3 py-1"
                            type="button"
                            disabled={isRemoteActionPending(remote.name, 'push')}
                            onClick={() => void handleRemoteSync(remote.name, 'push')}
                          >
                            {isRemoteActionPending(remote.name, 'push') ? 'Pushing…' : 'Push'}
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>
                )
              }}
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

export default WorkspaceSummary
