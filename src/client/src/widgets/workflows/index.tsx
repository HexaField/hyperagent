import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js'
import { ZodError } from 'zod'
import type { WorkspaceRecord } from '../../../../interfaces/core/projects'
import { workflowTemplates } from '../../data/workflowTemplates'
import { draftWorkflowFromPrompt } from '../../lib/workflowDraft'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  parseWorkflowJson,
  updateWorkflow,
  validateRemotely,
  type WorkflowDetail
} from '../../lib/workflows'
import { formatTimestamp } from '../../shared/utils/datetime'

export type WorkflowsWidgetProps = {
  workspace: WorkspaceRecord
}

export function WorkflowsWidget(props: WorkflowsWidgetProps) {
  const [instructions, setInstructions] = createSignal(
    'Describe the feature, acceptance criteria, constraints, and environments. Request a reviewer loop.'
  )
  const [draftJson, setDraftJson] = createSignal('')
  const [status, setStatus] = createSignal<'idle' | 'drafting' | 'validating' | 'saving'>('idle')
  const [message, setMessage] = createSignal<string | null>(null)
  const [validationIssues, setValidationIssues] = createSignal<string[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = createSignal<string | null>(workflowTemplates[0]?.id ?? null)
  const [previewInstructions, setPreviewInstructions] = createSignal(
    'Ship a CLI that audits repository TODOs and outputs a markdown report.'
  )
  const [selectedWorkflowId, setSelectedWorkflowId] = createSignal<string | null>(null)

  const selectedTemplate = createMemo(() => workflowTemplates.find((tpl) => tpl.id === selectedTemplateId()) ?? null)

  const [workflows, { refetch: refetchWorkflows }] = createResource(listWorkflows)
  const [workflowDetail, { refetch: refetchDetail }] = createResource(selectedWorkflowId, async (id) =>
    id ? await getWorkflow(id) : null
  )

  createEffect(() => {
    const items = workflows()
    if (items && items.length && !selectedWorkflowId()) {
      setSelectedWorkflowId(items[0]?.id ?? null)
    }
  })

  const steps = createMemo(() => {
    const detail = workflowDetail()
    if (!detail) return [] as Array<{ key: string; role: string; prompt: string[] }>
    const roundSteps = detail.definition.flow.round.steps ?? []
    const bootstrap = detail.definition.flow.bootstrap ? [detail.definition.flow.bootstrap] : []
    return [...bootstrap, ...roundSteps].map((step) => ({ key: step.key, role: step.role, prompt: step.prompt }))
  })

  const isBusy = () => status() !== 'idle'

  const renderPreviewPrompt = () => {
    const detail = workflowDetail()
    if (!detail) return null
    const candidate =
      detail.definition.flow.bootstrap?.prompt?.[0] ?? detail.definition.flow.round.steps[0]?.prompt?.[0]
    if (!candidate) return null
    return candidate.replace(/\{\{\s*user\.instructions\s*\}\}/g, previewInstructions())
  }

  const captureIssues = (error: unknown) => {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => `${(issue.path ?? []).join('.') || 'definition'}: ${issue.message}`)
      setValidationIssues(issues)
    } else if (error instanceof Error) {
      setValidationIssues([error.message])
    } else {
      setValidationIssues(['Unknown validation error'])
    }
  }

  const handleApplyTemplate = (templateId: string) => {
    const template = workflowTemplates.find((tpl) => tpl.id === templateId)
    if (!template) return
    setSelectedTemplateId(templateId)
    setDraftJson(JSON.stringify(template.definition, null, 2))
    setInstructions(template.sampleInstructions ?? instructions())
    setMessage(`Loaded template ${template.label}`)
  }

  const handleDraft = async () => {
    const prompt = instructions().trim()
    if (!prompt.length) {
      setValidationIssues(['Provide instructions before drafting'])
      return
    }
    setStatus('drafting')
    setMessage(null)
    setValidationIssues([])
    try {
      const draft = await draftWorkflowFromPrompt({ instructions: prompt, template: selectedTemplate() })
      setDraftJson(JSON.stringify(draft.definition, null, 2))
      setMessage('Drafted workflow with LLM')
    } catch (error) {
      captureIssues(error)
      const detail = error instanceof Error ? error.message : 'Failed to draft workflow'
      setMessage(detail)
    } finally {
      setStatus('idle')
    }
  }

  const handleValidate = async () => {
    setStatus('validating')
    setMessage(null)
    setValidationIssues([])
    try {
      const parsed = parseWorkflowJson(draftJson())
      const hydrated = await validateRemotely(parsed)
      setDraftJson(JSON.stringify(hydrated, null, 2))
      setMessage('Workflow validated successfully')
    } catch (error) {
      captureIssues(error)
      setMessage('Validation failed')
    } finally {
      setStatus('idle')
    }
  }

  const handleSave = async () => {
    setStatus('saving')
    setMessage(null)
    setValidationIssues([])
    try {
      const parsed = parseWorkflowJson(draftJson())
      const hydrated = await validateRemotely(parsed)
      const existing = (workflows() ?? []).some((wf) => wf.id === hydrated.id)
      if (existing) {
        await updateWorkflow(hydrated.id, hydrated)
        setMessage(`Updated workflow ${hydrated.id}`)
      } else {
        await createWorkflow(hydrated)
        setMessage(`Created workflow ${hydrated.id}`)
      }
      await refetchWorkflows()
      setSelectedWorkflowId(hydrated.id)
      await refetchDetail()
    } catch (error) {
      captureIssues(error)
      setMessage('Save failed')
    } finally {
      setStatus('idle')
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await deleteWorkflow(id)
    if (!ok) return
    await refetchWorkflows()
    setSelectedWorkflowId(null)
    setMessage(`Deleted workflow ${id}`)
  }

  const loadIntoEditor = (detail: WorkflowDetail | null) => {
    if (!detail) return
    setDraftJson(JSON.stringify(detail.definition, null, 2))
    setInstructions(previewInstructions())
    setMessage(`Loaded ${detail.id} into editor`)
  }

  const sortedWorkflows = createMemo(() => (workflows() ?? []).slice())

  return (
    <div class="flex h-full flex-col gap-4 bg-[var(--bg-app)] p-4 text-[var(--text)]">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Workflows · {props.workspace.name}</p>
          <h1 class="text-2xl font-semibold">Text-first workflow creator</h1>
        </div>
        <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <button
            class="rounded-xl border border-[var(--border)] px-3 py-1.5"
            type="button"
            disabled={isBusy()}
            onClick={() => void refetchWorkflows()}
          >
            Refresh
          </button>
          <Show when={message()}>{(msg) => <span class="text-[var(--text)]">{msg()}</span>}</Show>
        </div>
      </header>

      <div class="grid gap-4 lg:grid-cols-[minmax(420px,1fr),minmax(420px,1fr)]">
        <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Natural-language creator</p>
              <h2 class="text-lg font-semibold">Draft, validate, and save</h2>
            </div>
            <span class="rounded-lg bg-[var(--bg-muted)] px-3 py-1 text-xs text-[var(--text-muted)]">{status()}</span>
          </div>

          <label class="space-y-2 text-sm">
            <span class="text-[var(--text-muted)]">What should the workflow do?</span>
            <textarea
              class="h-28 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 font-mono text-sm"
              value={instructions()}
              onInput={(event) => setInstructions(event.currentTarget.value)}
              placeholder="Describe the goal, roles, constraints, and outputs"
            />
          </label>

          <div class="flex flex-wrap items-center gap-2 text-sm">
            <For each={workflowTemplates}>
              {(template) => (
                <button
                  class={`rounded-xl border px-3 py-1 ${selectedTemplateId() === template.id ? 'border-blue-500 text-blue-600' : 'border-[var(--border)] text-[var(--text)]'}`}
                  type="button"
                  onClick={() => handleApplyTemplate(template.id)}
                  disabled={isBusy()}
                >
                  {template.label}
                </button>
              )}
            </For>
          </div>

          <div class="flex flex-wrap gap-2 text-sm">
            <button
              class="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
              type="button"
              disabled={isBusy()}
              onClick={() => void handleDraft()}
            >
              Draft with AI
            </button>
            <button
              class="rounded-xl border border-[var(--border)] px-4 py-2"
              type="button"
              disabled={isBusy()}
              onClick={() => void handleValidate()}
            >
              Validate
            </button>
            <button
              class="rounded-xl border border-[var(--border)] px-4 py-2"
              type="button"
              disabled={isBusy()}
              onClick={() => void handleSave()}
            >
              Save workflow
            </button>
          </div>

          <label class="space-y-2 text-sm">
            <span class="text-[var(--text-muted)]">Workflow JSON</span>
            <textarea
              class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 font-mono text-xs"
              value={draftJson()}
              onInput={(event) => setDraftJson(event.currentTarget.value)}
              placeholder="Paste or draft AgentWorkflowDefinition JSON here"
            />
          </label>

          <Show when={validationIssues().length}>
            <div class="rounded-xl border border-red-400 bg-red-50 p-3 text-sm text-red-800">
              <p class="font-semibold">Validation issues</p>
              <ul class="list-disc space-y-1 pl-4">
                <For each={validationIssues()}>{(issue) => <li>{issue}</li>}</For>
              </ul>
            </div>
          </Show>
        </section>

        <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Library</p>
              <h2 class="text-lg font-semibold">Saved workflows</h2>
            </div>
            <span class="text-xs text-[var(--text-muted)]">{workflows()?.length ?? 0} total</span>
          </div>

          <div class="grid gap-2">
            <Show when={workflows.loading} fallback={null}>
              <p class="text-sm text-[var(--text-muted)]">Loading workflows…</p>
            </Show>
            <For each={sortedWorkflows()}>
              {(item) => (
                <button
                  class={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${
                    selectedWorkflowId() === item.id
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text)]'
                  }`}
                  type="button"
                  onClick={() => setSelectedWorkflowId(item.id)}
                >
                  <div class="space-y-1">
                    <p class="font-semibold">{item.id}</p>
                    <p class="text-xs text-[var(--text-muted)]">{item.description ?? 'No description'}</p>
                  </div>
                  <div class="text-xs text-[var(--text-muted)]">{formatTimestamp(item.updatedAt)}</div>
                </button>
              )}
            </For>
          </div>

          <Show when={workflowDetail()}>
            {(detailAccessor) => {
              const detail = detailAccessor()
              return (
                <div class="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-sm">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Workflow detail</p>
                      <h3 class="text-lg font-semibold">{detail.id}</h3>
                      <p class="text-xs text-[var(--text-muted)]">Model · {detail.definition.model ?? 'unspecified'}</p>
                    </div>
                    <div class="flex gap-2">
                      <button
                        class="rounded-lg border border-[var(--border)] px-3 py-1 text-xs"
                        type="button"
                        onClick={() => loadIntoEditor(detail)}
                      >
                        Load into editor
                      </button>
                      <button
                        class="rounded-lg border border-red-500 px-3 py-1 text-xs text-red-600"
                        type="button"
                        onClick={() => void handleDelete(detail.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <div class="space-y-1">
                    <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Roles</p>
                    <div class="flex flex-wrap gap-2">
                      <For each={Object.keys(detail.definition.roles ?? {})}>
                        {(role) => (
                          <span class="rounded-full bg-white/70 px-3 py-1 text-xs text-[var(--text)]">{role}</span>
                        )}
                      </For>
                    </div>
                  </div>

                  <div class="space-y-2">
                    <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Steps</p>
                    <ol class="space-y-2">
                      <For each={steps()}>
                        {(step) => (
                          <li class="rounded-lg border border-[var(--border)] bg-white/60 p-2">
                            <p class="font-semibold">{step.key}</p>
                            <p class="text-xs text-[var(--text-muted)]">Role · {step.role}</p>
                            <Show when={step.prompt?.length}>
                              <p class="mt-1 text-xs text-[var(--text)]">{step.prompt.join(' \n\n ')}</p>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ol>
                  </div>

                  <div class="space-y-2">
                    <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Run preview</p>
                    <textarea
                      class="h-20 w-full rounded-xl border border-[var(--border)] bg-white/70 p-2 text-xs"
                      value={previewInstructions()}
                      onInput={(event) => setPreviewInstructions(event.currentTarget.value)}
                    />
                    <Show when={renderPreviewPrompt()}>
                      {(preview) => (
                        <pre class="whitespace-pre-wrap rounded-lg bg-black/80 p-3 text-xs text-white">{preview()}</pre>
                      )}
                    </Show>
                  </div>

                  <p class="text-xs text-[var(--text-muted)]">Stored at {detail.path}</p>
                </div>
              )
            }}
          </Show>
        </section>
      </div>
    </div>
  )
}

export default WorkflowsWidget
