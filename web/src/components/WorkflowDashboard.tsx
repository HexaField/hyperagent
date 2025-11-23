import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js'

type Project = {
  id: string
  name: string
  description?: string | null
  repositoryPath: string
  defaultBranch: string
  createdAt: string
}

type WorkflowRecord = {
  id: string
  projectId: string
  kind: string
  status: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type WorkflowStep = {
  id: string
  workflowId: string
  status: string
  sequence: number
  data: Record<string, unknown>
  result: Record<string, unknown> | null
}

type WorkflowSummary = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
}

type CodeServerSession = {
  id: string
  projectId: string
  branch: string
  workspacePath: string
  url: string
  status: string
  startedAt: string
}

type CreateProjectPayload = {
  name: string
  repositoryPath: string
  description?: string
  defaultBranch?: string
}

type CreateWorkflowPayload = {
  projectId: string
  kind?: string
  tasks: Array<{ id: string; title: string; instructions: string }>
  autoStart?: boolean
}

async function fetchJson<T> (input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || 'Request failed')
  }
  return (await response.json()) as T
}

export default function WorkflowDashboard () {
  const [projectForm, setProjectForm] = createSignal<CreateProjectPayload>({
    name: '',
    repositoryPath: ''
  })
  const [workflowForm, setWorkflowForm] = createSignal({
    kind: 'custom',
    tasksInput: '',
    autoStart: true
  })
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null)

  const [projects, { refetch: refetchProjects }] = createResource(async () => {
    const data = await fetchJson<{ projects: Project[] }>('/api/projects')
    return data.projects
  })

  createEffect(() => {
    const list = projects()
    if (list && list.length && !selectedProjectId()) {
      setSelectedProjectId(list[0].id)
    }
  })

  const [workflows, { refetch: refetchWorkflows }] = createResource(selectedProjectId, async (projectId) => {
    if (!projectId) return []
    const data = await fetchJson<{ workflows: WorkflowSummary[] }>(`/api/workflows?projectId=${encodeURIComponent(projectId)}`)
    return data.workflows
  })

  const [sessions, { refetch: refetchSessions }] = createResource(async () => {
    const data = await fetchJson<{ sessions: CodeServerSession[] }>('/api/code-server/sessions')
    return data.sessions
  })

  const activeProject = createMemo(() => {
    const list = projects()
    const selected = selectedProjectId()
    return list?.find(project => project.id === selected) ?? null
  })

  const handleProjectSubmit = async (event: SubmitEvent) => {
    event.preventDefault()
    const payload = projectForm()
    if (!payload.name.trim() || !payload.repositoryPath.trim()) {
      setStatusMessage('Project name and repository path are required')
      return
    }
    try {
      await fetchJson<Project>(
        '/api/projects',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      )
      setProjectForm({ name: '', repositoryPath: '' })
      await refetchProjects()
      setStatusMessage('Project created')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to create project')
    }
  }

  const handleWorkflowSubmit = async (event: SubmitEvent) => {
    event.preventDefault()
    const projectId = selectedProjectId()
    if (!projectId) {
      setStatusMessage('Select a project first')
      return
    }
    const tasks = buildTasksFromInput(workflowForm().tasksInput)
    if (!tasks.length) {
      setStatusMessage('Enter at least one task (one per line)')
      return
    }
    const payload: CreateWorkflowPayload = {
      projectId,
      kind: workflowForm().kind,
      tasks,
      autoStart: workflowForm().autoStart
    }
    try {
      await fetchJson('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      setWorkflowForm(form => ({ ...form, tasksInput: '' }))
      await refetchWorkflows()
      setStatusMessage('Workflow created')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to create workflow')
    }
  }

  const refreshAll = async () => {
    await Promise.all([refetchProjects(), refetchWorkflows(), refetchSessions()])
  }

  return (
    <section class="flex flex-col gap-6 rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-[0_18px_30px_rgba(15,23,42,0.08)]">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Workflow runtime</p>
          <h2 class="text-2xl font-semibold text-[var(--text)]">Projects & workflows</h2>
          <p class="text-[var(--text-muted)]">
            Persist project metadata, queue workflows, and watch the background worker progress.
          </p>
        </div>
        <button
          class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
          type="button"
          onClick={refreshAll}
        >
          Refresh
        </button>
      </header>

      <Show when={statusMessage()}>
        {message => <p class="text-sm text-[var(--text-muted)]">{message()}</p>}
      </Show>

      <div class="grid gap-6 lg:grid-cols-2">
        <form class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4" onSubmit={handleProjectSubmit}>
          <h3 class="text-lg font-semibold text-[var(--text)]">New project</h3>
          <label class="text-sm font-semibold text-[var(--text-muted)]" for="project-name">
            Name
          </label>
          <input
            id="project-name"
            type="text"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2 text-[var(--text)]"
            value={projectForm().name}
            onInput={event => setProjectForm(form => ({ ...form, name: event.currentTarget.value }))}
          />
          <label class="text-sm font-semibold text-[var(--text-muted)]" for="project-repo">
            Repository path
          </label>
          <input
            id="project-repo"
            type="text"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2 text-[var(--text)]"
            value={projectForm().repositoryPath}
            onInput={event => setProjectForm(form => ({ ...form, repositoryPath: event.currentTarget.value }))}
          />
          <button class="rounded-xl bg-[#0f172a] px-4 py-2 font-semibold text-white" type="submit">
            Save project
          </button>
        </form>

        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
          <h3 class="mb-3 text-lg font-semibold text-[var(--text)]">Projects</h3>
          <Show when={projects()} fallback={<p class="text-sm text-[var(--text-muted)]">No projects yet.</p>}>
            {list => (
              <ul class="flex flex-col gap-2">
                <For each={list()}>
                  {project => (
                    <li>
                      <button
                        type="button"
                        class="flex w-full flex-col rounded-xl border px-3 py-2 text-left"
                        classList={{
                          'border-blue-500 text-blue-600': selectedProjectId() === project.id,
                          'border-[var(--border)] text-[var(--text)]': selectedProjectId() !== project.id
                        }}
                        onClick={() => setSelectedProjectId(project.id)}
                      >
                        <span class="font-semibold">{project.name}</span>
                        <span class="text-xs text-[var(--text-muted)]">{project.repositoryPath}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
        </div>
      </div>

      <Show when={activeProject()} fallback={<p class="text-sm text-[var(--text-muted)]">Create a project to manage workflows.</p>}>
        {project => (
          <div class="space-y-6">
            <form class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4" onSubmit={handleWorkflowSubmit}>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="text-lg font-semibold text-[var(--text)]">New workflow for {project().name}</h3>
                <label class="flex items-center gap-2 text-sm text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={workflowForm().autoStart}
                    onChange={event => setWorkflowForm(form => ({ ...form, autoStart: event.currentTarget.checked }))}
                  />
                  Auto start
                </label>
              </div>
              <label class="text-sm font-semibold text-[var(--text-muted)]" for="workflow-kind">
                Kind
              </label>
              <input
                id="workflow-kind"
                type="text"
                class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2 text-[var(--text)]"
                value={workflowForm().kind}
                onInput={event => setWorkflowForm(form => ({ ...form, kind: event.currentTarget.value }))}
              />
              <label class="text-sm font-semibold text-[var(--text-muted)]" for="workflow-tasks">
                Tasks (one per line)
              </label>
              <textarea
                id="workflow-tasks"
                rows={4}
                class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2 text-[var(--text)]"
                value={workflowForm().tasksInput}
                onInput={event => setWorkflowForm(form => ({ ...form, tasksInput: event.currentTarget.value }))}
                placeholder="Example: Draft README\nExample: Implement API"
              />
              <button class="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white" type="submit">
                Queue workflow
              </button>
            </form>

            <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
              <div class="mb-3 flex items-center justify-between">
                <h3 class="text-lg font-semibold text-[var(--text)]">Workflows</h3>
                <button class="text-sm text-blue-600" type="button" onClick={() => refetchWorkflows()}>
                  Refresh
                </button>
              </div>
              <Show when={workflows()} fallback={<p class="text-sm text-[var(--text-muted)]">No workflows yet.</p>}>
                {items => (
                  <div class="flex flex-col gap-3">
                    <For each={items()}>
                      {entry => (
                        <article class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                          <header class="mb-2 flex items-center justify-between text-sm">
                            <div>
                              <p class="font-semibold text-[var(--text)]">{entry.workflow.kind}</p>
                              <p class="text-xs text-[var(--text-muted)]">Status: {entry.workflow.status}</p>
                            </div>
                            <time class="text-xs text-[var(--text-muted)]">
                              {new Date(entry.workflow.createdAt).toLocaleString()}
                            </time>
                          </header>
                          <ol class="flex flex-col gap-2">
                            <For each={entry.steps}>
                              {step => (
                                <li class="rounded-lg border border-dashed border-[var(--border)] p-2 text-sm">
                                  <p class="font-semibold text-[var(--text)]">
                                    {(step.data?.title as string | undefined) ?? `Step ${step.sequence}`}
                                  </p>
                                  <p class="text-xs text-[var(--text-muted)]">
                                    {step.status}
                                  </p>
                                </li>
                              )}
                            </For>
                          </ol>
                        </article>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>

      <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-lg font-semibold text-[var(--text)]">Active code-server sessions</h3>
          <button class="text-sm text-blue-600" type="button" onClick={() => refetchSessions()}>
            Refresh
          </button>
        </div>
        <Show when={sessions()} fallback={<p class="text-sm text-[var(--text-muted)]">No running sessions.</p>}>
          {items => (
            <ul class="flex flex-col gap-2">
              <For each={items()}>
                {session => (
                  <li class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm">
                    <p class="font-semibold text-[var(--text)]">{session.projectId}</p>
                    <p class="text-xs text-[var(--text-muted)]">{session.workspacePath}</p>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </div>
    </section>
  )
}

function buildTasksFromInput (raw: string): Array<{ id: string; title: string; instructions: string }> {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      id: `task-${Date.now()}-${index}`,
      title: `Task ${index + 1}`,
      instructions: line
    }))
}
