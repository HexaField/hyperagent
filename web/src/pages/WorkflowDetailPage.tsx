import { A, useParams } from '@solidjs/router'
import WorkflowDetailView from '../components/WorkflowDetailView'

export default function WorkflowDetailPage() {
  const params = useParams()
  return (
    <WorkflowDetailView
      workflowId={params.workflowId}
      actions={<A href="/workflows" class="text-sm text-blue-600">Back to workflows</A>}
    />
  )
}
