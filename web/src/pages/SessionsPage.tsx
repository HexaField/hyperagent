import { useSearchParams } from '@solidjs/router'
import OpencodeConsole from '../components/OpencodeConsole'

export default function SessionsPage() {
  const [params, setParams] = useSearchParams()
  const workspaceFilter = () => params.workspace ?? ''

  const handleWorkspaceChange = (value: string) => {
    const next = value.trim()
    setParams((current) => ({
      ...current,
      workspace: next || undefined
    }))
  }

  return (
    <div class="flex flex-col gap-6">
      <header class="rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-[0_18px_30px_rgba(15,23,42,0.08)]">
        <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Sessions</p>
        <h1 class="text-3xl font-semibold text-[var(--text)]">Global Opencode Sessions</h1>
        <p class="text-[var(--text-muted)]">
          Inspect every opencode session that has run on this server, regardless of which workspace spawned it.
          Filter by workspace path to focus on a single repository, kick off new background runs, and rehydrate
          transcripts after restarts.
        </p>
      </header>

      <OpencodeConsole
        workspaceFilter={workspaceFilter()}
        onWorkspaceFilterChange={handleWorkspaceChange}
        heading="Workspace activity"
        description="Use the workspace filter to scope the session list or leave it blank to see everything."
      />
    </div>
  )
}
