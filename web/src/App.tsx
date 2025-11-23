import AgentDuet from './components/AgentDuet'
import WorkflowDashboard from './components/WorkflowDashboard'

export default function App() {
  return (
    <main class="mx-auto flex h-full w-full max-w-[1200px] flex-col gap-6 px-4 pb-12 pt-8 sm:px-6 lg:px-10">
      <AgentDuet />
      <WorkflowDashboard />
      {/* <NodeGraph /> */}
    </main>
  )
}
