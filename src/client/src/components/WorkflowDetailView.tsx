import type { JSX } from 'solid-js'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js'
import { fetchJson } from '../shared/api/httpClient'
import DiffViewer from './DiffViewer'

type WorkflowRecord = {
  id: string
  projectId: string
  status: string
  kind: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type WorkflowStep = {
  id: string
  workflowId: string
  status: string
  sequence: number
  dependsOn: string[]
  taskId?: string | null
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
  updatedAt: string
}

type WorkflowDetail = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
  runs: AgentRunRecord[]
}

type AgentRunRecord = {
  id: string
  workflowStepId: string | null
  logsPath: string | null
  status: string
  branch: string
  startedAt: string
  finishedAt: string | null
}

type DiffPayload = {
  workflowId: string
  stepId: string
  commitHash: string
  branch: string
  message: string
  diffText: string
}

type AgentWorkerTurn = {
  round: number
  parsed: {
    status: string
    plan: string
    work: string
    requests: string
  }
}

type AgentVerifierTurn = {
  round: number
  parsed: {
    verdict: string
    critique: string
    instructions: string
    priority: number
  }
}

type AgentConversation = {
  userInstructions: string
  outcome: 'approved' | 'failed' | 'max-rounds'
  reason: string
  bootstrap: AgentVerifierTurn
  rounds: Array<{
    worker: AgentWorkerTurn
    verifier: AgentVerifierTurn
  }>
  provider?: string | null
  model?: string | null
}

type WorkspaceInfo = {
  workspacePath: string
  branchName: string
  baseBranch: string
}

type CommitInfo = {
  branch: string
  commitHash: string
  message: string
  changedFiles: string[]
}

type WorkflowStepResult = {
  workspace?: WorkspaceInfo
  commit?: CommitInfo
  agent?: AgentConversation
  summary?: string
  instructions?: string
  note?: string
  error?: string
  provenance?: {
    logsPath?: string | null
  }
  pullRequest?: {
    id: string
  }
  policyAudit?: {
    runnerInstanceId?: string | null
    decision?: {
      allowed?: boolean
      reason?: string
      metadata?: Record<string, unknown>
    }
    recordedAt?: string
  }
}

