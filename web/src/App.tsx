import type { RouteSectionProps } from '@solidjs/router'
import { A, Navigate, Route, Router } from '@solidjs/router'
import { Show, createResource } from 'solid-js'
import { fetchJson } from './lib/http'
import RepositoriesPage from './pages/RepositoriesPage'
import RepositoryGraphPage from './pages/RepositoryGraphPage'
import TerminalPage from './pages/TerminalPage'
import WorkflowDetailPage from './pages/WorkflowDetailPage'
import WorkflowsPage from './pages/WorkflowsPage'

type RadicleStatus = {
  reachable: boolean
  loggedIn: boolean
  identity?: string | null
  alias?: string | null
  message?: string | null
}

const RedirectHome = () => <Navigate href="/repositories" />

const AppShell = (props: RouteSectionProps) => (
  <main class="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-6 px-4 pb-12 pt-8 sm:px-6 lg:px-10">
    <header class="flex flex-wrap items-center justify-between gap-4 rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] px-6 py-4 shadow-[0_18px_30px_rgba(15,23,42,0.08)]">
      <div>
        <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Hyperagent</p>
        <h1 class="text-2xl font-semibold text-[var(--text)]">Operations console</h1>
      </div>
      <nav class="flex flex-wrap items-center gap-3 text-sm font-semibold">
        <NavLink href="/repositories">Repositories</NavLink>
        <NavLink href="/workflows">Workflows</NavLink>
        <NavLink href="/terminal">Terminal</NavLink>
      </nav>
    </header>
    <section class="flex-1">{props.children}</section>
  </main>
)

export default function App() {
  const [radicleStatus, { refetch: refetchRadicleStatus }] = createResource(fetchRadicleStatus)

  const isReady = () => {
    const status = radicleStatus()
    return Boolean(status && status.reachable && status.loggedIn)
  }

  return (
    <Show when={isReady()} fallback={<RadicleGate status={radicleStatus()} onRetry={() => refetchRadicleStatus()} />}>
      <Router root={AppShell}>
        <Route path="/" component={RedirectHome} />
        <Route path="/repositories" component={RepositoriesPage} />
        <Route path="/repositories/:projectId/graph" component={RepositoryGraphPage} />
        <Route path="/workflows" component={WorkflowsPage} />
        <Route path="/workflows/:workflowId" component={WorkflowDetailPage} />
        <Route path="/terminal" component={TerminalPage} />
      </Router>
    </Show>
  )
}

type NavLinkProps = {
  href: string
  children: string
}

function NavLink(props: NavLinkProps) {
  return (
    <A
      href={props.href}
      class="rounded-xl px-3 py-1.5 text-[var(--text-muted)]"
      activeClass="bg-blue-600 text-white"
      end
    >
      {props.children}
    </A>
  )
}

type RadicleGateProps = {
  status: RadicleStatus | undefined
  onRetry: () => void
}

function RadicleGate(props: RadicleGateProps) {
  const message = () => {
    if (!props.status) return 'Checking Radicle node status…'
    if (!props.status.reachable) {
      return props.status.message ?? 'Radicle node is unreachable. Ensure your local node is running.'
    }
    if (!props.status.loggedIn) {
      return props.status.message ?? 'You must be logged into Radicle before using Hyperagent.'
    }
    return 'Radicle is ready.'
  }
  return (
    <main class="mx-auto flex min-h-screen w-full max-w-[760px] flex-col items-center justify-center gap-6 px-4 text-center">
      <section class="w-full rounded-[1.5rem] border border-[var(--border)] bg-[var(--bg-card)] px-6 py-10 shadow-[0_30px_40px_rgba(15,23,42,0.12)]">
        <p class="text-sm uppercase tracking-[0.35em] text-[var(--text-muted)]">Radicle required</p>
        <h1 class="mt-3 text-3xl font-semibold text-[var(--text)]">Connect to your Radicle node</h1>
        <p class="mt-4 text-[var(--text-muted)]">{message()}</p>
        <button
          class="mt-6 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white"
          type="button"
          onClick={props.onRetry}
        >
          Retry
        </button>
      </section>
    </main>
  )
}

async function fetchRadicleStatus(): Promise<RadicleStatus> {
  try {
    const payload = await fetchJson<{ status: RadicleStatus }>('/api/radicle/status')
    return payload.status
  } catch (error) {
    return {
      reachable: false,
      loggedIn: false,
      message: error instanceof Error ? error.message : 'Unable to reach Radicle status endpoint'
    }
  }
}
