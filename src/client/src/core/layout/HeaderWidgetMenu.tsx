import { For, Show, createSignal, type JSX } from 'solid-js'
import { WIDGET_TEMPLATES } from '../../constants/widgetTemplates'
import { dispatchWorkspaceNavigatorOpen } from '../events/workspaceNavigator'
import { useWorkspaceSelection } from '../state/WorkspaceSelectionContext'

export type HeaderWidgetMenuProps = {
  onClose: () => void
  onSelectWidget: (templateId: string) => void
}

export default function HeaderWidgetMenu(props: HeaderWidgetMenuProps) {
  const selection = useWorkspaceSelection()
  const [workspaceSectionOpen, setWorkspaceSectionOpen] = createSignal(true)
  const [widgetSectionOpen, setWidgetSectionOpen] = createSignal(true)

  const workspaceList = selection.workspaces
  const isLoading = selection.isLoading
  const currentWorkspaceId = selection.currentWorkspaceId

  const handleWorkspaceSelect = (workspaceId: string) => {
    selection.setWorkspaceId(workspaceId)
    props.onClose()
  }

  const handleWidgetSelect = (templateId: string) => {
    props.onSelectWidget(templateId)
    props.onClose()
  }

  return (
    <div class="flex flex-col gap-3">
      <button
        type="button"
        class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-left text-sm font-semibold transition hover:bg-[var(--bg-muted)]"
        onClick={() => {
          dispatchWorkspaceNavigatorOpen()
          props.onClose()
        }}
      >
        <p>Manage workspaces</p>
        <p class="text-xs font-normal text-[var(--text-muted)]">Register repositories and switch</p>
      </button>

      <MenuSection
        title="Workspaces"
        open={workspaceSectionOpen()}
        onToggle={() => setWorkspaceSectionOpen((prev) => !prev)}
      >
        <div class="space-y-2">
          {isLoading() && <p class="text-xs text-[var(--text-muted)]">Loading workspaces…</p>}
          {!isLoading() && (workspaceList()?.length ?? 0) === 0 && (
            <p class="text-xs text-[var(--text-muted)]">No workspaces available</p>
          )}
          <For each={workspaceList() ?? []}>
            {(workspace) => {
              const isActive = () => currentWorkspaceId() === workspace.id
              return (
                <button
                  type="button"
                  class="w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-muted)]"
                  classList={{
                    'border border-[var(--border)] bg-[var(--bg-muted)]': isActive()
                  }}
                  onClick={() => handleWorkspaceSelect(workspace.id)}
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-medium">{workspace.name}</span>
                    {isActive() && (
                      <span class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Active</span>
                    )}
                  </div>
                  {workspace.repositoryPath && (
                    <p class="text-xs text-[var(--text-muted)]">{workspace.repositoryPath}</p>
                  )}
                </button>
              )
            }}
          </For>
        </div>
      </MenuSection>

      <MenuSection title="Widgets" open={widgetSectionOpen()} onToggle={() => setWidgetSectionOpen((prev) => !prev)}>
        <div class="space-y-2">
          <For each={WIDGET_TEMPLATES}>
            {(template) => (
              <button
                type="button"
                class="w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-muted)]"
                onClick={() => handleWidgetSelect(template.id)}
              >
                <p class="font-medium">{template.label}</p>
                {template.description && (
                  <p class="text-xs text-[var(--text-muted)]">{template.description}</p>
                )}
              </button>
            )}
          </For>
        </div>
      </MenuSection>
    </div>
  )
}

function MenuSection(props: { title: string; open: boolean; onToggle: () => void; children: JSX.Element }) {
  return (
    <section class="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]">
      <button
        type="button"
        class="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold"
        onClick={props.onToggle}
      >
        <span>{props.title}</span>
        <span>{props.open ? '−' : '+'}</span>
      </button>
      <Show when={props.open}>
        <div class="border-t border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">{props.children}</div>
      </Show>
    </section>
  )
}