type WorkflowRunnerEvent = {
  id: string
  workflowId: string
  stepId: string
  type: string
  status: string
  runnerInstanceId: string | null
  attempts: number
  latencyMs: number | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

type WorkflowEventsPayload = {
  workflowId: string
  events: WorkflowRunnerEvent[]
}

type WorkspaceEntry = {
  name: string
  kind: 'file' | 'directory'
}

type ProvenancePayload = {
  logsPath: string | null
  workspacePath: string | null
  content: string | null
  parsed: unknown
  workspaceEntries: WorkspaceEntry[]
  downloadUrl?: string | null
}

type WorkflowDetailViewProps = {
  workflowId: string | undefined | null
  actions?: JSX.Element
}

export default function WorkflowDetailView(props: WorkflowDetailViewProps) {
  const [selectedStepId, setSelectedStepId] = createSignal<string | null>(null)
  const [diffError, setDiffError] = createSignal<string | null>(null)
  const [provenanceOpen, setProvenanceOpen] = createSignal(false)
  const [provenanceError, setProvenanceError] = createSignal<string | null>(null)

  createEffect(() => {
    // reset local state when workflow changes
    void props.workflowId
    setSelectedStepId(null)
    setDiffError(null)
    setProvenanceOpen(false)
    setProvenanceError(null)
  })

  const [detail, { refetch: refetchDetail }] = createResource(
    () => props.workflowId,
    async (workflowId) => {
      if (!workflowId) return null
      return await fetchJson<WorkflowDetail>(`/api/workflows/${workflowId}`)
    }
  )

  const [runnerEvents, { refetch: refetchRunnerEvents }] = createResource(
    () => props.workflowId,
    async (workflowId) => {
      if (!workflowId) return null
      return await fetchJson<WorkflowEventsPayload>(`/api/workflows/${workflowId}/events`)
    }
  )

  createEffect(() => {
    const workflowId = props.workflowId
    const summary = detail()
    if (!workflowId || !summary) {
      return
    }
    if (!shouldPollWorkflow(summary.workflow, summary.steps)) {
      return
    }
    const timer = setInterval(() => {
      void refetchDetail()
      void refetchRunnerEvents()
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })

  const workflowRecord = () => detail()?.workflow ?? null

  const selectedStep = createMemo<WorkflowStep | null>(() => {
    const summary = detail()
    if (!summary) return null
    const id = selectedStepId()
    if (!id) return null
    return summary.steps.find((step) => step.id === id) ?? null
  })

  const selectedResult = createMemo<WorkflowStepResult | null>(() => {
    const step = selectedStep()
    if (!step?.result) return null
    return step.result as WorkflowStepResult
  })

  const selectedAgent = createMemo<AgentConversation | null>(() => selectedResult()?.agent ?? null)
  const selectedCommit = createMemo<CommitInfo | null>(() => selectedResult()?.commit ?? null)
  const selectedWorkspace = createMemo<WorkspaceInfo | null>(() => selectedResult()?.workspace ?? null)
  const selectedPolicyAudit = createMemo(() => selectedResult()?.policyAudit ?? null)
  const selectedPullRequest = createMemo(() => selectedResult()?.pullRequest ?? null)
    const plannerSteps = createMemo(() => detail()?.steps ?? [])
    const describeDependencies = (step: WorkflowStep) =>
      step.dependsOn && step.dependsOn.length ? step.dependsOn.join(', ') : 'None'
  const agentProviderMeta = createMemo(() => {
    const agent = selectedAgent()
    if (!agent) return null
    const providerLabel = agent.provider?.trim()
    const modelLabel = agent.model?.trim()
    if (!providerLabel && !modelLabel) return null
    return [providerLabel, modelLabel].filter(Boolean).join(' · ')
  })
  const stepInstructions = createMemo(() => {
    const resultInstructions = selectedResult()?.instructions
    if (typeof resultInstructions === 'string' && resultInstructions.trim().length) {
      return resultInstructions
    }
    const step = selectedStep()
    const raw = step ? (step.data as Record<string, unknown>)['instructions'] : undefined
    return typeof raw === 'string' && raw.trim().length ? raw : null
  })

  createEffect(() => {
    const summary = detail()
    if (!summary) return
    if (!selectedStepId()) {
      const firstWithCommit = summary.steps.find((step) => hasCommit(step))
      setSelectedStepId(firstWithCommit?.id ?? summary.steps[0]?.id ?? null)
    }
  })

  createEffect(() => {
    selectedStepId()
    setProvenanceOpen(false)
    setProvenanceError(null)
  })

  const runnerEventList = createMemo(() => runnerEvents()?.events ?? [])
  const selectedRunnerEvents = createMemo(() => {
    const stepId = selectedStepId()
    if (!stepId) return []
    return runnerEventList().filter((event) => event.stepId === stepId)
  })
  const changedFiles = createMemo(() => selectedCommit()?.changedFiles ?? [])

  const [diff] = createResource(
    () => {
      const workflowId = props.workflowId
      const stepId = selectedStepId()
      if (!workflowId || !stepId) return null
      return { workflowId, stepId }
    },
    async (input) => {
      if (!input) return null
      try {
        setDiffError(null)
        return await fetchJson<DiffPayload>(`/api/workflows/${input.workflowId}/steps/${input.stepId}/diff`)
      } catch (error) {
        setDiffError(error instanceof Error ? error.message : 'Diff unavailable')
        return null
      }
    }
  )

  const [provenance] = createResource(
    () => {
      if (!provenanceOpen()) return null
      const workflowId = props.workflowId
      const stepId = selectedStepId()
      if (!workflowId || !stepId) return null
      return { workflowId, stepId }
    },
    async (params) => {
      if (!params) return null
      setProvenanceError(null)
      try {
        return await fetchJson<ProvenancePayload>(
          `/api/workflows/${params.workflowId}/steps/${params.stepId}/provenance`
        )
      } catch (error) {
        setProvenanceError(error instanceof Error ? error.message : 'Failed to load provenance data')
        return null
      }
    }
  )

  const formattedProvenance = createMemo(() => {
    const payload = provenance()
    if (!payload) return null
    if (payload.parsed) {
      try {
        return JSON.stringify(payload.parsed, null, 2)
      } catch {
        // ignore and fall back to raw content
      }
    }
    if (payload.content) {
      try {
        return JSON.stringify(JSON.parse(payload.content), null, 2)
      } catch {
        return payload.content
      }
    }
    return null
  })

  const renderActions = () => {
    if (!props.actions) return null
    return <div>{props.actions}</div>
  }

  return (
    <div class="flex flex-col gap-6" data-testid="workflow-detail-view">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Workflow detail</p>
          <h1 class="text-3xl font-semibold text-[var(--text)]">
            {workflowRecord() ? `${workflowRecord()!.kind} workflow` : 'Loading…'}
          </h1>
          <Show
            when={workflowRecord()}
            fallback={<p class="text-[var(--text-muted)]">Select a workflow to inspect.</p>}
          >
            {(workflow) => (
              <p class="text-[var(--text-muted)]">
                Status · {workflow().status} — started {new Date(workflow().createdAt).toLocaleString()}
              </p>
            )}
          </Show>
        </div>
        {renderActions()}
      </header>

      <div class="grid gap-6 lg:grid-cols-[320px,1fr]">
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h2 class="mb-3 text-lg font-semibold text-[var(--text)]">Steps</h2>
          <Show when={detail()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading steps…</p>}>
            {(payload) => (
              <ol class="flex flex-col gap-2">
                <For each={payload().steps}>
                  {(step) => (
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-xl border border-[var(--border)] px-3 py-2 text-left text-sm"
                        classList={{
                          'bg-blue-600 text-white': selectedStepId() === step.id,
                          'bg-[var(--bg-muted)] text-[var(--text)]': selectedStepId() !== step.id
                        }}
                        onClick={() => setSelectedStepId(step.id)}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <span class="font-semibold">
                            {typeof step.data?.title === 'string'
                              ? (step.data.title as string)
                              : `Step ${step.sequence}`}
                          </span>
                          <span class="text-xs capitalize">{step.status}</span>
                        </div>
                        <Show when={hasCommit(step)}>
                          <p class="text-xs opacity-70">Commit ready</p>
                        </Show>
                        <Show when={runnerStatus(step)}>
                          {(label) => <p class="text-xs text-[var(--text-muted)]">{label()}</p>}
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </Show>
        </section>

        <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h2 class="mb-3 text-lg font-semibold text-[var(--text)]">Planner timeline</h2>
          <Show when={plannerSteps().length > 0} fallback={<p class="text-sm text-[var(--text-muted)]">Planner tasks will appear after a plan is attached to this workflow.</p>}>
            <ol class="flex flex-col gap-3">
              <For each={plannerSteps()}>
                {(step) => (
                  <li class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text)]">
                    <div class="flex items-center justify-between gap-2">
                      <p class="font-semibold">
                        {typeof step.data?.title === 'string' ? (step.data.title as string) : `Step ${step.sequence}`}
                      </p>
                      <span class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Seq {step.sequence}</span>
                    </div>
                    <p class="text-xs text-[var(--text-muted)]">Status · {step.status}</p>
                    <p class="text-xs text-[var(--text-muted)]">Depends on · {describeDependencies(step)}</p>
                    <p class="text-xs text-[var(--text-muted)]">Planner task · {step.taskId ?? 'not mapped'}</p>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>

        <div class="flex flex-col gap-4">
          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <header class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <h2 class="text-lg font-semibold text-[var(--text)]">Diff preview</h2>
                <Show when={selectedCommit()}>
                  {(commit) => (
                    <span class="text-xs text-[var(--text-muted)]">
                      {commit().branch} · {shortHash(commit().commitHash)}
                    </span>
                  )}
                </Show>
              </div>
              <Show when={diffError()}>{(message) => <p class="text-xs text-red-500">{message()}</p>}</Show>
            </header>
            <DiffViewer diffText={diff()?.diffText ?? null} />
          </section>

          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <header class="space-y-1">
              <h2 class="text-lg font-semibold text-[var(--text)]">Branch &amp; PR status</h2>
              <Show when={selectedCommit()}>
                {(commit) => (
                  <p class="text-xs text-[var(--text-muted)]">
                    Branch {commit().branch} · Commit {shortHash(commit().commitHash)}
                  </p>
                )}
              </Show>
            </header>
            <Show
              when={selectedCommit()}
              fallback={<p class="text-sm text-[var(--text-muted)]">Commit metadata will appear once this step finishes with a git update.</p>}
            >
              {(commit) => (
                <div class="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text)]">
                  <p class="font-semibold">{commit().message || 'No commit message recorded.'}</p>
                  <div class="flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
                    <span>Hash · {commit().commitHash}</span>
                    <span>Files changed · {changedFiles().length}</span>
                  </div>
                  <Show when={changedFiles().length > 0}>
                    <ul class="max-h-40 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-xs">
                      <For each={changedFiles().slice(0, 8)}>
                        {(file) => (
                          <li class="border-b border-[var(--border)] px-3 py-2 font-mono text-[var(--text)] last:border-b-0">
                            {file}
                          </li>
                        )}
                      </For>
                      <Show when={changedFiles().length > 8}>
                        <li class="px-3 py-2 text-[var(--text-muted)]">+{changedFiles().length - 8} more</li>
                      </Show>
                    </ul>
                  </Show>
                  <Show when={selectedPullRequest()}>
                    {(pullRequest) => (
                      <p class="text-xs text-[var(--text-muted)]">
                        Pull request queued · ID {pullRequest().id}
                      </p>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </section>

          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <header class="space-y-1">
              <h2 class="text-lg font-semibold text-[var(--text)]">Runner telemetry</h2>
              <Show when={selectedRunnerEvents().length === 0}>
                <p class="text-xs text-[var(--text-muted)]">Runner heartbeats will appear while this step is enqueued or executing.</p>
              </Show>
            </header>
            <Show when={selectedRunnerEvents().length > 0}>
              <ul class="flex flex-col gap-2">
                <For each={selectedRunnerEvents()}>
                  {(event) => (
                    <li
                      class="rounded-xl border p-3 text-xs"
                      classList={{
                        'border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text)]': event.status !== 'failed',
                        'border-red-500/50 bg-red-500/5 text-[var(--text)]': event.status === 'failed'
                      }}
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <p class="font-semibold">
                          {describeRunnerEvent(event)} · {event.status}
                        </p>
                        <span class="text-[var(--text-muted)]">{formatTimestamp(event.createdAt)}</span>
                      </div>
                      <div class="flex flex-wrap gap-3 text-[var(--text-muted)]">
                        <Show when={event.runnerInstanceId}>
                          {(id) => <span>Runner {shortToken(id())}</span>}
                        </Show>
                        <span>Attempts {event.attempts}</span>
                        <Show when={formatLatency(event.latencyMs)}>{(latency) => <span>Latency {latency()}</span>}</Show>
                      </div>
                      <Show when={event.metadata?.error}>
                        {(message) => <p class="mt-1 text-red-500">{String(message())}</p>}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <header class="space-y-1">
              <h2 class="text-lg font-semibold text-[var(--text)]">Task brief & agent trace</h2>
              <Show when={selectedWorkspace()}>
                {(workspace) => (
                  <p class="text-xs text-[var(--text-muted)]">
                    Branch {workspace().branchName} (base {workspace().baseBranch}) · {workspace().workspacePath}
                  </p>
                )}
              </Show>
            </header>
            <div class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text)]">
              <Show
                when={stepInstructions()}
                fallback={<p class="text-[var(--text-muted)]">No explicit instructions provided for this step.</p>}
              >
                {(body) => <p class="whitespace-pre-wrap">{body()}</p>}
              </Show>
            </div>
            <div>
              <Show
                when={selectedAgent()}
                fallback={<p class="text-sm text-[var(--text-muted)]">Agent output not available yet.</p>}
              >
                {(agent) => (
                  <div class="flex flex-col gap-3">
                    <p class="text-sm text-[var(--text)]">
                      Outcome ·
                      <span
                        class="ml-1 font-semibold"
                        classList={{
                          'text-green-600': agent().outcome === 'approved',
                          'text-amber-600': agent().outcome === 'max-rounds',
                          'text-red-600': agent().outcome === 'failed'
                        }}
                      >
                        {agent().outcome}
                      </span>{' '}
                      — {agent().reason}
                    </p>
                    <Show when={agentProviderMeta()}>
                      {(meta) => <p class="text-xs text-[var(--text-muted)]">Agent · {meta()}</p>}
                    </Show>
                    <p class="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{agent().userInstructions}</p>
                    <div class="divide-y divide-[var(--border)] border border-[var(--border)] rounded-2xl">
                      <div class="space-y-1 p-4">
                        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                          Verifier bootstrap
                        </p>
                        <p class="text-sm text-[var(--text)] whitespace-pre-wrap">
                          {agent().bootstrap.parsed.instructions || agent().bootstrap.parsed.critique}
                        </p>
                      </div>
                      <For each={agent().rounds}>
                        {(round) => (
                          <div class="space-y-3 p-4">
                            <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              Round {round.worker.round}
                            </p>
                            <div class="space-y-1">
                              <p class="text-xs font-semibold text-[var(--text-muted)]">Worker plan</p>
                              <p class="text-sm text-[var(--text)] whitespace-pre-wrap">
                                {(round.worker.parsed.plan || round.worker.parsed.work || '').trim() ||
                                  'No plan returned.'}
                              </p>
                            </div>
                            <div class="space-y-1">
                              <p class="text-xs font-semibold text-[var(--text-muted)]">Verifier guidance</p>
                              <p class="text-sm text-[var(--text)] whitespace-pre-wrap">
                                {round.verifier.parsed.instructions || round.verifier.parsed.critique}
                              </p>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={selectedPolicyAudit()}>
                {(audit) => (
                  <div class="mt-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm">
                    <div class="flex items-center justify-between gap-2">
                      <p class="font-semibold text-[var(--text)]">Policy decision</p>
                      <span class="text-xs text-[var(--text-muted)]">
                        Runner · {audit().runnerInstanceId ?? 'unknown'}
                      </span>
                    </div>
                    <p class="text-sm text-[var(--text)]">
                      {audit().decision?.allowed ? 'Allowed' : 'Blocked'}{' '}
                      {audit().decision?.reason ? `— ${audit().decision?.reason}` : ''}
                    </p>
                    <Show when={audit().recordedAt}>
                      {(timestamp) => (
                        <p class="text-xs text-[var(--text-muted)]">
                          Recorded {new Date(timestamp()).toLocaleString()}
                        </p>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </section>

          <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <button
              type="button"
              class="flex items-center justify-between gap-2 text-left text-lg font-semibold text-[var(--text)]"
              onClick={() => setProvenanceOpen((prev) => !prev)}
              disabled={!selectedStepId()}
              aria-expanded={provenanceOpen()}
            >
              <span>Provenance & workspace</span>
              <span class="text-sm text-[var(--text-muted)]">{provenanceOpen() ? 'Hide' : 'Show'}</span>
            </button>
            <Show when={provenanceOpen()}>
              <div class="space-y-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm">
                <Show when={provenance.loading}>
                  <p class="text-[var(--text-muted)]">Loading provenance…</p>
                </Show>
                <Show when={provenanceError()}>{(message) => <p class="text-red-500">{message()}</p>}</Show>
                <Show
                  when={provenance()}
                  fallback={
                    <p class="text-[var(--text-muted)]">
                      {provenanceError() ?? 'Select a workflow step and expand this panel to view provenance details.'}
                    </p>
                  }
                >
                  {(payload) => (
                    <div class="grid gap-4 lg:grid-cols-2">
                      <div class="space-y-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                          Provenance file
                        </p>
                        <code class="block truncate rounded bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text)]">
                          {payload().logsPath ?? 'Not recorded'}
                        </code>
                        <Show when={payload().downloadUrl}>
                          {(url) => (
                            <a
                              class="text-xs font-semibold text-blue-500 underline"
                              href={url() ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Download raw JSON
                            </a>
                          )}
                        </Show>
                        <div class="max-h-64 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 text-xs text-[var(--text)]">
                          <Show
                            when={formattedProvenance()}
                            fallback={<p class="text-[var(--text-muted)]">Provenance file is empty or unavailable.</p>}
                          >
                            {(body) => <pre class="whitespace-pre-wrap font-mono leading-snug">{body()}</pre>}
                          </Show>
                        </div>
                      </div>
                      <div class="space-y-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                          Workspace folder
                        </p>
                        <code class="block truncate rounded bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text)]">
                          {payload().workspacePath ?? 'Workspace no longer available'}
                        </code>
                        <Show
                          when={(payload().workspaceEntries?.length ?? 0) > 0}
                          fallback={
                            <p class="text-xs text-[var(--text-muted)]">
                              Workspace directory listing unavailable or cleaned up.
                            </p>
                          }
                        >
                          <ul class="max-h-64 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-xs">
                            <For each={payload().workspaceEntries}>
                              {(entry) => (
                                <li class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 last:border-b-0">
                                  <span class="font-mono text-[var(--text)]">{entry.name}</span>
                                  <span class="text-[var(--text-muted)]">
                                    {entry.kind === 'directory' ? 'dir' : 'file'}
                                  </span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </section>
        </div>
      </div>
    </div>
  )
}

const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function shouldPollWorkflow(workflow: WorkflowRecord | null, steps: WorkflowStep[]): boolean {
  if (!workflow) return false
  if (!TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return true
  }
  return steps.some((step) => step.status === 'pending' || step.status === 'running')
}

function hasCommit(step: WorkflowStep): boolean {
  const commitPayload = (step.result as WorkflowStepResult | null)?.commit
  return typeof commitPayload?.commitHash === 'string'
}

function runnerStatus(step: WorkflowStep): string | null {
  if (step.status !== 'running') return null
  if (!step.runnerInstanceId) return 'Waiting for Docker runner'
  return `Runner ${shortToken(step.runnerInstanceId)}`
}

function describeRunnerEvent(event: WorkflowRunnerEvent): string {
  switch (event.type) {
    case 'runner.enqueue':
      return event.status === 'failed' ? 'Runner enqueue attempt' : 'Runner enqueued'
    case 'runner.execute':
      return 'Runner execution'
    case 'runner.callback':
      return 'Callback delivery'
    default: {
      const fallback = event.type.replace(/\./g, ' ').trim()
      return fallback.length ? fallback.replace(/^./, (char) => char.toUpperCase()) : 'Runner event'
    }
  }
}

function shortToken(token: string): string {
  return token.length <= 14 ? token : `${token.slice(0, 6)}…${token.slice(-4)}`
}

function shortHash(hash: string): string {
  if (!hash) return ''
  return hash.length > 10 ? hash.slice(0, 10) : hash
}

function formatLatency(latencyMs: number | null): string | null {
  if (typeof latencyMs !== 'number' || Number.isNaN(latencyMs)) {
    return null
  }
  if (latencyMs < 1000) {
    return `${latencyMs} ms`
  }
  return `${(latencyMs / 1000).toFixed(1)} s`
}

function formatTimestamp(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toLocaleString()
}
