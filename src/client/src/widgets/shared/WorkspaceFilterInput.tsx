import { Show, type JSX } from 'solid-js'

export type WorkspaceFilterInputProps = {
  value: string
  onChange: (value: string) => void
  label?: string
  description?: string
  placeholder?: string
  actions?: JSX.Element
  class?: string
}

export function WorkspaceFilterInput(props: WorkspaceFilterInputProps) {
  const normalizedPlaceholder = () => props.placeholder ?? 'workspace-id or repository path'
  const handleInput = (event: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement }) => {
    props.onChange(event.currentTarget.value)
  }

  return (
    <div class={`rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 ${props.class ?? ''}`}>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold text-[var(--text)]">{props.label ?? 'Workspace filter'}</p>
          <Show when={props.description} keyed>
            {(description) => <p class="text-xs text-[var(--text-muted)]">{description}</p>}
          </Show>
        </div>
        <Show when={props.actions} keyed>
          {(actions) => <div class="flex flex-wrap items-center gap-2">{actions}</div>}
        </Show>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          class="flex-1 min-w-[220px] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)]"
          value={props.value}
          placeholder={normalizedPlaceholder()}
          onInput={handleInput}
        />
      </div>
    </div>
  )
}

export default WorkspaceFilterInput
