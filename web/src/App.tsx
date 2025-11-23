import { A, Navigate, Route, Router } from '@solidjs/router'
import type { RouteSectionProps } from '@solidjs/router'
import LaunchWorkflowPage from './pages/LaunchWorkflowPage'
import RepositoriesPage from './pages/RepositoriesPage'
import RepositoryGraphPage from './pages/RepositoryGraphPage'
import WorkflowDetailPage from './pages/WorkflowDetailPage'
import WorkflowsPage from './pages/WorkflowsPage'

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
        <NavLink href="/launch">Launch</NavLink>
      </nav>
    </header>
    <section class="flex-1">
      {props.children}
    </section>
  </main>
)

export default function App () {
  return (
    <Router root={AppShell}>
      <Route path="/" component={RedirectHome} />
      <Route path="/repositories" component={RepositoriesPage} />
      <Route path="/repositories/:projectId/graph" component={RepositoryGraphPage} />
      <Route path="/workflows" component={WorkflowsPage} />
      <Route path="/workflows/:workflowId" component={WorkflowDetailPage} />
      <Route path="/launch" component={LaunchWorkflowPage} />
    </Router>
  )
}

type NavLinkProps = {
  href: string
  children: string
}

function NavLink (props: NavLinkProps) {
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
